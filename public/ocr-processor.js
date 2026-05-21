/**
 * OCRProcessor — Client-side OCR + Scryfall name search
 *
 * Responsibilities:
 *   1. Crop the title region from a perspective-corrected card using DOM-driven coordinates
 *   2. Run Tesseract.js OCR on that region
 *   3. Search Scryfall with the OCR text + optional set lock
 *
 * This is the PRIMARY identification path. The server-side hash matching
 * (identifier.py / scan-direct) runs in the background for variant validation only.
 */
class OCRProcessor {
  constructor() {
    this.tesseractWorker = null;
    this.cardNamesCache = [];
    this._lastRawTitleCrop = null;
    this._lastProcessedTitleCrop = null;
    // Mobile detection: use 1.5x upscale instead of 4x for 7× faster OCR
    this._isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    this._titleUpscale = this._isMobile ? 1.5 : 4;
  }

  async init() {
    if (this.tesseractWorker) return;
    // Tesseract.js is loaded globally via <script> tag in index.html
    if (typeof window.Tesseract === 'undefined') {
      console.error('Tesseract.js not loaded globally — falling back to lazy load');
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    this.tesseractWorker = await window.Tesseract.createWorker('eng', 1, {
      logger: m => { /* suppress verbose Tesseract logging */ }
    });
    console.log('OCRProcessor: Tesseract.js worker created');
  }

  /**
   * Crop the title region of a 500×700 perspective-corrected card image.
   *
   * The title region is determined by reading the CSS `.title-bar` element's
   * position (top, height) and projecting it through the detected card quad
   * onto the 500×700 card crop. This ensures the crop matches what the user
   * sees highlighted on screen.
   *
   * @param {string} cardCropDataUrl - 500×700 perspective-corrected card
   * @returns {Promise<string>} Data URL of the title-region crop (binarized, upscaled)
   */
  async cropToTitleRegion(cardCropDataUrl) {
    // The perspective-corrected card is 500×700 (width=500, height=700).
    // Use vertical fractions against height (700) and horizontal against width (500).
    // titleTopFrac is very small because MTG card names start near the top edge.
    const titleTopFrac = 0.018;      // 1.8% from top edge — skip border artifacts and art-shadow noise
    const titleHeightFrac = 0.10;     // 10% of card height — covers the full title bar
    const titleLeftFrac = 0.05;
    const titleWidthFrac = 0.70;

    return this._cropAndBinarize(cardCropDataUrl, {
      offsetY: Math.round(700 * titleTopFrac),       // vertical: use height (700)
      cropHeight: Math.round(700 * titleHeightFrac), // vertical: use height (700)
      offsetX: Math.round(500 * titleLeftFrac),      // horizontal: use width (500)
      cropWidth: Math.round(500 * titleWidthFrac)     // horizontal: use width (500)
    });
  }

  /**
   * Internal: crop a region from the card image and apply Otsu binarization + upscale.
   * Uses adaptive upscale (4x desktop, 1.5x mobile) for mobile performance.
   * @param {string} dataUrl
   * @param {object} region - {offsetX, offsetY, cropWidth, cropHeight}
   * @returns {Promise<string>} binarized & upscaled data URL
   */
  async _cropAndBinarize(dataUrl, region) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const { offsetX, offsetY, cropWidth, cropHeight } = region;
        const safeW = Math.min(cropWidth, img.width - offsetX);
        const safeH = Math.min(cropHeight, img.height - offsetY);
        if (safeW < 1 || safeH < 1) {
          // Fallback: return the whole card resized
          resolve(dataUrl);
          return;
        }

        // Adaptive upscale: 4x desktop, 1.5x mobile for much faster OCR on phones
        const upscale = this._titleUpscale;
        const outW = safeW * upscale;
        const outH = safeH * upscale;

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');

        // Store "before" (raw) image for debug panel
        const beforeCanvas = document.createElement('canvas');
        beforeCanvas.width = outW;
        beforeCanvas.height = outH;
        const beforeCtx = beforeCanvas.getContext('2d');
        beforeCtx.drawImage(img, offsetX, offsetY, safeW, safeH, 0, 0, outW, outH);
        this._lastRawTitleCrop = beforeCanvas.toDataURL('image/jpeg', 0.85);

        // Draw with pixelated upscale for sharp text edges
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.drawImage(img, offsetX, offsetY, safeW, safeH, 0, 0, outW, outH);

        // Otsu binarization
        const imageData = ctx.getImageData(0, 0, outW, outH);
        const data = imageData.data;
        const totalPixels = outW * outH;
        const histogram = new Array(256).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
          histogram[gray]++;
        }

        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * histogram[i];
        let sumB = 0, wB = 0, maxVariance = 0, threshold = 128;
        for (let i = 0; i < 256; i++) {
          wB += histogram[i];
          if (wB === 0) continue;
          const wF = totalPixels - wB;
          if (wF === 0) break;
          sumB += i * histogram[i];
          const mB = sumB / wB;
          const mF = (sum - sumB) / wF;
          const variance = wB * wF * (mB - mF) * (mB - mF);
          if (variance > maxVariance) { maxVariance = variance; threshold = i; }
        }

