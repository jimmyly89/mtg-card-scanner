#!/usr/bin/env bash
#
# install.sh — one-command installer for the MTG Card Scanner inside an
# existing Debian/Ubuntu Proxmox LXC container.
#
# This script runs INSIDE the container as root. It does NOT create the
# container or modify the Proxmox host. It uses native installation (no Docker)
# and does NOT install a MariaDB server — it configures the app to use your
# existing external MariaDB.
#
# Idempotent: rerunning it preserves credentials (.env), databases (data/),
# inventory, uploads, certificates, and existing configuration, and never
# creates duplicate cron entries.
#
# Works when downloaded separately from the repository: it installs Git before
# attempting to clone.
#
# Usage:
#   bash install.sh
#
# Optional environment overrides:
#   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD  (skip interactive prompt)
#   NODE_MAJOR=20                                     (Node.js LTS major)
#   REFRESH_SCHEDULE="0 3 * * *"                      (cron schedule)
#   APP_DIR=/opt/mtg-card-scanner                     (install location)
#   REPO_URL=https://github.com/jimmyly89/mtg-card-scanner.git
#   REPO_BRANCH=main
#
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
APP_DIR="${APP_DIR:-/opt/mtg-card-scanner}"
REPO_URL="${REPO_URL:-https://github.com/jimmyly89/mtg-card-scanner.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_NAME="mtg-card-scanner"
SERVICE_USER="mtgscanner"
SERVICE_GROUP="mtgscanner"
ENV_FILE="${APP_DIR}/.env"
CRON_FILE="/etc/cron.d/mtg-card-scanner"
LOGROTATE_FILE="/etc/logrotate.d/mtg-card-scanner"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LOG_FILE="/var/log/mtg-card-scanner-install.log"
HEALTH_URL="http://127.0.0.1:${PORT:-3000}/api/health"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"

# ── Helpers ─────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "${LOG_FILE}"; }
die()  { log "ERROR: $*" >&2; exit 1; }

# ── Preflight: root ─────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: install.sh must be run as root (inside the LXC container)." >&2
    echo "  sudo bash install.sh" >&2
    exit 1
fi

mkdir -p "$(dirname "${LOG_FILE}")"
log "=== MTG Card Scanner installer starting ==="

# ── Preflight: OS / architecture ────────────────────────────────────────────
if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
else
    die "Cannot determine OS (/etc/os-release missing). Only Debian/Ubuntu are supported."
fi
case "${ID:-}" in
    debian|ubuntu) : ;;
    *) die "Unsupported OS '${ID:-unknown}'. Only Debian/Ubuntu are supported." ;;
esac
log "Detected OS: ${PRETTY_NAME:-${ID} ${VERSION_ID}}"

ARCH="$(uname -m)"
case "${ARCH}" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "Unsupported architecture: ${ARCH}" ;;
esac
log "Architecture: ${ARCH}"

# ── Preflight: disk space (need ~4 GB for catalog + models + deps) ─────────
AVAIL_KB="$(df -Pk /opt 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ -n "${AVAIL_KB}" && "${AVAIL_KB}" -lt 4194304 ]]; then
    die "Insufficient disk space on /opt (${AVAIL_KB} KB available; need >= 4 GB)."
fi
log "Disk space OK (${AVAIL_KB} KB available on /opt)."

# ── Preflight: network access ───────────────────────────────────────────────
log "Checking network access..."
if ! curl -fsS --max-time 15 -o /dev/null https://api.scryfall.com/bulk-data 2>/dev/null; then
    log "WARNING: cannot reach api.scryfall.com. Installation will continue, but the"
    log "         initial data refresh may fail. Check connectivity and re-run refresh-data.sh."
fi

# ── Install system packages ─────────────────────────────────────────────────
log "Updating package lists..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >> "${LOG_FILE}" 2>&1 || die "apt-get update failed"

log "Installing system packages (git, curl, certs, openssl, python, cron, native libs)..."
apt-get install -y --no-install-recommends \
    git curl ca-certificates gnupg openssl \
    build-essential \
    python3 python3-pip python3-venv \
    cron logrotate \
    tesseract-ocr \
    libgl1 libglib2.0-0 \
    >> "${LOG_FILE}" 2>&1 || die "Failed to install system packages"

# ── Install Node.js LTS ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | sed 's/v//; s/\..*//')" != "${NODE_MAJOR}" ]]; then
    log "Installing Node.js ${NODE_MAJOR} LTS (NodeSource)..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >> "${LOG_FILE}" 2>&1 \
        || die "Failed to add NodeSource repository"
    apt-get install -y nodejs >> "${LOG_FILE}" 2>&1 || die "Failed to install Node.js"
fi
log "Node.js version: $(node -v)"

