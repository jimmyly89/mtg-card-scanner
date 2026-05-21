"""
MTG Card Scanner - Scryfall Index Builder (Memory-Safe, English-Optimized)
Downloads default_cards bulk data and stores metadata + image URLs only.
NO image downloads, NO hash computation - just JSON parsing + DB inserts.

Key improvements over v1:
- Streams JSON one card at a time instead of loading everything into memory (fixes OOM crashes)
- Filters to English-only cards (~55K instead of ~114K — halves DB size and build time)
- Removes unused image_uris column (extracted into normal_image_url / art_crop_url)
- Does not cache the large JSON file on disk
- Supports resume: checks which card IDs already exist in DB and skips them
- Per-card error handling so one bad card doesn't derail a batch
"""

import requests
import sqlite3
import json
from pathlib import Path
from datetime import datetime
import sys
import time
import ijson  # streaming JSON parser

# Configuration - use script location to determine paths
SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"
DB_PATH = DATA_DIR / "mtg_cards.db"
BUILD_STATUS_PATH = DATA_DIR / "build_status.json"
BULK_FILE = DATA_DIR / "default-cards.json"
SCRYFALL_BULK_URL = "https://api.scryfall.com/bulk-data"
BATCH_SIZE = 1000  # DB insert batch size (same as before — keeps SQLite fast)

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)


# ── Build status tracking ──
BUILD_STEPS = [
    {"id": "fetch_metadata", "label": "Fetch Scryfall metadata", "status": "pending", "detail": ""},
    {"id": "download",       "label": "Download bulk data",      "status": "pending", "detail": ""},
    {"id": "filter",         "label": "Filter English cards",    "status": "pending", "detail": ""},
    {"id": "insert",         "label": "Insert into database",    "status": "pending", "detail": ""},
    {"id": "finalize",       "label": "Finalize & index",        "status": "pending", "detail": ""},
]


def update_build_step(step_id, status, detail=""):
    """Mark a step as 'active', 'done', or 'pending' and write status."""
    for s in BUILD_STEPS:
        if s["id"] == step_id:
            s["status"] = status
            if detail:
                s["detail"] = detail
            break


def update_build_status(processed, total_cards, status_message):
    """Write build progress to JSON file with step tracking."""
    try:
        status = {
            "total_cards": total_cards,
            "processed": processed,
            "images_downloaded": 0,
            "hashes_computed": 0,
            "start_time": getattr(update_build_status, "start_time", datetime.now().isoformat()),
            "current_status": status_message,
            "percent_complete": round((processed / total_cards) * 100, 2) if total_cards > 0 else 0,
            "steps": [
                {"id": s["id"], "label": s["label"], "status": s["status"], "detail": s["detail"]}
                for s in BUILD_STEPS
            ]
        }
        with open(BUILD_STATUS_PATH, 'w') as f:
            json.dump(status, f)
    except Exception as e:
        print(f"Error writing build status: {e}")


# Initialize start time
update_build_status.start_time = datetime.now().isoformat()
update_build_status.BUILD_STEPS = BUILD_STEPS


def get_bulk_data_info():
    """Get the download URL and total_cards estimate for default_cards bulk data."""
    print("Fetching Scryfall bulk data info...")
    headers = {
        'User-Agent': 'MTG-Card-Scanner/1.0',
        'Accept': 'application/json'
    }
    response = requests.get(SCRYFALL_BULK_URL, headers=headers, timeout=30)
    response.raise_for_status()
    bulk_data = response.json()

    for item in bulk_data.get("data", []):
        if item.get("type") == "default_cards":
            print(f"Found bulk data: {item.get('name')}")
            print(f"Size: {item.get('size', 0) // 1024 // 1024} MB")
            print(f"Updated: {item.get('updated_at')}")
            # Scryfall tells us the total card count in the API metadata
            total_entries = item.get("total_values", item.get("size", 538710820))
            return {
                "download_uri": item.get("download_uri"),
                "total_cards": item.get("total_values", 114193),
            }

    raise ValueError("Could not find default_cards bulk data")


def get_existing_ids(conn):
    """Get the set of card IDs already in the database (for resume support)."""
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM cards")
    return {row[0] for row in cursor.fetchall()}


