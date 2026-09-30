# MTG Card Scanner

A real-time **Magic: The Gathering card scanner** that identifies cards from a live camera feed using **neural embedding matching** (powered by [CollectorVision](https://github.com/HanClinto/CollectorVision)). Point your phone or webcam at a card and it instantly recognises the card, shows its value, and lets you build an inventory — all with a clean, mobile-friendly UI.

---

## ✨ Features

- **📷 Live card scanning** — point a camera at a card; the app detects the card, dewarp it, and identifies it in real time.
- **🧠 Neural embedding matching** — uses CollectorVision's pre-built ~113K-card MTG embedding catalog with **cosine-similarity search** (no OCR needed). Robust to angle, lighting, and skew.
- **💰 Value detection** — shows each card's market price (in AUD) and plays a **"ching ching" cash sound** when a card is over your value threshold.
- **📦 Inventory management** — save scanned cards to sessions, track box cost vs. value vs. net, and manage your collection.
- **📊 Sessions & orders** — group scans into sessions, mark cards as sold, and track orders.
- **📥 Excel export** — export any session to a formatted `.xlsx` file with all card columns (including a **Keep** flag).
- **📱 Mobile-friendly** — works from a phone camera over HTTPS (self-signed cert for local access).

---

## 🏗 Architecture

The app is a **Node.js (Express)** server with a **Python** helper layer for card identification.

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (public/)                                          │
│  • Live camera feed → client-side card detection (OpenCV)   │
│  • Sends perspective-corrected crop to the server           │
└──────────────────────────┬──────────────────────────────────┘
                           │  POST /api/mtg/scan-neural
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Node.js / Express (server.js)                              │
│  • Serves the UI + REST + Socket.IO session sync            │
│  • Shells out to Python for identification                  │
└──────────────────────────┬──────────────────────────────────┘
                           │  python collectorvision_scanner.py
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Python — CollectorVision (scripts/collectorvision_scanner) │
│  1. NeuralCornerDetector (Cornelius) → finds card corners   │
│  2. detection.dewarp() → perspective-corrected 448×448 crop │
│  3. NeuralEmbedder (Milo) → 128-d ArcFace embedding         │
│  4. Catalog.search_records() → cosine search (113K cards)   │
└─────────────────────────────────────────────────────────────┘
```

### Data stores

| Store | Purpose |
|-------|---------|
| **SQLite** (`data/mtg_cards.db`) | Local card catalog (~114K cards) with names, sets, prices, image URLs |
| **MariaDB** (`mtg_inventory`) | Inventory, sessions, and orders (via `db.js`) |
| **CollectorVision catalog** | Pre-built MTG embedding index (downloaded on first use from HuggingFace) |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+ (with npm)
- **Python** 3.10+ (tested on 3.14)
- **MariaDB** server (for inventory features)
- Python packages: `onnxruntime`, `opencv-python`, `numpy`, `Pillow`, `requests`, `collectorvision`

### 1. Install dependencies

```bash
# Node dependencies
npm install

# Python dependencies
pip install onnxruntime opencv-python-headless numpy Pillow requests
pip install "git+https://github.com/HanClinto/CollectorVision.git"
```

> **Note:** `collectorvision` is not on PyPI — install it from the GitHub repo as shown above.

### 2. Configure the database

Copy `.env.example` to `.env` and set your MariaDB connection details. The server connects to MariaDB at the host configured in `db.js` (default `192.168.4.41`, user `mtgscanner`).

```bash
cp .env.example .env
```

### 3. Build the card catalog (optional)

The app uses CollectorVision's pre-built MTG catalog (downloaded automatically on first scan). If you want to build/refresh the local SQLite card database:

```bash
python scripts/db_builder.py
```

### 4. Start the server

```bash
npm start
# or
node server.js
```

The app runs at **http://localhost:3000** (HTTPS on **https://localhost:3443** for phone camera access).

---

## 🎮 Usage

1. Open `http://localhost:3000` in a browser (or on your phone via the HTTPS URL).
2. Allow camera access.
3. Hold an MTG card up to the camera.
4. The app detects the card, identifies it, and shows its name, set, and value.
5. If the card is over your **Min Value** threshold, you'll hear a **"ching ching"** cash sound.
6. Add cards to inventory, group them into sessions, and export to Excel when done.

### Settings

| Setting | Description |
|---------|-------------|
| **Min Value ($)** | Cards at or above this price trigger the cash sound (default $5) |
| **Scan Mode** | Detection method (OCR / Neural Embeddings) |
| **Buttons Position** | Overlay button placement (left/right) |

---

## 📁 Project Structure

```
mtg-card-scanner/
├── server.js                 # Express server, REST + Socket.IO, scan endpoints
├── db.js                     # MariaDB connection pool + schema init
├── sql_schema.sql            # MariaDB schema (inventory, sessions, orders)
├── package.json
├── public/                   # Frontend (served statically)
│   ├── index.html            # Main scanner UI
│   ├── inventory.html        # Inventory / sessions / orders UI
│   ├── card-detector.js      # Client-side card detection (OpenCV)
│   ├── hash-scanner.js       # Hash-based scan provider
│   ├── neural-scanner.js     # Neural scan provider
│   ├── card-scan-service.js  # Scan orchestration
│   └── ocr-processor.js      # OCR processor (legacy)
├── routes/
│   └── inventory-api.js      # Inventory REST API + Excel export
├── scripts/
│   ├── collectorvision_scanner.py  # ★ Primary scan pipeline (CollectorVision)
│   ├── db_builder.py         # Builds the SQLite card catalog
│   ├── identifier.py         # Legacy OCR + hash pipeline
│   ├── neural_scanner.py     # Legacy neural pipeline
│   ├── detector.py           # OpenCV card detector
│   └── scryfall_loader.py    # Scryfall data loader
├── models/                   # ONNX models (cornelius.onnx, milo.onnx)
├── data/                     # SQLite DB, card images, build status
└── deploy/                   # Proxmox LXC deployment scripts
```

---

## 🔌 API Endpoints

### Scanning

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/mtg/scan-neural` | Identify a card via CollectorVision (multipart `image`; optional `skip_detection=1` for pre-cropped input) |
| `POST` | `/api/mtg/scan-direct` | Legacy OCR + hash identification |
| `POST` | `/api/mtg/scan-hash` | Legacy detection + hash identification |

### Card catalog

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mtg/search-local` | Search local SQLite catalog by name |
| `GET` | `/api/mtg/sets` | List all sets |
| `GET` | `/api/mtg/sets-search` | Search sets |
| `GET` | `/api/mtg/card-versions` | Card printings/versions |

### Inventory

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/inventory/sessions` | List sessions with totals |
| `POST` | `/api/inventory/save-session` | Save a completed session + cards |
| `GET` | `/api/inventory/cards` | List inventory cards |
| `GET` | `/api/inventory/sessions/:id/export` | **Export a session to Excel** |
| `GET` | `/api/inventory/stats` | Dashboard stats |
| `GET` | `/api/inventory/orders` | List orders |

---

## 📥 Excel Export

Each session can be exported to a formatted Excel workbook with **three sheets**:

1. **Session Summary** — session metadata, cost, value, net, card count.
2. **Cards** — every inventory column plus Scryfall enrichment (collector number, rarity, type line, colors, CMC, artist, prices, image URIs) and a **Keep** flag (`Yes`/`No`).
3. **Orders** — order details for any cards linked to orders.

The header row is styled, frozen, and has auto-filter enabled for easy sorting.

---

## 🧠 How Identification Works

The scanner uses **CollectorVision's** neural pipeline — no OCR required:

1. **Detect** — `NeuralCornerDetector` (Cornelius, a MobileViT-XXS + SimCC model) finds the 4 card corners, even with extreme skew or rotation.
2. **Dewarp** — the card region is perspective-corrected into a flat 448×448 image.
3. **Embed** — `NeuralEmbedder` (Milo, ArcFace) produces a 128-dimensional embedding vector.
4. **Search** — the embedding is compared via **cosine similarity** against CollectorVision's pre-built ~113K-card MTG catalog.
5. **Match** — the top matches are returned with confidence scores; the UI shows the best match and alternatives.

This approach is far more robust than OCR because it matches on the card's visual identity rather than reading text, making it resilient to lighting, angle, and print variations.

---

## 🛠 Development

### Running the scanner script directly

```bash
python scripts/collectorvision_scanner.py <image_path> [skip]
```

- `<image_path>` — path to a card image
- `skip` — optional; use if the image is already a perspective-corrected card crop

### Testing the scan endpoint

```bash
curl -F "image=@card.jpg" http://localhost:3000/api/mtg/scan-neural
```

### Legacy scripts

The original OCR (`identifier.py`) and neural (`neural_scanner.py`) pipelines are kept for reference/rollback. The active scan path is `collectorvision_scanner.py`.

---

## 📦 Deployment

See [`deploy/README.md`](deploy/README.md) for deploying to a Proxmox LXC container. The deploy script fetches the latest code, installs dependencies, and restarts the app as a systemd service.

---

## 🙏 Credits

- **[CollectorVision](https://github.com/HanClinto/CollectorVision)** — the neural card detection + embedding matching library and pre-built MTG catalog.
- **[Scryfall](https://scryfall.com)** — card data, images, and pricing.
- **Tesseract** — legacy OCR (no longer used in the primary scan path).

---

## 📄 License

ISC