# CSV-SERVER — FILE INDEX
> Railway backend. Auto-deploys from GitHub main.

---

## FILES

| File | Purpose |
|------|---------|
| `server.js` | Main Express + WebSocket server (798 lines) |
| `dashboard.html` | Admin dashboard UI — served at GET /dashboard (Driver Log = Van manifest `#vm-root`: undo-aware netting, PO fallback, sticky panels, per-invoice delete; Scan Log excludes van scans) |
| `app.json` | Backend app config |
| `package.json` | Backend dependencies (express, multer, ws) |

---

## SERVER.JS — TABLE OF CONTENTS

| Line | Section |
|------|---------|
| 1 | **Imports** — express, multer, fs, http, ws |
| 8 | **Server init** — app, httpServer, WebSocketServer |
| 12 | **Constants** — PORT, DATA_DIR, UPLOAD, META paths |
| 20 | **Meta helpers** — readMeta / writeMeta |
| 25 | **Rooms persistence** — readRooms / saveRooms |
| 49 | **rooms map** — loaded on startup |
| 52 | **getRoomByClient / cleanRooms** — room management helpers |
| 67 | **Scan log** — readScanLog / saveScanLog / purgeScanLog (14-day TTL) |
| 83 | **Invoices persistence** — readInvoices / saveInvoices / purgeInvoices |
| 101 | **clients map** — ws → clientInfo |
| 103 | **broadcast / broadcastToRoom / sendToClient** — WS message helpers |
| 123 | **getRoomPresence** — builds presence list for a room |
| 139 | **wss.on("connection")** — ★ WebSocket handler (all board sync logic) |
| 572 | **HTTP middleware** — JSON body, CORS headers |
| 581 | **multer storage** — file upload config |
| 590 | `GET  /files` — list uploaded CSV files |
| 595 | `POST /upload` — upload CSV file |
| 605 | `GET  /file-meta/:filename` — file metadata |
| 611 | `GET  /file/:filename` — download CSV |
| 617 | `DELETE /file/:filename` — delete CSV |
| 624 | `GET  /watch-status` — polling status check |
| 630 | `GET/POST /expo-link` — store/retrieve Expo Go link |
| 639 | `GET  /rooms` — list active rooms |
| 659 | `GET  /room/:roomId` — room detail |
| 665 | `GET  /room/:roomId/updates` — room update log |
| 672 | `POST /log-scan` — log a scan event |
| 698 | `GET  /scan-logs` — retrieve scan log |
| ~778 | `POST /delete-van-scans` — delete one invoice's on/off_board scans (password "123") |
| 711 | `GET  /scan-log-stats` — scan log stats |
| ~790 | `GET  /known-drivers` — distinct driver initials (scan log + connected clients + rooms) |
| 725 | `POST /sync-invoices` — receive invoice sync from app |
| 753 | `POST /clear-invoices` — clear server invoices |
| 777 | `GET  /invoices` — retrieve server invoices |
| 787 | `GET  /ping` — health check |
| 790 | `GET  /dashboard` — serve dashboard HTML |
| 796 | `GET  /` — version/status |

---

## QUICK LOOKUP

- **Fix WebSocket board sync?** → server.js ~139
- **Fix CSV upload/fetch?** → server.js ~590-617
- **Fix invoice sync?** → server.js ~725
- **Fix scan logging?** → server.js ~67 + ~672
- **Fix room presence?** → server.js ~123
