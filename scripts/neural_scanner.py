"""
Neural Card Scanner — ONNX-based card detection + embedding matching.

Uses two ONNX models from CollectorVision:
1. Cornelius (NeuralCornerDetector) — finds card corners even with extreme skew/rotation
2. Milo (NeuralEmbedder) — produces 128-d ArcFace embeddings for visual matching

Pipeline:
  Input image → Cornelius (detect corners + dewarp) → Milo (embed) → cosine search against candidates

The candidate card names are obtained via lightweight OCR, or optionally via
direct embedding search against a pre-built catalog (NPZ file).

Output format matches the existing identifier.py for drop-in replacement.
"""

import os
import sys
import json
import io
import tempfile
import sqlite3
import logging
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# ── ONNX Runtime ──
import onnxruntime as ort

# ── Tesseract OCR (lightweight fallback for name lookup) ──
try:
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    HAS_TESSERACT = True
except Exception:
    HAS_TESSERACT = False


# ── Configuration ──
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = PROJECT_DIR / "data"
MODELS_DIR = PROJECT_DIR / "models"
DB_PATH = DATA_DIR / "mtg_cards.db"
CATALOG_PATH = MODELS_DIR / "mtg_embeddings.npz"  # optional pre-built catalog

DETECTOR_PATH = MODELS_DIR / "cornelius.onnx"
EMBEDDER_PATH = MODELS_DIR / "milo.onnx"

# Input size for each model
DETECTOR_SIZE = 384
EMBEDDER_SIZE = 448

# Thresholds
MIN_SHARPNESS = 0.02       # Below this = no card in frame
EMBEDDING_MATCH_THRESHOLD = 0.80  # Minimum cosine similarity for auto-match
OCR_FALLBACK_THRESHOLD = 0.65     # Below this → ask user

_LOG = logging.getLogger("neural_scanner")


# ═══════════════════════════════════════════════════════════════════════════
# ImageNet normalisation constants (same as CollectorVision)
# ═══════════════════════════════════════════════════════════════════════════
_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


# ═══════════════════════════════════════════════════════════════════════════
# 1. Neural Corner Detection (Cornelius)
# ═══════════════════════════════════════════════════════════════════════════

def _preprocess_detector(bgr: np.ndarray) -> np.ndarray:
    """BGR uint8 → (1, 3, 384, 384) float32, ImageNet-normalised."""
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    rgb = cv2.resize(rgb, (DETECTOR_SIZE, DETECTOR_SIZE), interpolation=cv2.INTER_LINEAR)
    x = rgb.astype(np.float32) / 255.0
    x = (x - _IMAGENET_MEAN) / _IMAGENET_STD
    return x.transpose(2, 0, 1)[np.newaxis].astype(np.float32)


def _order_corners(pts: np.ndarray, image_shape=None):
    """
    Reorder four (x,y) points to canonical TL, TR, BR, BL order,
    then rotate so the shortest original-space edge becomes the top.
    """
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    ordered = np.array([
        pts[np.argmin(s)],   # TL: smallest x+y
        pts[np.argmin(d)],   # TR: smallest x-y
        pts[np.argmax(s)],   # BR: largest x+y
        pts[np.argmax(d)],   # BL: largest x-y
    ], dtype=np.float32)

    if image_shape is not None:
        h, w = image_shape[:2]
        pixel_corners = ordered * np.array([w, h], dtype=np.float32)
        edge_lengths = np.linalg.norm(
            pixel_corners - np.roll(pixel_corners, -1, axis=0), axis=1
        )
        shortest_edge = int(np.argmin(edge_lengths))
        ordered = np.roll(ordered, -shortest_edge, axis=0)

    return ordered


