"""
CollectorVision-backed card scanner.

Uses the official CollectorVision library (https://github.com/HanClinto/CollectorVision)
for learned card detection + embedding-based matching, mirroring its backend
architecture:

  1. NeuralCornerDetector (Cornelius)  — finds 4 card corners, handles skew
  2. detection.dewarp()                — perspective-corrects to a flat 448x448 crop
  3. NeuralEmbedder (Milo)             — produces a 128-d ArcFace embedding
  4. Catalog.search_records()          — cosine-similarity search against a
                                         pre-built ~113K-card MTG embedding catalog

The catalog and detector are loaded ONCE at module level and reused across
requests (mirrors CollectorVision's FastAPI server which lazy-loads and reuses
them). No OCR is used — matching is pure embedding similarity.

Output contract matches the existing scripts (identifier.py / neural_scanner.py):
  - debug logs -> stderr
  - final JSON  -> stdout
so the Node server's runPythonScript() can parse it unchanged.

Usage:
    python collectorvision_scanner.py <image_path>
"""

import sys
import os
import json
import sqlite3
import logging
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import collector_vision as cvg

# ── Configuration ──
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = PROJECT_DIR / "data"
DB_PATH = DATA_DIR / "mtg_cards.db"

# Thresholds (mirror CollectorVision defaults / existing neural_scanner.py)
MIN_SHARPNESS = 0.02          # Below this = no card in frame
EMBEDDING_MATCH_THRESHOLD = 0.80  # Min cosine similarity for auto-match
TOP_K = 5

_LOG = logging.getLogger("collectorvision_scanner")


# ═══════════════════════════════════════════════════════════════════════════
# Lazy singletons — loaded once, reused across requests (like CollectorVision)
# ═══════════════════════════════════════════════════════════════════════════
_catalog = None
_detector = None


def get_catalog():
    """Load the CollectorVision MTG embedding catalog once and reuse it."""
    global _catalog
    if _catalog is None:
        _LOG.info("Loading CollectorVision MTG catalog...")
        _catalog = cvg.Catalog.load("mtg")
        _LOG.info("Catalog loaded: %d cards", len(_catalog.card_ids))
    return _catalog


def get_detector():
    """Load the CollectorVision NeuralCornerDetector (Cornelius) once."""
    global _detector
    if _detector is None:
        _LOG.info("Loading CollectorVision NeuralCornerDetector...")
        _detector = cvg.NeuralCornerDetector()
    return _detector


# ═══════════════════════════════════════════════════════════════════════════
# Card detail lookup from local SQLite (join on Scryfall UUID = cards.id)
# ═══════════════════════════════════════════════════════════════════════════

