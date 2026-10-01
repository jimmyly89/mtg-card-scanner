# Deployment — MTG Card Scanner (Proxmox LXC)

This directory contains everything needed to deploy the **MTG Card Scanner**
app inside an existing Proxmox Linux LXC container.

The app is a **Node.js (Express)** server with a **Python** helper layer used
for OCR / neural card scanning. There is **no build step** — "building" means
installing the npm and Python dependencies.

The installer runs **inside the container** as root. It does **not** create the
container or modify the Proxmox host. It uses **native installation (no
Docker)** and does **not** install a MariaDB server — it configures the app to
use your existing external MariaDB.

| File | Purpose |
|------|---------|
| `install.sh` | One-command installer (provisions everything, idempotent). |
| `update.sh` | One-command code update (fetch, deps, restart, verify). |
| `refresh-data.sh` | Manual backend data refresh (SQLite + MariaDB + CollectorVision). |
| `deploy.sh` | Legacy deploy script (kept; prefer `update.sh`). |
| `mtg-card-scanner.service` | systemd unit to run the app as a service. |
| `mtg-card-scanner.cron` | Managed daily data-refresh cron job. |
| `mtg-card-scanner.logrotate` | Log rotation for app + refresh logs. |

---

## Requirements

- An existing **Debian 12 / Ubuntu 22.04+** LXC container (systemd available).
- Root access inside the container.
- An **external MariaDB** server reachable from the container, with a database
  and user already created (see below).
- ~4 GB free disk space and outbound internet access (Scryfall, HuggingFace,
  NodeSource).

---

## First installation

Copy `install.sh` into the container (or clone the repo) and run it as root:

```bash
# Inside the LXC, as root
bash install.sh
```

The installer will:

1. Check root, OS, architecture, disk space, and network access.
2. Install system packages (git, curl, ca-certificates, openssl, Python with
   venv support, cron, tesseract-ocr, native image libraries, logrotate).
3. Install Node.js 20 LTS (NodeSource).
4. Create a dedicated `mtgscanner` service account.
5. Clone the repository into `/opt/mtg-card-scanner`.
6. Install Node deps (`npm ci --omit=dev`).
7. Create a Python virtual environment and install `requirements.txt`.
8. Prompt for the external MariaDB credentials and write them to `.env`.
9. Verify MariaDB connectivity and permissions.
10. Install the systemd service, cron job, and logrotate config.
11. Run the initial data refresh and preload CollectorVision neural assets.
12. Start the app and verify readiness at `/api/health`.

### External MariaDB setup

The installer does **not** create the database or user. On your MariaDB server
(as admin), run:

```sql
CREATE DATABASE IF NOT EXISTS mtg_inventory CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'mtgscanner'@'%' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON mtg_inventory.* TO 'mtgscanner'@'%';
FLUSH PRIVILEGES;
```

Then provide these values when `install.sh` prompts (or via env vars
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).

### Idempotency

Rerunning `install.sh` is safe: it preserves `.env`, `data/`, uploads,
certificates, and existing configuration, and never creates duplicate cron
entries.

---

## Updating code

```bash
sudo /opt/mtg-card-scanner/deploy/update.sh
```

This pulls the latest code, installs dependencies, applies non-destructive
schema migrations (handled by the app on startup), updates managed
service/cron config, restarts the service, and verifies readiness. It refuses
to discard local changes or divergent commits, and records the previous commit
for recovery.

Code updates are **manual by default** — the cron job only refreshes data.

---

## Manual data refresh

```bash
sudo -u mtgscanner /opt/mtg-card-scanner/deploy/refresh-data.sh
```

This refreshes three independent sources:

| Data | Behaviour |
|------|-----------|
| SQLite card catalog (`data/mtg_cards.db`) | Adds new cards, updates metadata + prices (preserves scan hashes). |
| MariaDB `tbl_card` | Refreshes card reference data used by inventory/export queries. |
| CollectorVision catalog/models | Refreshes the MTG embedding catalog + neural models. |

Scryfall and CollectorVision are refreshed **independently** — refreshing
Scryfall does **not** update neural embeddings. The script shares one
`default-cards.json` download between the SQLite and MariaDB importers, uses
staging files so a failed download keeps prior data usable, and records
`last_attempt` / `last_success` / `last_source_version` / counts / errors in
`data/refresh_state.json`.

