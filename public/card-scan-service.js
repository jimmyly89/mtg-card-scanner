/**
 * CardScanService — Two-stage scan orchestrator
 *
 * Stage 1 (FAST, user-facing): Title OCR → Scryfall search
 * Stage 2 (BACKGROUND, non-blocking): Hash-based variant validation via Python server
 *
 * The two stages run independently so the user gets instant feedback from Scryfall
 * while the server validates the specific printing in the background.
 */
class CardScanService {
    constructor() {
        this.ocrProcessor = window.OCRProcessor ? new OCRProcessor() : null;
        this.hashProvider = window.HashScanProvider ? new HashScanProvider() : null;
        this.lastTitleResult = null;
        this.lastVariantResult = null;
        this._variantInProgress = false;
    }

    /**
     * Initialize providers.
     */
    async init() {
        if (this.ocrProcessor) {
            try {
                await this.ocrProcessor.init();
                console.log('CardScanService: OCRProcessor ready');
            } catch (err) {
                console.warn('CardScanService: OCRProcessor init failed:', err);
            }
        }
        if (this.hashProvider) {
            console.log('CardScanService: HashScanProvider ready');
        }
    }

    /**
     * STAGE 1 — Fast title OCR + Scryfall search.
     * Runs Tesseract.js on the title crop, then searches Scryfall (with set lock).
     * Returns immediately with the result.
     *
     * @param {string} titleCropDataUrl - Binarized title region crop
     * @param {string|null} setLock - Set code filter from dropdown
     * @returns {Promise<object|null>} { card, score, ocrText, cleanedName }
     */
    async fastTitleScan(titleCropDataUrl, setLock) {
        if (!this.ocrProcessor) {
            console.warn('CardScanService: OCRProcessor not available');
            return null;
        }

        try {
            const result = await this.ocrProcessor.ocrAndSearchScryfall(titleCropDataUrl, setLock);
            this.lastTitleResult = result;
            return result;
        } catch (err) {
            console.error('CardScanService: fastTitleScan error:', err);
            return null;
        }
    }

    /**
     * Direct Scryfall search with pre-OCR'd text — no re-OCR.
     * Call this when you already have OCR text from runOcr() and local DB missed.
     * Avoids duplicating the ~1s Tesseract call.
     *
     * @param {string} cleanedName - Already cleaned OCR text
     * @param {string|null} setLock - Set code filter from dropdown
     * @returns {Promise<object|null>} { card, score, ocrText, cleanedName }
     */
    async searchScryfallByName(cleanedName, setLock) {
        if (!this.ocrProcessor) {
            console.warn('CardScanService: OCRProcessor not available');
            return null;
        }
        try {
            // Search Scryfall directly — no OCR needed since we already have the text
            const card = await this.ocrProcessor._searchScryfall(cleanedName, setLock);
            if (!card) return null;
            return { card, score: 0.85, ocrText: cleanedName, cleanedName };
        } catch (err) {
            console.error('CardScanService: searchScryfallByName error:', err);
            return null;
        }
    }

    /**
     * STAGE 2 — Background variant validation.
     * Sends the FULL card crop to the Python server for perceptual hash matching
     * against the local database. This determines the specific printing.
     *
     * This is fire-and-forget. Callers should poll lastVariantResult or use the callback.
     *
     * @param {string} fullCardCropDataUrl - 500×700 perspective-corrected card
     * @returns {Promise<object|null>} Hash scan result from server
     */
    async variantValidation(fullCardCropDataUrl) {
        if (this._variantInProgress) {
            console.log('CardScanService: variant validation already in progress, skipping');
            return null;
        }
        if (!this.hashProvider) {
            console.warn('CardScanService: HashScanProvider not available');
            return null;
        }

        this._variantInProgress = true;
        try {
            const result = await this.hashProvider.scan(fullCardCropDataUrl);
            this.lastVariantResult = result;
            return result;
        } catch (err) {
            console.error('CardScanService: variantValidation error:', err);
            return null;
        } finally {
            this._variantInProgress = false;
        }
    }

    /**
     * Get alternatives from the last variant validation result.
     * @returns {Array}
     */
    getAlternatives() {
        if (this.lastVariantResult?.alternatives) {
            return this.lastVariantResult.alternatives;
        }
        return [];
    }

    /**
     * Get the last full scan debug info.
     * @returns {object}
     */
    getDebugInfo() {
        return this.lastVariantResult?.scanDebug || {};
    }
}

window.CardScanService = CardScanService;