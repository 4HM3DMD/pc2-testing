# Handover: `ipfs.ela.city` Authenticated Pin Endpoint (Nginx Patch)

> **Audience**: Whoever operates the Elacity IPFS gateway box
> (`ipfs.ela.city` → `34.77.31.164` → GCP VM `ipfs-node0`).
> **Status**: Ready to apply. Surgical nginx patch, read-only to
> everything that already works. Unblocks Irzhy's playback issue
> and every future PC2 mint.
> **Created**: 2026-04-29

---

## Why this is needed

`ipfs.ela.city` already runs Kubo v0.24.0 with the gateway paths
(`/ipfs/`, `/ipns/`) exposed publicly. Its write-side API
(`/api/v0/*`) is firewalled — we confirmed this from the outside by
probing every public Kubo endpoint and getting 404 on everything
except a handful of safe read verbs.

That's correct security posture. But it means PC2 nodes cannot ask
`ipfs.ela.city` to pin content they've just minted. Today, when a
creator on PC2-A mints an asset, the only place the bytes live is
PC2-A's local Helia. `ipfs.ela.city` can technically reach them via
DHT + direct peering (once `IPFS-ELACITY-BOOTSTRAP` lands), but it
won't *pin* them — so as soon as PC2-A goes offline, the content
disappears from `ipfs.ela.city`'s cache and every downstream buyer
gets `Playback Error — fetch failed`.

**Irzhy hit exactly this** on 2026-04-28. Full diagnosis:
`docs/handover/IRZHY_PLAYBACK_DIAGNOSIS_2026_04_28.md`.

**The fix**: open a narrow, authenticated `/api/v0/pin/add` on the
nginx in front of Kubo, so PC2 nodes can `POST` a CID after mint and
Kubo pulls it into its own pinset durably.

No byte upload through nginx. Nothing else in the Kubo API is
exposed. Bearer-token auth means random Internet traffic cannot
fill the pinset. Zero impact on existing gateway reads.

---

## The nginx patch

This assumes the existing vhost for `ipfs.ela.city` proxies to a
local Kubo on `127.0.0.1:5001`. That's the default Kubo API port and
matches what the team confirmed.

Apply to whatever file owns the `server { server_name ipfs.ela.city; }`
block (likely `/etc/nginx/sites-available/ipfs.ela.city` or similar).

### Step 1 — store the bearer token in a file nginx can read

```bash
sudo mkdir -p /etc/nginx/conf.d/elacity
# Generate a 48-byte URL-safe token. Keep a copy — PC2 nodes will
# need it in the ELACITY_PIN_FORWARD_TOKEN env var.
sudo openssl rand -base64 48 | tr -d '\n' | sudo tee /etc/nginx/conf.d/elacity/pin-bearer.txt
sudo chmod 0600 /etc/nginx/conf.d/elacity/pin-bearer.txt
sudo chown root:root /etc/nginx/conf.d/elacity/pin-bearer.txt
```

### Step 2 — add the map + location blocks

Add this to the `http { }` scope (or the existing `/etc/nginx/conf.d/elacity/`
include), **outside** any `server` block:

```nginx
# /etc/nginx/conf.d/elacity/pin-auth.conf
#
# Bearer-token auth for the narrow Kubo pin endpoint. The token is
# loaded from a root-owned file at nginx start; rotate by rewriting
# the file and running `nginx -s reload`.
#
# PC2 nodes are expected to pass:
#   Authorization: Bearer <token>
# Every other caller is rejected with 401.

map $http_authorization $elacity_pin_auth_ok {
    default 0;
    # Replace ${EXPECTED_TOKEN} with `cat /etc/nginx/conf.d/elacity/pin-bearer.txt`
    # at deploy time (nginx does not interpolate env vars, so the
    # token must be literal here). Use `envsubst` or a small deploy
    # script if you want to keep the token out of this file.
    "Bearer ${EXPECTED_TOKEN}" 1;
}
```

> **Deploy tip**: a reasonable pattern is a `pin-auth.conf.template`
> kept in your config repo with the placeholder, and a post-deploy
> step that does:
>
> ```bash
> TOKEN=$(cat /etc/nginx/conf.d/elacity/pin-bearer.txt)
> envsubst '${EXPECTED_TOKEN}' < /etc/nginx/conf.d/elacity/pin-auth.conf.template \
>   | sudo tee /etc/nginx/conf.d/elacity/pin-auth.conf >/dev/null
> sudo nginx -t && sudo nginx -s reload
> ```

