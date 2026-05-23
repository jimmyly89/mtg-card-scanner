const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const db = require('./db');
const inventoryApi = require('./routes/inventory-api');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Generate self-signed certificate for HTTPS (required for phone camera access)
function getHttpsCredentials() {
    const certDir = path.join(__dirname, '.certs');
    const certPath = path.join(certDir, 'server.cert');
    const keyPath = path.join(certDir, 'server.key');
    
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        try {
            const cert = new (require('crypto').X509Certificate)(fs.readFileSync(certPath));
            const daysLeft = Math.floor((cert.validTo - Date.now()) / 86400000);
            if (daysLeft > 30) return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
        } catch (e) { /* regenerate */ }
    }
    
    if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
    
    const { execSync } = require('child_process');
    try {
        execSync(
            `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=MTG-Scanner"`,
            { stdio: 'ignore', timeout: 10000 }
        );
    } catch (e) {
        // Fallback: generate cert & key using Node.js crypto directly
        const forge = require('node-forge');
        const pki = forge.pki;
        const keys = pki.rsa.generateKeyPair(2048);
        const cert = pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = Date.now().toString(16);
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
        const attrs = [{ name: 'commonName', value: 'MTG-Scanner' }];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);
        cert.sign(keys.privateKey);
        const pemKey = pki.privateKeyToPem(keys.privateKey);
        const pemCert = pki.certificateToPem(cert);
        fs.writeFileSync(keyPath, pemKey);
        fs.writeFileSync(certPath, pemCert);
    }
    
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

// Start HTTPS server (port 3443) with its own socket.io that forwards to HTTP io
function startHttpsServer(httpIo) {
    try {
        const credentials = getHttpsCredentials();
        const httpsServer = https.createServer(credentials, app);
        const httpsIo = socketIo(httpsServer);
        
        httpsServer.listen(3443, '0.0.0.0', () => {
            console.log(`HTTPS server running on https://0.0.0.0:3443 (for phone camera access)`);
            console.log(`⚠️  Browsers will warn about self-signed cert — click "Advanced" → "Proceed"`);
        });
        
        return true;
    } catch (e) {
        console.log('⚠️  Could not start HTTPS server:', e.message);
        console.log('   Phone camera access will require http://localhost from the same machine');
        return false;
    }
}

const UPLOAD_DIR = path.join(os.tmpdir(), 'mtg-card-scanner-uploads');

// Configure multer for image uploads
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG and PNG are allowed.'));
        }
    }
});

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Inventory API routes ──
app.use('/api/inventory', inventoryApi);

const sessions = new Map();
let sessionCounter = 0;
let mtgSeqCounter = 0;
const USD_TO_AUD = 1.55;

function toAUD(usdPrice) {
    return usdPrice * USD_TO_AUD;
}