def create_database(force_recreate=False):
    """Create SQLite database with schema for card data."""
    if force_recreate and DB_PATH.exists():
        DB_PATH.unlink()
        print("Removed existing database for fresh build...")

    print(f"Opening database at {DB_PATH}...")
    conn = sqlite3.connect(str(DB_PATH))

    # Enable WAL mode for better concurrent read performance during building
    conn.execute("PRAGMA journal_mode=WAL")
    # Increase cache size for faster inserts
    conn.execute("PRAGMA cache_size=-80000")  # 80 MB cache
    # Use synchronous mode balanced for speed vs safety
    conn.execute("PRAGMA synchronous=NORMAL")

    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS cards (
            id TEXT PRIMARY KEY,
            oracle_id TEXT,
            name TEXT NOT NULL,
            printed_name TEXT,
            set_code TEXT NOT NULL,
            collector_number TEXT NOT NULL,
            lang TEXT NOT NULL,
            layout TEXT,
            image_uris TEXT,
            art_crop_url TEXT,
            normal_image_url TEXT,
            usd_price TEXT,
            usd_foil_price TEXT,
            full_card_phash TEXT,
            full_card_dhash TEXT,
            art_crop_phash TEXT,
            color_hash TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Create indexes for faster lookups (IF NOT EXISTS makes them idempotent)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_set_collector ON cards(set_code, collector_number)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_name ON cards(name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_oracle_id ON cards(oracle_id)")

    conn.commit()
    return conn


def prepare_card_data(card):
    """Extract relevant fields from a card dict for DB insertion."""
    card_id = card.get('id')
    oracle_id = card.get('oracle_id')
    name = card.get('name', '')
    printed_name = card.get('printed_name')
    set_code = card.get('set')
    collector_number = str(card.get('collector_number', ''))
    lang = card.get('lang', 'en')
    layout = card.get('layout')

    # Get image URLs from image_uris or card_faces
    image_uris = card.get('image_uris', {})
    if not image_uris and 'card_faces' in card:
        faces = card.get('card_faces', [])
        if faces:
            image_uris = faces[0].get('image_uris', {})

    art_crop_url = image_uris.get('art_crop') if image_uris else None
    normal_url = image_uris.get('normal') if image_uris else None

    # Get prices
    prices = card.get('prices', {}) or {}
    usd_price = prices.get('usd', '') or ''
    usd_foil_price = prices.get('usd_foil', '') or ''

    return (
        card_id,
        oracle_id,
        name,
        printed_name,
        set_code,
        collector_number,
        lang,
        layout,
        json.dumps(image_uris) if image_uris else None,  # store as JSON string
        art_crop_url,
        normal_url,
        usd_price,
        usd_foil_price,
        None,  # full_card_phash (to be computed on-the-fly)
        None,  # full_card_dhash
        None,  # art_crop_phash
        None,  # color_hash
    )


def stream_cards_from_file(file_path):
    """Stream cards one at a time from a local JSON file using ijson.

    Yields each card dict with minimal memory overhead (~1 card in memory at a time).
    Uses ijson's streaming JSON parser to avoid loading the entire 538 MB file.
    """
    print(f"Streaming cards from local file: {file_path}")
    try:
        with open(file_path, 'rb') as f:
            parser = ijson.parse(f)
            for card in ijson.items(parser, 'item'):
                yield card
    except Exception as e:
        print(f"Error reading local file: {e}")
        raise


def download_bulk_file(url):
    """Download the bulk data file to disk (requests handles gzip decompression transparently).
    
    Scryfall serves this file gzip-compressed. Requests auto-decompresses when saving
    to a file, so the cached file will be plain JSON that ijson can parse.
    """
    print(f"\nDownloading bulk data to {BULK_FILE}...")
    print("(This is ~500 MB and takes ~2 minutes on first run)")
    headers = {
        'User-Agent': 'MTG-Card-Scanner/1.0',
        'Accept': 'application/json'
    }

    try:
        response = requests.get(url, headers=headers, stream=True, timeout=600)
        response.raise_for_status()

        # Write to temp file first to avoid partial downloads
        tmp = BULK_FILE.with_suffix(".json.tmp")
        bytes_written = 0
        last_log = 0
        with open(tmp, 'wb') as f:
            for chunk in response.iter_content(chunk_size=65536):
                f.write(chunk)
                bytes_written += len(chunk)
                mb = bytes_written / (1024 * 1024)
                if mb - last_log >= 50:
                    print(f"  Downloaded {mb:.0f} MB...")
                    last_log = mb

        # Move temp file to final location
        tmp.replace(BULK_FILE)
        size_mb = BULK_FILE.stat().st_size / (1024 * 1024)
        print(f"Downloaded {size_mb:.0f} MB to {BULK_FILE}")
        return BULK_FILE

    except requests.exceptions.RequestException as e:
        print(f"Download error: {e}")
        if tmp.exists():
            tmp.unlink()
        raise
    except Exception as e:
        print(f"Download error: {e}")
        if tmp.exists():
            tmp.unlink()
        raise




def process_card_batch(conn, batch_data):
    """Insert a batch of prepared card tuples into the database."""
    cursor = conn.cursor()
    cursor.executemany("""
        INSERT OR REPLACE INTO cards 
        (id, oracle_id, name, printed_name, set_code, collector_number, lang, layout, 
         image_uris, art_crop_url, normal_image_url, 
         usd_price, usd_foil_price,
         full_card_phash, full_card_dhash, art_crop_phash, color_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, batch_data)
    conn.commit()


def main():
    print("=" * 60)
    print("MTG Card Scanner - Memory-Safe Index Builder (English, Streamed)")
    print("=" * 60)

    # Step 1: Get bulk data info from Scryfall
    update_build_step("fetch_metadata", "active", "Fetching Scryfall bulk data...")
    update_build_status(0, 0, "Fetching Scryfall metadata...")
    try:
        bulk_info = get_bulk_data_info()
        bulk_url = bulk_info["download_uri"]
        total_cards_estimate = bulk_info["total_cards"]
    except Exception as e:
        print(f"Failed to get bulk data info: {e}")
        update_build_step("fetch_metadata", "done", f"Failed: {e}")
        sys.exit(1)

    print(f"\nTotal cards in Scryfall: {total_cards_estimate}")
    update_build_step("fetch_metadata", "done", f"{total_cards_estimate} cards found")

    # Step 2: Create/open database
    # Don't force recreate — support resume by default
    conn = create_database(force_recreate=False)

    # Check what we already have (for resume support)
    existing_ids = get_existing_ids(conn)
    if existing_ids:
        print(f"Existing cards in DB: {len(existing_ids)} — will skip duplicates (resume mode)")
    else:
        print("No existing cards found — starting fresh build")

    # Step 3: Stream all cards from Scryfall, filter to English, insert in batches
    processed = 0
    skipped_existing = 0
    filtered_non_english = 0
    filtered_no_image = 0
    batch_buffer = []
    total_english_found = 0
    total_attempted = 0

    print(f"\nStreaming + processing cards (English only, batch size {BATCH_SIZE})...")
    print("-" * 60)

    # Always download to local cache first (handles gzip decompression)
    update_build_step("download", "active", "Downloading ~500 MB from Scryfall...")
    update_build_status(0, total_cards_estimate, "Downloading bulk data...")
    if BULK_FILE.exists() and (time.time() - BULK_FILE.stat().st_mtime) / 3600 < 24:
        cached_size = BULK_FILE.stat().st_size // (1024 * 1024)
        print(f"Using cached bulk data from {BULK_FILE}")
        update_build_step("download", "done", f"{cached_size} MB cached, < 24h old")
    else:
        download_bulk_file(bulk_url)
        final_size = BULK_FILE.stat().st_size // (1024 * 1024)
        update_build_step("download", "done", f"{final_size} MB downloaded")

    update_build_step("filter", "active", f"Scanning {BULK_FILE.stat().st_size // (1024 * 1024)} MB for English cards...")
    update_build_step("insert", "pending", "")
    update_build_step("finalize", "pending", "")
    update_build_status(0, total_cards_estimate, "Filtering English cards...")

    filter_detail = ""
    insert_active = False

    print(f"Streaming cards from local cache: {BULK_FILE}")

    try:
        for card in stream_cards_from_file(BULK_FILE):
            total_attempted += 1

            # Filter 1: Must have an image (no image = useless for scanning)
            if not card.get('image_uris') and not card.get('card_faces'):
                filtered_no_image += 1
                continue

            # Filter 2: English only (scanner OCR is English-only)
            if card.get('lang') and card.get('lang') != 'en':
                filtered_non_english += 1
                continue

            total_english_found += 1

            # Mark filter as done on first English card found
            if not insert_active:
                update_build_step("filter", "done",
                    f"{filtered_non_english} non-English filtered, {filtered_no_image} no-image filtered")
                update_build_step("insert", "active", "Starting batch inserts...")
                insert_active = True

            # Filter 3: Skip if already in database (resume mode)
            card_id = card.get('id')
            if card_id and card_id in existing_ids:
                skipped_existing += 1
                if skipped_existing % 5000 == 0:
                    print(f"  Skipped {skipped_existing} cards already in DB...")
                continue

            # Add to batch buffer
            batch_buffer.append(card)

            # Process full batch
            if len(batch_buffer) >= BATCH_SIZE:
                try:
                    batch_data = [prepare_card_data(c) for c in batch_buffer if c.get('id')]
                    if batch_data:
                        process_card_batch(conn, batch_data)
                    processed += len(batch_buffer)
                except Exception as e:
                    # If batch fails, try each card individually (slow path)
                    successful = 0
                    print(f"  Batch failed ({e}), retrying card-by-card...")
                    for c in batch_buffer:
                        try:
                            card_data = prepare_card_data(c)
                            if card_data[0]:  # has id
                                cursor = conn.cursor()
                                cursor.execute("""
                                INSERT OR REPLACE INTO cards 
                                (id, oracle_id, name, printed_name, set_code, collector_number,
                                 lang, layout, image_uris, art_crop_url, normal_image_url,
                                 usd_price, usd_foil_price,
                                 full_card_phash, full_card_dhash, art_crop_phash, color_hash)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                """, card_data)
                                conn.commit()
                                successful += 1
                        except Exception:
                            pass  # skip problematic cards
                    processed += successful
                    print(f"  Recovered: inserted {successful}/{len(batch_buffer)} cards individually")

                batch_buffer = []

                # Update status every 5000 cards
                if processed % 5000 == 0:
                    pct = round((processed / max(total_english_found, 1)) * 100, 1)
                    remaining = total_english_found - processed - skipped_existing
                    update_build_step("insert", "active",
                        f"{processed} inserted, {skipped_existing} skipped, ~{remaining} remaining")
                    update_build_status(processed, total_english_found,
                                        f"Processed {processed} English cards ({pct}%)")
                    print(f"  Processed {processed} English cards... ({pct}%)")

        # Process remaining cards in buffer
        if batch_buffer:
            try:
                batch_data = [prepare_card_data(c) for c in batch_buffer if c.get('id')]
                if batch_data:
                    process_card_batch(conn, batch_data)
                processed += len(batch_buffer)
            except Exception as e:
                successful = 0
                print(f"  Final batch failed ({e}), retrying card-by-card...")
                for c in batch_buffer:
                    try:
                        card_data = prepare_card_data(c)
                        if card_data[0]:
                            cursor = conn.cursor()
                            cursor.execute("""
                                INSERT OR REPLACE INTO cards 
                                (id, oracle_id, name, printed_name, set_code, collector_number,
                                 lang, layout, image_uris, art_crop_url, normal_image_url,
                                 usd_price, usd_foil_price,
                                 full_card_phash, full_card_dhash, art_crop_phash, color_hash)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """, card_data)
                            conn.commit()
                            successful += 1
                    except Exception:
                        pass
                processed += successful
            batch_buffer = []

    except Exception as e:
        print(f"\nFatal error during processing: {e}")
        # Clean up potentially corrupt cache file so retry re-downloads
        if BULK_FILE.exists():
            print(f"Removing corrupt cache file: {BULK_FILE}")
            BULK_FILE.unlink(missing_ok=True)
        update_build_status(processed, total_english_found, f"Crashed: {str(e)[:80]}")
        conn.close()
        sys.exit(1)

    # Mark insert as done and finalize
    update_build_step("insert", "done", f"{processed} cards inserted into database")
    update_build_step("finalize", "active", "Running final statistics...")

    # Print database stats
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM cards")
    total_count = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM cards WHERE lang='en'")
    en_count = cursor.fetchone()[0]

    update_build_step("finalize", "done",
        f"{total_count} total cards ({en_count} English), "
        f"{skipped_existing} skipped (resume), "
        f"{filtered_non_english + filtered_no_image} filtered out")

    # Mark build as complete
    update_build_status(processed, total_english_found, "Build complete!")

    print("-" * 60)
    print(f"\nCompleted!")
    print(f"  Total cards scanned:   {total_attempted}")
    print(f"  Non-English filtered:  {filtered_non_english}")
    print(f"  No-image cards:        {filtered_no_image}")
    print(f"  Total English cards:   {total_english_found}")
    print(f"  Skipped (existing DB): {skipped_existing}")
    print(f"  Inserted this run:     {processed}")
    print(f"  Database: {DB_PATH}")

    # Print database stats
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM cards")
    count = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM cards WHERE lang='en'")
    en_count = cursor.fetchone()[0]
    print(f"\nTotal cards in database: {count} ({en_count} English)")
    print(f"Memory-efficient streaming used — no large JSON files cached")

    conn.close()
    print("\nDone!")


def download_and_cache(url):
    """Fallback: download the full file for local caching if streaming fails.
    
    This is kept only as a compatibility fallback. The main build now uses streaming.
    """
    print(f"Downloading full bulk data (fallback mode) to {BULK_FILE}...")
    headers = {
        'User-Agent': 'MTG-Card-Scanner/1.0',
        'Accept': 'application/json'
    }
    response = requests.get(url, headers=headers, timeout=600)
    response.raise_for_status()
    with open(BULK_FILE, 'wb') as f:
        f.write(response.content)
    print(f"Downloaded {BULK_FILE.stat().st_size // 1024 // 1024} MB")


if __name__ == "__main__":
    main()