"""
Card Identifier using OCR + On-the-Fly Hashing
1. OCR the scanned card to get name
2. Lookup candidates by name in DB (5-20 cards)
3. Download + hash only those candidates (with caching)
4. Compare scanned card against candidates
"""

import sqlite3
import imagehash
from PIL import Image
import cv2
import numpy as np
import os
import sys
from pathlib import Path
import json
import requests
import io
import pytesseract

# Tesseract configuration
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

# Configuration - use script location to determine paths
SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"
DB_PATH = DATA_DIR / "mtg_cards.db"
IMAGE_DIR = DATA_DIR / "card_images"

# Weights for final scoring
HASH_WEIGHT = 0.60
ORB_SIFT_WEIGHT = 0.25
TEMPLATE_WEIGHT = 0.15

def hamming_distance(hash1_str, hash2_str):
    """Calculate Hamming distance between two hash strings."""
    if not hash1_str or not hash2_str:
        return float('inf')
    
    try:
        h1 = int(hash1_str, 16)
        h2 = int(hash2_str, 16)
        return bin(h1 ^ h2).count('1')
    except:
        return float('inf')

def compute_image_hashes(image_path):
    """Compute perceptual hashes for an image."""
    try:
        img = Image.open(image_path)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        return {
            'phash': str(imagehash.phash(img)),
            'dhash': str(imagehash.dhash(img)),
            'colorhash': str(imagehash.colorhash(img))
        }
    except Exception as e:
        print(f"Error computing hashes for {image_path}: {e}")
        return None

def ocr_card_name(image_path):
    """OCR the image to extract card name.
    
    Strategy: Crop to the top ~15% (title region) and use PSM 7
    (single text line) for much better accuracy on card titles.
    """
    try:
        # Load and preprocess image
        img = cv2.imread(image_path)
        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Crop to top 15% — the title bar region (excludes art, text box, P/T)
        title_h = max(30, int(h * 0.15))
        title_region = gray[0:title_h, 0:w]
        
        # Upscale 2x for better OCR on small text
        title_region = cv2.resize(title_region, None, fx=2, fy=2, 
                                   interpolation=cv2.INTER_CUBIC)
        
        # Apply Otsu binarization to get clean black-on-white text
        _, title_binary = cv2.threshold(title_region, 0, 255, 
                                        cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # OCR restricted to the title region — PSM 7 = single text line
        # Whitelist common card name characters only
        custom_config = '--psm 7 -c tessedit_char_whitelist="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\',- "'
        text = pytesseract.image_to_string(title_binary, config=custom_config)
        
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        
        if lines:
            card_name = lines[0]
            print(f"[OCR] Title-region OCR result: '{card_name}'")
            return card_name
        
        # Fallback: OCR the whole image with PSM 6
        print("[OCR] Title region empty, falling back to full-image OCR...")
        text = pytesseract.image_to_string(gray, config='--psm 6')
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        if lines:
            card_name = lines[0]
            print(f"[OCR] Fallback OCR result: '{card_name}'")
            return card_name
        
        return None
    except Exception as e:
        print(f"OCR error: {e}")
        return None

def lookup_candidates_by_name(conn, card_name):
    """Lookup cards by name in database."""
    cursor = conn.cursor()
    
    # Try exact match first
    cursor.execute("""
        SELECT id, name, set_code, collector_number, lang, 
               full_card_phash, full_card_dhash, art_crop_phash, color_hash,
               art_crop_url, normal_image_url
        FROM cards 
        WHERE name LIKE ?
        LIMIT 20
    """, (f"%{card_name}%",))
    
    cards = cursor.fetchall()
    
    if not cards:
        # Try more fuzzy match
        cursor.execute("""
            SELECT id, name, set_code, collector_number, lang, 
                   full_card_phash, full_card_dhash, art_crop_phash, color_hash,
                   art_crop_url, normal_image_url
            FROM cards 
            WHERE LOWER(name) LIKE LOWER(?)
            LIMIT 20
        """, (f"%{card_name}%",))
        cards = cursor.fetchall()
    
    candidates = []
    for card in cards:
        (card_id, name, set_code, collector_number, lang,
         full_phash, full_dhash, art_phash, color_hash,
         art_crop_url, normal_image_url) = card
    
        candidates.append({
            'id': card_id,
            'name': name,
            'set_code': set_code,
            'collector_number': collector_number,
            'lang': lang,
            'full_card_phash': full_phash,
            'full_card_dhash': full_dhash,
            'art_crop_phash': art_phash,
            'color_hash': color_hash,
            'art_crop_url': art_crop_url,
            'normal_image_url': normal_image_url
        })
    
    return candidates

def download_and_hash_candidate(candidate, image_dir):
    """Download candidate image and compute hashes if not already cached."""
    card_id = candidate['id']
    normal_url = candidate.get('normal_image_url')
    
    if not normal_url:
        return candidate
    
    # Check if hashes already computed
    if candidate.get('full_card_phash'):
        return candidate  # Already hashed
    
    # Download image
    try:
        response = requests.get(normal_url, timeout=10)
        response.raise_for_status()
        
        # Save temporarily
        temp_path = str(image_dir / f"temp_{card_id}.jpg")
        with open(temp_path, 'wb') as f:
            f.write(response.content)
        
        # Compute hashes
        hashes = compute_image_hashes(temp_path)
        
        if hashes:
            candidate['full_card_phash'] = hashes['phash']
            candidate['full_card_dhash'] = hashes['dhash']
            candidate['color_hash'] = hashes['colorhash']
            
            # Update database with hashes
            try:
                conn = sqlite3.connect(str(DB_PATH))
                cursor = conn.cursor()
                cursor.execute("""
                    UPDATE cards 
                    SET full_card_phash = ?, full_card_dhash = ?, color_hash = ?
                    WHERE id = ?
                """, (hashes['phash'], hashes['dhash'], hashes['colorhash'], card_id))
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"Error updating DB with hashes: {e}")
            
            # Cleanup temp file
            try:
                os.remove(temp_path)
            except:
                pass
        
    except Exception as e:
        print(f"Error downloading {normal_url}: {e}")
    
    return candidate