function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            id: sessionId,
            scanners: [],
            displays: [],
            cards: [],
            inventory: [],
            boxInfo: null,
            isScanning: false
        });
    }
    return sessions.get(sessionId);
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    socket.on('generate-session', () => {
        mtgSeqCounter++;
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let code = '';
        for (let i = 0; i < 4; i++) {
            code += letters.charAt(Math.floor(Math.random() * letters.length));
        }
        const newSessionId = `MTG${code}-${mtgSeqCounter}`;
        console.log('Generated new session:', newSessionId);
        socket.emit('session-generated', { sessionId: newSessionId });
    });

    socket.on('join-session', (data) => {
        const { sessionId, deviceType } = data;
        if (!sessionId) return;
        
        const session = getOrCreateSession(sessionId);
        socket.join(sessionId);
        socket.sessionId = sessionId;
        socket.deviceType = deviceType;
        
        if (deviceType === 'scanner' && !session.scanners.includes(socket.id)) {
            session.scanners.push(socket.id);
        } else if (deviceType === 'display' && !session.displays.includes(socket.id)) {
            session.displays.push(socket.id);
        }
        
        console.log(`Session ${sessionId}: ${session.scanners.length} scanners, ${session.displays.length} displays`);
        
        // Send current state to newly joined client
        socket.emit('session-state', {
            boxInfo: session.boxInfo,
            isScanning: session.isScanning,
            cards: session.cards,
            inventory: session.inventory
        });
    });

    socket.on('set-box', (data) => {
        const { sessionId, boxName, boxCost } = data;
        const session = getOrCreateSession(sessionId);
        session.boxInfo = { name: boxName, cost: parseFloat(boxCost) };
        io.to(sessionId).emit('box-updated', session.boxInfo);
    });

    socket.on('start-scanning', (data) => {
        const { sessionId } = data;
        const session = getOrCreateSession(sessionId);
        session.isScanning = true;
        io.to(sessionId).emit('scanning-started');
    });

    socket.on('finish-scanning', async (data) => {
        const { sessionId, sessionName } = data;
        const session = getOrCreateSession(sessionId);
        session.isScanning = false;
        
        let saveSuccess = false;
        let cardsInserted = 0;
        
        // Auto-save to MariaDB inventory
        try {
            const cardsToSave = session.inventory.length > 0 ? session.inventory : session.cards;
            if (cardsToSave.length > 0) {
                const setCode = session.boxInfo?.setLock || '';
                const setCodeLower = setCode.toLowerCase();
                
                const payload = {
                    session_id: sessionId,
                    session_name: sessionName || sessionId || '',
                    set_code: setCodeLower,
                    set_name: setCode || '',
                    cost: session.boxInfo?.cost || 0,
                    cards: cardsToSave.map(c => ({
                        card_name: c.name || c.card_name || 'Unknown',
                        set_name: c.set_name || '',
                        set_code: c.set_code || setCodeLower,
                        scryfall_id: c.scryfall_id || c.id || '',
                        foil: c.foil ? 1 : 0,
                        borderless: c.borderless ? 1 : 0,
                        price: c.price || c.priceUsd || 0,
                        condition: c.condition || 'NM'
                    }))
                };
                
                // Fire and log result
                const http = require('http');
                const body = JSON.stringify(payload);
                const req = http.request({
                    hostname: 'localhost',
                    port: PORT,
                    path: '/api/inventory/save-session',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, (resp) => {
                    let data = '';
                    resp.on('data', chunk => data += chunk);
                    resp.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            if (result.success) {
                                saveSuccess = true;
                                cardsInserted = result.cards_inserted || 0;
                                console.log(`Auto-saved session ${sessionId}: ${cardsInserted} cards`);
                            }
                            // Emit session-finished with result
                            io.to(sessionId).emit('session-finished', {
                                success: result.success,
                                cards_inserted: result.cards_inserted || 0,
                                error: result.error || null
                            });
                        } catch(e) {
                            io.to(sessionId).emit('session-finished', {
                                success: true,
                                cards_inserted: cardsToSave.length,
                                error: null
                            });
                        }
                    });
                });
                req.on('error', (e) => {
                    console.error('Auto-save error:', e.message);
                    io.to(sessionId).emit('session-finished', {
                        success: true,
                        cards_inserted: 0,
                        error: e.message
                    });
                });
                req.write(body);
                req.end();
            } else {
                // No cards to save — still emit success
                io.to(sessionId).emit('session-finished', {
                    success: true,
                    cards_inserted: 0,
                    error: null
                });
            }
        } catch (e) {
            console.error('Auto-save failed:', e.message);
            io.to(sessionId).emit('session-finished', {
                success: false,
                cards_inserted: 0,
                error: e.message
            });
        }
        
        io.to(sessionId).emit('scanning-finished');
    });

    socket.on('scan-card', async (data) => {
        const { sessionId, card } = data;
        const session = getOrCreateSession(sessionId);
        
        // Convert price to AUD if needed
        if (card.priceUsd) {
            card.price = toAUD(card.priceUsd);
        }
        
        session.cards.push(card);
        
        // Broadcast to ALL clients (including sender) in session
        io.to(sessionId).emit('card-added', {
            card,
            inventory: session.inventory,
            totals: calculateTotals(session)
        });
    });

    socket.on('toggle-inventory', (data) => {
        const { sessionId, cardId } = data;
        const session = getOrCreateSession(sessionId);
        
        const card = session.cards.find(c => c.id === cardId);
        if (card) {
            card.addedToInventory = !card.addedToInventory;
            
            if (card.addedToInventory) {
                session.inventory.push(card);
            } else {
                session.inventory = session.inventory.filter(c => c.id !== cardId);
            }
            
            // Broadcast to ALL clients in session
            io.to(sessionId).emit('inventory-updated', {
                card,
                inventory: session.inventory,
                totals: calculateTotals(session)
            });
        }
    });

    // ── FORCE SCAN: Display requests scanner to force scan ──
    socket.on('force-scan', (data) => {
        const { sessionId } = data;
        if (!sessionId) return;
        // Forward to all scanners in the session
        socket.to(sessionId).emit('force-scan-request');
    });

    // ── FRAME RELAY: Scanner broadcasts frames to all session clients (including self) ──
    socket.on('frame-relay', (data) => {
        const { sessionId, frameData } = data;
        if (!sessionId || !frameData) return;
        // Throttle: relay to ALL clients in session (io.to includes sender, fixing same-browser display sync)
        io.to(sessionId).emit('frame-relay', { frameData });
    });

    socket.on('get-inventory', (data) => {
        const { sessionId } = data;
        const session = getOrCreateSession(sessionId);
        socket.emit('inventory-updated', {
            inventory: session.inventory,
            totals: calculateTotals(session)
        });
    });

    function calculateTotals(session) {
        const inventoryValue = session.inventory.reduce((sum, c) => sum + c.price, 0);
        const inventoryCount = session.inventory.length;
        const allCardsValue = session.cards.reduce((sum, c) => sum + c.price, 0);
        const allCardsCount = session.cards.length;
        
        return {
            allCardsValue,
            allCardsCount,
            inventoryValue,
            inventoryCount,
            boxCost: session.boxInfo?.cost || 0,
            profit: inventoryValue - (session.boxInfo?.cost || 0)
        };
    }

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        const sessionId = socket.sessionId;
        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId);
            session.scanners = session.scanners.filter(id => id !== socket.id);
            session.displays = session.displays.filter(id => id !== socket.id);
            console.log(`Session ${sessionId}: ${session.scanners.length} scanners, ${session.displays.length} displays`);
            
            if (session.scanners.length === 0 && session.displays.length === 0) {
                sessions.delete(sessionId);
            }
        }
    });
});

