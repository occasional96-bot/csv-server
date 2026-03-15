const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");

// Make uploads folder if it doesn't exist
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Save files using their original name
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files allowed"));
    }
  },
});

// ── POST /upload ──────────────────────────────────────────────
// Send a CSV file → server saves it by filename
// Example: POST /upload  (form-data key: "file")
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  res.json({
    message: "Uploaded successfully",
    filename: req.file.originalname,
    url: `/file/${req.file.originalname}`,
  });
});

// ── GET /file/:name ───────────────────────────────────────────
// Fetch a CSV by filename
// Example: GET /file/parts.csv
app.get("/file/:name", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.setHeader("Content-Type", "text/csv");
  res.sendFile(filePath);
});

// ── GET /files ────────────────────────────────────────────────
// List all stored CSV files
app.get("/files", (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter((f) => f.endsWith(".csv"));
  res.json({ files });
});

// ── DELETE /file/:name ────────────────────────────────────────
// Delete a CSV by filename
app.delete("/file/:name", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  fs.unlinkSync(filePath);
  res.json({ message: `${req.params.name} deleted` });
});

app.listen(PORT, () => console.log(`CSV Server running on port ${PORT}`));
