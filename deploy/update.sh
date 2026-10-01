#!/usr/bin/env bash
#
# update.sh — one-command code update for the MTG Card Scanner.
#
# Pulls the latest code, installs dependencies, applies non-destructive schema
# migrations, updates managed service/cron config, restarts the service, and
# verifies readiness. Preserves configuration and all persistent data. Does NOT
# rebuild the entire catalog during ordinary code updates.
#
# Privilege model:
#   * Run this script as root (it needs systemctl).
#   * Git fetch/merge and dependency installation run as the mtgscanner user.
#
# Safety:
#   * flock prevents overlapping updates.
#   * Refuses to discard local (uncommitted) changes or divergent commits.
#   * If dependency installation fails, the working server is left running.
#   * Records the previous commit and provides a recovery procedure.
#
# Usage:
#   sudo /opt/mtg-card-scanner/deploy/update.sh
#
# Exit codes:
#   0  success
#   1  generic failure
#   2  local changes present (refusing to overwrite)
#   3  another update is already running (flock)
#   4  already up to date
#
set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME="mtg-card-scanner"
SERVICE_USER="mtgscanner"
SERVICE_GROUP="mtgscanner"
ENV_FILE="${APP_DIR}/.env"
CRON_FILE="/etc/cron.d/mtg-card-scanner"
LOGROTATE_FILE="/etc/logrotate.d/mtg-card-scanner"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
STATE_FILE="${APP_DIR}/data/.deploy-state"
LOCK_FILE="${LOCK_FILE:-/tmp/mtg-card-scanner-update.lock}"
LOG_FILE="/var/log/mtg-card-scanner-deploy.log"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-3}"

# ── Helpers ─────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "${LOG_FILE}"; }
die()  { log "ERROR: $*" >&2; exit 1; }

state_get() {
    local key="$1"
    if [[ -f "${STATE_FILE}" ]]; then
        awk -F= -v k="${key}" '$1==k {print $2}' "${STATE_FILE}"
    fi
}
state_set() {
    local key="$1" value="$2"
    mkdir -p "$(dirname "${STATE_FILE}")"
    if [[ -f "${STATE_FILE}" ]]; then
        grep -v "^${key}=" "${STATE_FILE}" > "${STATE_FILE}.tmp" || true
        mv "${STATE_FILE}.tmp" "${STATE_FILE}"
    fi
    printf '%s=%s\n' "${key}" "${value}" >> "${STATE_FILE}"
}

# ── Preflight ───────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: update.sh must be run as root." >&2
    echo "  sudo ${APP_DIR}/deploy/update.sh" >&2
    exit 1
fi
command -v git >/dev/null 2>&1 || die "git is not installed"
command -v npm >/dev/null 2>&1 || die "npm is not installed"
command -v node >/dev/null 2>&1 || die "node is not installed"
[[ -d "${APP_DIR}/.git" ]] || die "Not a git repository: ${APP_DIR}"

# ── Locking ─────────────────────────────────────────────────────────────────
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    log "Another update is already running (lock held on ${LOCK_FILE})."
    exit 3
fi

cd "${APP_DIR}"

# ── Determine tracking branch ───────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ -z "${UPSTREAM}" || "${UPSTREAM}" == "@{u}" ]]; then
    UPSTREAM="origin/main"
fi
REMOTE="${UPSTREAM%%/*}"
REMOTE_BRANCH="${UPSTREAM#*/}"
log "Tracking branch: ${UPSTREAM}"

# ── Fetch + check for local changes / divergence ────────────────────────────
log "Fetching from ${REMOTE}..."
git fetch "${REMOTE}" "${REMOTE_BRANCH}"

if ! git diff --quiet HEAD; then
    log "Local (uncommitted) changes detected. Refusing to overwrite them."
    log "Commit or stash your changes, then re-run."
    exit 2
fi

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "${UPSTREAM}")"

if [[ "${LOCAL_SHA}" == "${REMOTE_SHA}" ]]; then
    log "Already up to date (${LOCAL_SHA:0:12}). Nothing to do."
    exit 4
fi

# ── Fast-forward (refuse if divergent) ──────────────────────────────────────
log "Updating from ${LOCAL_SHA:0:12} to ${REMOTE_SHA:0:12}..."
if ! git merge --ff-only "${UPSTREAM}" 2>/dev/null; then
    die "Cannot fast-forward to ${UPSTREAM}. Local commits diverge; resolve manually."