// ── REST API: Sessions (for frontend Setup panel) ────────────────────────────
// GET /api/sessions - list active sessions
app.get('/api/sessions', (req, res) => {
    const active = [];
    for (const [id, session] of sessions) {
        if (session.scanners.length > 0 || session.displays.length > 0) {
            active.push({
                id: session.id,
                scanners: session.scanners.length,
                displays: session.displays.length,
                cards: session.cards.length,
                hasBox: !!session.boxInfo
            });
        }
    }
    res.json({ sessions: active });
});

// POST /api/sessions - create a new session
app.post('/api/sessions', (req, res) => {
    mtgSeqCounter++;
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    const newSessionId = `MTG${code}-${mtgSeqCounter}`;
    getOrCreateSession(newSessionId);
    console.log('Generated new session via REST:', newSessionId);
    res.json({ id: newSessionId });
});

// ── LIST ACTIVE SESSIONS (legacy) ──────────────────────────────────────────────
app.get('/api/mtg/sessions', (req, res) => {
    const active = [];
    for (const [id, session] of sessions) {
        if (session.scanners.length > 0 || session.displays.length > 0) {
            active.push({
                id: session.id,
                scanners: session.scanners.length,
                displays: session.displays.length,
                cards: session.cards.length,
                hasBox: !!session.boxInfo
            });
        }
    }
    res.json({ sessions: active });
});

