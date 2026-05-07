// ─────────────────────────────────────────────────────────────────────────────
// PATCH SNIPPET — apply to your existing server.js
// Only the /log-scan handler changes. Replace your current handler with this one
// so lineNo is captured on each scan (matches /invoices indexing).
// ─────────────────────────────────────────────────────────────────────────────

app.post("/log-scan", (req, res) => {
  const { initials, color, invoiceId, orderRef, brand, partNumber, description, action, note, qty, confirmed, lineNo } = req.body;
  if (!initials || !invoiceId || !partNumber || !action) return res.status(400).json({ error: "Missing fields" });
  let log = purgeScanLog(readScanLog());
  const entry = {
    id: Math.random().toString(36).slice(2, 10).toUpperCase(),
    timestamp: Date.now(),
    initials: initials || "?",
    color: color || "#8BA3BE",
    invoiceId,
    orderRef: orderRef || "",
    brand: brand || (invoiceId.startsWith("L") ? "KIA" : invoiceId.startsWith("F") ? "HY" : "?"),
    partNumber,
    description: description || "",
    action, // "confirmed" | "manual" | "not_found" | "short" | "over" | "missing" | "undo"
    note: note || "",
    qty: qty || 0,
    confirmed: confirmed || 0,
    lineNo: lineNo || "0",   // ← NEW: capture lineNo
  };
  log.unshift(entry);
  saveScanLog(log);
  broadcast({ type: "scan_log_update", entry });
  res.json({ ok: true, entry });
});