class NeuralDetector:
    """Wrapper around Cornelius (MobileViT-XXS + SimCC) corner detector."""

    def __init__(self, model_path: str | Path = DETECTOR_PATH, num_threads: int = 4):
        model_path = Path(model_path)
        if not model_path.exists():
            raise FileNotFoundError(f"Detector model not found: {model_path}")

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = num_threads
        opts.inter_op_num_threads = 1
        self._sess = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self._input_name = self._sess.get_inputs()[0].name
        out_names = {o.name for o in self._sess.get_outputs()}
        self._has_sharpness = "sharpness" in out_names

    def detect(self, image: np.ndarray, min_sharpness: float = MIN_SHARPNESS) -> dict:
        """
        Returns dict with:
          - success: bool
          - card_present: bool
          - corners: list of 4 (x, y) normalised [0,1] or None
          - sharpness: float or None
          - confidence: float
          - reason: str
        """
        x = _preprocess_detector(image)
        outs = self._sess.run(None, {self._input_name: x})

        corners_flat = np.clip(outs[0].squeeze(), 0.0, 1.0)  # (8,)
        presence_logit = float(outs[1].squeeze())
        presence = float(1.0 / (1.0 + np.exp(-presence_logit)))

        sharpness: float | None = None
        card_present: bool
        confidence: float

        if self._has_sharpness:
            sharpness = float(outs[2].squeeze())
            card_present = sharpness >= min_sharpness
            confidence = sharpness
        else:
            card_present = presence >= 0.5
            confidence = presence

        if not card_present:
            return {
                "success": True,
                "card_present": False,
                "corners": None,
                "sharpness": sharpness,
                "confidence": confidence,
                "reason": "No card detected",
            }

        corners = _order_corners(
            corners_flat.reshape(4, 2).astype(np.float32), image.shape
        )

        return {
            "success": True,
            "card_present": True,
            "corners": corners.tolist(),
            "sharpness": sharpness,
            "confidence": confidence,
            "reason": "OK",
        }


# ═══════════════════════════════════════════════════════════════════════════
# 2. Neural Embedder (Milo)
# ═══════════════════════════════════════════════════════════════════════════

def _preprocess_embedder(pil_img: Image.Image) -> np.ndarray:
    """PIL Image → (1, 3, 448, 448) float32, ImageNet-normalised."""
    rgb = pil_img.convert("RGB").resize((EMBEDDER_SIZE, EMBEDDER_SIZE), Image.BILINEAR)
    x = np.array(rgb, dtype=np.float32) / 255.0
    x = (x - _IMAGENET_MEAN) / _IMAGENET_STD
    return x.transpose(2, 0, 1)[np.newaxis].astype(np.float32)


class NeuralEmbedder:
    """Wrapper around Milo (MobileViT-XXS + ArcFace) card embedder."""

    def __init__(self, model_path: str | Path = EMBEDDER_PATH, num_threads: int = 4):
        model_path = Path(model_path)
        if not model_path.exists():
            raise FileNotFoundError(f"Embedder model not found: {model_path}")

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = num_threads
        opts.inter_op_num_threads = 1
        self._sess = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self._input_name = self._sess.get_inputs()[0].name

    def embed(self, pil_img: Image.Image) -> np.ndarray:
        """Embed a single PIL image → (128,) float32 L2-normalised vector."""
        x = _preprocess_embedder(pil_img)
        out = self._sess.run(None, {self._input_name: x})[0]
        emb = out.squeeze().astype(np.float32)
        norm = float(np.linalg.norm(emb))
        if norm > 1e-8:
            emb = emb / norm
        return emb

    def embed_batch(self, images: list[Image.Image]) -> np.ndarray:
        """Embed a list of PIL images → (N, 128) float32."""
        embs = [self.embed(img) for img in images]
        return np.stack(embs, axis=0)


# ═══════════════════════════════════════════════════════════════════════════
# 3. Dewarp (perspective correction)
# ═══════════════════════════════════════════════════════════════════════════