// ── LOCAL DB SEARCH ──────────────────────────────────────────────────────────
// Queries the local SQLite database for card names matching the OCR text.
// Returns name, set, collector_number, image URLs. Scryfall is only hit for pricing.
app.get('/api/mtg/search-local', (req, res) => {
    const query = (req.query.q || '').trim();
    const setLock = (req.query.set || '').trim().toLowerCase();
    if (!query || query.length < 2) {
        return res.json({ matches: [], match: null });
    }

    const dbPath = path.join(__dirname, 'data', 'mtg_cards.db');
    if (!fs.existsSync(dbPath)) {
        return res.json({ matches: [], match: null, db_exists: false });
    }

    let sqlite3;
    try {
        sqlite3 = require('sqlite3');
    } catch (e) {
        return res.json({ matches: [], match: null, error: 'sqlite3 not available' });
    }

    try {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
        
        // Build the search query: exact match first, then partial
        const queryLower = query.toLowerCase();
        const likePattern = `%${queryLower}%`;
        
        const sql = `
            SELECT name, set_code as s_set, collector_number, normal_image_url, art_crop_url, image_uris, oracle_id, usd_price, usd_foil_price
            FROM cards 
            WHERE LOWER(name) LIKE ?
            ${setLock && setLock !== 'any' ? 'AND LOWER(set_code) = ?' : ''}
            ORDER BY 
                CASE 
                    WHEN LOWER(name) = ? THEN 0
                    WHEN LOWER(name) LIKE ? THEN 1
                    ELSE 2
                END,
                name ASC
            LIMIT 10
        `;

        const params = [likePattern];
        if (setLock && setLock !== 'any') params.push(setLock);
        params.push(queryLower); // exact match check
        params.push(`${queryLower}%`); // starts-with

        db.all(sql, params, (err, rows) => {
            db.close();
            if (err) {
                console.error('DB search error:', err);
                return res.json({ matches: [], match: null, error: err.message });
            }

            const matches = rows.map(row => ({
                name: row.name,
                set: row.s_set,
                collector_number: row.collector_number,
                oracle_id: row.oracle_id,
                image_url: row.normal_image_url || null,
                price_usd: row.usd_price || null,
                price_usd_foil: row.usd_foil_price || null
            }));

            res.json({
                matches,
                match: matches.length > 0 ? matches[0] : null,
                db_exists: true
            });
        });

    } catch (err) {
        console.error('DB search error:', err);
        res.json({ matches: [], match: null, error: err.message });
    }
});

// ── SET AUTOCOMPLETE SEARCH (excludes token sets) ──
app.get('/api/mtg/sets-search', (req, res) => {
    const query = (req.query.q || '').trim().toLowerCase();
    const dbPath = path.join(__dirname, 'data', 'mtg_cards.db');
    if (!fs.existsSync(dbPath)) {
        return res.json({ sets: [], db_exists: false });
    }
    let sqlite3;
    try {
        sqlite3 = require('sqlite3');
    } catch (e) {
        return res.json({ sets: [], error: 'sqlite3 not available' });
    }
    try {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
        const likePat = `%${query}%`;
        db.all(`
            SELECT code, name FROM sets_info
            WHERE (LOWER(name) LIKE ? OR LOWER(code) LIKE ?)
              AND LOWER(name) NOT LIKE '%token%'
              AND LOWER(code) NOT LIKE '%tok%'
              AND code NOT IN ('TUST','THP1','THP2','THP3','THP4','THP5')
            ORDER BY
                CASE WHEN LOWER(code) = ? THEN 0
                     WHEN LOWER(name) = ? THEN 1
                     ELSE 2 END,
                release_date DESC
            LIMIT 20
        `, [likePat, likePat, query, query], (err, rows) => {
            db.close();
            if (err) return res.json({ sets: [], error: err.message });
            res.json({ sets: rows });
        });
    } catch (err) {
        res.json({ sets: [], error: err.message });
    }
});

