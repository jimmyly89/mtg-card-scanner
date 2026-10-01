"""
Refresh the CollectorVision MTG catalog and preload the neural models.

CollectorVision's MTG embedding catalog is refreshed INDEPENDENTLY of Scryfall:
it is downloaded from CollectorVision's HuggingFace feed via
``CatalogV2Downloader.install(Game.MTG)``. Refreshing Scryfall does NOT update
neural embeddings, so this script is the documented mechanism for that.

It also instantiates the NeuralCornerDetector (Cornelius) and the catalog's
NeuralEmbedder (Milo) once, which triggers any required model-weight download
into the CollectorVision cache. Running this as the mtgscanner service user
during installation preloads the assets so the first live scan does not stall
on a large download.

Usage:
    python scripts/update_collectorvision.py [--offline]

Exit codes:
    0  catalog + models ready
    1  refresh failed (existing cached catalog remains usable)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Ensure scripts/ is on sys.path so env_config is importable when run directly.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from env_config import collectorvision_cache  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh CollectorVision MTG catalog + models")
    parser.add_argument(
        "--offline", action="store_true",
        help="Only load from cache; never make network calls (fails if not cached)."
    )
    args = parser.parse_args()

    # Point CollectorVision's cache at our configured location (writable by the
    # service account) so the server and this script share the same assets.
    cache = collectorvision_cache()
    if cache:
        os.environ["COLLECTORVISION_CACHE"] = cache
        Path(cache).mkdir(parents=True, exist_ok=True)

    try:
        import collector_vision as cvg
        from collector_vision.games import Game
    except ImportError as exc:
        print(f"ERROR: collectorvision is not installed: {exc}", file=sys.stderr)
        print("Run: .venv/bin/pip install -r requirements.txt", file=sys.stderr)
        return 1

    print("Refreshing CollectorVision MTG catalog...")
    try:
        catalog = cvg.Catalog.load("mtg", offline=args.offline)
        print(f"Catalog ready: {len(catalog)} cards (algo={catalog.algo_key})")
    except Exception as exc:
        print(f"ERROR refreshing catalog: {exc}", file=sys.stderr)
        print("A previously cached catalog (if any) remains usable.", file=sys.stderr)
        return 1

    print("Preloading neural models (Cornelius detector + Milo embedder)...")
    try:
        detector = cvg.NeuralCornerDetector(offline=args.offline)
        print(f"Detector ready: {detector}")
        embedder = catalog.embedder
        print(f"Embedder ready: {embedder}")
    except Exception as exc:
        print(f"ERROR preloading models: {exc}", file=sys.stderr)
        return 1

    print("CollectorVision catalog + models are ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())