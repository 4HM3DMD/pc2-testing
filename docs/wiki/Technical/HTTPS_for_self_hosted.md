# HTTPS for self-hosted PC2

> **Who needs this:** anyone running PC2 on a remote server / VPS / Jetson and
> reaching it from a different machine over the internet. If you only ever
> open PC2 at `http://localhost:4200` on the same machine you run it on, you
> can skip this guide.

---

## Why HTTPS is suddenly required

Modern browsers gate the Web Crypto API (`window.crypto.subtle`) behind a
**secure context**. A secure context is one of:

| Context                                       | Secure?         |
| --------------------------------------------- | --------------- |
| `https://anything`                            | Yes             |
| `http://localhost` / `http://127.0.0.1`       | Yes (loopback)  |
| `http://your-vps-ip:4200`                     | **No**          |
| `http://yourdomain.com:4200` (plain HTTP)     | **No**          |

PC2's encrypted-content playback (Lit Protocol decryption, secure-view
delegation, AES-GCM) runs in the browser and needs `crypto.subtle`. Without
a secure context, you'll see:

- _"crypto.subtle is undefined"_ in the JS console
- A blank player or the friendly fallback page added in **PC2 v1.2.7.5**

Switching browsers does **not** help — Chrome, Firefox, Brave, Edge and
Safari all enforce the same rule. The fix has to be done server-side, by
putting HTTPS in front of PC2.

---

## Three setup options

Pick one. All three terminate TLS in front of PC2 and proxy plain HTTP to
`localhost:4200` on the PC2 box. PC2 itself does not need any changes.

### Option A — Caddy (easiest, ~3 min)

Caddy is a Go-based reverse proxy that auto-provisions Let's Encrypt
certificates. No certbot. No cron. No nginx config files.

**Prerequisite:** a domain (e.g. `pc2.example.com`) pointing to the VPS's
public IP, plus ports 80 and 443 reachable.

```bash
# Debian / Ubuntu
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Then write `/etc/caddy/Caddyfile`:

```caddy
pc2.example.com {
    reverse_proxy 127.0.0.1:4200
}
```

```bash
sudo systemctl reload caddy
```

That's it. Caddy will fetch a Let's Encrypt cert on first request and
auto-renew it forever. Your PC2 is now reachable at
`https://pc2.example.com`, and the player loads without complaint.

### Option B — Cloudflare Tunnel (no ports, no certs)

Useful when you can't open inbound ports (residential ISP, Jetson behind
NAT) or don't want to manage certificates.

**Prerequisite:** a Cloudflare account with the domain on Cloudflare DNS.

```bash
# Install cloudflared (example: Debian/Ubuntu arm64 — see Cloudflare docs
# for your platform).
curl -L --output cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login              # opens browser → authorise
cloudflared tunnel create pc2
cloudflared tunnel route dns pc2 pc2.example.com
```

Write `~/.cloudflared/config.yml`:

```yaml
tunnel: pc2
credentials-file: /home/YOU/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: pc2.example.com
    service: http://localhost:4200
  - service: http_status:404
```

```bash
sudo cloudflared service install
```

Cloudflare now terminates TLS at its edge and proxies into your tunnel. No
inbound firewall rule needed; Cloudflare provides the cert automatically.

### Option C — nginx + certbot (classic stack)

If you already run nginx, this is the lowest-friction option.

**Prerequisite:** domain pointing to the VPS, ports 80 + 443 open.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Write `/etc/nginx/sites-available/pc2`:

```nginx
server {
    listen 80;
    server_name pc2.example.com;

    location / {
        proxy_pass http://127.0.0.1:4200;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket / long-lived connection upgrades (RTC signalling, etc.)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/pc2 /etc/nginx/sites-enabled/pc2
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pc2.example.com
```

certbot edits the nginx config in-place to enable HTTPS, and installs a
systemd timer that renews every 90 days.

---

## After you have HTTPS

1. Browse to `https://pc2.example.com` — the player should load normally.
2. Update any bookmarks/launchers from `http://...:4200` to the HTTPS URL.
3. (Optional) drop port 4200 from your firewall — only Caddy / nginx /
   cloudflared needs to be reachable from outside.

---

## Common issues

- **"DNS_PROBE_FINISHED_NXDOMAIN"** — your DNS A record hasn't propagated;
  wait 5-10 min.
- **Caddy cert errors on first request** — ensure ports 80 and 443 are open
  to the world; Let's Encrypt's HTTP-01 challenge needs port 80.
- **`502 Bad Gateway`** — PC2 isn't running, or it's bound to a different
  port. Confirm with `curl http://localhost:4200/api/health` on the VPS.
- **Player still says "crypto.subtle undefined" after HTTPS works** — hard
  refresh (`Cmd-Shift-R` / `Ctrl-Shift-R`) so the browser re-evaluates the
  secure-context flag with the new origin.

---

## Roadmap (v1.2.7.6+)

We're tracking a follow-up to ship **built-in HTTPS in PC2 itself**:

- Self-signed cert on first boot for trivial localhost-as-server scenarios.
- Optional Let's Encrypt via ACME HTTP-01 when a domain is configured.

This will collapse the three options above into one config flag. Until
then, the reverse-proxy approach is the recommended path.
