"""
Backfill prices from the cached default-cards.json into the existing MTG database.
Adds usd_price and usd_foil_price columns if they don't exist.
Streams the JSON (ijson) to avoid OOM with the 538 MB file.
"""

import sqlite3
import json
from pathlib import Path
import ijson
import sys
import time

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"
DB_PATH = DATA_DIR / "mtg_cards.db"
BULK_FILE = DATA_DIR / "default-cards.json"


def add_price_columns(conn):
    """Add price columns to the cards table if they don't already exist."""
    cursor = conn.cursor()
    existing_columns = {row[1] for row in cursor.execute("PRAGMA table_info(cards)")}

    added = []
    if "usd_price" not in existing_columns:
        cursor.execute("ALTER TABLE cards ADD COLUMN usd_price TEXT")
        added.append("usd_price")
    if "usd_foil_price" not in existing_columns:
        cursor.execute("ALTER TABLE cards ADD COLUMN usd_foil_price TEXT")
        added.append("usd_foil_price")
    conn.commit()

    if added:
        print(f"Added columns: {', '.join(added)}")
    else:
        print("Price columns already exist")
    return added


def count_prices(conn):
    """Count how many cards have prices filled."""
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM cards WHERE usd_price IS NOT NULL AND usd_price != ''")
    with_price = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM cards")
    total = cursor.fetchone()[0]
    return total, with_price


def main():
    print("=" * 60)
    print("MTG Card Scanner - Price Backfill")
    print("=" * 60)

    if not BULK_FILE.exists():
        print(f"ERROR: Bulk data file not found at {BULK_FILE}")
        print("Cannot backfill prices without the cached default-cards.json")
        print("Run the database builder once to download it, or re-download:")
        print("  python scripts/db_builder.py")
        sys.exit(1)

    # Connect to DB and add columns
    conn = sqlite3.connect(str(DB_PATH))
    add_price_columns(conn)

    total_before, prices_before = count_prices(conn)
    print(f"Database before: {total_before} total cards, {prices_before} with prices")

    # Build lookup of card IDs that need prices
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM cards WHERE usd_price IS NULL OR usd_price = ''")
    need_price_ids = {row[0] for row in cursor.fetchall()}
    print(f"Cards needing price update: {len(need_price_ids)}")

    if not need_price_ids:
        print("All cards already have prices. Nothing to do!")
        conn.close()
        return

    # Stream through the JSON and extract prices
    print(f"\nStreaming prices from {BULK_FILE.name}...")
    updated = 0
    skipped = 0
    start = time.time()

    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA journal_mode=MEMORY")

    batch = []
    with open(BULK_FILE, 'rb') as f:
        parser = ijson.parse(f)
        for card in ijson.items(parser, 'item'):
            card_id = card.get('id')
            if card_id and card_id in need_price_ids:
                prices = card.get('prices', {}) or {}
                usd = prices.get('usd', '') or ''
                usd_foil = prices.get('usd_foil', '') or ''
                batch.append((usd, usd_foil, card_id))

                if len(batch) >= 5000:
                    cursor.executemany(
                        "UPDATE cards SET usd_price = ?, usd_foil_price = ? WHERE id = ?",
                        batch
                    )
                    conn.commit()
                    updated += len(batch)
                    batch = []
                    if updated % 25000 == 0:
                        elapsed = time.time() - start
                        print(f"  Updated {updated} cards ({elapsed:.1f}s)")

    # Flush remaining batch
    if batch:
        cursor.executemany(
            "UPDATE cards SET usd_price = ?, usd_foil_price = ? WHERE id = ?",
            batch
        )
        conn.commit()
        updated += len(batch)

    elapsed = time.time() - start
    print(f"\nUpdated {updated} cards with prices in {elapsed:.1f}s")

    # Final stats
    total_after, prices_after = count_prices(conn)
    print(f"Database after:  {total_after} total cards, {prices_after} with prices")

    conn.close()
    print("\nDone! Prices backfilled successfully.")


if __name__ == "__main__":
    main()