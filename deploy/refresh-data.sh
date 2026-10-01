#!/usr/bin/env bash
#
# refresh-data.sh — refresh the MTG Card Scanner backend data.
#
# Refreshes three independent data sources:
#   1. SQLite card catalog (data/mtg_cards.db)  — via scripts/db_builder.py
#   2. MariaDB tbl_card (card reference data)   — via scripts/scryfall_loader.py
#   3. CollectorVision catalog + models         — via scripts/update_collectorvision.py
#
# Scryfall and CollectorVision are refreshed independently: refreshing Scryfall
# does NOT update neural embeddings. This script handles both.
#
# Design guarantees:
#   * flock prevents overlapping refreshes (cron + manual + UI-triggered).
#   * One shared default-cards.json download is reused by both importers.
#   * Downloads go to a temp file and are atomically renamed, so a failed
#     download leaves the previous data usable.
#   * Never modifies user inventory, sessions, orders, purchase costs, or
#     historical sale values.
#   * Records last attempt / last success / source version / counts / errors in
#     data/refresh_state.json.
#
# Usage:
#   sudo -u mtgscanner /opt/mtg-card-scanner/deploy/refresh-data.sh
#   sudo -u mtgscanner /opt/mtg-card-scanner/deploy/refresh-data.sh --skip-collectorvision
#
set -euo pipefail

# ── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${APP_DIR}/data"
VENV_PY="${APP_DIR}/.venv/bin/python"
ENV_FILE="${APP_DIR}/.env"
BULK_FILE="${DATA_DIR}/default-cards.json"
STATE_FILE="${DATA_DIR}/refresh_state.json"
LOCK_FILE="${DATA_DIR}/.refresh.lock"
LOG_DIR="${DATA_DIR}/logs"
LOG_FILE="${LOG_DIR}/refresh.log"

# Scryfall bulk-data manifest endpoint.
SCRYFALL_BULK_URL="https://api.scryfall.com/bulk-data"

# ── Helpers ─────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die()  { log "ERROR: $*" >&2; exit 1; }

# Load .env values into the environment (without clobbering existing vars).
# Parsed line-by-line — never `source`d directly, because values like
# REFRESH_SCHEDULE="0 3 * * *" contain shell metacharacters.
load_env() {
    if [[ -f "${ENV_FILE}" ]]; then
        while IFS='=' read -r _key _val; do
            _key="${_key//[[:space:]]/}"
            _val="${_val%\"}"; _val="${_val#\"}"
            if [[ -n "${_key}" && "${_key}" != \#* ]]; then
                export "${_key}=${_val}"
            fi
        done < "${ENV_FILE}"
    fi
}

# Read a JSON field from the state file (simple, no jq dependency).
state_get() {
    local key="$1"
    if [[ -f "${STATE_FILE}" ]]; then
        python3 -c "import json,sys; d=json.load(open('${STATE_FILE}')); print(d.get('${key}',''))" 2>/dev/null || true
    fi
}

state_set() {
    local key="$1" value="$2"
    python3 - "$key" "$value" "${STATE_FILE}" <<'PY'
import json, sys
key, value, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path))
except Exception:
    d = {}
d[key] = value
json.dump(d, open(path, "w"), indent=2)
PY
}

# ── Argument parsing ────────────────────────────────────────────────────────
SKIP_COLLECTORVISION=0
for arg in "$@"; do
    case "${arg}" in
        --skip-collectorvision) SKIP_COLLECTORVISION=1 ;;
        -h|--help)
            sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "Unknown argument: ${arg}" ;;
    esac
done

# ── Preflight ───────────────────────────────────────────────────────────────
[[ -x "${VENV_PY}" ]] || die "Virtual environment not found at ${VENV_PY}. Run install.sh first."
load_env
mkdir -p "${DATA_DIR}" "${LOG_DIR}"
chmod 700 "${DATA_DIR}"

# ── Locking (prevent overlapping refreshes) ─────────────────────────────────
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    log "Another refresh is already running (lock held on ${LOCK_FILE}). Exiting."
    exit 3
fi

# ── Record attempt ──────────────────────────────────────────────────────────
state_set last_attempt "$(date -Is)"
state_set last_status "running"

