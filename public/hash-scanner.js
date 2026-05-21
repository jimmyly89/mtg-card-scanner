/**
 * HashScanProvider - Perceptual hash-based card scanning
 * Uses POST /api/mtg/scan-hash endpoint for two-stage matching
 */
class HashScanProvider {
    constructor() {
        this.lastScanTime = 0;
        this.scanCooldown = 2000; // 2 seconds between scans
        this.isProcessing = false;
    }

    /**
     * Scan image using perceptual hash matching
     * @param {string} imageDataUrl - Data URL of the image to scan
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

            // Send to scan-direct endpoint — skip redundant detector.py pass
            // since the client already crops & perspective-corrects the card
            const response = await fetch('/api/mtg/scan-direct', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || `Server error: ${response.statusText}`);
            }

            const result = await response.json();
            
            return {
                success: true,
                bestMatch: result.bestMatch || null,
                alternatives: result.alternatives || [],
                scanDebug: result.scanDebug || {},
                needsManualConfirmation: result.needsManualConfirmation || false
            };

        } catch (error) {
            console.error('Hash scan error:', error);
            return {
                success: false,
                error: error.message || 'Hash scan failed'
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

window.HashScanProvider = HashScanProvider;