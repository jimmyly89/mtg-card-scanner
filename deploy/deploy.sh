#!/usr/bin/env bash
#
# deploy.sh — MTG Card Scanner deployment script for a Proxmox LXC container.
#
# This is a Node.js (Express) app with a Python helper layer. There is no
# build step; "build" here means installing npm + Python dependencies.
#
# Features:
#   * Fetches and updates the repository's current tracking branch.
#   * Refuses to overwrite local (uncommitted) changes.
#   * Prevents overlapping deployments with flock.
#   * Installs dependencies (npm + Python) as appropriate.
#   * Restarts the app via systemd (unit provided in this repo).
#   * Keeps secrets (.env), databases (data/) and uploads intact.
#   * Exits on failure and verifies the app responds after deployment.
#   * Supports scheduled runs: skips rebuild when the deployed commit already
#     matches GitHub, but retries if the previous deployment failed.
#
# Usage:
#   ./deploy.sh                 # full deploy (fetch, install, restart, verify)
#   ./deploy.sh --check         # scheduled check: only deploy if needed
#   ./deploy.sh --force         # deploy even if commit is unchanged
#   ./deploy.sh --no-verify     # skip the post-deploy health check
#
# Exit codes:
#   0  success (or nothing to do in --check mode)
#   1  generic failure
#   2  local changes present (refusing to overwrite)
#   3  another deployment is already running (flock)
#   4  already up to date (only in --check mode, no failure)
#
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
# Resolve the repo root (parent of this script's directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# The systemd service name (see deploy/mtg-card-scanner.service).
SERVICE_NAME="mtg-card-scanner"

# Health check target. The app serves static files from public/ on HTTP 3000.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"   # seconds to wait for the app
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"  # seconds between checks

# Lock file to prevent overlapping deployments.
LOCK_FILE="${LOCK_FILE:-/tmp/mtg-card-scanner-deploy.lock}"

# State file recording the last deployed commit and whether it succeeded.
# Used by --check mode to decide whether a rebuild is needed.
STATE_FILE="${STATE_FILE:-${APP_DIR}/data/.deploy-state}"

# Log file for deployment output.
LOG_FILE="${LOG_FILE:-/var/log/mtg-card-scanner-deploy.log}"

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die()  { log "ERROR: $*" >&2; exit 1; }

# Read a value from the state file (KEY=VALUE lines).
state_get() {
    local key="$1"
    if [[ -f "${STATE_FILE}" ]]; then
        awk -F= -v k="${key}" '$1==k {print $2}' "${STATE_FILE}"
    fi
}

# Write a value to the state file.
state_set() {
    local key="$1" value="$2"
    mkdir -p "$(dirname "${STATE_FILE}")"
    if [[ -f "${STATE_FILE}" ]]; then
        grep -v "^${key}=" "${STATE_FILE}" > "${STATE_FILE}.tmp" || true
        mv "${STATE_FILE}.tmp" "${STATE_FILE}"
    fi
    printf '%s=%s\n' "${key}" "${value}" >> "${STATE_FILE}"
}

# ── Argument parsing ─────────────────────────────────────────────────────────
MODE="deploy"   # deploy | check
FORCE=0
VERIFY=1

for arg in "$@"; do
    case "${arg}" in
        --check)  MODE="check" ;;
        --force)  FORCE=1 ;;
        --no-verify) VERIFY=0 ;;
        -h|--help)
            sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "Unknown argument: ${arg}" ;;
    esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
command -v git  >/dev/null 2>&1 || die "git is not installed"
command -v npm  >/dev/null 2>&1 || die "npm is not installed"
command -v node >/dev/null 2>&1 || die "node is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed"

[[ -d "${APP_DIR}/.git" ]] || die "Not a git repository: ${APP_DIR}"
cd "${APP_DIR}"

# ── Locking (prevent overlapping deployments) ────────────────────────────────
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    log "Another deployment is already running (lock held on ${LOCK_FILE})."
    exit 3
