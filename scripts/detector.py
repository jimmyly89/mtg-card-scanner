"""
Card Detector using OpenCV
Detects MTG cards in images, performs perspective correction,
and computes quality metrics.
"""
import cv2
import numpy as np
from PIL import Image
import io
import os
import sys

def load_image(image_path_or_bytes):
    """Load image from path or bytes."""
    if isinstance(image_path_or_bytes, bytes):
        nparr = np.frombuffer(image_path_or_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    else:
        img = cv2.imread(image_path_or_bytes)
    return img

def detect_card(image):
    """
    Detect MTG card in image and return perspective-corrected crop.
    
    Returns:
        dict with 'success', 'cropped_image', 'quality', 'corners'
    """
    if image is None:
        return {'success': False, 'error': 'Could not load image'}
    
    original = image.copy()
    height, width = image.shape[:2]
    
    # Step 1: Convert to grayscale
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Step 2: Gaussian blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    
    # Step 3: Canny edge detection
    # Use adaptive thresholds based on image median
    median = np.median(blurred)
    lower = int(max(0, 0.7 * median))
    upper = int(min(255, 1.3 * median))
    edges = cv2.Canny(blurred, lower, upper)
    
    # Step 4: Dilate to connect edges
    kernel = np.ones((5, 5), np.uint8)
    dilated = cv2.dilate(edges, kernel, iterations=1)
    
    # Step 5: Find contours
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        return {'success': False, 'error': 'No contours found'}
    
    # Sort contours by area (largest first)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    
    card_contour = None
    for contour in contours:
        area = cv2.contourArea(contour)
        
        # Filter by area (card should be significant portion of image)
        min_area = (width * height) * 0.05  # At least 5% of image
        if area < min_area:
            continue
        
        # Approximate contour to polygon
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        
        # Check if it's a quadrilateral
        if len(approx) == 4:
            card_contour = approx
            break
    
    if card_contour is None:
        return {'success': False, 'error': 'No card-like contour found'}
    
    # Step 6: Order corners (top-left, top-right, bottom-right, bottom-left)
    corners = order_corners(card_contour.reshape(4, 2))
    
    # Step 7: Perspective transform
    cropped = perspective_transform(original, corners)
    
    # Step 8: Assess quality
    quality = assess_quality(cropped)
    
    return {
        'success': True,
        'cropped_image': cropped,
        'quality': quality,
        'corners': corners.tolist()
    }

def order_corners(pts):
    """Reorder corners to: top-left, top-right, bottom-right, bottom-left."""
    rect = np.zeros((4, 2), dtype="float32")
    
    # Sum and difference to find corners
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    
    rect[0] = pts[np.argmin(s)]  # Top-left
    rect[2] = pts[np.argmax(s)]  # Bottom-right
    rect[1] = pts[np.argmin(diff)]  # Top-right
    rect[3] = pts[np.argmax(diff)]  # Bottom-left
    
    return rect

def perspective_transform(image, corners):
    """Apply perspective transform to get top-down view."""
    # Destination points (standard card size: 250x350)
    dst = np.array([
        [0, 0],
        [250, 0],
        [250, 350],
        [0, 350]
    ], dtype="float32")
    
    # Compute transform matrix
    M = cv2.getPerspectiveTransform(corners, dst)
    
    # Apply transform
    warped = cv2.warpPerspective(image, M, (250, 350))
    
    return warped

def assess_quality(image):
    """
    Assess image quality: sharpness, brightness, glare.
    Returns dict with scores 0-1.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Sharpness: variance of Laplacian
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    sharpness = min(1.0, (laplacian.var() / 500.0))  # Normalize
    
    # Brightness: mean pixel value
    brightness = gray.mean() / 255.0
    
    # Glare detection: percentage of very bright pixels
    _, glare_mask = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY)
    glare_ratio = np.count_nonzero(glare_mask) / (gray.shape[0] * gray.shape[1])
    glare = max(0, 1.0 - (glare_ratio * 5))  # Penalize high glare
    
    # Stability: not applicable for single image, use default
    stability = 1.0
    
    # Overall quality
    overall = (sharpness * 0.4 + brightness * 0.3 + glare * 0.3)
    
    return {
        'sharpness': round(sharpness, 2),
        'brightness': round(brightness, 2),
        'glare': round(glare, 2),
        'stability': stability,
        'overall': round(overall, 2)
    }

def image_to_pil(cv_image):
    """Convert OpenCV image (BGR) to PIL Image (RGB)."""
    rgb = cv2.cvtColor(cv_image, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb)

def image_to_bytes(cv_image, format='JPEG', quality=90):
    """Convert OpenCV image to bytes."""
    _, buffer = cv2.imencode(f'.{format.lower()}', cv_image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buffer.tobytes()

def save_image(image, path):
    """Save image to path."""
    cv2.imwrite(path, image)

def main():
    """CLI interface for testing."""
    if len(sys.argv) < 2:
        print("Usage: python detector.py <image_path> [output_path]")
        sys.exit(1)
    
    image_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else "detected_card.jpg"
    
    print(f"Processing: {image_path}")
    
    # Load image
    image = load_image(image_path)
    if image is None:
        print("Error: Could not load image")
        sys.exit(1)
    
    # Detect card
    result = detect_card(image)
    
    if not result['success']:
        print(f"Error: {result.get('error', 'Unknown error')}")
        sys.exit(1)
    
    # Save cropped image
    save_image(result['cropped_image'], output_path)
    print(f"Saved cropped image to: {output_path}")
    
    # Print quality metrics
    print("\nQuality Metrics:")
    for key, value in result['quality'].items():
        print(f"  {key}: {value}")
    
    # Print corners
    print(f"\nDetected corners: {result['corners']}")

if __name__ == "__main__":
    main()