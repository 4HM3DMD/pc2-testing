# PC2 Node — Identity Recovery

> Audience: node operators running PC2 in Docker, bare metal, or dev mode.
> Scope: everything needed to get your `yourname.ela.city` handle back
> after data loss — provided you kept the 24-word recovery phrase.

---

## 1. What actually persists your node

A PC2 node's "soul" lives in **one file**:

```text
pc2-node/data/identity.json   (mode 0600)
```

That file stores a version-2 Boson identity:

| Field                | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `nodeId`             | Base58 of the ed25519 public key                      |
| `did`                | `did:boson:<nodeId>` — what the gateway associates    |
|                      | with `yourname.ela.city`                              |
| `publicKey`          | SPKI-wrapped ed25519 public key (hex)                 |
| `privateKey`         | PKCS#8-wrapped ed25519 seed+pub (hex)                 |
| `identityVersion`    | Always `2` for mnemonic-derived identities            |
| `adminWalletAddress` | Tethered EVM wallet (once linked — optional)          |
| `encryptedMnemonic`  | Your 24-word phrase, sealed with wallet signature     |
|                      | (only present if you connected a wallet)              |

**Everything in this file is deterministically derived from the 24-word
recovery phrase** via:

```text
HKDF-like(
  salt = "pc2-boson-identity-v2",
  info = "ed25519-seed",
  ikm  = <your mnemonic, utf-8>,
) → 32-byte seed → ed25519 keypair
```

Same phrase ⇒ same seed ⇒ same keypair ⇒ same nodeId ⇒ same DID ⇒ same
ela.city handle on the gateway.

---

## 2. How you get the phrase in the first place

On **first boot** of a brand-new node, `IdentityService` generates 48
bytes of entropy, selects 24 words from the built-in wordlist, and:

1. Prints the phrase into the server logs under `[IdentityService] 🆕 Generated new node identity`.
2. Surfaces it to the setup wizard at `GET /api/setup/mnemonic` — the
   wizard displays it once and asks you to acknowledge.
3. If you connect an EVM wallet during setup, the node encrypts the
   phrase to a signature from that wallet and stores it as
   `encryptedMnemonic` inside `identity.json`. From that point, the
   plaintext phrase is **wiped from server memory**.

**Your phrase is your responsibility.** Write it on paper. Store it in a
password manager. Tattoo it on your forearm. Whatever works — just keep
it somewhere the container can't reach.

---

## 3. Recovery — you lost the volume but kept the phrase

This is the Hellarnasstrom scenario: your `docker compose` setup went
sideways, the `pc2-data` volume is toast, but you have the 24 words.

### Option A — CLI (preferred)

```bash
# From the pc2-node directory on the host:
cd pc2-node
npm run recover-mnemonic
# → paste your 24 words (input is hidden)
# → writes data/identity.json, mode 0600
# → prints your nodeId + did for verification
```

Inside Docker:

```bash
docker compose run --rm pc2-node npm run recover-mnemonic
```

Flags:

- `--mnemonic "word1 word2 ..."` — non-interactive; useful for CI. Beware
  your shell history.
- `--force` — overwrite an existing `identity.json` (the old file is
  kept as `identity.json.bak-<timestamp>`, never deleted).

Environment:

- `PC2_DATA_DIR` — override the data directory. Default is
  `pc2-node/data` when run from the repo, `/app/data` inside Docker.

After the CLI finishes, just start the node:

```bash
docker compose up -d
```

BosonService will load the identity on boot and announce to the gateway.
The gateway recognises the returning DID and re-binds your name.

### Option B — HTTP endpoint (during setup wizard)

If the wizard detects no `identity.json` and no `setup-complete` flag,
it exposes:

```http
POST /api/setup/restore-mnemonic
Content-Type: application/json

{ "mnemonic": "word1 word2 word3 ... word24" }
```

Guarantees:

- Rate limited: 5 attempts / 15 min / IP.
- 403 if an identity is already present (deliberately — we never
  overwrite a working node from the network). Use the CLI with
  `--force` for explicit overwrite.
- Phrase stays in RAM, never persisted.

Response:

```json
{
  "success": true,
  "nodeId": "5Ex...t9dR",
  "did": "did:boson:5Ex...t9dR",
  "message": "Identity restored. Restart the node...",
  "needsRestart": true
}
```

### Option C — `.tar.gz` backup

If you kept a snapshot via `npm run backup`, the existing
`POST /api/setup/restore` + `POST /api/setup/restore/finalize` flow
handles everything, including decrypting the `identity.enc` bundle with
your mnemonic. See the wizard UI for the guided path.

---

## 4. What is **not** recovered by the mnemonic

The phrase rebuilds:

- ✅ Identity (nodeId, DID, ed25519 keypair)
- ✅ Access to `yourname.ela.city` on the gateway (via the same DID)

It does **not** rebuild:

- ❌ Your SQLite database (`pc2.db`) — posts, agents, installed apps,
      deal-book history, etc.
- ❌ Your IPFS repo (`data/ipfs/`) — content you self-pinned.
- ❌ Your tethered wallet linkage (re-link via Settings → Wallets).
- ❌ SSL certs from Let's Encrypt (they regenerate on next challenge).

For those you need a real backup (`npm run backup` → `pc2-backups`
volume). The mnemonic is the *identity* backstop, not a filesystem
backup.

---

## 5. How to avoid ever needing this page

1. On first boot, **capture the 24-word phrase** from the setup wizard
   (or the server log). Store it offline.
2. Run `npm run backup` weekly. The compose file now mounts a
   dedicated `pc2-backups` volume so tarballs live separately from
   `pc2-data` — a stray `docker volume rm pc2-node_pc2-data` won't
   take your snapshots with it.
3. Pull backups off the host periodically:
   ```bash
   docker cp pc2-node:/app/backups ./pc2-backups-$(date +%F)
   ```
4. Never run `docker compose down -v` unless you mean to wipe the node.
   The `-v` flag removes **every** named volume including `pc2-data`.

---

## 6. Operational guardrails in 1.2

- `docker-compose.yml` now carries an inline warning block at the top
  spelling out which commands destroy data versus which preserve it,
  and an explicit backup-volume mount.
- `POST /api/setup/restore-mnemonic` is rate-limited and will refuse to
  clobber an existing identity — it can only be used during the fresh
  setup flow.
- `npm run recover-mnemonic` is the only path that overwrites an
  existing `identity.json`, and even then it keeps a timestamped
  `.bak-` copy.

---

## 7. Community response snippet

Drop-in reply for Hellarnasstrom-style questions:

> Yes — v1.2 ships a mnemonic-based identity restore. If you kept your
> 24-word phrase from first setup, run
> `docker compose run --rm pc2-node npm run recover-mnemonic`, paste
> the words, and the node will come back with the same DID (so the
> same `yourname.ela.city` handle). The new docker-compose.yml also
> calls out which commands are destructive vs safe, and adds a
> separate `pc2-backups` volume so snapshots can't be accidentally
> wiped alongside the data volume. Full recovery guide:
> `docs/wiki/Technical/RECOVERY.md`.
>
> If you did not save the phrase, the DID is unrecoverable
> cryptographically — the ela.city handle stays bound to your old
> keypair on the gateway and we'd need to intervene from the
> supernode side to free the name, which we can do on request.

---

## 8. See also

- `pc2-node/src/services/boson/IdentityService.ts` — the source of
  truth for generation and derivation.
- `pc2-node/src/api/setup.ts` — `/restore-mnemonic` plus the full
  backup-tarball restore flow.
- `pc2-node/scripts/recover-mnemonic.js` — the CLI that mirrors the
  endpoint for container-less operation.
- `pc2-node/docker-compose.yml` — now carries the inline
  data-persistence warning block.