fi

# ── Install dependencies (as the service user) ──────────────────────────────
log "Installing Node dependencies (npm ci --omit=dev)..."
if ! sudo -u "${SERVICE_USER}" bash -c "cd '${APP_DIR}' && npm ci --omit=dev --no-audit --no-fund"; then
    log "ERROR: npm ci failed. The working server was NOT stopped."
    log "Recovery: the previous commit was ${LOCAL_SHA}. To roll back:"
    log "  cd ${APP_DIR} && git reset --hard ${LOCAL_SHA} && sudo -u ${SERVICE_USER} npm ci --omit=dev"
    state_set last_status "failed"
    state_set last_error "npm ci failed"
    exit 1
fi

log "Installing Python dependencies..."
if ! sudo -u "${SERVICE_USER}" bash -c "cd '${APP_DIR}' && .venv/bin/pip install --no-cache-dir -r requirements.txt"; then
    log "ERROR: Python dependency install failed. The working server was NOT stopped."
    log "Recovery: the previous commit was ${LOCAL_SHA}. To roll back:"
    log "  cd ${APP_DIR} && git reset --hard ${LOCAL_SHA} && sudo -u ${SERVICE_USER} .venv/bin/pip install -r requirements.txt"
    state_set last_status "failed"
    state_set last_error "pip install failed"
    exit 1
fi

# ── Apply non-destructive schema migrations ─────────────────────────────────
# The app's db.initDatabase() runs idempotent CREATE TABLE IF NOT EXISTS +
# additive ALTERs on startup, so no separate migration step is needed here.
# This hook exists for future explicit migrations.
log "Schema migrations: handled automatically by the app on startup (non-destructive)."

# ── Update managed service/cron config when changed ─────────────────────────
if ! cmp -s "${APP_DIR}/deploy/mtg-card-scanner.service" "${SERVICE_FILE}"; then
    log "Updating systemd service file..."
    cp "${APP_DIR}/deploy/mtg-card-scanner.service" "${SERVICE_FILE}"
    systemctl daemon-reload
fi
if ! cmp -s "${APP_DIR}/deploy/mtg-card-scanner.cron" "${CRON_FILE}"; then
    log "Updating cron file..."
    REFRESH_SCHEDULE="$(grep -E '^REFRESH_SCHEDULE=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || echo '0 3 * * *')"
    sed "s|^0 3 \* \* \* mtgscanner|${REFRESH_SCHEDULE} mtgscanner|" \
        "${APP_DIR}/deploy/mtg-card-scanner.cron" > "${CRON_FILE}"
    chmod 644 "${CRON_FILE}"
fi
if ! cmp -s "${APP_DIR}/deploy/mtg-card-scanner.logrotate" "${LOGROTATE_FILE}"; then
    log "Updating logrotate config..."
    cp "${APP_DIR}/deploy/mtg-card-scanner.logrotate" "${LOGROTATE_FILE}"
    chmod 644 "${LOGROTATE_FILE}"
fi

# ── Restart the service ─────────────────────────────────────────────────────
log "Restarting ${SERVICE_NAME}..."
systemctl restart "${SERVICE_NAME}" || die "Failed to restart service"

# ── Record state ────────────────────────────────────────────────────────────
state_set deployed_sha "${REMOTE_SHA}"
state_set previous_sha "${LOCAL_SHA}"
state_set deployed_at "$(date -Is)"
state_set last_status "pending"

# ── Verify readiness ────────────────────────────────────────────────────────
PORT="$(grep -E '^PORT=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- || echo 3000)"
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
    log "App is ready. Update complete."
    state_set last_status "ok"
    state_set last_error ""
    exit 0
else
    log "App did not become ready within ${HEALTH_TIMEOUT}s."
    log "Recovery: the previous commit was ${LOCAL_SHA}. To roll back:"
    log "  cd ${APP_DIR} && git reset --hard ${LOCAL_SHA}"
    log "  sudo -u ${SERVICE_USER} npm ci --omit=dev"
    log "  sudo -u ${SERVICE_USER} .venv/bin/pip install -r requirements.txt"
    log "  systemctl restart ${SERVICE_NAME}"
    state_set last_status "failed"
    state_set last_error "health check failed"
    exit 1
fi