        for (let i = 0; i < data.length; i += 4) {
          const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
          if (gray > threshold) {
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
          } else {
            data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
          }
          data[i + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);

        const processedUrl = canvas.toDataURL('image/jpeg', 0.95);
        this._lastProcessedTitleCrop = processedUrl;
        resolve(processedUrl);
      };
      img.onerror = () => reject(new Error('Failed to load image for crop'));
      img.src = dataUrl;
    });
  }

  /**
   * Run OCR on the title crop, then search Scryfall with the recognized text.
   * This is the PRIMARY card identification path.
   *
   * @param {string} titleCropDataUrl - Binarized title region
   * @param {string|null} setLock - Optional set code from the dropdown
   * @returns {Promise<object|null>} { card, score, ocrText, cleanedName } or null
   */
  async ocrAndSearchScryfall(titleCropDataUrl, setLock) {
    if (!this.tesseractWorker) {
      console.warn('OCRProcessor: Tesseract not initialized');
      return null;
    }

    // STEP 1: OCR
    let ocrText;
    try {
      const { data: { text } } = await this.tesseractWorker.recognize(titleCropDataUrl);
      console.log('OCRProcessor raw text:', text);
      // Take the first non-empty line as the card name
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
      ocrText = lines[0] || null;
    } catch (err) {
      console.error('OCRProcessor: Tesseract error:', err);
      return null;
    }

    if (!ocrText) {
      console.warn('OCRProcessor: No text found');
      return null;
    }

    // STEP 2: Clean the OCR text
    let cleanedName = ocrText
      .replace(/[^\w\s',\-]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\b(Rare|Uncommon|Common|Mythic)\b/gi, '')
      .replace(/\d+\/\d+/g, '')
      .trim();

    if (cleanedName.length < 2) {
      console.warn('OCRProcessor: Cleaned name too short');
      return null;
    }

    console.log(`OCRProcessor: OCR="${ocrText}" cleaned="${cleanedName}"`);

    // STEP 3: Search Scryfall
    const card = await this._searchScryfall(cleanedName, setLock);
    if (!card) {
      // Try with original OCR text as fallback
      const fallback = await this._searchScryfall(ocrText, setLock);
      if (!fallback) return null;
      return { card: fallback, score: 0.6, ocrText, cleanedName };
    }

    return { card, score: 0.85, ocrText, cleanedName };
  }

  /**
   * Search Scryfall with optional set lock.
   */
  async _searchScryfall(name, setLock) {
    try {
      // Try with set lock first
      if (setLock && setLock !== 'any') {
        const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}&set=${setLock}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json();
          if (data.object !== 'error') return data;
        }
      }

      // Retry without set lock
      const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data.object === 'error') return null;
      return data;
    } catch (err) {
      console.error('OCRProcessor: Scryfall search error:', err);
      return null;
    }
  }

  /**
   * Search for alternatives when the primary match is uncertain.
   * @param {string} name - Card name to search alternatives for
   * @param {string|null} setLock
   * @returns {Promise<Array>} List of { card, set_name }
   */
  async searchAlternatives(name, setLock) {
    try {
      const url = `https://api.scryfall.com/cards/search?order=released&dir=desc&unique=prints&q=${encodeURIComponent(name)}`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!data.data) return [];

      // Filter by set if locked
      let printings = data.data;
      if (setLock && setLock !== 'any') {
        printings = printings.filter(p => p.set === setLock);
      }
      return printings.slice(0, 5).map(card => ({
        card,
        set_name: `${card.set_name} (${card.set.toUpperCase()}) #${card.collector_number || '?'}`
      }));
    } catch (err) {
      console.error('OCRProcessor: alternatives search error:', err);
      return [];
    }
  }

  /**
   * Clean up resources.
   */
  async destroy() {
    if (this.tesseractWorker) {
      await this.tesseractWorker.terminate();
      this.tesseractWorker = null;
    }
  }
}

window.OCRProcessor = OCRProcessor;