def dewarp_card(bgr: np.ndarray, corners: list, output_size: int = EMBEDDER_SIZE) -> Image.Image:
    """
    Perspective-warp the card region to a flat square.

    Args:
        bgr: Full-frame BGR image (cv2 format)
        corners: 4 normalised (x, y) corners in TL, TR, BR, BL order
        output_size: Square output size (default 448 for Milo)

    Returns:
        PIL Image (RGB) dewarped card
    """
    h, w = bgr.shape[:2]
    src = np.array(corners, dtype=np.float32) * np.array([w, h], dtype=np.float32)
    dst = np.array([
        [0, 0],
        [output_size - 1, 0],
        [output_size - 1, output_size - 1],
        [0, output_size - 1],
    ], dtype=np.float32)

    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(bgr, M, (output_size, output_size))
    return Image.fromarray(cv2.cvtColor(warped, cv2.COLOR_BGR2RGB))


# ═══════════════════════════════════════════════════════════════════════════
# 4. OCR name extraction (lightweight, for catalog lookup)
# ═══════════════════════════════════════════════════════════════════════════

def ocr_card_name(image_path: str) -> str | None:
    """OCR the top ~15% of the card to extract the name.

    Same strategy as identifier.py for compatibility.
    """
    if not HAS_TESSERACT:
        return None

    try:
        img = cv2.imread(image_path)
        if img is None:
            return None
        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        title_h = max(30, int(h * 0.15))
        title_region = gray[0:title_h, 0:w]
        title_region = cv2.resize(title_region, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        _, title_binary = cv2.threshold(title_region, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        custom_config = '--psm 7 -c tessedit_char_whitelist="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\',- "'
        text = pytesseract.image_to_string(title_binary, config=custom_config)
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        if lines:
            return lines[0]
    except Exception as e:
        _LOG.warning(f"OCR error: {e}")

    return None


# ═══════════════════════════════════════════════════════════════════════════
# 5. Embedding Catalog (pre-computed or on-the-fly)
# ═══════════════════════════════════════════════════════════════════════════

class EmbeddingCatalog:
    """Manage card embeddings: load from NPZ or build on-the-fly from DB.

    The catalog is an in-memory mapping from card_id → (name, name_lower, embedding).
    If a pre-computed NPZ exists at CATALOG_PATH, it's loaded directly.
    Otherwise, embeddings are fetched lazily (downloaded from Scryfall + embedded).
    """

    def __init__(self, embedder: NeuralEmbedder, db_path: str | Path = DB_PATH):
        self._embedder = embedder
        self._db_path = Path(db_path)

        # In-memory index: list of (card_id, name, name_lower, embedding_vector)
        self._entries: list[tuple[str, str, str, np.ndarray]] = []
        self._is_loaded = False

    def load_or_build(self, force_rebuild: bool = False) -> int:
        """Load NPZ catalog, or build from DB if not available.

        Returns number of entries loaded.
        """
        npz_path = Path(CATALOG_PATH)

        if not force_rebuild and npz_path.exists():
            try:
                data = np.load(npz_path)
                embeddings = data["embeddings"]  # (N, 128)
                card_ids = data["card_ids"].tolist()
                names = data["names"].tolist()
                self._entries = [
                    (cid, name, name.lower(), emb)
                    for cid, name, emb in zip(card_ids, names, embeddings)
                ]
                self._is_loaded = True
                _LOG.info(f"Loaded {len(self._entries)} entries from NPZ catalog")
                return len(self._entries)
            except Exception as e:
                _LOG.warning(f"Failed to load NPZ catalog: {e}")

        # Fallback: load names & image URLs from DB
        _LOG.info("Building embedding index from DB (on-the-fly)...")
        return self._load_from_db()

    def _load_from_db(self) -> int:
        """Load card metadata from SQLite for on-the-fly embedding."""
        if not self._db_path.exists():
            _LOG.error(f"Database not found: {self._db_path}")
            return 0

        conn = sqlite3.connect(str(self._db_path))
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, name, normal_image_url, art_crop_url
                FROM cards
                WHERE name IS NOT NULL
                LIMIT 50000
            """)
            rows = cursor.fetchall()
            for row in rows:
                card_id, name, norm_url, art_url = row
                name_lower = (name or "").lower()
                # No embedding yet — will be fetched on demand
                self._entries.append((str(card_id), name or "", name_lower, None))
        finally:
            conn.close()

        self._is_loaded = True
        _LOG.info(f"Loaded {len(self._entries)} card names from DB (embeddings on-demand)")
        return len(self._entries)

    def search_by_name(self, query: str, top_k: int = 10) -> list[dict]:
        """Fuzzy search cards by name. Returns candidates for embedding matching."""
        query_lower = query.lower().strip()
        if not query_lower or not self._entries:
            return []

        # Exact prefix match first, then substring
        exact = []
        substring = []
        for cid, name, name_lower, emb in self._entries:
            if name_lower == query_lower:
                exact.append((cid, name, name_lower, emb))
            elif query_lower in name_lower:
                substring.append((cid, name, name_lower, emb))

        results = exact + substring

        # Lazy-load embeddings for top candidates
        loaded = []
        for cid, name, name_lower, emb in results[:top_k]:
            # If no embedding yet, try to fetch
            if emb is None:
                emb = self._fetch_embedding(cid)
            loaded.append({
                "card_id": cid,
                "name": name,
                "embedding": emb,
            })

        return loaded

    def _fetch_embedding(self, card_id: str) -> np.ndarray | None:
        """Download card image from DB URL and compute embedding."""
        conn = sqlite3.connect(str(self._db_path))
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT normal_image_url, art_crop_url FROM cards WHERE id = ?",
                (card_id,)
            )
            row = cursor.fetchone()
            if not row:
                return None
            norm_url = row[0] or row[1]
            if not norm_url:
                return None
        finally:
            conn.close()

        try:
            import requests
            resp = requests.get(norm_url, timeout=10)
            resp.raise_for_status()
            img_bytes = resp.content
            pil_img = Image.open(io.BytesIO(img_bytes))
            return self._embedder.embed(pil_img)
        except Exception as e:
            _LOG.warning(f"Failed to fetch/embed {norm_url}: {e}")
            return None

    def find_matches(self, query_embedding: np.ndarray, candidates: list[dict],
                     top_k: int = 5) -> list[dict]:
        """Find best matching candidates by cosine similarity to query embedding."""
        scored = []
        for cand in candidates:
            emb = cand.get("embedding")
            if emb is None or not isinstance(emb, np.ndarray):
                continue
            # Cosine similarity (both are L2-normalised)
            sim = float(np.dot(query_embedding, emb))
            scored.append({
                "name": cand["name"],
                "card_id": cand["card_id"],
                "score": sim,
            })

        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top_k]

    def get_card_details(self, card_id: str, conn: sqlite3.Connection | None = None) -> dict | None:
        """Get full card details from DB."""
        if conn is None:
            own_conn = True
            conn = sqlite3.connect(str(self._db_path))
        else:
            own_conn = False

        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, name, set_code, collector_number, lang,
                       usd_price, usd_foil_price, normal_image_url
                FROM cards WHERE id = ?
            """, (card_id,))
            row = cursor.fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "name": row[1],
                "set": row[2],
                "collector_number": row[3],
                "lang": row[4],
                "price_usd": row[5],
                "price_usd_foil": row[6],
                "image_url": row[7],
            }
        finally:
            if own_conn:
                conn.close()