Then add this **inside** the existing `server { ... server_name
ipfs.ela.city; ... }` block, typically near the end before the
closing brace, after the existing gateway locations:

```nginx
    # ─────────────────────────────────────────────────────────────
    # Authenticated pin endpoint for trusted PC2 nodes.
    # Everything else under /api/v0/ remains blocked by existing rules.
    # ─────────────────────────────────────────────────────────────
    location = /api/v0/pin/add {
        if ($elacity_pin_auth_ok != 1) { return 401; }
        limit_except POST OPTIONS { deny all; }

        # Kubo's HTTP API; Kubo only accepts requests with Host set
        # to one of the values in its API config — see notes below.
        proxy_pass http://127.0.0.1:5001;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:5001;
        proxy_set_header Connection "";

        # Pins can take a while for large objects; override default.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_connect_timeout 15s;

        # Body is empty for pin/add (CID is in the ?arg= query); keep
        # client_max_body_size small to avoid being used as a tunnel.
        client_max_body_size 4k;
    }

    # Optional: diagnostic — lets PC2 confirm a pin landed.
    # Safe to expose because it only lists pinset, no mutations.
    location = /api/v0/pin/ls {
        if ($elacity_pin_auth_ok != 1) { return 401; }
        limit_except POST OPTIONS { deny all; }

        proxy_pass http://127.0.0.1:5001;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1:5001;
        proxy_set_header Connection "";
        proxy_read_timeout 30s;
        client_max_body_size 4k;
    }
```

### Step 3 — confirm Kubo accepts the proxied Host header

Kubo refuses API calls whose `Host:` header isn't in its
`API.HTTPHeaders.Access-Control-Allow-Origin` list. The stock config
accepts `127.0.0.1:5001`, which is what the block above sets. If
your Kubo is tighter, you'll see `403 Forbidden` from Kubo even when
nginx passes the request through. Fix by adding `ipfs.ela.city` to
`Gateway.PathPrefixes` or `API.HTTPHeaders` on the Kubo side (your
team already controls this; the config dump showed `"API": { ... }`
is standard).

### Step 4 — reload and test

```bash
sudo nginx -t
sudo nginx -s reload

# Negative test: no auth → 401
curl -i -X POST 'https://ipfs.ela.city/api/v0/pin/add?arg=bafybeihtest'
# Expect: HTTP/1.1 401 Unauthorized

# Negative test: wrong auth → 401
curl -i -X POST 'https://ipfs.ela.city/api/v0/pin/add?arg=bafybeihtest' \
     -H 'Authorization: Bearer WRONG'
# Expect: HTTP/1.1 401 Unauthorized

# Positive test with a real, small, globally-available CID:
TOKEN=$(sudo cat /etc/nginx/conf.d/elacity/pin-bearer.txt)
curl -i -X POST 'https://ipfs.ela.city/api/v0/pin/add?arg=bafkreicrd7qwfkqwjxdwrfqvcgfjd4mypzvqbhwl7m4pdcdyvs5ihq2ote' \
     -H "Authorization: Bearer $TOKEN"
# Expect: HTTP/1.1 200 OK, JSON body {"Pins":["bafk..."],"Progress":...}

# Confirm it's in the pinset:
curl -X POST "https://ipfs.ela.city/api/v0/pin/ls?arg=bafkreicrd7qwfkqwjxdwrfqvcgfjd4mypzvqbhwl7m4pdcdyvs5ihq2ote" \
     -H "Authorization: Bearer $TOKEN"
# Expect: {"Keys":{"bafk...":{"Type":"recursive"}}}
```

If all four pass → patch is live and PC2 nodes can start using it
as soon as `ELACITY_PIN_FORWARD_URL=https://ipfs.ela.city` and
`ELACITY_PIN_FORWARD_TOKEN=<token>` are set on the PC2 side.

---

## Rollback

Cut the two `location` blocks out of the vhost and `nginx -s reload`.
Zero residual effect — the Kubo API on `127.0.0.1:5001` was never
reachable from the Internet before, and isn't after rollback.

The bearer-token file can stay; it's only read at nginx start.

---

## Rotation

1. Generate a new token:
   `sudo openssl rand -base64 48 | tr -d '\n' | sudo tee /etc/nginx/conf.d/elacity/pin-bearer.txt`
2. Re-render `pin-auth.conf` from the template (Step 2 deploy tip).
3. `sudo nginx -t && sudo nginx -s reload`.
4. Update `ELACITY_PIN_FORWARD_TOKEN` on every PC2 node that uses
   the forward. Old token is rejected immediately; pin-forward calls
   with stale token fail fast with 401 (logged but fire-and-forget,
   no user impact).

