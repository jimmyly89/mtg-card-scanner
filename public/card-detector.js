// CardDetector module for MTG card detection (Manabox-style)
class CardDetector {
    constructor() {
    this.lastDetectionTime = 0;
    // Mobile: 200ms interval so UI thread has more breathing room
    this._isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    this.detectionInterval = this._isMobile ? 200 : 100;
    this.stableFrames = 0;
    this.requiredStableFrames = 1;
    this.lastQuad = null;
    this.isProcessing = false;
    this.lastDetectedQuad = null;
    this.smoothingFactor = 0.5;
    this.overlayCanvas = null;
    this.debugCanvas = null;
    this.debugMode = false;
    this.zoomFactor = 0.8;
    this.lastDebugInfo = {
      bestScore: 0,
      reason: 'No card detected',
      contoursFound: 0,
      edgePixelCount: 0,
      boundingBox: null,
      frameWidth: 0,
      frameHeight: 0,
      clustersFound: 0,
      adaptiveThreshold: 0,
      topClusters: []
    };
    // Change detection state
    this.lastScannedCropHash = null;
    this.sameCardFrames = 0;
    this.cardChangedThreshold = 0.02; // 2% hash distance = card changed (lower = faster new-card detection)
    this.lastScannedTimestamp = 0;
    this.scanCooldown = 1200; // min time between accepting scans (ms)
    // Position-lock optimisation: if the card is in a fixed box, detect faster
    this.lastDetectedCenter = null;
    this.positionLockRadius = 0.10; // 10% — skip stability if quad center is within this
    // Reusable canvases to reduce GC pressure
    this._captureCanvas = document.createElement('canvas');
    this._captureCtx = null;
    this._downscaleCanvas = document.createElement('canvas');
    this._downscaleCtx = null;
    // Mobile: internal downscale target for detection (640 wide max)
    this._detectMaxWidth = this._isMobile ? 640 : 0; // 0 = no downscale on desktop
  }
  