def compare_with_candidates(query_hashes, candidates):
    """Compare query hashes against candidates and return scored list.
    
    Uses all three hash types with the following weight breakdown:
    - phash (perceptual): 35% — best overall structural similarity
    - dhash (difference): 15% — captures edge/gradient differences
    - colorhash:          10% — distinguishes cards with different color profiles
    Total hash weight = 60% (the HASH_WEIGHT constant).
    """
    # Sub-weights within the 60% hash budget
    PHASH_SUB = 0.35
    DHASH_SUB = 0.15
    COLOR_SUB = 0.10
    
    results = []
    
    for candidate in candidates:
        scores = []
        
        # --- pHash comparison (35% of total score) ---
        if candidate.get('full_card_phash') and query_hashes.get('phash'):
            dist = hamming_distance(query_hashes['phash'], candidate['full_card_phash'])
            similarity = max(0, 1.0 - (dist / 64.0))
            scores.append(similarity * PHASH_SUB)
        
        # --- dHash comparison (15% of total score) ---
        if candidate.get('full_card_dhash') and query_hashes.get('dhash'):
            dist = hamming_distance(query_hashes['dhash'], candidate['full_card_dhash'])
            similarity = max(0, 1.0 - (dist / 64.0))
            scores.append(similarity * DHASH_SUB)
        
        # --- ColorHash comparison (10% of total score) ---
        if candidate.get('color_hash') and query_hashes.get('colorhash'):
            dist = hamming_distance(query_hashes['colorhash'], candidate['color_hash'])
            similarity = max(0, 1.0 - (dist / 32.0))
            scores.append(similarity * COLOR_SUB)
        
        # Add candidate to results if we have any scores
        if scores:
            combined_score = sum(scores)
            results.append({
                'candidate': candidate,
                'score': combined_score
            })
    
    # Sort by score descending
    results.sort(key=lambda x: x['score'], reverse=True)
    
    return results

def get_card_details(conn, card_id):
    """Get full card details from database."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, oracle_id, name, printed_name, set_code, collector_number,
               lang, layout, image_uris
        FROM cards WHERE id = ?
    """, (card_id,))
    
    row = cursor.fetchone()
    if not row:
        return None
    
    return {
        'id': row[0],
        'oracle_id': row[1],
        'name': row[2],
        'printed_name': row[3],
        'set': row[4],
        'collector_number': row[5],
        'lang': row[6],
        'layout': row[7],
        'image_uris': json.loads(row[8]) if row[8] else {}
    }

