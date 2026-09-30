# Deployment — MTG Card Scanner (Proxmox LXC)

This directory contains everything needed to deploy the **MTG Card Scanner**
app inside a Proxmox Linux LXC container.

The app is a **Node.js (Express)** server with a **Python** helper layer used
for OCR / neural card scanning. There is **no build step** — "building" means
installing the npm and Python dependencies.

| File | Purpose |
|------|---------|
| `deploy.sh` | Main deployment script (fetch, install, restart, verify). |
| `mtg-card-scanner.service` | systemd unit to run the app as a service. |

---

## What the deploy script does

1. **Locks** against overlapping runs with `flock`.
2. **Fetches** the current tracking branch (`origin/main` by default).
3. **Refuses to overwrite** local (uncommitted) changes — exits with code 2.
4. **Fast-forwards** to the remote commit (refuses if local commits diverge).
5. **Installs** npm deps (`npm ci`) and Python deps (`pip install`).
6. **Restarts** the app via the `mtg-card-scanner` systemd service.
7. **Verifies** the app responds on HTTP port 3000.
8. **Records** the deployed commit + status in `data/.deploy-state`.

### What is preserved

The following are **gitignored** and are never touched by the script:

- `.env` — secrets / configuration
- `data/` — SQLite DB (`mtg_cards.db`), card images, build status, uploads
- `uploads/` — uploaded scan images
- `.certs/` — self-signed HTTPS certificates (regenerated automatically)
- `node_modules/` — reinstalled from `package-lock.json`

---

## First-time setup (run once, as root)

```bash
# 1. Install system packages
apt update
apt install -y git curl ca-certificates gnupg \
    build-essential python3 python3-pip python3-venv \
    openssl

# 2. Install Node.js 20.x (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 3. Create a dedicated system user
useradd --system --home /opt/mtg-card-scanner --shell /usr/sbin/nologin mtgscanner

# 4. Clone the repository
git clone https://github.com/jimmyly89/mtg-card-scanner.git /opt/mtg-card-scanner
cd /opt/mtg-card-scanner

# 5. Create the .env file (gitignored, holds secrets)
cp .env.example .env
#    Edit .env to set PORT, NODE_ENV, and any credentials.

# 6. Create persistent data directories and set ownership
mkdir -p data/uploads data/card_images .certs
chown -R mtgscanner:mtgscanner /opt/mtg-card-scanner

# 7. Install the systemd service
cp deploy/mtg-card-scanner.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mtg-card-scanner

# 8. Run the first deployment (installs npm + Python deps, starts, verifies)
sudo -u mtgscanner bash deploy/deploy.sh --force
```

> **Note on the database:** the app connects to a **MariaDB** instance at
> `192.168.4.37` (see `db.js`). That host must be reachable from the LXC
> container. The local SQLite DB (`data/mtg_cards.db`) is built separately via
> `scripts/db_builder.py` and is preserved across deploys.

---

## Usage

```bash
# Full deployment (fetch, install, restart, verify)
sudo -u mtgscanner bash deploy/deploy.sh

# Force a rebuild even if the commit is unchanged
sudo -u mtgscanner bash deploy/deploy.sh --force

# Scheduled check: only rebuild if the remote commit changed OR the last
# deployment failed. Exits 4 when already up to date.
sudo -u mtgscanner bash deploy/deploy.sh --check

# Skip the post-deploy health check
sudo -u mtgscanner bash deploy/deploy.sh --no-verify
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic failure (e.g. health check failed) |
| 2 | Local changes present — refusing to overwrite |
| 3 | Another deployment is already running |
| 4 | Already up to date (only in `--check` mode) |

---

## Scheduled checks (cron)

Add this to the `mtgscanner` user's crontab to check every 15 minutes. It
skips rebuilding when the deployed commit already matches GitHub, but retries
if the previous deployment failed.

```bash
# As root:
crontab -u mtgscanner -e
```

```cron
# Check for updates every 15 minutes; deploy only when needed.
*/15 * * * * /opt/mtg-card-scanner/deploy/deploy.sh --check >> /var/log/mtg-card-scanner-deploy.log 2>&1
```

> The script uses `flock`, so overlapping cron runs are safe. If a deployment
> fails, `last_status=failed` is recorded and the next `--check` run retries.

---

## Manual service control

```bash
systemctl status mtg-card-scanner
systemctl restart mtg-card-scanner
journalctl -u mtg-card-scanner -f
```

## Health check

The script verifies the app by requesting `http://127.0.0.1:3000/` (the app
serves `public/index.html`). Override with `HEALTH_URL` if needed:

```bash
HEALTH_URL=http://127.0.0.1:3000/api/sessions bash deploy/deploy.sh
```