  async detectCard(videoElement) {
    const now = Date.now();
    if (now - this.lastDetectionTime < this.detectionInterval || this.isProcessing) {
      return { found: false, reason: 'Throttled' };
    }
    this.lastDetectionTime = now;
    this.isProcessing = true;
    
    try {
      // Reusable canvas for frame capture — reduces GC pressure
      const canvas = this._captureCanvas;
      let ctx = this._captureCtx;
      if (!ctx) { ctx = canvas.getContext('2d'); this._captureCtx = ctx; }
      
      canvas.width = videoElement.videoWidth;
      canvas.height = videoElement.videoHeight;
      
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      
      // --- Mobile: downscale detection frame for faster processing ---
      // Detection doesn't need full resolution — edges and clusters work fine at 640px wide.
      let detectW = canvas.width;
      let detectH = canvas.height;
      let detectData = null;
      
      if (this._detectMaxWidth > 0 && canvas.width > this._detectMaxWidth) {
        const scale = this._detectMaxWidth / canvas.width;
        detectW = Math.round(canvas.width * scale);
        detectH = Math.round(canvas.height * scale);
        const dsCanvas = this._downscaleCanvas;
        let dsCtx = this._downscaleCtx;
        if (!dsCtx) { dsCtx = dsCanvas.getContext('2d'); this._downscaleCtx = dsCtx; }
        dsCanvas.width = detectW;
        dsCanvas.height = detectH;
        dsCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, detectW, detectH);
        detectData = dsCtx.getImageData(0, 0, detectW, detectH);
      } else {
        detectData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      }
      
      const cardQuad = this.detectCardBoundaries(detectData, detectW, detectH);
      
      // Scale quad coordinates back to full frame coordinates if we downscaled
      if (cardQuad && this._detectMaxWidth > 0 && canvas.width > this._detectMaxWidth) {
        const scaleX = canvas.width / detectW;
        const scaleY = canvas.height / detectH;
        for (let i = 0; i < cardQuad.length; i++) {
          cardQuad[i].x = Math.round(cardQuad[i].x * scaleX);
          cardQuad[i].y = Math.round(cardQuad[i].y * scaleY);
        }
      }
      
      if (!cardQuad) {
        this.isProcessing = false;
        this.hideOverlay();
        return { found: false, reason: 'No card detected' };
      }
      
      const smoothedQuad = this.smoothQuad(cardQuad);
      
      // Position-lock optimisation: if the detected quad center is within
      // positionLockRadius (10%) of the previous center, the card is in a
      // fixed-position box — skip stability accumulation for faster detection.
      const currCenter = {
        x: (cardQuad[0].x + cardQuad[1].x + cardQuad[2].x + cardQuad[3].x) / 4,
        y: (cardQuad[0].y + cardQuad[1].y + cardQuad[2].y + cardQuad[3].y) / 4
      };
      let positionLocked = false;
      if (this.lastDetectedCenter) {
        const dx = Math.abs(currCenter.x - this.lastDetectedCenter.x) / (canvas.width || 1);
        const dy = Math.abs(currCenter.y - this.lastDetectedCenter.y) / (canvas.height || 1);
        if (dx < this.positionLockRadius && dy < this.positionLockRadius) {
          positionLocked = true;
        }
      }
      this.lastDetectedCenter = currCenter;
      
      if (positionLocked) {
        // Card is in same fixed position — skip stability frame accumulation
        this.stableFrames = Math.max(this.stableFrames, 1);
      } else if (this.isStable(smoothedQuad)) {
        this.stableFrames++;
      } else {
        this.stableFrames = Math.max(0, this.stableFrames - 1);
      }
      
      this.lastQuad = smoothedQuad;
      this.lastDetectedQuad = smoothedQuad;
      
      if (this.stableFrames < this.requiredStableFrames) {
        this.isProcessing = false;
        return { 
          found: false, 
          reason: this.stableFrames > 0 ? 'Hold steady' : 'Looking for card' 
        };
      }
      
      // --- THE PERSPECTIVE-CORRECTED CARD CROP (500×700) IS RETURNED BELOW ---
      // Perspective correction always runs on the FULL-RES frame for best quality.
      const fullFrameImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const crop = this.perspectiveCorrect(fullFrameImageData, smoothedQuad, canvas.width, canvas.height);
      
      const quality = this.assessQuality(crop);
      
      if (quality.overall < 0.5) {
        this.isProcessing = false;
        return { found: false, reason: 'Poor image quality' };
      }
      
      this.isProcessing = false;
      return {
        found: true,
        quad: smoothedQuad,
        crop: crop,
        quality: quality,
        confidence: quality.overall
      };
      
    } catch (error) {
      console.error('Card detection error:', error);
      this.isProcessing = false;
      return { found: false, reason: 'Detection error' };
    }
  }
  
  detectCardBoundaries(imageData, width, height) {
    let gray = this.toGrayscale(imageData);
    gray = this.enhanceContrast(gray, width, height);
    
    let grayMin = 255, grayMax = 0, graySum = 0;
    for (let i = 0; i < gray.length; i++) {
      grayMin = Math.min(grayMin, gray[i]);
      grayMax = Math.max(grayMax, gray[i]);
      graySum += gray[i];
    }
    const grayAvg = graySum / gray.length;
    
    const result = this.findCardByEdges(gray, width, height);
    
    Object.assign(this.lastDebugInfo, {
      bestScore: result.bestScore || 0,
      reason: result.bestContour ? 'OK' : (result.reason || 'No card detected'),
      contoursFound: result.contoursFound || 0,
      edgePixelCount: result.edgePixelCount || 0,
      edgePixelCountPct: result.edgePixelCountPct || 0,
      boundingBox: result.boundingBox,
      frameWidth: width,
      frameHeight: height,
      grayAvg: grayAvg,
      grayMin: grayMin,
      grayMax: grayMax,
      adaptiveThreshold: result.adaptiveThreshold || 0,
      clustersFound: result.clustersFound || 0,
      topClusters: result.topClusters || []
    });
    
    console.log(`detectCardBoundaries: result.bestContour exists? ${!!result.bestContour}, edgePixelCount=${result.edgePixelCount}`);
    
    this.updateDebugPanel();
    
    const video = document.getElementById('videoElement');
    if (video && this.debugMode) {
      this.drawDebugView(video, gray, null, null, result.bestContour, width, height);
    }
    
    return result.bestContour;
  }
  
  findCardByEdges(gray, width, height) {
    console.log('Using edge-based detection');
    
    const edges = this.detectEdges(gray, width, height);
    const dilated = this.dilateEdges(edges, width, height, 1);
    const clusters = this.findClusters(dilated, width, height);
    console.log(`Found ${clusters.length} edge clusters`);
    
    if (clusters.length === 0) {
      return {
        bestContour: null, bestScore: 0, contoursFound: 0,
        edgePixelCount: 0, edgePixelCountPct: 0, boundingBox: null,
        reason: 'No edge clusters found', clustersFound: 0,
        adaptiveThreshold: 0, topClusters: []
      };
    }
    
    const scoredClusters = clusters.map((cluster, idx) => {
      const scoreResult = this.scoreCluster(cluster, width, height);
      return { ...cluster, ...scoreResult, index: idx };
    });
    
    scoredClusters.sort((a, b) => b.score - a.score);
    
    const topClusters = scoredClusters.slice(0, 5);
    const topClustersData = topClusters.map(c => ({
      score: c.score, reason: c.reason,
      pixels: c.pixelCount, aspectRatio: c.aspectRatio
    }));
    
    const best = scoredClusters[0];
    
    if (!best || best.score < 0.3) {
      return {
        bestContour: null, bestScore: best?.score || 0,
        contoursFound: clusters.length,
        edgePixelCount: best?.pixelCount || 0, edgePixelCountPct: 0,
        boundingBox: best?.bounds || null,
        reason: best?.reason || 'No good edge cluster found',
        clustersFound: clusters.length, adaptiveThreshold: 0,
        topClusters: topClustersData
      };
    }
    
    const { minX, minY, maxX, maxY } = best.bounds;
    const quad = [
      {x: minX, y: minY}, {x: maxX, y: minY},
      {x: maxX, y: maxY}, {x: minX, y: maxY}
    ];
    
    console.log(`BEST EDGE CLUSTER: score=${best.score.toFixed(2)}, bounds=(${minX},${minY}) to (${maxX},${maxY})`);
    
    return {
      bestContour: quad, bestScore: best.score,
      contoursFound: clusters.length,
      edgePixelCount: best.pixelCount,
      edgePixelCountPct: (best.pixelCount / (width * height)) * 100,
      boundingBox: {minX, minY, maxX, maxY},
      reason: 'OK', clustersFound: clusters.length,
      adaptiveThreshold: 0, topClusters: topClustersData
    };
  }
  
  dilateEdges(edges, width, height, iterations) {
    let current = new Uint8Array(edges);
    
    for (let iter = 0; iter < iterations; iter++) {
      const next = new Uint8Array(width * height);
      
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = y * width + x;
          
          if (current[idx] > 0 ||
              current[idx - 1] > 0 || current[idx + 1] > 0 ||
              current[idx - width] > 0 || current[idx + width] > 0 ||
              current[idx - width - 1] > 0 || current[idx - width + 1] > 0 ||
              current[idx + width - 1] > 0 || current[idx + width + 1] > 0) {
            next[idx] = 255;
          }
        }
      }
      
      current = next;
    }
    
    console.log(`Dilated edges ${iterations} times`);
    return current;
  }
  
  findCardByThreshold(gray, width, height) {
    const sorted = gray.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)];
    const threshold = Math.min(255, median * 1.2);
    
    console.log(`Gray: min=${sorted[0]}, max=${sorted[sorted.length-1]}, median=${median}`);
    console.log(`Using ADAPTIVE threshold: ${threshold}`);
    
    const binary = new Uint8Array(width * height);
    let edgePixelCount = 0;
    
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] <= threshold) {
        binary[i] = 255;
        edgePixelCount++;
      } else {
        binary[i] = 0;
      }
    }
    
    const edgePixelCountPct = (edgePixelCount / (width * height)) * 100;
    console.log(`Binary pixels: ${edgePixelCount} (${edgePixelCountPct.toFixed(1)}%)`);
    
    if (edgePixelCount < 50) {
      return {
        bestContour: null, bestScore: 0, contoursFound: 0,
        edgePixelCount: edgePixelCount, edgePixelCountPct: edgePixelCountPct,
        boundingBox: null, reason: 'Too few pixels after thresholding',
        clustersFound: 0, adaptiveThreshold: threshold, topClusters: []
      };
    }
    
    const clusters = this.findClusters(binary, width, height);
    console.log(`Found ${clusters.length} clusters`);
    
    if (clusters.length === 0) {
      return {
        bestContour: null, bestScore: 0, contoursFound: 0,
        edgePixelCount: edgePixelCount, edgePixelCountPct: edgePixelCountPct,
        boundingBox: null, reason: 'No clusters found',
        clustersFound: 0, adaptiveThreshold: threshold, topClusters: []
      };
    }
    
    const scoredClusters = clusters.map((cluster, idx) => {
      const scoreResult = this.scoreCluster(cluster, width, height);
      return { ...cluster, ...scoreResult, index: idx };
    });
    
    scoredClusters.sort((a, b) => b.score - a.score);
    
    const topClusters = scoredClusters.slice(0, 5);
    const topClustersData = topClusters.map(c => ({
      score: c.score, reason: c.reason,
      pixels: c.pixelCount, aspectRatio: c.aspectRatio
    }));
    
    const best = scoredClusters[0];
    
    if (best && best.bounds) {
      const { minX, minY, maxX, maxY } = best.bounds;
      const boxW = maxX - minX;
      const boxH = maxY - minY;
      const boxArea = boxW * boxH;
      const frameArea = width * height;
      const areaPct = boxArea / frameArea;
      
      if (areaPct > 0.4) {
        console.log(`REJECTED: Cluster covers ${areaPct.toFixed(1)}% of frame (too large)`);
        return {
          bestContour: null, bestScore: 0,
          contoursFound: clusters.length,
          edgePixelCount: edgePixelCount, edgePixelCountPct: edgePixelCountPct,
          boundingBox: best.bounds,
          reason: `Too large (${areaPct.toFixed(0)}% of frame)`,
          clustersFound: clusters.length, adaptiveThreshold: threshold,
          topClusters: topClustersData
        };
      }
    }
    
    if (!best || best.score < 0.3) {
      return {
        bestContour: null, bestScore: best?.score || 0,
        contoursFound: clusters.length,
        edgePixelCount: edgePixelCount, edgePixelCountPct: edgePixelCountPct,
        boundingBox: best?.bounds || null,
        reason: best?.reason || 'No good cluster found',
        clustersFound: clusters.length, adaptiveThreshold: threshold,
        topClusters: topClustersData
      };
    }
    
    const { minX, minY, maxX, maxY } = best.bounds;
    const quad = [
      {x: minX, y: minY}, {x: maxX, y: minY},
      {x: maxX, y: maxY}, {x: minX, y: maxY}
    ];
    
    console.log(`BEST CLUSTER: score=${best.score.toFixed(2)}, bounds=(${minX},${minY}) to (${maxX},${maxY})`);
    
    return {
      bestContour: quad, bestScore: best.score,
      contoursFound: clusters.length,
      edgePixelCount: edgePixelCount, edgePixelCountPct: edgePixelCountPct,
      boundingBox: {minX, minY, maxX, maxY},
      reason: 'OK', clustersFound: clusters.length,
      adaptiveThreshold: threshold, topClusters: topClustersData
    };
  }
  
  findClusters(binary, width, height) {
    const visited = new Uint8Array(width * height);
    const clusters = [];
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (binary[idx] > 0 && !visited[idx]) {
          const pixels = [];
          const stack = [{x, y}];
          let minX = x, minY = y, maxX = x, maxY = y;
          
          while (stack.length > 0) {
            const {x: cx, y: cy} = stack.pop();
            const cidx = cy * width + cx;
            
            if (visited[cidx] || binary[cidx] === 0) continue;
            
            visited[cidx] = 1;
            pixels.push({x: cx, y: cy});
            minX = Math.min(minX, cx);
            minY = Math.min(minY, cy);
            maxX = Math.max(maxX, cx);
            maxY = Math.max(maxY, cy);
            
            const neighbors = [
              {x: cx-1, y: cy}, {x: cx+1, y: cy},
              {x: cx, y: cy-1}, {x: cx, y: cy+1}
            ];
            
            for (const n of neighbors) {
              if (n.x >= 0 && n.x < width && n.y >= 0 && n.y < height) {
                const nidx = n.y * width + n.x;
                if (!visited[nidx] && binary[nidx] > 0) {
                  stack.push(n);
                }
              }
            }
          }
          
          if (pixels.length >= 50) {
            clusters.push({
              pixels,
              bounds: {minX, minY, maxX, maxY},
              pixelCount: pixels.length
            });
          }
        }
      }
    }
    
    return clusters;
  }
  
  scoreCluster(cluster, frameWidth, frameHeight) {
    const { bounds, pixelCount } = cluster;
    const { minX, minY, maxX, maxY } = bounds;
    
    const boxW = maxX - minX;
    const boxH = maxY - minY;
    const boxArea = boxW * boxH;
    
    if (boxArea === 0 || boxW === 0 || boxH === 0) {
      return { score: 0, reason: 'Degenerate bounds' };
    }
    
    const boxPerimeter = 2 * (boxW + boxH);
    const perimeterDensity = pixelCount / boxPerimeter;
    
    const perimeterScore = perimeterDensity >= 1 && perimeterDensity <= 20 ? 1.0 : 
                           Math.max(0, 1.0 - Math.abs(perimeterDensity - 5) / 10);
    
    const areaFill = pixelCount / boxArea;
    
    const aspectRatio = boxW / boxH;
    const portraitScore = 1.0 - Math.min(1.0, Math.abs(aspectRatio - 0.714) / 0.714);
    const landscapeScore = 1.0 - Math.min(1.0, Math.abs(aspectRatio - 1.4) / 1.4);
    const aspectScore = Math.max(portraitScore, landscapeScore);
    
    const frameArea = frameWidth * frameHeight;
    const areaPct = boxArea / frameArea;
    const areaScore = areaPct > 0.05 && areaPct < 0.6 ? 1.0 : Math.max(0, 1.0 - Math.abs(areaPct - 0.3) / 0.3);
    
    const centerX = frameWidth / 2;
    const centerY = frameHeight / 2;
    const clusterCenterX = (minX + maxX) / 2;
    const clusterCenterY = (minY + maxY) / 2;
    const dist = Math.sqrt((clusterCenterX - centerX)**2 + (clusterCenterY - centerY)**2);
    const maxDist = Math.sqrt(centerX**2 + centerY**2);
    const centerScore = 1.0 - (dist / maxDist);
    
    if (areaPct < 0.03) return { score: 0, reason: 'Too small', aspectRatio };
    if (areaPct > 0.7) return { score: 0, reason: 'Too large', aspectRatio };
    if (boxW / boxH < 0.3 || boxW / boxH > 3.0) return { score: 0, reason: `Too thin (ratio=${aspectRatio.toFixed(2)})`, aspectRatio };
    if (perimeterDensity < 0.5) return { score: 0, reason: `Too sparse (density=${perimeterDensity.toFixed(2)})`, aspectRatio };
    if (perimeterDensity > 50) return { score: 0, reason: `Too dense (density=${perimeterDensity.toFixed(2)})`, aspectRatio };
    
    const score = aspectScore * 0.4 + perimeterScore * 0.3 + areaScore * 0.2 + centerScore * 0.1;
    
    return { 
      score, reason: 'OK', 
      debug: { pixelCount, boxArea, areaFill, perimeterDensity, aspectRatio, areaPct, centerScore },
      aspectRatio
    };
  }
  
  toGrayscale(imageData) {
    const data = imageData.data;
    const gray = new Uint8Array(data.length / 4);
    for (let i = 0; i < gray.length; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return gray;
  }
  
  gaussianBlur(gray, width, height, radius) {
    const result = new Uint8Array(gray.length);
    const kernel = [];
    const sigma = radius / 2;
    let sum = 0;
    
    for (let i = -radius; i <= radius; i++) {
      const g = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel.push(g);
      sum += g;
    }
    
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    
    const temp = new Uint8Array(gray.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let val = 0;
        for (let k = -radius; k <= radius; k++) {
          const px = Math.max(0, Math.min(width - 1, x + k));
          val += gray[y * width + px] * kernel[k + radius];
        }
        temp[y * width + x] = val;
      }
    }
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let val = 0;
        for (let k = -radius; k <= radius; k++) {
          const py = Math.max(0, Math.min(height - 1, y + k));
          val += temp[py * width + x] * kernel[k + radius];
        }
        result[y * width + x] = val;
      }
    }
    
    return result;
  }
  
  detectEdges(gray, width, height) {
    const edges = new Uint8Array(width * height);
    const magnitudes = new Float32Array(width * height);
    let maxMagnitude = 0;
    
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const gx = gray[idx + 1] - gray[idx - 1];
        const gy = gray[idx + width] - gray[idx - width];
        const magnitude = Math.sqrt(gx * gx + gy * gy);
        magnitudes[idx] = magnitude;
        if (magnitude > maxMagnitude) maxMagnitude = magnitude;
      }
    }
    
    const sortedMags = Array.from(magnitudes).filter(m => m > 0).sort((a, b) => b - a);
    const percentile85 = sortedMags[Math.floor(sortedMags.length * 0.15)] || 0;
    const adaptiveThreshold = Math.max(20, percentile85);
    
    let edgePixelCount = 0;
    for (let i = 0; i < magnitudes.length; i++) {
      if (magnitudes[i] >= adaptiveThreshold) {
        edges[i] = 255;
        edgePixelCount++;
      } else {
        edges[i] = 0;
      }
    }
    
    this.lastDebugInfo.edgeMaxMagnitude = maxMagnitude;
    this.lastDebugInfo.edgeThreshold = adaptiveThreshold;
    this.lastDebugInfo.edgePixelCountInDetect = edgePixelCount;
    
    console.log(`Edge detection (adaptive): maxMag=${maxMagnitude.toFixed(2)}, threshold=${adaptiveThreshold.toFixed(2)}, pixels=${edgePixelCount}`);
    
    return edges;
  }
  
  findCardContour(edges, width, height) {
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let edgePixelCount = 0;
    const edgeThreshold = 0;
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (edges[idx] > edgeThreshold) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          edgePixelCount++;
        }
      }
    }
    
    console.log(`findCardContour: edgePixelCount=${edgePixelCount}, minX=${minX}, minY=${minY}, maxX=${maxX}, maxY=${maxY}`);
    
    this.lastDebugInfo.edgePixelCount = edgePixelCount;
    this.lastDebugInfo.boundingBox = {minX, minY, maxX, maxY};
    
    if (edgePixelCount < 100) {
      this.lastDebugInfo.reason = 'Too few edge pixels';
      return { contours: [], bestContour: null, bestScore: 0 };
    }
    
    const w = maxX - minX;
    const h = maxY - minY;
    const area = w * h;
    const frameArea = width * height;
    if (area < frameArea * 0.08) {
      this.lastDebugInfo.reason = 'Card too small';
      return { contours: [], bestContour: null, bestScore: 0 };
    }
    
    const aspectRatio = w / h;
    const targetRatio = 0.714;
    const ratioScore = 1.0 - Math.min(1.0, Math.abs(aspectRatio - targetRatio) / targetRatio);
    
    if (ratioScore < 0.3) {
      this.lastDebugInfo.reason = `Bad aspect ratio: ${aspectRatio.toFixed(2)}`;
      return { contours: [], bestContour: null, bestScore: ratioScore };
    }
    
    const sizeScore = Math.min(1.0, area / (frameArea * 0.3));
    const score = ratioScore * 0.7 + sizeScore * 0.3;
    
    const quad = [
      {x: minX, y: minY}, {x: maxX, y: minY},
      {x: maxX, y: maxY}, {x: minX, y: maxY}
    ];
    
    this.lastDebugInfo.reason = 'OK';
    return { contours: [quad], bestContour: quad, bestScore: score };
  }
  
  scoreCardContour(contour, width, height) { return 0; }
  getQuadrilateralFromContour(contour) { return null; }
  
  smoothQuad(newQuad) {
    if (!this.lastDetectedQuad) return newQuad;
    const smoothed = [];
    for (let i = 0; i < 4; i++) {
      smoothed.push({
        x: this.lastDetectedQuad[i].x * this.smoothingFactor + newQuad[i].x * (1 - this.smoothingFactor),
        y: this.lastDetectedQuad[i].y * this.smoothingFactor + newQuad[i].y * (1 - this.smoothingFactor)
      });
    }
    return smoothed;
  }
  
  isStable(currentQuad) {
    if (!this.lastQuad) return false;
    const threshold = 15;
    for (let i = 0; i < 4; i++) {
      const dx = Math.abs(currentQuad[i].x - this.lastQuad[i].x);
      const dy = Math.abs(currentQuad[i].y - this.lastQuad[i].y);
      if (dx > threshold || dy > threshold) return false;
    }
    return true;
  }
  
  // drawTitleBarOverlay removed — replaced by static CSS title bar in index.html

  
  // Order quad points as TL, TR, BR, BL
  orderQuadPoints(quad) {
    const sorted = [...quad];
    sorted.sort((a, b) => a.y - b.y);
    const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = sorted.slice(2).sort((a, b) => a.x - b.x);
    return [top[0], top[1], bottom[1], bottom[0]]; // TL, TR, BR, BL
  }

  // Compute affine transform mapping src0,src1,src2 → dst0,dst1,dst2
  computeAffineTransform(src0, src1, src2, dst0, dst1, dst2) {
    const x = [src0.x, src1.x, src2.x];
    const y = [src0.y, src1.y, src2.y];
    const xp = [dst0.x, dst1.x, dst2.x];
    const yp = [dst0.y, dst1.y, dst2.y];

    const D = x[0] * (y[1] - y[2]) + x[1] * (y[2] - y[0]) + x[2] * (y[0] - y[1]);
    if (Math.abs(D) < 0.001) return null;

    const a = (xp[0] * (y[1] - y[2]) + xp[1] * (y[2] - y[0]) + xp[2] * (y[0] - y[1])) / D;
    const c = (x[0] * (xp[1] - xp[2]) + x[1] * (xp[2] - xp[0]) + x[2] * (xp[0] - xp[1])) / D;
    const e = (x[0] * (y[1] * xp[2] - y[2] * xp[1]) + x[1] * (y[2] * xp[0] - y[0] * xp[2]) + x[2] * (y[0] * xp[1] - y[1] * xp[0])) / D;

    const b = (yp[0] * (y[1] - y[2]) + yp[1] * (y[2] - y[0]) + yp[2] * (y[0] - y[1])) / D;
    const d = (x[0] * (yp[1] - yp[2]) + x[1] * (yp[2] - yp[0]) + x[2] * (yp[0] - yp[1])) / D;
    const f = (x[0] * (y[1] * yp[2] - y[2] * yp[1]) + x[1] * (y[2] * yp[0] - y[0] * yp[2]) + x[2] * (y[0] * yp[1] - y[1] * yp[0])) / D;

    return { a, b, c, d, e, f };
  }

  // Proper projective transform using two-triangle affine mapping
  perspectiveCorrect(imageData, quad, width, height) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    canvas.width = 500;
    canvas.height = 700;
    
    // Order quad points: TL, TR, BR, BL
    const ordered = this.orderQuadPoints(quad);
    const srcTL = ordered[0], srcTR = ordered[1], srcBR = ordered[2], srcBL = ordered[3];
    
    const dstTL = {x: 0, y: 0};
    const dstTR = {x: 500, y: 0};
    const dstBR = {x: 500, y: 700};
    const dstBL = {x: 0, y: 700};
    
    // Two-triangle affine approximation of perspective transform
    const tri1 = this.computeAffineTransform(srcTL, srcTR, srcBL, dstTL, dstTR, dstBL);
    const tri2 = this.computeAffineTransform(srcTR, srcBR, srcBL, dstTR, dstBR, dstBL);
    
    if (!tri1 || !tri2) {
      // Fallback to axis-aligned crop
      const minX = Math.min(...quad.map(p => p.x));
      const minY = Math.min(...quad.map(p => p.y));
      const maxX = Math.max(...quad.map(p => p.x));
      const maxY = Math.max(...quad.map(p => p.y));
      
      const cropCanvas = document.createElement('canvas');
      const cropCtx = cropCanvas.getContext('2d');
      cropCanvas.width = maxX - minX;
      cropCanvas.height = maxY - minY;
      cropCtx.putImageData(imageData, -minX, -minY);
      ctx.drawImage(cropCanvas, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.9);
    }
    
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.putImageData(imageData, 0, 0);
    
    // Triangle 1: TL-TR-BL
    // IMPORTANT: clip path MUST be defined BEFORE setTransform, so the clip
    // coordinates are interpreted in OUTPUT-pixel space (500×700), not in
    // source-image logical space. Otherwise the clip creates a tiny top-left
    // corner crop instead of the full triangle.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dstTL.x, dstTL.y);
    ctx.lineTo(dstTR.x, dstTR.y);
    ctx.lineTo(dstBL.x, dstBL.y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(tri1.a, tri1.b, tri1.c, tri1.d, tri1.e, tri1.f);
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.restore();
    
    // Triangle 2: TR-BR-BL
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dstTR.x, dstTR.y);
    ctx.lineTo(dstBR.x, dstBR.y);
    ctx.lineTo(dstBL.x, dstBL.y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(tri2.a, tri2.b, tri2.c, tri2.d, tri2.e, tri2.f);
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.restore();
    
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  // Compute a simple 8x8 average block hash of a crop for change detection
  async computeCropHash(cropDataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const hashCanvas = document.createElement('canvas');
        hashCanvas.width = 8;
        hashCanvas.height = 8;
        const hctx = hashCanvas.getContext('2d');
        hctx.drawImage(img, 0, 0, 8, 8);
        const data = hctx.getImageData(0, 0, 8, 8).data;
        
        let sum = 0;
        const pixels = [];
        for (let i = 0; i < 64; i++) {
          const gray = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
          pixels.push(gray);
          sum += gray;
        }
        const avg = sum / 64;
        
        let hash = 0n;
        for (let i = 0; i < 64; i++) {
          if (pixels[i] >= avg) {
            hash |= (1n << BigInt(i));
          }
        }
        resolve(hash);
      };
      img.onerror = () => resolve(0n);
      img.src = cropDataUrl;
    });
  }

  // Check if the card in frame has changed since last scan
  isCardChanged(newCropHash) {
    if (this.lastScannedCropHash === null) return true;
    
    let xor = this.lastScannedCropHash ^ newCropHash;
    let distance = 0;
    while (xor > 0n) {
      distance++;
      xor &= (xor - 1n);
    }
    const normalizedDist = distance / 64;
    
    console.log(`Card change distance: ${(normalizedDist * 100).toFixed(1)}% (threshold: ${(this.cardChangedThreshold * 100).toFixed(0)}%)`);
    
    if (normalizedDist < this.cardChangedThreshold) {
      this.sameCardFrames++;
      return false;
    }
    
    this.sameCardFrames = 0;
    return true;
  }

  // Mark a crop as "scanned" so we don't re-scan it
  markScanned(cropHash) {
    this.lastScannedCropHash = cropHash;
    this.lastScannedTimestamp = Date.now();
    this.sameCardFrames = 0;
  }

  // Check if enough time has passed since last scan
  canAcceptNewScan() {
    return (Date.now() - this.lastScannedTimestamp) >= this.scanCooldown;
  }
  
  // Debug method to visualize what the detector sees
  drawDebugView(videoElement, gray, edges, contours, bestContour, width, height) {
    if (!this.debugMode) return;
    
    if (!this.debugCanvas) {
      this.debugCanvas = document.createElement('canvas');
      this.debugCanvas.id = 'debugOverlay';
      this.debugCanvas.style.position = 'absolute';
      this.debugCanvas.style.top = '0';
      this.debugCanvas.style.left = '0';
      this.debugCanvas.style.pointerEvents = 'none';
      this.debugCanvas.style.zIndex = '9';
      this.debugCanvas.style.opacity = '0.7';
      
      const container = videoElement.parentElement;
      if (container) {
        container.appendChild(this.debugCanvas);
      }
    }
    
    const video = document.getElementById('videoElement');
    if (video) {
      this.debugCanvas.width = video.videoWidth || width;
      this.debugCanvas.height = video.videoHeight || height;
      this.debugCanvas.style.width = video.offsetWidth + 'px';
      this.debugCanvas.style.height = video.offsetHeight + 'px';
    } else {
      this.debugCanvas.width = width;
      this.debugCanvas.height = height;
    }
    
    const ctx = this.debugCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.debugCanvas.width, this.debugCanvas.height);
    
    const scaleX = this.debugCanvas.width / width;
    const scaleY = this.debugCanvas.height / height;
    
    if (contours && contours.length > 0) {
      ctx.strokeStyle = '#0000FF';
      ctx.lineWidth = 1;
      
      contours.forEach((contour, idx) => {
        if (!contour || contour.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(contour[0].x * scaleX, contour[0].y * scaleY);
        for (let i = 1; i < contour.length; i++) {
          ctx.lineTo(contour[i].x * scaleX, contour[i].y * scaleY);
        }
        ctx.stroke();
      });
    }
    
    if (bestContour && bestContour.length >= 4) {
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 3;
      
      ctx.beginPath();
      ctx.moveTo(bestContour[0].x * scaleX, bestContour[0].y * scaleY);
      for (let i = 1; i < bestContour.length; i++) {
        ctx.lineTo(bestContour[i].x * scaleX, bestContour[i].y * scaleY);
      }
      ctx.closePath();
      ctx.stroke();
      
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      bestContour.forEach(p => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
      
      ctx.strokeStyle = '#FFFF00';
      ctx.lineWidth = 2;
      ctx.strokeRect(minX * scaleX, minY * scaleY, (maxX - minX) * scaleX, (maxY - minY) * scaleY);
    }
    
    ctx.font = '12px monospace';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.fillText(`Gray avg: ${this.lastDebugInfo?.grayAvg?.toFixed(2) || 'N/A'}`, 10, 20);
    ctx.fillText(`Dark pixels: ${this.lastDebugInfo?.edgePixelCount || 0} (${(this.lastDebugInfo?.edgePixelCountPct || 0).toFixed(1)}%)`, 10, 35);
    ctx.fillText(`Best score: ${(this.lastDebugInfo?.bestScore * 100 || 0).toFixed(1)}%`, 10, 50);
    ctx.fillText(`Reason: ${this.lastDebugInfo?.reason || 'none'}`, 10, 65);
  }
  
  // Update debug info panel on screen
  updateDebugPanel() {
    if (!this.debugMode || !this.lastDebugInfo) return;
    
    const edgesThresholdEl = document.getElementById('debugEdgesThreshold');
    const contoursFoundEl = document.getElementById('debugContoursFound');
    const bestScoreEl = document.getElementById('debugBestScore');
    const reasonEl = document.getElementById('debugReason');
    const frameSizeEl = document.getElementById('debugFrameSize');
    const detectionStateEl = document.getElementById('debugDetectionState');
    const edgePixelCountEl = document.getElementById('debugEdgePixelCount');
    const boundingBoxEl = document.getElementById('debugBoundingBox');
    const clustersFoundEl = document.getElementById('debugClustersFound');
    const adaptiveThresholdEl = document.getElementById('debugAdaptiveThreshold');
    const topClustersEl = document.getElementById('debugTopClusters');
    
    if (edgesThresholdEl) edgesThresholdEl.textContent = `Gray avg: ${this.lastDebugInfo.grayAvg?.toFixed(2) || 'N/A'}`;
    if (contoursFoundEl) contoursFoundEl.textContent = `Pixels found: ${this.lastDebugInfo.edgePixelCount || 0}`;
    if (bestScoreEl) bestScoreEl.textContent = `Best score: ${(this.lastDebugInfo.bestScore * 100 || 0).toFixed(1)}%`;
    if (reasonEl) reasonEl.textContent = `Reason: ${this.lastDebugInfo.reason || 'none'}`;
    if (frameSizeEl) frameSizeEl.textContent = `Frame: ${this.lastDebugInfo.frameWidth || 0}x${this.lastDebugInfo.frameHeight || 0}`;
    if (adaptiveThresholdEl) adaptiveThresholdEl.textContent = `Adaptive threshold: ${this.lastDebugInfo.adaptiveThreshold?.toFixed(2) || 'N/A'}`;
    if (edgePixelCountEl) edgePixelCountEl.textContent = `Dark pixels: ${this.lastDebugInfo.edgePixelCount || 0} (${(this.lastDebugInfo.edgePixelCountPct || 0).toFixed(1)}%)`;
    if (clustersFoundEl) clustersFoundEl.textContent = `Clusters found: ${this.lastDebugInfo.clustersFound || 0}`;
    
    if (boundingBoxEl && this.lastDebugInfo.boundingBox) {
      const box = this.lastDebugInfo.boundingBox;
      boundingBoxEl.textContent = `Box: (${Math.round(box.minX)},${Math.round(box.minY)}) to (${Math.round(box.maxX)},${Math.round(box.maxY)})`;
    }
    
    if (topClustersEl && this.lastDebugInfo.topClusters && this.lastDebugInfo.topClusters.length > 0) {
      const topText = this.lastDebugInfo.topClusters.map((c, i) => 
        `#${i+1}: score=${(c.score*100).toFixed(1)}%, pixels=${c.pixels}, aspect=${c.aspectRatio?.toFixed(2) || 'N/A'}, reason=${c.reason}`
      ).join('\n');
      topClustersEl.textContent = `Top clusters:\n${topText}`;
    }
    
    if (detectionStateEl) {
      if (this.lastDebugInfo.bestScore >= 0.3) {
        detectionStateEl.textContent = 'State: Card detected!';
        detectionStateEl.style.color = '#00FF00';
      } else if (this.lastDebugInfo.clustersFound > 0) {
        detectionStateEl.textContent = `State: ${this.lastDebugInfo.clustersFound} clusters found, checking...`;
        detectionStateEl.style.color = '#FFFF00';
      } else if (this.lastDebugInfo.edgePixelCount > 50) {
        detectionStateEl.textContent = 'State: Dark area found, checking shape...';
        detectionStateEl.style.color = '#FFFF00';
      } else {
        detectionStateEl.textContent = 'State: Looking for dark areas...';
        detectionStateEl.style.color = '#00FFFF';
      }
    }
  }
  
  hideOverlay() {
    if (this.overlayCanvas) {
      const ctx = this.overlayCanvas.getContext('2d');
      ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
  }
  
  assessQuality(cropDataUrl) {
    return {
      sharpness: 0.8,
      brightness: 0.7,
      glare: 0.9,
      stability: this.stableFrames / this.requiredStableFrames,
      overall: 0.8
    };
  }

  // Apply contrast enhancement to grayscale image
  enhanceContrast(gray, width, height) {
    let min = 255, max = 0;
    for (let i = 0; i < gray.length; i++) {
      min = Math.min(min, gray[i]);
      max = Math.max(max, gray[i]);
    }
    
    if (max === min) return gray;
    
    const range = max - min;
    const enhanced = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) {
      enhanced[i] = Math.min(255, Math.max(0, ((gray[i] - min) / range) * 255));
    }
    
    console.log(`Contrast enhanced: min=${min}, max=${max}, new range=0-255`);
    return enhanced;
  }
}

window.CardDetector = CardDetector;