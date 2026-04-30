# PC2 on Windows (WSL2)

> Run your Personal Cloud Computer on Windows via WSL2 (Windows Subsystem for Linux).

## Prerequisites

- **Windows 10** (build 19041+) or **Windows 11**
- **4GB+ RAM** allocated to WSL (8GB recommended)
- **10GB+ free disk space**

## Quick Start

### Step 1: Install WSL2 (One-Time)

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

Restart your computer when prompted. This installs Ubuntu by default.

### Step 2: Install PC2

Open **Ubuntu** from your Start menu, then paste:

```bash
curl -fsSL https://raw.githubusercontent.com/Elacity/pc2.net/main/scripts/install-wsl.sh | bash
```

The script handles everything: Node.js, build tools, transport binaries, and PM2 setup.

### Step 3: Access PC2

Open your Windows browser (Chrome, Edge, Firefox) and go to:

```
http://localhost:4200
```

Connect your wallet and you're done.

---

## Systemd (Recommended)

Systemd enables PM2 to auto-start PC2 when Windows boots (or WSL starts). Without it, you need to open a Ubuntu terminal for PC2 to start.

### Enable Systemd

The install script will offer to enable it. If you skipped that, do it manually:

1. In Ubuntu terminal:

```bash
sudo bash -c 'echo -e "[boot]\nsystemd=true" >> /etc/wsl.conf'
```

2. In PowerShell (Windows):

```powershell
wsl --shutdown
```

3. Reopen Ubuntu. Systemd is now active.

4. Configure PM2 auto-start:

```bash
pm2 startup systemd -u $(whoami) --hp $HOME
pm2 save
```

### Without Systemd

If you can't enable systemd, the install script adds a `.bashrc` hook that starts PM2 processes whenever you open Ubuntu. PC2 will start automatically when you open a terminal, but not when Windows boots unless you open Ubuntu.

---

## WSL Memory Configuration

By default, WSL2 may use up to 50% of your Windows RAM. To control this:

Create or edit `%USERPROFILE%\.wslconfig` (e.g., `C:\Users\YourName\.wslconfig`):

```ini
[wsl2]
memory=4GB
swap=2GB
processors=4
```

Then restart WSL:

```powershell
wsl --shutdown
```

---

## Troubleshooting

### node-pty build fails

This is the most common WSL issue. Fix:

```bash
sudo apt-get install -y build-essential python3
cd ~/pc2.net/pc2-node && npm rebuild
```

### Port 4200 not accessible from Windows

WSL2 should forward `localhost` ports automatically. If not:

1. Check WSL is running: `wsl --list --verbose` in PowerShell
2. Try the WSL IP directly: run `hostname -I` in Ubuntu, use that IP
3. Check Windows Firewall isn't blocking port 4200

### Build fails with "out of memory"

Increase WSL memory in `.wslconfig` (see above) and restart WSL.

### PM2 process not starting after WSL restart

```bash
# Check if PM2 has saved processes
pm2 list

# If empty, re-save
cd ~/pc2.net/pc2-node
pm2 start npm --name "pc2" -- start
pm2 save
```

### WireGuard not working

WSL2 runs its own Linux kernel, so WireGuard kernel module may not be available. PC2 falls back to `wireguard-go` (userspace) automatically. If neither works, PC2 uses relay (slower but functional).

To install transport binaries manually:

```bash
cd ~/pc2.net && bash scripts/fix-networking.sh
```

### "Cannot connect to X display" or GUI errors

PC2 is a web application -- it runs in your Windows browser, not in a Linux GUI. Just open `http://localhost:4200` in Chrome/Edge/Firefox.

---

## Useful Commands

```bash
# View live logs
pm2 logs pc2

# Restart PC2
pm2 restart pc2

# Stop PC2
pm2 stop pc2

# Check status
pm2 status

# Update PC2
cd ~/pc2.net && git pull && cd pc2-node && npm install --legacy-peer-deps --ignore-scripts && npm rebuild && npm run build && pm2 restart pc2

# Complete reinstall
pm2 delete pc2
rm -rf ~/pc2.net
# Then run the install script again
```

---

## Architecture Notes

- PC2 runs as a Node.js process inside WSL2's Linux environment
- Your browser on Windows connects to it via `localhost:4200` (WSL2 port forwarding)
- Files are stored in WSL's Linux filesystem (`~/pc2.net/pc2-node/data/`)
- WireGuard tunnels for remote access (`yourname.ela.city`) work from WSL2
- PM2 manages the process lifecycle (restart on crash, log rotation)