# ── Create the service account ──────────────────────────────────────────────
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    log "Creating system user '${SERVICE_USER}'..."
    useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}" \
        || die "Failed to create user '${SERVICE_USER}'"
else
    log "User '${SERVICE_USER}' already exists."
fi

# ── Clone / update the repository ───────────────────────────────────────────
if [[ ! -d "${APP_DIR}/.git" ]]; then
    log "Cloning repository into ${APP_DIR}..."
    mkdir -p "$(dirname "${APP_DIR}")"
    git clone --branch "${REPO_BRANCH}" "${REPO_URL}" "${APP_DIR}" >> "${LOG_FILE}" 2>&1 \
        || die "Failed to clone repository"
else
    log "Repository already present at ${APP_DIR}; fetching latest ${REPO_BRANCH}..."
    git -C "${APP_DIR}" fetch origin "${REPO_BRANCH}" >> "${LOG_FILE}" 2>&1 || true
    git -C "${APP_DIR}" checkout "${REPO_BRANCH}" >> "${LOG_FILE}" 2>&1 || true
    git -C "${APP_DIR}" merge --ff-only "origin/${REPO_BRANCH}" >> "${LOG_FILE}" 2>&1 || true
fi

# ── Create persistent data directories ──────────────────────────────────────
log "Creating persistent data directories..."
mkdir -p "${APP_DIR}/data/uploads" \
         "${APP_DIR}/data/card_images" \
         "${APP_DIR}/data/logs" \
         "${APP_DIR}/uploads" \
         "${APP_DIR}/.certs" \
         "${APP_DIR}/.collectorvision-cache"

# ── Configure .env (preserve existing) ──────────────────────────────────────
if [[ ! -f "${ENV_FILE}" ]]; then
    log "Creating .env from .env.example..."
    cp "${APP_DIR}/.env.example" "${ENV_FILE}"
fi

