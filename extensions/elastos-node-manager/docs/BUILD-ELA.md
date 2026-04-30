# Build the ELA binary (one-time, ~5 minutes)

The Node Manager runs a pre-built `ela` binary that you compile yourself from the official Elastos source. We do not ship a pre-built binary in v0.1 — you keep full control of provenance.

These steps are run **once** on the same Ubuntu/Debian machine where PC2 is running.

## Prerequisites

- Ubuntu 22.04+ (or Debian 11+) — the same OS PC2 runs on
- ~2 GB free disk for the build artifacts
- Internet (just to clone the repo and pull Go modules)

## Steps

```bash
# 1. Install build deps (one-time)
sudo apt update
sudo apt install -y golang-go git make

# 2. Verify Go version is 1.20+ (Elastos.ELA requirement)
go version

# 3. Clone the official source and pin a known-good tag
git clone https://github.com/elastos/Elastos.ELA.git ~/Elastos.ELA
cd ~/Elastos.ELA
git checkout v0.9.9.5      # or the tag you want; latest stable is recommended

# 4. Build (~5 min on a modern CPU)
make all

# 5. Confirm
./ela --version
./ela-cli --version
```

You now have two binaries:

- `~/Elastos.ELA/ela` — the chain node
- `~/Elastos.ELA/ela-cli` — the wallet/admin CLI

## Tell the Node Manager where the binary is

In the Node Manager setup wizard, step 4 ("Locate ELA binary"):

- Paste `/home/<your-username>/Elastos.ELA/ela` (or wherever you cloned it)
- The Node Manager will run `./ela --version` to confirm it's executable, and stash the path in its config

That's it. The binary stays where you built it. The Node Manager just points at it via `child_process.spawn`. You can move it later — just update the path in Settings.

## Updating to a new ELA version

```bash
cd ~/Elastos.ELA
git fetch --tags
git checkout v0.9.9.6        # whatever the new stable tag is
make all
./ela --version              # confirm new version
```

Then in the Node Manager → Settings → Binary, click **Re-verify**. The Node Manager will detect the new version and offer to restart the running node with it (an OWNER-CONFIRMS healing event). It does **not** auto-update — you choose when.

## Why we don't pre-build binaries (yet)

- We never edit the upstream `Elastos.ELA` repository (your operator policy)
- v0.1 is a local-only build; we don't host binaries on a CDN
- Operators want full provenance — building yourself means you trust only the upstream source
- v0.2 may add an opt-in binary mirror under the `elacity` namespace (separate repo, never modifies `Elastos.ELA`)

## Troubleshooting

**`make: command not found`** → `sudo apt install make`.

**`go: command not found` after `apt install golang-go`** → close and reopen your shell, or run `source /etc/profile`.

**`/usr/lib/go-1.18: too old` (Go version error)** → Ubuntu 20.04 ships Go 1.18, which is below ELA's minimum. Install Go 1.21 from the [official tarball](https://go.dev/dl/):

```bash
sudo rm -rf /usr/local/go
wget -O - https://go.dev/dl/go1.21.13.linux-amd64.tar.gz | sudo tar -xz -C /usr/local
echo 'export PATH=/usr/local/go/bin:$PATH' >> ~/.profile
source ~/.profile
go version
```

**Build fails with network errors** → Go module proxy can be slow on first run. Retry, or set `GOPROXY=https://goproxy.cn,direct` if you're in mainland China.

**`./ela: cannot execute binary file`** → wrong architecture. Check `uname -m` matches the build target (amd64 vs arm64).
