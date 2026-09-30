// ── MariaDB Connection Pool ──────────────────────────────────────────────
// Connects to the MariaDB instance at 192.168.4.41
const mysql = require('mysql2/promise');

const DB_CONFIG = {
    host: '192.168.4.41',
    user: 'mtgscanner',
    password: 'Cookmush888!',
    database: 'mtg_inventory',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool = null;

async function getPool() {
    if (!pool) {
        pool = mysql.createPool(DB_CONFIG);
    }
    return pool;
}

// Initialize database: create DB and tables if they don't exist
async function initDatabase() {
    // First connect without database to create it
    const initConn = await mysql.createConnection({
        host: DB_CONFIG.host,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password
    });
    
    await initConn.execute(`CREATE DATABASE IF NOT EXISTS mtg_inventory`);
    await initConn.end();
    
    const p = await getPool();
    
    // Create tables
    await p.execute(`
        CREATE TABLE IF NOT EXISTS tbl_sessions (
            session_id VARCHAR(32) PRIMARY KEY,
            session_name VARCHAR(128) NOT NULL DEFAULT '',
            set_code VARCHAR(8) DEFAULT '',
            set_name VARCHAR(128) DEFAULT '',
            date_scanned DATETIME DEFAULT CURRENT_TIMESTAMP,
            cost DECIMAL(10,2) DEFAULT 0.00,
            value DECIMAL(10,2) DEFAULT 0.00,
            net DECIMAL(10,2) DEFAULT 0.00
        )
    `);
    
    // Add session_name column if it doesn't exist (for existing tables)
    try {
        await p.execute(`ALTER TABLE tbl_sessions ADD COLUMN session_name VARCHAR(128) NOT NULL DEFAULT ''`);
    } catch (e) {
        // Column already exists — ignore
    }
    
    await p.execute(`
        CREATE TABLE IF NOT EXISTS tbl_inventory (
            id INT AUTO_INCREMENT PRIMARY KEY,
            card_name VARCHAR(255) NOT NULL,
            set_name VARCHAR(128) DEFAULT '',
            set_code VARCHAR(8) DEFAULT '',
            card_condition VARCHAR(8) DEFAULT 'NM',
            scryfall_id VARCHAR(64) DEFAULT '',
            session_id VARCHAR(32) DEFAULT '',
            active TINYINT(1) DEFAULT 1,
            foil TINYINT(1) DEFAULT 0,
            borderless TINYINT(1) DEFAULT 0,
            date_sold DATETIME NULL,
            order_id VARCHAR(32) DEFAULT NULL,
            price DECIMAL(10,2) DEFAULT 0.00,
            sold_price DECIMAL(10,2) DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES tbl_sessions(session_id) ON DELETE SET NULL
        )
    `);
    
    await p.execute(`
        CREATE TABLE IF NOT EXISTS tbl_orders (
            order_id INT AUTO_INCREMENT PRIMARY KEY,
            order_id_external VARCHAR(64) DEFAULT '',
            order_value DECIMAL(10,2) DEFAULT 0.00,
            order_cost DECIMAL(10,2) DEFAULT 0.00,
            order_date DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Migration: add new columns if missing (for existing databases)
    try { await p.execute(`ALTER TABLE tbl_orders ADD COLUMN order_id_external VARCHAR(64) DEFAULT '' AFTER order_id`); } catch (e) { /* column exists */ }
    try { await p.execute(`ALTER TABLE tbl_orders ADD COLUMN order_cost DECIMAL(10,2) DEFAULT 0.00 AFTER order_value`); } catch (e) { /* column exists */ }
    try { await p.execute(`ALTER TABLE tbl_orders MODIFY COLUMN order_id INT AUTO_INCREMENT`); } catch (e) { /* may fail if VARCHAR data exists, handled at app level */ }
    // Also add order_id_external to tbl_inventory for orders created via the new flow
    try { await p.execute(`ALTER TABLE tbl_inventory ADD COLUMN order_id_external VARCHAR(64) DEFAULT ''`); } catch (e) { /* column exists */ }
    
    await p.execute(`
        CREATE TABLE IF NOT EXISTS tbl_card (
            scryfall_id VARCHAR(64) PRIMARY KEY,
            oracle_id VARCHAR(64) DEFAULT '',
            name VARCHAR(255) DEFAULT '',
            set_code VARCHAR(8) DEFAULT '',
            set_name VARCHAR(128) DEFAULT '',
            collector_number VARCHAR(16) DEFAULT '',
            lang VARCHAR(8) DEFAULT '',
            released_at DATE DEFAULT NULL,
            layout VARCHAR(32) DEFAULT '',
            mana_cost VARCHAR(64) DEFAULT '',
            cmc DECIMAL(5,1) DEFAULT 0.0,
            type_line VARCHAR(255) DEFAULT '',
            oracle_text TEXT DEFAULT NULL,
            power VARCHAR(8) DEFAULT '',
            toughness VARCHAR(8) DEFAULT '',
            loyalty VARCHAR(8) DEFAULT '',
            colors VARCHAR(64) DEFAULT '',
            color_identity VARCHAR(64) DEFAULT '',
            keywords TEXT DEFAULT NULL,
            rarity VARCHAR(16) DEFAULT '',
            artist VARCHAR(128) DEFAULT '',
            image_uris TEXT DEFAULT NULL,
            card_faces TEXT DEFAULT NULL,
            legalities TEXT DEFAULT NULL,
            prices TEXT DEFAULT NULL,
            purchase_uris TEXT DEFAULT NULL,
            edhrec_rank INT DEFAULT NULL,
            reserved TINYINT(1) DEFAULT 0,
            foil_available TINYINT(1) DEFAULT 0,
            nonfoil_available TINYINT(1) DEFAULT 0,
            finishes VARCHAR(64) DEFAULT '',
            promo TINYINT(1) DEFAULT 0,
            promo_types VARCHAR(128) DEFAULT '',
            digital TINYINT(1) DEFAULT 0,
            tcgplayer_id INT DEFAULT NULL,
            cardmarket_id INT DEFAULT NULL,
            scryfall_uri VARCHAR(255) DEFAULT '',
            INDEX idx_name (name),
            INDEX idx_set_code (set_code),
            INDEX idx_oracle_id (oracle_id)
        )
    `);
    
    console.log('Database tables initialized successfully');
    return true;
}

// ── Query helpers ──

async function query(sql, params = []) {
    const p = await getPool();
    const [rows] = await p.execute(sql, params);
    return rows;
}

async function getOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows.length > 0 ? rows[0] : null;
}

async function insert(sql, params = []) {
    const p = await getPool();
    const [result] = await p.execute(sql, params);
    return result;
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = {
    getPool,
    initDatabase,
    query,
    getOne,
    insert,
    closePool
};