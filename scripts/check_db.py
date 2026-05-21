import sqlite3
import sys

db_path = sys.argv[1] if len(sys.argv) > 1 else "C:\\Users\\jimmy\\Desktop\\mtg-card-scanner\\data\\mtg_cards.db"

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(*) FROM cards")
    total = cursor.fetchone()[0]
    
    cursor.execute("SELECT COUNT(*) FROM cards WHERE full_card_phash IS NOT NULL")
    with_hash = cursor.fetchone()[0]
    
    print(f"Total cards in database: {total}")
    print(f"Cards with hashes: {with_hash}")
    
    conn.close()
except Exception as e:
    print(f"Error: {e}")