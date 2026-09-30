// ── Inventory API Routes ────────────────────────────────────────────────
// REST endpoints for sessions, cards, and orders

const express = require('express');
const router = express.Router();
const db = require('../db');

// ── SESSIONS ─────────────────────────────────────────────────────────────

// GET /api/inventory/sessions — list all sessions with totals
router.get('/sessions', async (req, res) => {
    try {
        const sessions = await db.query(`
            SELECT s.*, 
                   COALESCE(COUNT(i.id), 0) AS card_count
            FROM tbl_sessions s
            LEFT JOIN tbl_inventory i ON s.session_id = i.session_id
            GROUP BY s.session_id
            ORDER BY s.date_scanned DESC
        `);

        // Calculate cumulative totals for graph
        const cumulative = [];
        let runningCost = 0, runningValue = 0, runningNet = 0;
        const ordered = [...sessions].reverse();
        for (const s of ordered) {
            runningCost += parseFloat(s.cost || 0);
            runningValue += parseFloat(s.value || 0);
            runningNet += parseFloat(s.net || 0);
            cumulative.push({
                session_id: s.session_id,
                date: s.date_scanned,
                cost: parseFloat(runningCost.toFixed(2)),
                value: parseFloat(runningValue.toFixed(2)),
                net: parseFloat(runningNet.toFixed(2))
            });
        }

        // Totals
        const totals = {
            total_cost: sessions.reduce((a, s) => a + parseFloat(s.cost || 0), 0),
            total_value: sessions.reduce((a, s) => a + parseFloat(s.value || 0), 0),
            total_net: sessions.reduce((a, s) => a + parseFloat(s.net || 0), 0),
            total_cards: sessions.reduce((a, s) => a + parseInt(s.card_count || 0), 0)
        };

        res.json({ sessions, cumulative, totals });
    } catch (err) {
        console.error('Error fetching sessions:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/inventory/sessions/:id — update a session
router.put('/sessions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { session_name, set_code, set_name, date_scanned, cost, value, net } = req.body;
        
        const updates = [];
        const params = [];
        
        if (session_name !== undefined) { updates.push('session_name = ?'); params.push(session_name); }
        if (set_code !== undefined) { updates.push('set_code = ?'); params.push(set_code); }
        if (set_name !== undefined) { updates.push('set_name = ?'); params.push(set_name); }
        if (date_scanned !== undefined) { updates.push('date_scanned = ?'); params.push(date_scanned); }
        if (cost !== undefined) { updates.push('cost = ?'); params.push(cost); }
        if (value !== undefined) { updates.push('value = ?'); params.push(value); }
        if (net !== undefined) { updates.push('net = ?'); params.push(net); }
        
        if (updates.length === 0) {
            return res.json({ success: true, message: 'No changes' });
        }
        
        params.push(id);
        await db.query(`UPDATE tbl_sessions SET ${updates.join(', ')} WHERE session_id = ?`, params);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating session:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── CARDS / INVENTORY ────────────────────────────────────────────────────

// GET /api/inventory/cards — list all inventory cards with optional filtering
router.get('/cards', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();
        const activeOnly = req.query.active !== 'false' && req.query.active !== '0';
        const setCode = (req.query.set || '').trim().toLowerCase();
        const sortBy = req.query.sort_by || 'created_at';
        const sortDir = req.query.sort_dir === 'asc' ? 'ASC' : 'DESC';
        const columns = req.query.columns ? req.query.columns.split(',') : null;

        let where = [];
        let params = [];

        if (activeOnly) {
            where.push('i.active = 1');
        }

        if (search) {
            where.push('LOWER(i.card_name) LIKE ?');
            params.push(`%${search.toLowerCase()}%`);
        }

        if (setCode) {
            where.push('LOWER(i.set_code) = ?');
            params.push(setCode);
        }

        const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

        // Count total
        const countResult = await db.getOne(
            `SELECT COUNT(*) AS total FROM tbl_inventory i ${whereClause}`,
            params
        );
        const total = countResult ? countResult.total : 0;

        // Validate sort column (whitelist)
        const allowedSorts = ['id', 'card_name', 'set_name', 'set_code', 'price', 'sold_price', 'date_sold', 'created_at', 'foil', 'borderless', 'active'];
        const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'created_at';

        // Fetch with card image lookup
        const rows = await db.query(`
            SELECT i.*, 
                   tc.image_uris AS scryfall_image_uris,
                   tc.name AS scryfall_name
            FROM tbl_inventory i
            LEFT JOIN tbl_card tc ON i.scryfall_id = tc.scryfall_id
            ${whereClause}
            ORDER BY i.${safeSort} ${sortDir}
            LIMIT ? OFFSET ?
        `, [...params, String(limit), String(offset)]);

        // Parse image_uris for each row
        let cards = rows.map(row => ({
            ...row,
            price: parseFloat(row.price || 0),
            sold_price: row.sold_price ? parseFloat(row.sold_price) : null,
            card_image: row.scryfall_image_uris ? JSON.parse(row.scryfall_image_uris) : null
        }));

        // Fallback: for cards without images, try local SQLite DB
        const cardsMissingImages = cards.filter(c => !c.card_image && c.scryfall_id);
        if (cardsMissingImages.length > 0) {
            try {
                const path = require('path');
                const fs = require('fs');
                const sqlitePath = path.join(__dirname, '..', 'data', 'mtg_cards.db');
                if (fs.existsSync(sqlitePath)) {
                    const sqlite3 = require('sqlite3');
                    const sqliteDb = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
                    
                    // Build query: look up by scryfall_id (oracle_id in SQLite) 
                    // or by card_name as last resort
                    const missingIds = cardsMissingImages.map(c => c.scryfall_id).filter(Boolean);
                    if (missingIds.length > 0) {
                        const placeholders = missingIds.map(() => '?').join(',');
                        sqliteDb.all(
                            `SELECT oracle_id, normal_image_url, art_crop_url, image_uris FROM cards 
                             WHERE oracle_id IN (${placeholders})`,
                            missingIds,
                            (err, sqliteRows) => {
                                sqliteDb.close();
                                if (!err && sqliteRows) {
                                    // Build lookup by oracle_id
                                    const imgMap = {};
                                    for (const sr of sqliteRows) {
                                        let uris = null;
                                        if (sr.image_uris) {
                                            try { uris = JSON.parse(sr.image_uris); } catch(e) {
                                                uris = { small: sr.normal_image_url, normal: sr.normal_image_url };
                                            }
                                        } else if (sr.normal_image_url) {
                                            uris = { small: sr.normal_image_url, normal: sr.normal_image_url };
                                        }
                                        if (uris) imgMap[sr.oracle_id] = uris;
                                    }
                                    // Apply fallback images
                                    for (const card of cards) {
                                        if (!card.card_image && card.scryfall_id && imgMap[card.scryfall_id]) {
                                            card.card_image = imgMap[card.scryfall_id];
                                        }
                                    }
                                }
                                // Send response after fallback
                                res.json({ cards, total, page, limit, total_pages: Math.ceil(total / limit) });
                            }
                        );
                        return; // Response sent in callback
                    }
                    sqliteDb.close();
                }
            } catch (e) {
                // SQLite fallback failed - ignore, send response without images
            }
        }

        res.json({
            cards,
            total,
            page,
            limit,
            total_pages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Error fetching cards:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/inventory/cards/:id — update a card
router.put('/cards/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { foil, borderless, card_condition, price, active, date_sold, sold_price, order_id } = req.body;
        
        const updates = [];
        const params = [];
        
        if (foil !== undefined) { updates.push('foil = ?'); params.push(foil ? 1 : 0); }
        if (borderless !== undefined) { updates.push('borderless = ?'); params.push(borderless ? 1 : 0); }
        if (card_condition !== undefined) { updates.push('card_condition = ?'); params.push(card_condition); }
        if (price !== undefined) { updates.push('price = ?'); params.push(price); }
        if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
        if (date_sold !== undefined) { updates.push('date_sold = ?'); params.push(date_sold); }
        if (sold_price !== undefined) { updates.push('sold_price = ?'); params.push(sold_price); }
        if (order_id !== undefined) { updates.push('order_id = ?'); params.push(order_id); }
        
        if (updates.length === 0) {
            return res.json({ success: true, message: 'No changes' });
        }
        
        params.push(id);
        await db.query(`UPDATE tbl_inventory SET ${updates.join(', ')} WHERE id = ?`, params);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating card:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/inventory/cards/batch-sold — mark multiple cards as sold
router.post('/cards/batch-sold', async (req, res) => {
    try {
        const { card_ids, order_id } = req.body;
        
        if (!card_ids || !Array.isArray(card_ids) || card_ids.length === 0) {
            return res.status(400).json({ error: 'card_ids array is required' });
        }
        if (!order_id) {
            return res.status(400).json({ error: 'order_id is required' });
        }

        // First ensure the order exists
        const existingOrder = await db.getOne('SELECT order_id FROM tbl_orders WHERE order_id = ?', [order_id]);
        if (!existingOrder) {
            // Create the order automatically
            await db.query(
                'INSERT INTO tbl_orders (order_id, order_value, order_date) VALUES (?, 0, NOW())',
                [order_id]
            );
        }

        // Get total sold price from these cards
        const cardsToSell = await db.query(
            `SELECT id, price, sold_price FROM tbl_inventory WHERE id IN (${card_ids.map(() => '?').join(',')})`,
            card_ids
        );

        const totalSold = cardsToSell.reduce((sum, c) => {
            return sum + parseFloat(c.sold_price || c.price || 0);
        }, 0);

        // Mark cards as sold
        const placeholders = card_ids.map(() => '?').join(',');
        await db.query(
            `UPDATE tbl_inventory SET active = 0, date_sold = NOW(), order_id = ? WHERE id IN (${placeholders})`,
            [order_id, ...card_ids]
        );

        // Update order value
        await db.query(
            'UPDATE tbl_orders SET order_value = order_value + ? WHERE order_id = ?',
            [totalSold, order_id]
        );

        res.json({ success: true, cards_updated: card_ids.length, total_sold: totalSold });
    } catch (err) {
        console.error('Error batch selling cards:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── ORDERS ──────────────────────────────────────────────────────────────

// GET /api/inventory/orders — list all orders
router.get('/orders', async (req, res) => {
    try {
        const orders = await db.query(`
            SELECT o.*, 
                   COALESCE(COUNT(i.id), 0) AS card_count
            FROM tbl_orders o
            LEFT JOIN tbl_inventory i ON o.order_id = i.order_id
            GROUP BY o.order_id
            ORDER BY o.order_date DESC
        `);
        res.json({ orders });
    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/inventory/orders — create a new order (auto-increment order_id)
router.post('/orders', async (req, res) => {
    try {
        const { order_id_external, order_value, order_cost, order_date } = req.body;
        const dateVal = order_date || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const result = await db.query(
            `INSERT INTO tbl_orders (order_id_external, order_value, order_cost, order_date) VALUES (?, ?, ?, ?)`,
            [order_id_external || '', order_value || 0, order_cost || 0, dateVal]
        );
        const newId = result.insertId;
        res.json({ success: true, order_id: newId, order_id_external: order_id_external || '' });
    } catch (err) {
        console.error('Error creating order:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/inventory/orders/:id — update an order
router.put('/orders/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { order_id_external, order_value, order_cost, order_date } = req.body;
        
        const updates = [];
        const params = [];
        
        if (order_id_external !== undefined) { updates.push('order_id_external = ?'); params.push(order_id_external); }
        if (order_value !== undefined) { updates.push('order_value = ?'); params.push(order_value); }
        if (order_cost !== undefined) { updates.push('order_cost = ?'); params.push(order_cost); }
        if (order_date !== undefined) { updates.push('order_date = ?'); params.push(order_date); }
        
        if (updates.length === 0) {
            return res.json({ success: true, message: 'No changes' });
        }
        
        params.push(id);
        await db.query(`UPDATE tbl_orders SET ${updates.join(', ')} WHERE order_id = ?`, params);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating order:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── SAVE SESSION (triggered by "Done" button) ────────────────────────────

// POST /api/inventory/save-session — save a completed session with all its cards
router.post('/save-session', async (req, res) => {
    try {
        const { session_id, session_name, set_code, set_name, cost, cards } = req.body;
        
        if (!cards || !Array.isArray(cards)) {
            return res.status(400).json({ error: 'cards array required' });
        }

        // Calculate totals
        const totalValue = cards.reduce((sum, c) => sum + parseFloat(c.price || 0), 0);
        const sessionCost = parseFloat(cost || 0);
        const net = totalValue - sessionCost;

        // Insert new session row (session_id is AUTO_INCREMENT, managed by DB)
        const insertResult = await db.query(
            `INSERT INTO tbl_sessions (session_name, set_code, set_name, cost, value, net, date_scanned)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [session_name || session_id || 'Session', set_code || '', set_name || '', sessionCost, totalValue, net]
        );
        const newSessionId = insertResult.insertId;

        // Insert cards using the new numeric session_id
        let inserted = 0;
        for (const card of cards) {
            await db.query(
                `INSERT INTO tbl_inventory 
                 (card_name, set_name, set_code, card_condition, scryfall_id, session_id, 
                  active, foil, borderless, price)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
                [
                    card.card_name || card.name || 'Unknown',
                    card.set_name || '',
                    card.set_code || '',
                    card.card_condition || card.condition || 'NM',
                    card.scryfall_id || '',
                    newSessionId,
                    card.foil ? 1 : 0,
                    card.borderless ? 1 : 0,
                    parseFloat(card.price || 0)
                ]
            );
            inserted++;
        }

        console.log(`Session #${newSessionId} saved: ${inserted} cards, value $${totalValue.toFixed(2)}, net $${net.toFixed(2)}`);
        res.json({ success: true, session_id: newSessionId, cards_inserted: inserted, total_value: totalValue, net });
    } catch (err) {
        console.error('Error saving session:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/inventory/stats — quick stats for dashboard
router.get('/stats', async (req, res) => {
    try {
        const totalCards = await db.getOne('SELECT COUNT(*) AS count FROM tbl_inventory WHERE active = 1');
        const totalSold = await db.getOne('SELECT COUNT(*) AS count FROM tbl_inventory WHERE active = 0 AND date_sold IS NOT NULL');
        const totalValue = await db.getOne('SELECT COALESCE(SUM(price), 0) AS total FROM tbl_inventory WHERE active = 1');
        const totalSoldValue = await db.getOne('SELECT COALESCE(SUM(sold_price), 0) AS total FROM tbl_inventory WHERE active = 0');
        const totalSessions = await db.getOne('SELECT COUNT(*) AS count FROM tbl_sessions');
        
        res.json({
            total_cards: totalCards ? parseInt(totalCards.count) : 0,
            total_sold: totalSold ? parseInt(totalSold.count) : 0,
            total_value: totalValue ? parseFloat(totalValue.total) : 0,
            total_sold_value: totalSoldValue ? parseFloat(totalSoldValue.total) : 0,
            total_sessions: totalSessions ? parseInt(totalSessions.count) : 0
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── CARD SEARCH AUTOCOMPLETE ─────────────────────────────────────────────

// GET /api/inventory/card-search — autocomplete search with fallback to local SQLite
router.get('/card-search', async (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        if (query.length < 2) {
            return res.json({ results: [] });
        }
        
        const fs = require('fs');
        const path = require('path');
        
        // Try MariaDB first
        try {
            const results = await db.query(
                `SELECT scryfall_id, name, set_code, set_name, collector_number, 
                        image_uris, prices, rarity
                 FROM tbl_card 
                 WHERE LOWER(name) LIKE ? 
                 ORDER BY 
                    CASE WHEN LOWER(name) = ? THEN 0
                         WHEN LOWER(name) LIKE ? THEN 1
                         ELSE 2 END,
                    released_at DESC
                 LIMIT 20`,
                [`%${query.toLowerCase()}%`, query.toLowerCase(), `${query.toLowerCase()}%`]
            );
            
            if (results && results.length > 0) {
                const cards = results.map(r => ({
                    ...r,
                    image_uris: r.image_uris ? JSON.parse(r.image_uris) : null,
                    prices: r.prices ? JSON.parse(r.prices) : null
                }));
                return res.json({ results: cards, source: 'mariadb' });
            }
        } catch (mdbErr) {
            // MariaDB unavailable, fall through to local SQLite
            console.log('MariaDB card-search unavailable, falling back to SQLite');
        }
        
        // Fallback: search local SQLite database
        const dbPath = path.join(__dirname, '..', 'data', 'mtg_cards.db');
        if (!fs.existsSync(dbPath)) {
            return res.json({ results: [], source: 'none', db_exists: false });
        }
        
        let sqlite3;
        try {
            sqlite3 = require('sqlite3');
        } catch (e) {
            return res.json({ results: [], source: 'none', error: 'sqlite3 not available' });
        }
        
        const sqliteDb = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
        const queryLower = query.toLowerCase();
        
        sqliteDb.all(`
            SELECT name, set_code, collector_number, normal_image_url, art_crop_url, 
                   image_uris, oracle_id, usd_price, usd_foil_price
            FROM cards 
            WHERE LOWER(name) LIKE ?
            ORDER BY 
                CASE WHEN LOWER(name) = ? THEN 0
                     WHEN LOWER(name) LIKE ? THEN 1
                     ELSE 2 END,
                name ASC
            LIMIT 20
        `, [`%${queryLower}%`, queryLower, `${queryLower}%`], (err, rows) => {
            sqliteDb.close();
            if (err) {
                return res.json({ results: [], source: 'sqlite', error: err.message });
            }
            
            const cards = rows.map(r => {
                let imageUris = null;
                if (r.image_uris) {
                    try { imageUris = JSON.parse(r.image_uris); } catch(e) {
                        imageUris = { normal: r.normal_image_url, small: r.art_crop_url };
                    }
                } else if (r.normal_image_url) {
                    imageUris = { normal: r.normal_image_url, small: r.art_crop_url };
                }
                
                return {
                    scryfall_id: r.oracle_id || '',
                    name: r.name,
                    set_code: r.set_code,
                    set_name: '',
                    collector_number: r.collector_number,
                    image_uris: imageUris,
                    prices: (r.usd_price || r.usd_foil_price) ? {
                        usd: r.usd_price,
                        usd_foil: r.usd_foil_price
                    } : null,
                    rarity: ''
                };
            });
            
            res.json({ results: cards, source: 'sqlite' });
        });
        
    } catch (err) {
        console.error('Error in card search:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;