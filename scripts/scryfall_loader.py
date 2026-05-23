#!/usr/bin/env python3
"""
Scryfall Bulk Data Loader for tbl_card
========================================
Downloads Scryfall's default_cards bulk JSON and inserts/updates
all cards into the MariaDB tbl_card table.

Usage:
    python scripts/scryfall_loader.py

Requires: mysql-connector-python, requests
Install: pip install mysql-connector-python requests
"""

import json
import sys
import time
import os
import urllib.request
import urllib.error
import gzip
import io

DB_CONFIG = {
    'host': '192.168.4.37',
    'user': 'mtgscanner',
    'password': 'Cookmush888!',
    'database': 'mtg_inventory',
    'charset': 'utf8mb4'
}

SCRYFALL_BULK_URL = 'https://api.scryfall.com/bulk-data'

try:
    import mysql.connector
except ImportError:
    print("ERROR: mysql-connector-python not installed.")
    print("Run: pip install mysql-connector-python requests")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: requests not installed.")
    print("Run: pip install requests")
    sys.exit(1)


def safe_val(val, max_len=None):
    """Return None for None, otherwise stringify. Truncate if max_len given."""
    if val is None:
        return None
    s = str(val)
    if max_len and len(s) > max_len:
        s = s[:max_len]
    return s


