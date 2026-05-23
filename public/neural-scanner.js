/**
 * NeuralScanProvider — ONNX-based neural card scanning
 * Uses POST /api/mtg/scan-neural endpoint for learned card detection + embedding matching.
 *
 * Unlike the OCR/hash approach which requires two stages (detect crop → OCR),
 * the neural method does everything in one shot:
 *   1. Cornelius (MobileViT) finds 4 card corners directly — handles extreme skew
 *   2. Dewarps the card to a flat 448×448 image
 *   3. Milo (ArcFace) generates a 128-d embedding vector
 *   4. Cosine similarity search against DB candidates
 *
 * Result: faster, more robust to angle/lighting, no Tesseract dependency.
 */
class NeuralScanProvider {
    constructor() {
        this.lastScanTime = 0;
        this.scanCooldown = 1500; // 1.5 seconds — neural is faster than OCR
        this.isProcessing = false;
    }

    /**
     * Scan image using neural detection + embedding matching.
     * 
     * NOTE: This sends the FULL FRAME image since Cornelius needs to detect
     * card corners from the raw camera frame. Do NOT pre-crop the card.
     * 
     * @param {string} imageDataUrl - Data URL of the FULL FRAME (not pre-cropped)
     * @returns {Promise<object>} Scan result with matches
     */
    async scan(imageDataUrl) {
        const now = Date.now();
        if (now - this.lastScanTime < this.scanCooldown || this.isProcessing) {
            return { 
                success: false, 
                error: 'Scan cooldown active or already processing' 
            };
        }

        this.lastScanTime = now;
        this.isProcessing = true;

        try {
            // Convert data URL to blob
            const blob = await this.dataUrlToBlob(imageDataUrl);
            
            // Create form data
            const formData = new FormData();
            formData.append('image', blob, 'scan.jpg');

            // Send to neural scan endpoint
            const response = await fetch('/api/mtg/scan-neural', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || `Server error: ${response.statusText}`);
            }

            const result = await response.json();
            
            return {
                success: !result.error,
                bestMatch: result.bestMatch || null,
                alternatives: result.alternatives || [],
                scanDebug: result.scanDebug || {},
                needsManualConfirmation: result.needsManualConfirmation || false
            };

        } catch (error) {
            console.error('Neural scan error:', error);
            return {
                success: false,
                error: error.message || 'Neural scan failed'
            };
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Convert data URL to Blob
     * @param {string} dataUrl 
     * @returns {Promise<Blob>}
     */
    async dataUrlToBlob(dataUrl) {
        const response = await fetch(dataUrl);
        return await response.blob();
    }

    /**
     * Check if we can scan again
     * @returns {boolean}
     */
    canScanAgain() {
        const now = Date.now();
        return (now - this.lastScanTime >= this.scanCooldown) && !this.isProcessing;
    }
}

window.NeuralScanProvider = NeuralScanProvider;