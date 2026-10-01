"""
Preload CollectorVision neural assets (catalog + models) as the service user.

Downloads (or loads from cache) the MTG embedding catalog and the Cornelius /
Milo model weights into the CollectorVision cache. Run during installation so
the first live scan does not trigger a large download at scan time.

This is a convenience wrapper around update_collectorvision.py. It performs a
full refresh (downloads if needed); use refresh-data.sh for the scheduled
refresh that also updates the SQLite catalog and MariaDB tbl_card.

Usage:
    python scripts/preload_models.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from update_collectorvision import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())