It never modifies user inventory, sessions, orders, purchase costs, or
historical sale values.

---

## Viewing logs

```bash
# Service logs
journalctl -u mtg-card-scanner -f

# Data refresh logs
tail -f /opt/mtg-card-scanner/data/logs/refresh.log

# Deployment/update logs
tail -f /var/log/mtg-card-scanner-deploy.log

# Installer log
tail -f /var/log/mtg-card-scanner-install.log
```

---

## Changing the refresh schedule

The default schedule is **daily at 03:00** in the container's local time.

1. Edit `REFRESH_SCHEDULE` in `/opt/mtg-card-scanner/.env` (a cron expression,
   e.g. `30 2 * * *` for 02:30 daily).
2. Re-run `install.sh` (or `update.sh`) to rewrite `/etc/cron.d/mtg-card-scanner`.

### Timezone (Australia/Sydney)

The cron schedule follows the **container's local time**. To make it follow
Sydney time including daylight saving, set the container timezone explicitly:

```bash
timedatectl set-timezone Australia/Sydney
```

If `timedatectl` is unavailable in the LXC, uncomment `TZ=Australia/Sydney` in
`/etc/cron.d/mtg-card-scanner` (the cron environment variable). Verify with:

```bash
date
```

---

## Backup, restore, and failed-update recovery

### Backup

The following are the only persistent state you need to back up:

```bash
# Stop the service for a consistent snapshot (optional)
systemctl stop mtg-card-scanner

# Back up config + data + certs
tar czf mtg-backup.tar.gz \
    -C /opt/mtg-card-scanner \
    .env data uploads .certs .collectorvision-cache

systemctl start mtg-card-scanner
```

### Restore

```bash
systemctl stop mtg-card-scanner
tar xzf mtg-backup.tar.gz -C /opt/mtg-card-scanner
chown -R mtgscanner:mtgscanner /opt/mtg-card-scanner
systemctl start mtg-card-scanner
```

### Failed-update recovery

`update.sh` records the previous commit in `data/.deploy-state`
(`previous_sha`). To roll back after a failed update:

```bash
cd /opt/mtg-card-scanner
git reset --hard <previous_sha>
sudo -u mtgscanner npm ci --omit=dev
sudo -u mtgscanner .venv/bin/pip install -r requirements.txt
systemctl restart mtg-card-scanner
```

If dependency installation fails, `update.sh` leaves the working server
running and prints the exact rollback commands.

---

## HTTPS and phone-camera access

The app serves both HTTP (`PORT`, default 3000) and HTTPS (`HTTPS_PORT`,
default 3443). HTTPS uses a **self-signed certificate** generated on first
start into `.certs/`.

### Trusting the self-signed certificate on a phone

1. Find the container's IP: `hostname -I`.
2. Open `https://<container-ip>:3443` on the phone.
3. The browser will warn about the self-signed cert. Tap **Advanced →
   Proceed** (Chrome) or **Show Details → Visit website** (Safari).

For a trusted certificate matching your hostname/IP, replace the self-signed
cert with one from a CA (e.g. Let's Encrypt via `certbot`, or an internal CA):

```bash
# Example: place a CA-issued cert/key at
#   /opt/mtg-card-scanner/.certs/server.cert
#   /opt/mtg-card-scanner/.certs/server.key
# then restart the service
systemctl restart mtg-card-scanner
```

The certificate must match the hostname/IP you use on the phone. If you use a
custom CA, install its root certificate on the phone (Settings → Certificates)
so the browser trusts it without warnings.

---

## Ports

Ports are configurable via `.env`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP |
| `HTTPS_PORT` | `3443` | HTTPS (phone camera) |

---

## Verification checklist

- [ ] `bash install.sh` in a clean LXC → app up, `/api/health` returns 200.
- [ ] A second `install.sh` run preserves `.env`/data/uploads and adds no
      duplicate cron entries.
- [ ] After a container reboot, the service auto-starts and `/api/health`
      returns 200.
- [ ] `refresh-data.sh` updates an existing card's price and adds new cards.
- [ ] A failed download leaves existing data usable.
- [ ] Concurrent refresh/update attempts are handled safely (flock).
- [ ] `update.sh` preserves inventory and restarts successfully.

> Note: LXC and phone-camera tests are only claimed here if they were actually
> performed in your environment.
