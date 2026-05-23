-- ============================================================
-- MTG Card Scanner — Inventory System SQL Schema
-- Run this on MariaDB at 192.168.4.37 with user mtgscanner
-- ============================================================

CREATE DATABASE IF NOT EXISTS mtg_inventory;
USE mtg_inventory;

-- Sessions table: one row per scanning session
CREATE TABLE IF NOT EXISTS tbl_sessions (
    session_id VARCHAR(32) PRIMARY KEY,
    session_name VARCHAR(128) NOT NULL DEFAULT '',
    set_code VARCHAR(8) DEFAULT '',
    set_name VARCHAR(128) DEFAULT '',
    date_scanned DATETIME DEFAULT CURRENT_TIMESTAMP,
    cost DECIMAL(10,2) DEFAULT 0.00,
    value DECIMAL(10,2) DEFAULT 0.00,
    net DECIMAL(10,2) DEFAULT 0.00
);

-- Inventory table: one row per scanned card
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
);

-- Orders table
CREATE TABLE IF NOT EXISTS tbl_orders (
    order_id VARCHAR(32) PRIMARY KEY,
    order_value DECIMAL(10,2) DEFAULT 0.00,
    order_date DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Scryfall card data cache
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
);