// ── LIST MTG SETS ──
app.get('/api/mtg/sets', (req, res) => {
    const dbPath = path.join(__dirname, 'data', 'mtg_cards.db');
    if (!fs.existsSync(dbPath)) {
        return res.json({ sets: [], db_exists: false });
    }
    let sqlite3;
    try {
        sqlite3 = require('sqlite3');
    } catch (e) {
        return res.json({ sets: [], error: 'sqlite3 not available' });
    }
    try {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
        db.all('SELECT code, name, release_date FROM sets_info ORDER BY release_date DESC', (err, rows) => {
            db.close();
            if (err) return res.json({ sets: [], error: err.message });
            res.json({ sets: rows });
        });
    } catch (err) {
        res.json({ sets: [], error: err.message });
    }
});

// ── CARD VERSIONS SEARCH (for autocomplete & version picker) ──
app.get('/api/mtg/card-versions', (req, res) => {
    const query = (req.query.q || '').trim();
    const setLock = (req.query.set || '').trim().toLowerCase();
    if (!query || query.length < 1) {
        return res.json({ versions: [] });
    }

    const dbPath = path.join(__dirname, 'data', 'mtg_cards.db');
    if (!fs.existsSync(dbPath)) {
        return res.json({ versions: [], db_exists: false });
    }

    let sqlite3;
    try {
        sqlite3 = require('sqlite3');
    } catch (e) {
        return res.json({ versions: [], error: 'sqlite3 not available' });
    }

    try {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
        const queryLower = query.toLowerCase();
        const likePattern = `${queryLower}%`;

        // First get matches grouped by oracle_id for distinct card names
        let sql = `
            SELECT c.name, c.oracle_id, c.set_code, c.collector_number, 
                   c.normal_image_url, c.art_crop_url, c.usd_price, c.usd_foil_price,
                   s.released_at
            FROM cards c
            LEFT JOIN sets_info s ON c.set_code = s.code
            WHERE LOWER(c.name) LIKE ?
            ${setLock && setLock !== 'any' ? 'AND LOWER(c.set_code) = ?' : ''}
            ORDER BY 
                CASE WHEN LOWER(c.name) = ? THEN 0 ELSE 1 END,
                s.released_at DESC
        `;
        
        const params = [likePattern];
        if (setLock && setLock !== 'any') params.push(setLock);
        params.push(queryLower);

        db.all(sql, params, (err, rows) => {
            db.close();
            if (err) {
                return res.json({ versions: [], error: err.message });
            }

            // Group by oracle_id for unique card name results
            const nameMap = new Map();
            const allVersions = rows.map(row => ({
                name: row.name,
                oracle_id: row.oracle_id,
                set: row.set_code,
                collector_number: row.collector_number,
                image_url: row.normal_image_url || row.art_crop_url || null,
                price_usd: row.usd_price || null,
                price_usd_foil: row.usd_foil_price || null,
                released_at: row.released_at || '1900-01-01'
            }));

            // Deduplicate by name for autocomplete suggestions
            for (const v of allVersions) {
                if (!nameMap.has(v.name)) {
                    nameMap.set(v.name, v);
                }
            }

            // Get all versions for the top match (for version picker)
            let topName = null;
            for (const v of allVersions) {
                if (v.name.toLowerCase() === queryLower && !topName) {
                    topName = v.name;
                }
            }
            if (!topName && allVersions.length > 0) topName = allVersions[0].name;

            let versionsForPicker = [];
            if (topName) {
                let pickerSql = `
                    SELECT c.name, c.oracle_id, c.set_code, c.collector_number, 
                           c.normal_image_url, c.art_crop_url, c.usd_price, c.usd_foil_price,
                           s.released_at
                    FROM cards c
                    LEFT JOIN sets_info s ON c.set_code = s.code
                    WHERE LOWER(c.name) = ?
                    ORDER BY s.released_at DESC
                `;
                const nameLower = topName.toLowerCase();

                fetch('https://api.scryfall.com/cards/search?q=!' + encodeURIComponent(topName) + '&unique=prints&order=released')
                    .then(r => r.ok ? r.json() : { data: [] })
                    .then(sd => {
                        const scryfallVersions = (sd.data || []).map(d => ({
                            name: d.name,
                            oracle_id: d.oracle_id,
                            set: d.set,
                            collector_number: d.collector_number,
                            image_url: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal || null,
                            price_usd: d.prices?.usd || null,
                            price_usd_foil: d.prices?.usd_foil || null,
                            released_at: d.released_at || '1900-01-01'
                        }));
                        res.json({
                            suggestions: Array.from(nameMap.values()).slice(0, 10),
                            versions: scryfallVersions.slice(0, 30),
                            top_name: topName,
                            db_exists: true
                        });
                    })
                    .catch(() => {
                        // Fallback to local DB only
                        const localVersions = allVersions.filter(v => v.name === topName);
                        res.json({
                            suggestions: Array.from(nameMap.values()).slice(0, 10),
                            versions: localVersions.slice(0, 30),
                            top_name: topName,
                            db_exists: true
                        });
                    });
            } else {
                res.json({
                    suggestions: Array.from(nameMap.values()).slice(0, 10),
                    versions: [],
                    top_name: null,
                    db_exists: true
                });
            }
        });
    } catch (err) {
        console.error('Card versions search error:', err);
        res.json({ versions: [], error: err.message });
    }
});