fi

# ── Determine the tracking branch ────────────────────────────────────────────
# Use the current branch's upstream (e.g. origin/main). Fall back to origin/main.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ -z "${UPSTREAM}" || "${UPSTREAM}" == "@{u}" ]]; then
    log "No upstream configured for branch '${BRANCH}'; defaulting to origin/main."
    UPSTREAM="origin/main"
fi
REMOTE="${UPSTREAM%%/*}"
REMOTE_BRANCH="${UPSTREAM#*/}"
log "Tracking branch: ${UPSTREAM} (local branch: ${BRANCH})"

# ── Fetch latest from remote ─────────────────────────────────────────────────
log "Fetching from ${REMOTE}..."
git fetch "${REMOTE}" "${REMOTE_BRANCH}"

# ── Refuse to overwrite local changes ────────────────────────────────────────
if ! git diff --quiet HEAD; then
    log "Local (uncommitted) changes detected. Refusing to overwrite them."
    log "Commit or stash your changes, then re-run."
    exit 2
fi

# ── Scheduled check: skip rebuild when already up to date ────────────────────
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "${UPSTREAM}")"
LAST_DEPLOYED="$(state_get deployed_sha || true)"
LAST_STATUS="$(state_get last_status || true)"

if [[ "${MODE}" == "check" && "${FORCE}" -eq 0 ]]; then
    if [[ "${LOCAL_SHA}" == "${REMOTE_SHA}" && "${LAST_STATUS}" == "ok" ]]; then
        log "Already up to date (${LOCAL_SHA:0:12}) and last deployment succeeded. Nothing to do."
        exit 4
    fi
    if [[ "${LOCAL_SHA}" == "${REMOTE_SHA}" && "${LAST_STATUS}" != "ok" ]]; then
        log "Commit unchanged but previous deployment failed (status=${LAST_STATUS:-none}). Retrying."
    fi
fi

# ── Fast-forward / update to the remote commit ───────────────────────────────
# We already verified the working tree is clean, so a fast-forward is safe.
log "Updating to ${REMOTE_SHA:0:12}..."
if ! git merge --ff-only "${UPSTREAM}" 2>/dev/null; then
    # Not a fast-forward (e.g. local commits ahead). Reset to remote is
    # destructive, so refuse rather than lose work.
    die "Cannot fast-forward to ${UPSTREAM}. Local commits diverge; resolve manually."
fi

# ── Install dependencies ─────────────────────────────────────────────────────
log "Installing npm dependencies..."
npm ci --omit=dev --no-audit --no-fund

log "Installing Python dependencies..."
python3 -m pip install --upgrade pip >/dev/null 2>&1 || true
python3 -m pip install --no-cache-dir \
    requests ijson opencv-python-headless numpy onnxruntime

# ── Restart the app via systemd ──────────────────────────────────────────────
if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    log "Restarting systemd service '${SERVICE_NAME}'..."
    systemctl restart "${SERVICE_NAME}"
else
    die "systemd service '${SERVICE_NAME}' not found. Install deploy/mtg-card-scanner.service first."
fi

# ── Record state ─────────────────────────────────────────────────────────────
state_set deployed_sha "${REMOTE_SHA}"
state_set deployed_at "$(date -Is)"
state_set last_status "pending"

# ── Verify the app is responding ─────────────────────────────────────────────
if [[ "${VERIFY}" -eq 1 ]]; then
    log "Waiting for app to respond at ${HEALTH_URL}..."
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
        log "App is responding. Deployment complete."
        state_set last_status "ok"
        exit 0
    else
        log "App did not respond within ${HEALTH_TIMEOUT}s. Deployment may have failed."
        state_set last_status "failed"
        exit 1
    fi
else
    log "Skipping health check (--no-verify)."
    state_set last_status "ok"
    exit 0
fi