def safe_float(val):
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def safe_int(val):
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def get_bulk_data_url():
    """Get the download URL for the default_cards bulk data."""
    print("Fetching Scryfall bulk data manifest...")
    resp = requests.get(SCRYFALL_BULK_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    
    for entry in data.get('data', []):
        if entry.get('type') == 'default_cards':
            url = entry['download_uri']
            size = entry.get('size', 0)
            size_mb = size / (1024 * 1024)
            print(f"Found default_cards bulk data: {size_mb:.1f} MB")
            print(f"Last updated: {entry.get('updated_at', 'unknown')}")
            return url
    
    print("ERROR: Could not find default_cards bulk data type")
    sys.exit(1)


def download_and_parse(url):
    """Download the bulk data (gzipped JSON) and yield parsed card objects."""
    print(f"Downloading bulk data...")
    req = urllib.request.Request(url, headers={'User-Agent': 'MTG-Scanner/1.0'})
    
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            content_type = response.headers.get('Content-Encoding', '')
            raw = response.read()
            
            if 'gzip' in content_type or url.endswith('.gz'):
                buf = io.BytesIO(raw)
                with gzip.GzipFile(fileobj=buf) as f:
                    data = json.loads(f.read())
            else:
                data = json.loads(raw.decode('utf-8'))
            
            if isinstance(data, list):
                return data
            elif isinstance(data, dict) and 'data' in data:
                return data['data']
            else:
                print(f"ERROR: Unexpected JSON structure: {type(data)}")
                sys.exit(1)
    except Exception as e:
        print(f"ERROR downloading: {e}")
        sys.exit(1)


def create_table_if_not_exists(cursor):
    """Create tbl_card if it doesn't exist."""
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tbl_card (
            scryfall_id VARCHAR(64) PRIMARY KEY,
            oracle_id VARCHAR(64) DEFAULT '',
            name VARCHAR(255) DEFAULT '',
            set_code VARCHAR(8) DEFAULT '',
            set_name VARCHAR(128) DEFAULT '',
            collector_number VARCHAR(16) DEFAULT '',
            lang VARCHAR(8) DEFAULT '',
            released_at DATE DEFAULT NULL,
            layout VARCHAR(32) DEFAULT '',
            mana_cost VARCHAR(64) DEFAULT '',
            cmc DECIMAL(5,1) DEFAULT 0.0,
            type_line VARCHAR(255) DEFAULT '',
            oracle_text TEXT DEFAULT NULL,
            power VARCHAR(8) DEFAULT '',
            toughness VARCHAR(8) DEFAULT '',
            loyalty VARCHAR(8) DEFAULT '',
            colors VARCHAR(64) DEFAULT '',
            color_identity VARCHAR(64) DEFAULT '',
            keywords TEXT DEFAULT NULL,
            rarity VARCHAR(16) DEFAULT '',
            artist VARCHAR(128) DEFAULT '',
            image_uris TEXT DEFAULT NULL,
            card_faces TEXT DEFAULT NULL,
            legalities TEXT DEFAULT NULL,
            prices TEXT DEFAULT NULL,
            purchase_uris TEXT DEFAULT NULL,
            edhrec_rank INT DEFAULT NULL,
            reserved TINYINT(1) DEFAULT 0,
            foil_available TINYINT(1) DEFAULT 0,
            nonfoil_available TINYINT(1) DEFAULT 0,
            finishes VARCHAR(64) DEFAULT '',
            promo TINYINT(1) DEFAULT 0,
            promo_types VARCHAR(128) DEFAULT '',
            digital TINYINT(1) DEFAULT 0,
            tcgplayer_id INT DEFAULT NULL,
            cardmarket_id INT DEFAULT NULL,
            scryfall_uri VARCHAR(255) DEFAULT '',
            INDEX idx_name (name),
            INDEX idx_set_code (set_code),
            INDEX idx_oracle_id (oracle_id)
        )
    """)


def insert_card(cursor, card):
    """Insert or update a single card in tbl_card."""
    image_uris = card.get('image_uris')
    card_faces = card.get('card_faces')
    legalities = card.get('legalities')
    prices = card.get('prices')
    purchase_uris = card.get('purchase_uris')
    keywords = card.get('keywords', [])
    finishes = card.get('finishes', [])
    promo_types = card.get('promo_types', [])
    colors = card.get('colors', [])
    color_identity = card.get('color_identity', [])
    
    sql = """
        INSERT INTO tbl_card (
            scryfall_id, oracle_id, name, set_code, set_name,
            collector_number, lang, released_at, layout, mana_cost,
            cmc, type_line, oracle_text, power, toughness,
            loyalty, colors, color_identity, keywords, rarity,
            artist, image_uris, card_faces, legalities, prices,
            purchase_uris, edhrec_rank, reserved, foil_available,
            nonfoil_available, finishes, promo, promo_types, digital,
            tcgplayer_id, cardmarket_id, scryfall_uri
        ) VALUES (
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s
        ) ON DUPLICATE KEY UPDATE
            oracle_id = VALUES(oracle_id),
            name = VALUES(name),
            set_code = VALUES(set_code),
            set_name = VALUES(set_name),
            collector_number = VALUES(collector_number),
            lang = VALUES(lang),
            released_at = VALUES(released_at),
            layout = VALUES(layout),
            mana_cost = VALUES(mana_cost),
            cmc = VALUES(cmc),
            type_line = VALUES(type_line),
            oracle_text = VALUES(oracle_text),
            power = VALUES(power),
            toughness = VALUES(toughness),
            loyalty = VALUES(loyalty),
            colors = VALUES(colors),
            color_identity = VALUES(color_identity),
            keywords = VALUES(keywords),
            rarity = VALUES(rarity),
            artist = VALUES(artist),
            image_uris = VALUES(image_uris),
            card_faces = VALUES(card_faces),
            legalities = VALUES(legalities),
            prices = VALUES(prices),
            purchase_uris = VALUES(purchase_uris),
            edhrec_rank = VALUES(edhrec_rank),
            reserved = VALUES(reserved),
            foil_available = VALUES(foil_available),
            nonfoil_available = VALUES(nonfoil_available),
            finishes = VALUES(finishes),
            promo = VALUES(promo),
            promo_types = VALUES(promo_types),
            digital = VALUES(digital),
            tcgplayer_id = VALUES(tcgplayer_id),
            cardmarket_id = VALUES(cardmarket_id),
            scryfall_uri = VALUES(scryfall_uri)
    """
    
    params = (
        safe_val(card.get('id'), 64),
        safe_val(card.get('oracle_id'), 64),
        safe_val(card.get('name'), 255),
        safe_val(card.get('set'), 8),
        safe_val(card.get('set_name'), 128),
        safe_val(card.get('collector_number'), 16),
        safe_val(card.get('lang'), 8),
        safe_val(card.get('released_at')),
        safe_val(card.get('layout'), 32),
        safe_val(card.get('mana_cost'), 64),
        safe_float(card.get('cmc')),
        safe_val(card.get('type_line'), 255),
        safe_val(card.get('oracle_text')),
        safe_val(card.get('power'), 8),
        safe_val(card.get('toughness'), 8),
        safe_val(card.get('loyalty'), 8),
        json.dumps(colors) if colors else None,
        json.dumps(color_identity) if color_identity else None,
        json.dumps(keywords) if keywords else None,
        safe_val(card.get('rarity'), 16),
        safe_val(card.get('artist'), 128),
        json.dumps(image_uris) if image_uris else None,
        json.dumps(card_faces) if card_faces else None,
        json.dumps(legalities) if legalities else None,
        json.dumps(prices) if prices else None,
        json.dumps(purchase_uris) if purchase_uris else None,
        safe_int(card.get('edhrec_rank')),
        1 if card.get('reserved') else 0,
        1 if card.get('foil') else 0,
        1 if card.get('nonfoil') else 0,
        json.dumps(finishes) if finishes else None,
        1 if card.get('promo') else 0,
        json.dumps(promo_types) if promo_types else None,
        1 if card.get('digital') else 0,
        safe_int(card.get('tcgplayer_id')),
        safe_int(card.get('cardmarket_id')),
        safe_val(card.get('scryfall_uri'), 255)
    )
    
    cursor.execute(sql, params)


def main():
    print("=" * 60)
    print("MTG Scanner — Scryfall tbl_card Loader")
    print("=" * 60)
    
    # Connect to MariaDB
    print("\nConnecting to MariaDB...")
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        cursor = conn.cursor()
        print("Connected successfully.")
    except mysql.connector.Error as err:
        print(f"ERROR connecting to MariaDB: {err}")
        sys.exit(1)
    
    # Ensure table exists
    create_table_if_not_exists(cursor)
    conn.commit()
    print("Table tbl_card ready.")
    
    # Get bulk data URL
    url = get_bulk_data_url()
    
    # Download and parse
    print("\nDownloading card data (this may take a while)...")
    cards = download_and_parse(url)
    
    total = len(cards)
    print(f"Parsed {total} cards. Inserting into database...")
    
    batch_size = 500
    inserted = 0
    errors = 0
    start_time = time.time()
    
    for i, card in enumerate(cards):
        try:
            # Only insert actual card objects (skip tokens, etc. that have no name)
            if not card.get('name') or not card.get('id'):
                continue
            insert_card(cursor, card)
            inserted += 1
            
            if inserted % batch_size == 0:
                conn.commit()
                elapsed = time.time() - start_time
                rate = inserted / elapsed if elapsed > 0 else 0
                pct = (i + 1) / total * 100
                print(f"  {inserted} cards inserted ({pct:.1f}%, {rate:.0f} cards/sec)")
                
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  Error on card {card.get('name', '?')}: {e}")
    
    # Final commit
    conn.commit()
    
    elapsed = time.time() - start_time
    print(f"\n{'=' * 60}")
    print(f"Complete! Inserted {inserted} cards in {elapsed:.1f}s")
    if errors:
        print(f"Errors: {errors}")
    
    # Cleanup
    cursor.close()
    conn.close()
    print("Database connection closed.")


if __name__ == '__main__':
    main()