// POST /api/mtg/scan-neural - Neural card scanning using ONNX models (Cornelius + Milo)
// This uses a trained neural network for better corner detection and embedding-based matching.
app.post('/api/mtg/scan-neural', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const imagePath = req.file.path;
    let tempFiles = [imagePath];

    try {
        console.log(`Neural scan: ${req.file.originalname || 'unknown'}`);

        const scanResult = await runPythonScript('scripts/neural_scanner.py', [imagePath]);

        if (scanResult.error) {
            return res.status(500).json({ 
                error: 'Neural scan failed', 
                details: scanResult.error 
            });
        }

        res.json(scanResult);

    } catch (error) {
        console.error('Neural scan error:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message 
        });
    } finally {
        tempFiles.forEach(file => {
            if (fs.existsSync(file)) {
                try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
            }
        });
    }
});

// POST /api/mtg/scan-direct - Direct card scanning (skips detection, goes straight to identifier.py)
app.post('/api/mtg/scan-direct', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const imagePath = req.file.path;
    let tempFiles = [imagePath];

    try {
        console.log(`Direct scan: ${req.file.originalname || 'unknown'}`);

        const identifyResult = await runPythonScript('scripts/identifier.py', [imagePath]);

        if (identifyResult.error) {
            return res.status(500).json({ 
                error: 'Card identification failed', 
                details: identifyResult.error 
            });
        }

        res.json(identifyResult);

    } catch (error) {
        console.error('Scan-direct error:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message 
        });
    } finally {
        tempFiles.forEach(file => {
            if (fs.existsSync(file)) {
                try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
            }
        });
    }
});