def get_card_details(conn, scryfall_id):
    """Fetch full card details from the local SQLite DB by Scryfall UUID."""
    cur = conn.cursor()
    cur.execute("""
        SELECT id, oracle_id, name, printed_name, set_code, collector_number,
               lang, layout, image_uris, art_crop_url, normal_image_url,
               usd_price, usd_foil_price
        FROM cards WHERE id = ?
    """, (scryfall_id,))
    row = cur.fetchone()
    if not row:
        return None

    image_uris = None
    if row[8]:
        try:
            image_uris = json.loads(row[8])
        except Exception:
            image_uris = None

    return {
        "id": row[0],
        "oracle_id": row[1],
        "name": row[2],
        "printed_name": row[3],
        "set": row[4],
        "set_code": row[4],
        "collector_number": row[5],
        "lang": row[6],
        "layout": row[7],
        "image_uris": image_uris,
        "art_crop_url": row[9],
        "normal_image_url": row[10],
        "price_usd": row[11],
        "price_usd_foil": row[12],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Main scanning pipeline
# ═══════════════════════════════════════════════════════════════════════════

def scan_card(image_path, top_k=TOP_K, skip_detection=False):
    """
    Full CollectorVision scanning pipeline (no OCR).

    Steps:
      1. Load image (BGR)
      2. Detect card corners with Cornelius (unless skip_detection)
      3. Dewarp to 448x448 crop
      4. Embed with Milo -> query vector
      5. Cosine-search the pre-built MTG catalog
      6. Map top matches to local SQLite card details
      7. Return best match + alternatives

    If skip_detection is True, the input image is assumed to be an already
    perspective-corrected card crop (e.g. produced client-side), so the
    Cornelius detector is bypassed and the image is embedded directly.

    Returns dict matching the existing identifier.py / neural_scanner.py contract.
    """
    if not os.path.exists(image_path):
        return {"error": f"Image not found: {image_path}"}

    # ── Step 1: Load image ──
    bgr = cv2.imread(image_path)
    if bgr is None:
        return {"error": "Failed to load image"}

    # ── Step 2: Detect card (Cornelius) unless already cropped ──
    detection = None
    if skip_detection:
        # Input is already a perspective-corrected card crop — use directly.
        crop = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    else:
        detector = get_detector()
        detection = detector.detect(bgr, min_sharpness=MIN_SHARPNESS)

        if not detection.card_present:
            return {
                "error": "No card detected",
                "scanDebug": {
                    "method": "collectorvision",
                    "sharpness": detection.sharpness,
                    "confidence": detection.confidence,
                    "reason": "No card detected",
                }
            }

        # ── Step 3: Dewarp to flat crop ──
        crop = detection.dewarp(bgr)  # PIL Image, 448x448

    # ── Step 4: Embed query card with Milo ──
    catalog = get_catalog()
    query_embedding = catalog.embedder.embed(crop)  # (128,) L2-normalised

    # ── Step 5: Cosine-search the pre-built catalog ──
    records = catalog.search_records(query_embedding, top_k=top_k)

    # ── Step 6: Map to local SQLite details ──
    conn = sqlite3.connect(str(DB_PATH))
    try:
        results = []
        for rec in records:
            scryfall_id = rec.get("card_id") or rec.get("id")
            score = rec.get("score", 0.0)
            details = get_card_details(conn, scryfall_id) if scryfall_id else None
            if details:
                results.append({
                    "card": details,
                    "score": float(score),
                })
    finally:
        conn.close()

    if not results:
        return {
            "error": "No matching card found in catalog",
            "scanDebug": {
                "method": "collectorvision",
                "sharpness": detection.sharpness if detection else None,
                "confidence": detection.confidence if detection else None,
            }
        }

    best_match = results[0]
    alternatives = results[1:5]

    score = best_match["score"]
    second_score = alternatives[0]["score"] if alternatives else 0.0
    needs_manual = (
        score < EMBEDDING_MATCH_THRESHOLD or
        (score - second_score) < 0.05
    )

    scan_debug = {
        "method": "collectorvision",
        "sharpness": detection.sharpness if detection else None,
        "confidence": detection.confidence if detection else None,
        "corners": detection.corners.tolist() if (detection and detection.corners is not None) else None,
        "catalog_size": len(catalog.card_ids),
        "top_scores": [r["score"] for r in results],
    }

    return {
        "bestMatch": best_match,
        "alternatives": alternatives,
        "needsManualConfirmation": needs_manual,
        "scanDebug": scan_debug,
    }


# ═══════════════════════════════════════════════════════════════════════════
# CLI — debug to stderr, final JSON to stdout (matches existing scripts)
# ═══════════════════════════════════════════════════════════════════════════

def main():
    _original_print = print

    def debug_print(*args, **kwargs):
        if 'file' not in kwargs:
            _original_print(*args, file=sys.stderr, **kwargs)
        else:
            _original_print(*args, **kwargs)

    import builtins
    builtins.print = debug_print

    if len(sys.argv) < 2:
        _original_print(json.dumps({"error": "Usage: python collectorvision_scanner.py <image_path> [skip_detection]"}))
        sys.exit(1)

    image_path = sys.argv[1]
    skip_detection = len(sys.argv) > 2 and sys.argv[2].lower() in ("1", "true", "yes", "skip")

    try:
        result = scan_card(image_path, skip_detection=skip_detection)
    except Exception as e:
        _LOG.exception("Scan failed")
        result = {"error": str(e)}

    # Restore original print for final JSON output
    builtins.print = _original_print
    _original_print(json.dumps(result))


if __name__ == "__main__":
    main()