def identify_card(image_path, top_n=5):
    """
    Main identification function using OCR + on-the-fly hashing.
    Returns dict with best match, alternatives, and debug info.
    """
    if not os.path.exists(DB_PATH):
        return {'error': 'Database not found. Run db_builder.py first.'}
    
    # Connect to database
    conn = sqlite3.connect(str(DB_PATH))
    
    try:
        # Compute query hashes
        print("Computing query hashes...")
        query_hashes = compute_image_hashes(image_path)
        if not query_hashes:
            return {'error': 'Failed to compute query hashes'}
        
        # OCR the scanned card
        print("OCRing scanned card...")
        card_name = ocr_card_name(image_path)
        
        if not card_name:
            return {'error': 'OCR failed to extract card name'}
        
        print(f"OCR result: {card_name}")
        
        # Lookup candidates by name
        print("Looking up candidates by name...")
        candidates = lookup_candidates_by_name(conn, card_name)
        print(f"Found {len(candidates)} candidates by name")
        
        if not candidates:
            return {'error': f'No candidates found for name: {card_name}'}
        
        # Download + hash candidates on-the-fly
        print("Downloading and hashing candidates...")
        IMAGE_DIR.mkdir(exist_ok=True)
        
        updated_candidates = []
        for candidate in candidates:
            updated = download_and_hash_candidate(candidate, IMAGE_DIR)
            updated_candidates.append(updated)
        
        # Compare query against candidates
        print("Comparing with candidates...")
        comparison_results = compare_with_candidates(query_hashes, updated_candidates)
        
        # Get top N results
        top_results = comparison_results[:top_n]
        
        # Get full card details
        results = []
        for result in top_results:
            card_details = get_card_details(conn, result['candidate']['id'])
            if card_details:
                results.append({
                    'card': card_details,
                    'score': result['score'],
                    'distances': {
                        'phash': hamming_distance(query_hashes['phash'], 
                                           result['candidate'].get('full_card_phash', '')),
                        'dhash': hamming_distance(query_hashes['dhash'], 
                                           result['candidate'].get('full_card_dhash', ''))
                    }
                })
        
        # Determine if manual confirmation is needed
        needs_manual = False
        if len(results) > 0:
            best_score = results[0]['score']
            second_best = results[1]['score'] if len(results) > 1 else 0
            
            if best_score < 0.92 or (best_score - second_best) < 0.06:
                needs_manual = True
        
        return {
            'bestMatch': results[0] if results else None,
            'alternatives': results[1:5] if len(results) > 1 else [],
            'scanDebug': {
                'hashes': query_hashes,
                'ocrName': card_name,
                'candidatesFound': len(candidates),
                'resultsWithHashes': len([r for r in comparison_results if r['candidate'].get('full_card_phash')])
            },
            'needsManualConfirmation': needs_manual
        }
    
    finally:
        conn.close()

# Override print globally — always write debug to stderr, never stdout
# Only main() uses stdout for the final JSON result
_original_print = print
def print(*args, **kwargs):
    """Override: all internal print() calls go to stderr to keep stdout clean for JSON."""
    # If caller explicitly passes file=, respect it (e.g. for json.dumps)
    if 'file' in kwargs:
        _original_print(*args, **kwargs)
    else:
        _original_print(*args, file=sys.stderr, **kwargs)

def main():
    """CLI interface. Outputs debug to stderr (via global print override),
    final JSON result to stdout."""
    if len(sys.argv) < 2:
        err = {'error': 'Usage: python identifier.py <image_path>'}
        # The global print override sends this to stderr
        print(err['error'])
        # Need to write JSON to stdout explicitly — the global override sends to stderr
        # so we bypass it for the final JSON output
        _original_print(json.dumps(err))
        return
    
    image_path = sys.argv[1]
    
    if not os.path.exists(image_path):
        err = {'error': f'Image not found: {image_path}'}
        print(err['error'])
        _original_print(json.dumps(err))
        return
    
    result = identify_card(image_path)
    
    # Print ONLY the final JSON result to stdout using the original print
    # (the global override would send it to stderr)
    _original_print(json.dumps(result))

if __name__ == "__main__":
    main()