---

## Why these specific choices

| Choice | Reason |
|-------|---------|
| `location = /api/v0/pin/add` (exact match, no trailing slash) | Kubo honours exactly `/api/v0/pin/add` — not `/pin/add/` or `/pin/add/recursive`. Exact match keeps the attack surface a single verb. |
| `limit_except POST OPTIONS` | Kubo accepts POST and OPTIONS (CORS preflight) only. GET/HEAD/DELETE/PUT on this path would be misrouted Internet noise. |
| `proxy_set_header Host 127.0.0.1:5001` | Kubo rejects non-local `Host:` on the API port for CSRF protection. Stock behaviour; do not override unless Kubo config was tightened. |
| `client_max_body_size 4k` | `pin/add` takes the CID in the query string. Any request with a large body is someone trying to tunnel. 4k leaves room for CORS headers. |
| `proxy_read_timeout 600s` | Large pins (tens of GB) can take minutes while Kubo fetches from providers. Stock nginx 60 s is too short for real assets. |
| Bearer auth, not mTLS | PC2 nodes are numerous and operated by community members; mTLS would mean per-node cert issuance. One shared bearer per environment is operationally simpler; compromise = rotate and restart. |
| Separate `pin-bearer.txt` file | Keeps the token out of the vhost config (which is typically checked into a git repo). Root-owned 0600. |

---

## What this does NOT do

- **Does not expose `pin/rm`, `pin/update`, `pin/verify`, `swarm/*`,
  `config/*`, `repo/*`, `files/*`, or any other mutating Kubo verb.**
  Only `pin/add` (write) and `pin/ls` (read diagnostic) are added.
- **Does not change the public gateway behaviour** at all. Existing
  `/ipfs/`, `/ipns/`, `/api/v0/version`, `/api/v0/name/resolve`
  routes remain untouched.
- **Does not add byte uploads.** Creators still go through
  `https://base.ela.city/api/2.0/files/upload` for raw byte
  replication. This endpoint is *additional* — a lightweight
  "please pin this CID you can already reach via DHT or peering"
  signal.

---

## PC2 side: the client that will use this

Once you deploy the patch and share the token, PC2's
`ELACITY-KUBO-PIN-FORWARD` task ships the client. Current status
tracker: `.cursor/tasks/ELACITY-KUBO-PIN-FORWARD/`.

The client:
1. Reads `ELACITY_PIN_FORWARD_URL` + `ELACITY_PIN_FORWARD_TOKEN` env
   vars. Default: unset → forward disabled → zero traffic.
2. After every successful `/api/ipfs/pin` and after every successful
   `/api/storage/ipfs/upload-elacity{,-directory}` call, fires
   `POST ${URL}/api/v0/pin/add?arg=<cid>&recursive=true` with
   `Authorization: Bearer <token>`, 30 s timeout, fire-and-forget.
3. Adds `GET /api/storage/ipfs/elacity-pin-forward` owner-guarded
   diagnostic so operators can confirm the last 1–N forwards
   succeeded.

No user-visible behaviour change if the patch isn't deployed or
the env vars aren't set.

---

## Questions / edge cases for Elacity ops to flag

1. Is Kubo's `StorageMax` (230 GB) close to full? `pin/add` will
   fail when the repo is at 90% (current `StorageGCWatermark`). If
   so, let us know the current free bytes — we may want to add a
   PC2-side check that skips forwarding when we know storage is
   tight.
2. Is there a WAF/rate-limiter in front of nginx (Cloudflare?) that
   needs a carve-out for the new POST path? Default Cloudflare rules
   sometimes block un-parsable POST bodies or exotic methods on
   "API-like" paths.
3. Do you want the bearer token scoped per PC2 node, or one shared
   token? Per-node = better accountability but more rotation
   overhead. Recommend one shared token for v1.2, split per-node in
   a future milestone if abuse becomes a thing.

---

## Timeline ask

- **Goal**: patch deployed before v1.2.1 release (currently
  targeted for early May 2026).
- **Unblocks**: Irzhy's playback issue, every future PC2 creator's
  content being reliably reachable regardless of their node uptime.
- **Estimated apply time**: 20 min (5 min config, 15 min test).
- **Risk**: near-zero if the test matrix above passes; rollback is
  cutting two `location` blocks.

Ping me (PC2 side) when the token is ready and I'll set the env
vars on the reference PC2 node so we can do an end-to-end test the
same day.