# Load existing values so we don't clobber them on re-run.
# Parse .env safely line-by-line (never `source` it directly — values like
# REFRESH_SCHEDULE="0 3 * * *" contain shell metacharacters that would break
# sourcing). Only simple KEY=VALUE lines are honoured; surrounding quotes are
# stripped.
while IFS='=' read -r _key _val; do
    _key="${_key//[[:space:]]/}"
    _val="${_val%\"}"; _val="${_val#\"}"
    if [[ -n "${_key}" && "${_key}" != \#* ]]; then
        export "${_key}=${_val}"
    fi
done < "${ENV_FILE}"

# Prompt for DB credentials only if not already set.
prompt_value() {
    local var="$1" label="$2" current="${3:-}" secret="${4:-0}"
    if [[ -n "${current}" ]]; then
        echo "${current}"
        return
    fi
    local val=""
    if [[ "${secret}" -eq 1 ]]; then
        read -r -s -p "${label}: " val; echo
    else
        read -r -p "${label} [${current}]: " val
        val="${val:-${current}}"
    fi
    echo "${val}"
}

DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-mtg_inventory}"
DB_USER="${DB_USER:-mtgscanner}"
DB_PASSWORD="${DB_PASSWORD:-}"

if [[ -z "${DB_HOST}" ]]; then
    echo ""
    echo "── External MariaDB configuration ──────────────────────────────"
    echo "Point the app at your EXISTING MariaDB server (not installed here)."
    DB_HOST="$(prompt_value DB_HOST "MariaDB host" "${DB_HOST}")"
    DB_PORT="$(prompt_value DB_PORT "MariaDB port" "${DB_PORT}")"
    DB_NAME="$(prompt_value DB_NAME "Database name" "${DB_NAME}")"
    DB_USER="$(prompt_value DB_USER "Database user" "${DB_USER}")"
    DB_PASSWORD="$(prompt_value DB_PASSWORD "Database password" "${DB_PASSWORD}" 1)"
fi

# Export the DB values so the Python .env writer below can read them.
export DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD

# Write/update .env (preserving other keys).
log "Writing configuration to .env..."
python3 - "${ENV_FILE}" <<'PY'
import os, sys
path = sys.argv[1]
updates = {
    "DB_HOST": os.environ.get("DB_HOST", ""),
    "DB_PORT": os.environ.get("DB_PORT", "3306"),
    "DB_NAME": os.environ.get("DB_NAME", "mtg_inventory"),
    "DB_USER": os.environ.get("DB_USER", "mtgscanner"),
    "DB_PASSWORD": os.environ.get("DB_PASSWORD", ""),
    "PYTHON_INTERPRETER": os.environ.get("PYTHON_INTERPRETER", "/opt/mtg-card-scanner/.venv/bin/python"),
    "COLLECTORVISION_CACHE": os.environ.get("COLLECTORVISION_CACHE", "/opt/mtg-card-scanner/.collectorvision-cache"),
    "PORT": os.environ.get("PORT", "3000"),
    "HTTPS_PORT": os.environ.get("HTTPS_PORT", "3443"),
    "NODE_ENV": os.environ.get("NODE_ENV", "production"),
    "REFRESH_SCHEDULE": os.environ.get("REFRESH_SCHEDULE", "0 3 * * *"),
}
# Values that contain spaces / shell metacharacters must be quoted so the
# .env file can be safely sourced by the shell scripts.
def fmt(key, val):
    if any(ch in val for ch in " *?[]{}|&;<>()$`\"'\\\t\n"):
        return f'{key}="{val}"'
    return f"{key}={val}"

lines = []
seen = set()
if os.path.exists(path):
    for raw in open(path, encoding="utf-8"):
        line = raw.rstrip("\n")
        if line.strip() and not line.strip().startswith("#") and "=" in line:
            key = line.split("=", 1)[0].strip()
            if key in updates:
                seen.add(key)
                lines.append(fmt(key, updates[key]))
                continue
        lines.append(line)
for key, val in updates.items():
    if key not in seen:
        lines.append(fmt(key, val))
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
chmod 600 "${ENV_FILE}"
chown "${SERVICE_USER}:${SERVICE_GROUP}" "${ENV_FILE}"

# ── Install Node dependencies ───────────────────────────────────────────────
log "Installing Node dependencies (npm ci --omit=dev)..."
cd "${APP_DIR}"
npm ci --omit=dev --no-audit --no-fund >> "${LOG_FILE}" 2>&1 || die "npm ci failed"

# ── Create Python virtual environment + install deps ────────────────────────
log "Creating Python virtual environment..."
if [[ ! -x "${APP_DIR}/.venv/bin/python" ]]; then
    python3 -m venv "${APP_DIR}/.venv" >> "${LOG_FILE}" 2>&1 || die "Failed to create venv"
fi
log "Installing Python dependencies from requirements.txt..."
"${APP_DIR}/.venv/bin/pip" install --upgrade pip >> "${LOG_FILE}" 2>&1 || true
"${APP_DIR}/.venv/bin/pip" install --no-cache-dir -r "${APP_DIR}/requirements.txt" >> "${LOG_FILE}" 2>&1 \
    || die "Failed to install Python dependencies"

# ── Verify DB connectivity + permissions (using the venv's mysql client) ────
log "Verifying MariaDB connectivity and permissions..."
if ! "${APP_DIR}/.venv/bin/python" - "${ENV_FILE}" <<'PY'
import sys
env = {}
for raw in open(sys.argv[1], encoding="utf-8"):
    line = raw.strip()
    if line and not line.startswith("#") and "=" in line:
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
import mysql.connector
try:
    conn = mysql.connector.connect(
        host=env.get("DB_HOST", "127.0.0.1"),
        port=int(env.get("DB_PORT", "3306")),
        user=env.get("DB_USER", "mtgscanner"),
        password=env.get("DB_PASSWORD", ""),
        database=env.get("DB_NAME", "mtg_inventory"),
        connection_timeout=10,
    )
    cur = conn.cursor()
    cur.execute("SELECT 1")
    cur.fetchone()
    conn.close()
    print("MariaDB connectivity OK.")
except Exception as e:
    print(f"ERROR: MariaDB connection failed: {e}")
    print("")
    print("Setup instructions:")
    print(f"  1. Ensure a MariaDB server is reachable at {env.get('DB_HOST','127.0.0.1')}:{env.get('DB_PORT','3306')}.")
    print(f"  2. Create the database and user (run on the MariaDB server as admin):")
    print(f"       CREATE DATABASE IF NOT EXISTS {env.get('DB_NAME','mtg_inventory')} CHARACTER SET utf8mb4;")
    print(f"       CREATE USER IF NOT EXISTS '{env.get('DB_USER','mtgscanner')}'@'%' IDENTIFIED BY '<password>';")
    print(f"       GRANT ALL PRIVILEGES ON {env.get('DB_NAME','mtg_inventory')}.* TO '{env.get('DB_USER','mtgscanner')}'@'%';")
    print(f"       FLUSH PRIVILEGES;")
    print(f"  3. Re-run: bash install.sh")
    sys.exit(1)
PY
then
    die "Database verification failed. See instructions above."
fi

# ── Set ownership ───────────────────────────────────────────────────────────
log "Setting ownership on ${APP_DIR}..."
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}"

# ── Install systemd service ─────────────────────────────────────────────────
log "Installing systemd service..."
cp "${APP_DIR}/deploy/mtg-card-scanner.service" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >> "${LOG_FILE}" 2>&1 || die "Failed to enable service"