# ═══════════════════════════════════════════════════════════════════════════
# 6. Main scanning pipeline
# ═══════════════════════════════════════════════════════════════════════════

def scan_card(image_path: str, use_embeddings: bool = True) -> dict:
    """
    Full neural scanning pipeline.

    Steps:
      1. Load image
      2. Detect card corners with Cornelius
      3. Dewarp to 448×448 card crop
      4. Embed with Milo → query vector
      5. OCR the dewarped card → card name
      6. Look up candidates by name in DB
      7. Embed candidate images (on-the-fly) and compare
      8. Return best match + alternatives

    Returns dict matching the format of identifier.py output.
    """
    if not os.path.exists(image_path):
        return {"error": f"Image not found: {image_path}"}

    # ── Step 1: Load image ──
    bgr = cv2.imread(image_path)
    if bgr is None:
        return {"error": "Failed to load image"}

    # ── Step 2: Detect card ──
    detector = NeuralDetector()
    det_result = detector.detect(bgr)

    if not det_result["card_present"]:
        return {
            "error": "No card detected",
            "scanDebug": {
                "sharpness": det_result.get("sharpness"),
                "confidence": det_result.get("confidence"),
                "reason": det_result.get("reason"),
            }
        }

    corners = det_result["corners"]

    # ── Step 3: Dewarp ──
    dewarped_pil = dewarp_card(bgr, corners)

    # Save dewarped to temp for potential OCR fallback
    tmp_dewarped = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    dewarped_path = tmp_dewarped.name
    dewarped_pil.save(dewarped_path, "JPEG", quality=95)

    # ── Step 4: Embed query card with Milo ──
    embedder = NeuralEmbedder()
    query_embedding = embedder.embed(dewarped_pil)

    # ── Step 5: OCR card name ──
    ocr_name = ocr_card_name(dewarped_path)
    _LOG.info(f"OCR result: {ocr_name}")

    # ── Step 6: Look up candidates + embed matching ──
    catalog = EmbeddingCatalog(embedder)
    catalog.load_or_build()

    best_match = None
    alternatives = []
    needs_manual = True

    if ocr_name:
        candidates = catalog.search_by_name(ocr_name, top_k=10)

        if candidates:
            matches = catalog.find_matches(query_embedding, candidates, top_k=5)

            if matches:
                conn = sqlite3.connect(str(DB_PATH))
                try:
                    all_results = []
                    for m in matches:
                        details = catalog.get_card_details(m["card_id"], conn)
                        if details:
                            all_results.append({
                                "card": details,
                                "score": m["score"],
                            })

                    if all_results:
                        best_match = all_results[0]
                        alternatives = all_results[1:5]

                        score = best_match["score"]
                        second_score = alternatives[0]["score"] if alternatives else 0

                        needs_manual = (
                            score < EMBEDDING_MATCH_THRESHOLD or
                            (score - second_score) < 0.05
                        )
                finally:
                    conn.close()

    # Cleanup temp file
    try:
        os.unlink(dewarped_path)
    except Exception:
        pass

    # Build scan debug info
    scan_debug = {
        "method": "neural",
        "sharpness": det_result.get("sharpness"),
        "confidence": det_result.get("confidence"),
        "ocrName": ocr_name,
        "detection_corners": corners,
    }

    return {
        "bestMatch": best_match,
        "alternatives": alternatives,
        "needsManualConfirmation": needs_manual,
        "scanDebug": scan_debug,
    }


def main():
    """CLI interface. Outputs debug to stderr, final JSON to stdout."""

    # Redirect print debug to stderr
    _original_print = print
    def debug_print(*args, **kwargs):
        if 'file' not in kwargs:
            _original_print(*args, file=sys.stderr, **kwargs)
        else:
            _original_print(*args, **kwargs)

    import builtins
    builtins.print = debug_print

    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python neural_scanner.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]
    use_embeddings = True
    if len(sys.argv) > 2:
        use_embeddings = sys.argv[2].lower() in ("1", "true", "yes")

    print(f"Scanning: {image_path}")
    print(f"Using neural embeddings: {use_embeddings}")

    result = scan_card(image_path, use_embeddings=use_embeddings)

    # Restore original print for final JSON output
    import builtins
    builtins.print = _original_print
    print(json.dumps(result))


if __name__ == "__main__":
    main()