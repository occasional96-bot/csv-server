const express    = require("express");
const multer     = require("multer");
const path       = require("path");
const fs         = require("fs");
const http       = require("http");
const { WebSocketServer } = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT   = process.env.PORT || 3000;
const UPLOAD = path.join(__dirname, "uploads");
const META   = path.join(__dirname, "meta.json");

if (!fs.existsSync(UPLOAD)) fs.mkdirSync(UPLOAD);

const readMeta  = () => { try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return {}; } };
const writeMeta = (data) => fs.writeFileSync(META, JSON.stringify(data, null, 2));

// ── WebSocket clients + broadcast ──────────────────────────────────────────
const broadcast = (msg) => {
  const str = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(str);
  });
};

wss.on("connection", (ws) => {
  console.log("WS client connected. Total:", wss.clients.size);
  ws.send(JSON.stringify({ type: "connected" }));
  ws.on("close", () => console.log("WS client disconnected. Total:", wss.clients.size));
});

// Heartbeat ping every 30s to keep Railway connection alive + update "just now" label
setInterval(() => broadcast({ type: "ping" }), 30000);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD),
  filename:    (_, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// ── CSV endpoints ──────────────────────────────────────────────────────────
app.get("/files", (req, res) => {
  const files = fs.readdirSync(UPLOAD).filter(f => f.endsWith(".csv"));
  res.json({ files });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const meta = readMeta();
  if (!meta.fileTimes) meta.fileTimes = {};
  meta.fileTimes[req.file.originalname] = Date.now();
  writeMeta(meta);
  // Push to all connected apps instantly
  broadcast({ type: "new_file", filename: req.file.originalname, uploadedAt: Date.now() });
  res.json({ message: "Uploaded successfully", filename: req.file.originalname });
});

app.get("/file-meta/:filename", (req, res) => {
  const meta = readMeta();
  const uploadedAt = (meta.fileTimes || {})[req.params.filename] || null;
  res.json({ filename: req.params.filename, uploadedAt });
});

app.get("/file/:filename", (req, res) => {
  const fp = path.join(UPLOAD, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.sendFile(fp);
});

app.delete("/file/:filename", (req, res) => {
  const fp = path.join(UPLOAD, req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  fs.unlinkSync(fp);
  res.json({ message: "Deleted" });
});

// ── Watch-status endpoint (single fast call for app dot indicator) ────────────
app.get("/watch-status", (req, res) => {
  const meta = readMeta();
  const times = meta.fileTimes || {};
  res.json({
    stdpartski: times["stdpartski.csv"] || null,
    stdpartshy: times["stdpartshy.csv"] || null,
  });
});

// ── Expo link endpoints ────────────────────────────────────────────────────
app.get("/expo-link", (req, res) => {
  const meta = readMeta();
  res.json({ url: meta.expoLink || null });
});

app.post("/expo-link", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const meta = readMeta();
  meta.expoLink = url;
  writeMeta(meta);
  res.json({ message: "Expo link updated", url });
});

app.get("/", (req, res) => res.json({ status: "ok", version: "3.0-ws" }));

// ── Start (use server.listen, not app.listen, so WS shares the same port) ──
server.listen(PORT, () => console.log(`Server + WebSocket running on port ${PORT}`));