# ── Install cron job (idempotent — no duplicates) ───────────────────────────
log "Installing cron job..."
# Extract REFRESH_SCHEDULE from .env, stripping any surrounding quotes.
REFRESH_SCHEDULE="${REFRESH_SCHEDULE:-$(grep -E '^REFRESH_SCHEDULE=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '"' || echo '0 3 * * *')}"
# Rewrite the schedule line in the cron template.
sed "s|^0 3 \* \* \* mtgscanner|${REFRESH_SCHEDULE} mtgscanner|" \
    "${APP_DIR}/deploy/mtg-card-scanner.cron" > "${CRON_FILE}"
chmod 644 "${CRON_FILE}"
# Ensure cron is running.
if command -v systemctl >/dev/null 2>&1; then
    systemctl enable cron >> "${LOG_FILE}" 2>&1 || true
    systemctl restart cron >> "${LOG_FILE}" 2>&1 || true
fi
log "Cron job installed at ${CRON_FILE} (schedule: ${REFRESH_SCHEDULE})."

# ── Install logrotate ───────────────────────────────────────────────────────
log "Installing logrotate config..."
cp "${APP_DIR}/deploy/mtg-card-scanner.logrotate" "${LOGROTATE_FILE}"
chmod 644 "${LOGROTATE_FILE}"

# ── Run initial data refresh + preload models (as service user) ─────────────
log "Running initial data refresh (this downloads the card catalog; may take a while)..."
if sudo -u "${SERVICE_USER}" bash "${APP_DIR}/deploy/refresh-data.sh"; then
    log "Initial data refresh completed."
else
    log "WARNING: initial data refresh did not fully succeed. The app will still start;"
    log "         re-run: sudo -u ${SERVICE_USER} ${APP_DIR}/deploy/refresh-data.sh"
fi

log "Preloading CollectorVision neural assets as ${SERVICE_USER}..."
sudo -u "${SERVICE_USER}" "${APP_DIR}/.venv/bin/python" "${APP_DIR}/scripts/preload_models.py" \
    >> "${LOG_FILE}" 2>&1 || log "WARNING: model preload failed (first scan may download models)."

# ── Start the service ───────────────────────────────────────────────────────
log "Starting ${SERVICE_NAME} service..."
systemctl restart "${SERVICE_NAME}" >> "${LOG_FILE}" 2>&1 || die "Failed to start service"

# ── Verify readiness ────────────────────────────────────────────────────────
PORT="$(grep -E '^PORT=' "${ENV_FILE}" | cut -d= -f2- || echo 3000)"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
log "Waiting for app readiness at ${HEALTH_URL}..."
elapsed=0
ok=0
while [[ "${elapsed}" -lt "${HEALTH_TIMEOUT}" ]]; do
    if curl -fsS -o /dev/null --max-time 5 "${HEALTH_URL}" 2>/dev/null; then
        ok=1
        break
    fi
    sleep "${HEALTH_INTERVAL}"
    elapsed=$((elapsed + HEALTH_INTERVAL))
done

if [[ "${ok}" -eq 1 ]]; then
    log "Application is ready."
else
    log "WARNING: app did not become ready within ${HEALTH_TIMEOUT}s."
    log "         Check: journalctl -u ${SERVICE_NAME} -n 50"
fi

# ── Print summary ───────────────────────────────────────────────────────────
HTTPS_PORT="$(grep -E '^HTTPS_PORT=' "${ENV_FILE}" | cut -d= -f2- || echo 3443)"
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "  MTG Card Scanner installation complete"
echo "══════════════════════════════════════════════════════════════════"
echo ""
echo "  Application URLs:"
echo "    HTTP : http://${HOST_IP:-<container-ip>}:${PORT}"
echo "    HTTPS: https://${HOST_IP:-<container-ip>}:${HTTPS_PORT}  (self-signed cert)"
echo ""
echo "  Maintenance commands:"
echo "    Update code        : sudo ${APP_DIR}/deploy/update.sh"
echo "    Manual data refresh: sudo -u ${SERVICE_USER} ${APP_DIR}/deploy/refresh-data.sh"
echo "    Service status     : systemctl status ${SERVICE_NAME}"
echo "    Service logs       : journalctl -u ${SERVICE_NAME} -f"
echo "    Refresh logs       : tail -f ${APP_DIR}/data/logs/refresh.log"
echo "    Change schedule    : edit REFRESH_SCHEDULE in ${ENV_FILE}, then re-run install.sh"
echo ""
echo "  For HTTPS/phone-camera trust and backup/restore, see deploy/README.md"
echo "══════════════════════════════════════════════════════════════════"
log "=== Installer finished ==="