{
    log "=== Data refresh started ==="

    # ── Step 1: Check Scryfall bulk-data version ───────────────────────────
    log "Checking Scryfall bulk-data version..."
    BULK_UPDATED_AT=""
    BULK_DOWNLOAD_URI=""
    if curl -fsS --max-time 30 "${SCRYFALL_BULK_URL}" -o "${DATA_DIR}/bulk-manifest.json" 2>/dev/null; then
        BULK_UPDATED_AT="$(python3 -c "import json;d=json.load(open('${DATA_DIR}/bulk-manifest.json'));print(next((e.get('updated_at','') for e in d.get('data',[]) if e.get('type')=='default_cards'),''))" 2>/dev/null || true)"
        BULK_DOWNLOAD_URI="$(python3 -c "import json;d=json.load(open('${DATA_DIR}/bulk-manifest.json'));print(next((e.get('download_uri','') for e in d.get('data',[]) if e.get('type')=='default_cards'),''))" 2>/dev/null || true)"
    fi

    LAST_VERSION="$(state_get last_source_version)"
    if [[ -n "${BULK_UPDATED_AT}" && "${BULK_UPDATED_AT}" == "${LAST_VERSION}" && -f "${BULK_FILE}" ]]; then
        log "Scryfall bulk data unchanged since last refresh (${BULK_UPDATED_AT}). Reusing cached file."
    else
        log "New Scryfall bulk data available (${BULK_UPDATED_AT:-unknown}). Downloading..."
        if [[ -z "${BULK_DOWNLOAD_URI}" ]]; then
            log "WARNING: could not resolve download URI; falling back to letting db_builder download."
        else
            # Download to temp, then atomically rename so a failure keeps the old file.
            TMP_BULK="${BULK_FILE}.tmp"
            if curl -fsSL --max-time 1800 --retry 3 --retry-delay 5 \
                -H "User-Agent: MTG-Card-Scanner/1.0" \
                "${BULK_DOWNLOAD_URI}" -o "${TMP_BULK}"; then
                # Validate it parses as JSON before replacing the good file.
                if python3 -c "import json; json.load(open('${TMP_BULK}'))" 2>/dev/null; then
                    mv "${TMP_BULK}" "${BULK_FILE}"
                    log "Downloaded and validated bulk data (${BULK_UPDATED_AT})."
                else
                    rm -f "${TMP_BULK}"
                    log "WARNING: downloaded file failed JSON validation; keeping previous data."
                fi
            else
                rm -f "${TMP_BULK}"
                log "WARNING: download failed; keeping previous data."
            fi
        fi
    fi

    # ── Step 2: Refresh SQLite catalog ─────────────────────────────────────
    log "Refreshing SQLite card catalog..."
    if [[ -f "${BULK_FILE}" ]]; then
        if "${VENV_PY}" "${APP_DIR}/scripts/db_builder.py" --file "${BULK_FILE}"; then
            log "SQLite catalog refresh OK."
        else
            log "ERROR: SQLite catalog refresh failed."
            state_set last_status "failed"
            state_set last_error "SQLite catalog refresh failed"
            exit 1
        fi
    else
        log "No cached bulk file; letting db_builder download it."
        if "${VENV_PY}" "${APP_DIR}/scripts/db_builder.py"; then
            log "SQLite catalog refresh OK."
        else
            log "ERROR: SQLite catalog refresh failed."
            state_set last_status "failed"
            state_set last_error "SQLite catalog refresh failed"
            exit 1
        fi
    fi

    # ── Step 3: Refresh MariaDB tbl_card ───────────────────────────────────
    log "Refreshing MariaDB tbl_card..."
    if [[ -f "${BULK_FILE}" ]]; then
        if "${VENV_PY}" "${APP_DIR}/scripts/scryfall_loader.py" --file "${BULK_FILE}"; then
            log "MariaDB tbl_card refresh OK."
        else
            log "ERROR: MariaDB tbl_card refresh failed."
            state_set last_status "failed"
            state_set last_error "MariaDB tbl_card refresh failed"
            exit 1
        fi
    else
        if "${VENV_PY}" "${APP_DIR}/scripts/scryfall_loader.py"; then
            log "MariaDB tbl_card refresh OK."
        else
            log "ERROR: MariaDB tbl_card refresh failed."
            state_set last_status "failed"
            state_set last_error "MariaDB tbl_card refresh failed"
            exit 1
        fi
    fi

    # ── Step 4: Refresh CollectorVision catalog + models ───────────────────
    if [[ "${SKIP_COLLECTORVISION}" -eq 0 ]]; then
        log "Refreshing CollectorVision catalog + models..."
        if "${VENV_PY}" "${APP_DIR}/scripts/update_collectorvision.py"; then
            log "CollectorVision refresh OK."
        else
            log "WARNING: CollectorVision refresh failed (catalog may be stale but usable)."
        fi
    else
        log "Skipping CollectorVision refresh (--skip-collectorvision)."
    fi

    # ── Step 5: Record success ─────────────────────────────────────────────
    state_set last_success "$(date -Is)"
    state_set last_status "ok"
    state_set last_source_version "${BULK_UPDATED_AT}"
    state_set last_error ""
    log "=== Data refresh complete ==="
} >> "${LOG_FILE}" 2>&1

exit 0