// POST /api/mtg/scan-hash - Hash-based card scanning endpoint (with detection)
app.post('/api/mtg/scan-hash', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const imagePath = req.file.path;
    let tempFiles = [imagePath];
    const detectedCardPath = path.join(UPLOAD_DIR, `detected_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);

    try {
        console.log(`Processing image: ${req.file.originalname || 'unknown'}`);

        const detectResult = await runPythonScript('scripts/detector.py', [imagePath, detectedCardPath]);
        tempFiles.push(detectedCardPath);

        if (!detectResult.success) {
            return res.status(400).json({ 
                error: 'Card detection failed', 
                details: detectResult.error || 'Unknown error' 
            });
        }

        const identifyResult = await runPythonScript('scripts/identifier.py', [detectedCardPath]);

        if (identifyResult.error) {
            return res.status(500).json({ 
                error: 'Card identification failed', 
                details: identifyResult.error 
            });
        }

        res.json(identifyResult);

    } catch (error) {
        console.error('Scan-hash error:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message 
        });
    } finally {
        tempFiles.forEach(file => {
            if (fs.existsSync(file)) {
                try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
            }
        });
    }
});

// Helper function to run Python scripts
function runPythonScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
        const absoluteScriptPath = path.join(__dirname, scriptPath);
        const python = spawn('python', [absoluteScriptPath, ...args]);
        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        python.on('close', (code) => {
            if (code !== 0) {
                console.error(`Python script error (${scriptPath}):`, stderr);
                reject(new Error(stderr || `Script exited with code ${code}`));
            } else {
                try {
                    const result = JSON.parse(stdout);
                    resolve(result);
                } catch (e) {
                    resolve({ success: true, output: stdout });
                }
            }
        });
    });
}

// GET /api/mtg/build-status - Get database build progress with card count and progress
app.get('/api/mtg/build-status', (req, res) => {
    const statusPath = path.join(__dirname, 'data', 'build_status.json');
    const dbPath = path.join(__dirname, 'data', 'mtg_cards.db');
    
    try {
        let response = {
            status: 'not_started',
            message: 'Database build has not been started yet.',
            percent_complete: 0,
            db_exists: false,
            is_outdated: true,
            card_count: 0,
            total_scryfall_cards: 114178,
            coverage_percent: 0,
            last_refreshed: null,
            last_refreshed_formatted: 'Never'
        };
        
        // Check if database exists
        if (fs.existsSync(dbPath)) {
            response.db_exists = true;
            const stats = fs.statSync(dbPath);
            const mtime = stats.mtime;
            response.last_refreshed = mtime.toISOString();
            
            const now = Date.now();
            const ageMs = now - mtime.getTime();
            const ageHours = ageMs / (1000 * 60 * 60);
            response.is_outdated = ageHours > 72; // Only outdated if >72 hours old
            response.last_refreshed_formatted = formatDuration(ageMs);
        }
        
        // If build_status.json exists, read progress from it
        if (fs.existsSync(statusPath)) {
            try {
                const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
                
                // Forward step tracking info if present
                if (status.steps) {
                    response.steps = status.steps;
                }
                
                // Check if process actually ran to completion
                const isComplete = status.current_status === 'Build complete!' || status.percent_complete >= 100;
                
                if (isComplete) {
                    response.status = 'complete';
                    response.percent_complete = 100;
                    response.message = 'Database build complete!';
                    response.card_count = status.total_cards || status.processed || 114178;
                    response.coverage_percent = 100;
                    response.db_exists = true;
                    response.is_outdated = false;
                } else if (status.current_status && status.current_status !== 'not_started') {
                    // Still building or crashed — check if the process is still alive
                    const elapsedMs = Date.now() - new Date(status.start_time || now).getTime();
                    const elapsedMin = elapsedMs / 60000;
                    
                    // If it's been more than 15 minutes with no progress update, it crashed
                    if (elapsedMin > 15 && status.percent_complete < 100) {
                        response.status = 'crashed';
                        response.message = 'Build process appears to have stalled. Tap to restart.';
                        response.percent_complete = status.percent_complete || 0;
                        response.card_count = status.processed || 0;
                    } else {
                        response.status = 'building';
                        response.message = status.current_status || 'Building...';
                        response.percent_complete = status.percent_complete || 0;
                        response.card_count = status.processed || 0;
                        response.total_scryfall_cards = status.total_cards || 114178;
                        if (status.start_time) {
                            response.elapsed_ms = elapsedMs;
                            response.elapsed_formatted = formatDuration(elapsedMs);
                        }
                    }
                }
            } catch (e) {
                // status file corrupted — treat as not started
                response.status = 'not_started';
                response.message = 'Build status file corrupted. Tap to rebuild.';
            }
        } else if (response.db_exists) {
            // No status file but DB exists — it was built previously, mark as ready
            response.status = 'complete';
            response.percent_complete = 100;
            response.message = 'Database ready';
            response.is_outdated = false;
            // Try to count cards from DB
            let sqlite3 = null;
            try {
                sqlite3 = require('sqlite3');
            } catch (e) {
                response.card_count = response.total_scryfall_cards;
                response.coverage_percent = 100;
                response.message = 'Database ready (sqlite3 unavailable for count)';
                return res.json(response);
            }
            if (sqlite3) {
                try {
                    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
                    db.get('SELECT COUNT(*) AS cnt FROM cards', (err, row) => {
                        db.close();
                        if (!err && row) {
                            response.card_count = row.cnt;
                            response.coverage_percent = Math.round((row.cnt / response.total_scryfall_cards) * 100);
                        }
                        res.json(response);
                    });
                    return; // response sent in callback
                } catch (e) {
                    // Fallback: just respond without card count
                }
            }
        }
        
        // Calculate coverage
        if (response.card_count > 0) {
            response.coverage_percent = Math.round((response.card_count / response.total_scryfall_cards) * 100);
        }
        
        res.json(response);
    } catch (error) {
        console.error('Error reading build status:', error);
        res.status(500).json({ error: 'Failed to read build status' });
    }
});
    
// POST /api/mtg/build-database - Trigger database build
app.post('/api/mtg/build-database', (req, res) => {
    console.log('Database build requested...');
    
    const statusPath = path.join(__dirname, 'data', 'build_status.json');
    if (fs.existsSync(statusPath)) {
        try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            // Only reject if actively building (less than 15 min elapsed and not complete)
            const elapsedMin = (Date.now() - new Date(status.start_time || Date.now()).getTime()) / 60000;
            if (status.current_status && status.current_status !== 'Build complete!' && status.percent_complete < 100 && elapsedMin < 15) {
                return res.json({ success: false, message: 'Build already in progress' });
            }
        } catch (e) { /* ignore parse errors */ }
    }
    
    const scriptFullPath = path.join(__dirname, 'scripts', 'db_builder.py');
    const logPath = path.join(__dirname, 'data', 'db_build.log');
    
    try {
        if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
        
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        
        console.log(`Spawning Python script: ${scriptFullPath}`);
        
        const python = spawn('python', ['-u', 'db_builder.py'], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: path.join(__dirname, 'scripts')
        });
        
        python.stdout.on('data', (data) => {
            const logMsg = data.toString();
            logStream.write(logMsg);
            process.stdout.write(`[BUILD] ${logMsg}`);
        });
        
        python.stderr.on('data', (data) => {
            const logMsg = data.toString();
            logStream.write(logMsg);
            process.stderr.write(`[BUILD ERROR] ${logMsg}`);
        });
        
        python.on('close', (code) => {
            logStream.write(`\n=== Build process exited with code: ${code} ===\n`);
            logStream.end();
            console.log(`Database build process exited with code: ${code}`);
            // Mark as complete if it exited cleanly
            if (code === 0 && fs.existsSync(statusPath)) {
                try {
                    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
                    status.current_status = 'Build complete!';
                    status.percent_complete = 100;
                    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
                } catch (e) { /* ignore */ }
            }
        });
        
        python.on('error', (err) => {
            logStream.write(`\n=== Build process error: ${err.message} ===\n`);
            logStream.end();
            console.error('Failed to start database build:', err);
        });
        
        python.unref();
        
        logStream.on('open', () => {
            console.log(`Database build started with PID: ${python.pid}`);
            logStream.write(`\n=== Build started at ${new Date().toISOString()} ===\n`);
        });
        
        res.json({ success: true, message: 'Database build started.' });
        
    } catch (error) {
        console.error('Failed to start database build:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
    
// Helper: Format milliseconds to human-readable duration
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}
    
const PORT = process.env.PORT || 3000;

// Initialize database tables (non-blocking)
db.initDatabase().then(() => {
    console.log('MariaDB inventory database ready');
}).catch(err => {
    console.error('MariaDB initialization failed (will retry on first request):', err.message);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`MTG Card Scanner server running on http://localhost:${PORT}`);
    console.log('Prices displayed in AUD (USD * 1.55)');
    // Start HTTPS server for phone camera access (non-blocking)
    startHttpsServer(io);
});
