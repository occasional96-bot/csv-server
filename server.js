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

// ── Board rooms ─────────────────────────────────────────────────────────────
// rooms[roomId] = { name, hostId, members: [{ id, initials, color, name, lastSeen }], invoices: {...}, focusList: [], pinnedIds: [], createdAt }
const ROOMS_FILE = path.join(__dirname, "rooms.json");
const ROOMS_TMP  = path.join(__dirname, "rooms.tmp.json");
const readRooms  = () => {
  // Try main file first, then temp (in case of interrupted write)
  for (const f of [ROOMS_FILE, ROOMS_TMP]) {
    try { const d = JSON.parse(fs.readFileSync(f, "utf8")); if (d) return d; } catch {}
  }
  return {};
};
const saveRooms  = () => {
  try {
    const toSave = {};
    const midnight = new Date(); midnight.setHours(0,0,0,0);
    for (const [id, room] of Object.entries(rooms)) {
      // Only persist today's rooms
      if (room.createdAt < midnight.getTime()) continue;
      toSave[id] = { ...room, members: room.members.map(m => ({ ...m })) };
    }
    // Write to temp then rename for atomic write
    fs.writeFileSync(ROOMS_TMP, JSON.stringify(toSave, null, 2));
    fs.renameSync(ROOMS_TMP, ROOMS_FILE);
  } catch(e) { console.error("saveRooms error:", e); }
};
const rooms = readRooms(); // Load persisted rooms on startup
console.log(`Loaded ${Object.keys(rooms).length} persisted rooms`);

function getRoomByClient(clientId) {
  return Object.values(rooms).find(r => r.members.some(m => m.id === clientId)) || null;
}

function cleanRooms() {
  const midnight = new Date(); midnight.setHours(0,0,0,0);
  for (const [id, room] of Object.entries(rooms)) {
    if (room.createdAt < midnight.getTime()) delete rooms[id];
  }
}
setInterval(cleanRooms, 60 * 1000);

// ── WebSocket clients map: ws → { id, initials, color, name, roomId } ───────
const clients = new Map(); // ws → clientInfo

const broadcast = (msg) => {
  const str = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(str);
  });
};

const broadcastToRoom = (roomId, msg, excludeClientId = null) => {
  const str = JSON.stringify(msg);
  for (const [ws, info] of clients.entries()) {
    if (info.roomId === roomId && ws.readyState === 1 && info.id !== excludeClientId) {
      ws.send(str);
    }
  }
};

const sendToClient = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function getRoomPresence(roomId) {
  const room = rooms[roomId];
  if (!room) return [];
  return room.members.map(m => {
    const ws = [...clients.entries()].find(([, info]) => info.id === m.id)?.[0];
    const connected = ws && ws.readyState === 1;
    return { ...m, connected };
  });
}

// Helper: get roomId for a client, falling back to member lookup on reconnect race
function getRoomIdForClient(clientInfo, userId) {
  if (clientInfo.roomId) return clientInfo.roomId;
  return Object.keys(rooms).find(rid => rooms[rid].members.some(m => m.id === userId)) || null;
}

wss.on("connection", (ws) => {
  console.log("WS client connected. Total:", wss.clients.size);
  ws.send(JSON.stringify({ type: "connected" }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const clientInfo = clients.get(ws) || {};

      // Ignore client pong responses to our ping
      if (msg.type === "pong") return;

      // ── Join request (non-host asks to join) ────────────────────────────
      if (msg.type === "join_request") {
        const room = rooms[msg.roomId];
        if (!room) { sendToClient(ws, { type: "join_response", approved: false, reason: "Room not found" }); return; }
        // Forward request to the host
        for (const [hostWs, info] of clients.entries()) {
          if (info.id === room.hostId && hostWs.readyState === 1) {
            hostWs.send(JSON.stringify({
              type: "join_request",
              roomId: msg.roomId,
              requesterId: msg.userId,
              requesterInitials: msg.initials,
              requesterColor: msg.color,
              requesterName: msg.name,
              mergeMode: msg.mergeMode || "merge",
            }));
            break;
          }
        }
        return;
      }

      // ── Host responds to join request ───────────────────────────────────
      if (msg.type === "join_response") {
        // Find requester ws and notify them
        for (const [reqWs, info] of clients.entries()) {
          if (info.id === msg.requesterId && reqWs.readyState === 1) {
            reqWs.send(JSON.stringify({
              type: "join_response",
              approved: msg.approved,
              roomId: msg.roomId,
              roomName: msg.roomName,
              mergeMode: msg.mergeMode || "merge",
              reason: msg.reason || "",
            }));
            break;
          }
        }
        return;
      }

      // ── Register identity ──────────────────────────────────────────────
      if (msg.type === "identify") {
        clients.set(ws, { id: msg.id, initials: msg.initials, color: msg.color, name: msg.name, roomId: null });
        console.log(`[identify] ${msg.initials} id=${msg.id} totalClients=${clients.size}`);
        return;
      }

      // ── Create board room ──────────────────────────────────────────────
      if (msg.type === "create_room") {
        cleanRooms();
        const roomId = msg.roomId; // client generates this
        rooms[roomId] = {
          name: msg.roomName,
          hostId: msg.userId,
          members: [{ id: msg.userId, initials: msg.initials, color: msg.color, name: msg.name, lastSeen: Date.now() }],
          invoiceUpdates: {},
          invoices: msg.invoices || [],
          focusList: msg.focusList || [],
          pinnedIds: msg.pinnedIds || [],
          createdAt: Date.now(),
        };
        const info = clients.get(ws) || {};
        clients.set(ws, { ...info, id: msg.userId, initials: msg.initials, color: msg.color, name: msg.name, roomId });
        sendToClient(ws, { type: "room_created", roomId, roomName: msg.roomName });
        saveRooms();
        console.log(`Room created: ${roomId} (${msg.roomName})`);
        return;
      }

      // ── Join board room ────────────────────────────────────────────────
      if (msg.type === "join_room") {
        const room = rooms[msg.roomId];
        if (!room) { sendToClient(ws, { type: "room_error", error: "Room not found or expired" }); return; }
        // Add member if not already in
        if (!room.members.find(m => m.id === msg.userId)) {
          room.members.push({ id: msg.userId, initials: msg.initials, color: msg.color, name: msg.name, lastSeen: Date.now() });
        }
        const info = clients.get(ws) || {};
        clients.set(ws, { ...info, id: msg.userId, initials: msg.initials, color: msg.color, name: msg.name, roomId: msg.roomId });
        // Merge invoiceUpdates INTO room.invoices before sending so joiner gets ONE fully confirmed snapshot
        const mergedForJoiner = (room.invoices || []).map(inv => {
          const upd = room.invoiceUpdates[inv.id];
          if (!upd) return inv;
          const parts = inv.parts.map(p => {
            const key = p.partNumber + "_" + (p.lineNo || "0");
            const pu = upd.parts?.[key];
            if (!pu) return p;
            return { ...p, confirmed: pu.confirmed, short: pu.short, shortQty: pu.shortQty,
              confirmedBy: pu.confirmedBy, confirmedColor: pu.confirmedColor, confirmedAt: pu.confirmedAt };
          });
          const done = parts.every(p => p.short || p.confirmed >= p.qty);
          return { ...inv, parts, complete: upd.complete || done || inv.complete,
            completedAt: upd.completedAt || inv.completedAt, completedBy: upd.completedBy || inv.completedBy };
        });
        // Also save merged back so it stays fresh
        room.invoices = mergedForJoiner;
        saveRooms();
        console.log(`[join_room] ${msg.initials} joined room ${msg.roomId}. Sending ${mergedForJoiner.length} invoices. Room now has ${getRoomPresence(msg.roomId).length} members`);
        // Send current room state to joiner - single merged snapshot, no separate invoiceUpdates needed
        sendToClient(ws, {
          type: "room_joined",
          roomId: msg.roomId,
          roomName: room.name,
          hostId: room.hostId,
          members: getRoomPresence(msg.roomId).map(m => ({ ...m, isHost: m.id === room.hostId })),
          invoiceUpdates: room.invoiceUpdates,
          invoices: mergedForJoiner,
          focusList: room.focusList,
          pinnedIds: room.pinnedIds,
          mergeMode: msg.mergeMode,
        });
        // Notify others
        broadcastToRoom(msg.roomId, {
          type: "member_joined",
          member: { id: msg.userId, initials: msg.initials, color: msg.color, name: msg.name },
          presence: getRoomPresence(msg.roomId).map(m => ({ ...m, isHost: m.id === room.hostId })),
        }, msg.userId);
        return;
      }

      // ── Leave room ────────────────────────────────────────────────────
      if (msg.type === "leave_room") {
        const room = getRoomByClient(msg.userId);
        if (room) {
          const roomId = Object.keys(rooms).find(k => rooms[k] === room);
          room.members = room.members.filter(m => m.id !== msg.userId);
          // Re-assign host if needed
          if (room.hostId === msg.userId && room.members.length > 0) {
            room.hostId = room.members[0].id;
            broadcastToRoom(roomId, { type: "host_changed", newHostId: room.hostId });
          }
          if (room.members.length === 0) delete rooms[roomId];
          else broadcastToRoom(roomId, { type: "member_left", userId: msg.userId, presence: getRoomPresence(roomId) });
          const info = clients.get(ws) || {};
          clients.set(ws, { ...info, roomId: null });
        }
        return;
      }

      // ── Kick member (host only) ────────────────────────────────────────
      if (msg.type === "kick_member") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        const room = rooms[roomId];
        if (!room || room.hostId !== msg.userId) return;
        room.members = room.members.filter(m => m.id !== msg.targetId);
        // Find kicked client ws and notify
        for (const [kickWs, info] of clients.entries()) {
          if (info.id === msg.targetId) {
            sendToClient(kickWs, { type: "kicked" });
            clients.set(kickWs, { ...info, roomId: null });
          }
        }
        broadcastToRoom(roomId, { type: "member_left", userId: msg.targetId, presence: getRoomPresence(roomId) });
        return;
      }

      // ── Part confirmed / updated ───────────────────────────────────────
      if (msg.type === "part_update") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        const room = rooms[roomId];
        console.log(`[part_update] from=${msg.userId} initials=${msg.initials} roomId=${roomId} clientRoomId=${clientInfo.roomId} hasRoom=${!!room} totalClients=${clients.size}`);
        if (!room) {
          console.log(`[part_update] DROPPED - rooms available:`, Object.keys(rooms));
          return;
        }
        // Heal clientInfo.roomId if missing (reconnect race)
        if (!clientInfo.roomId && roomId) clients.set(ws, { ...clientInfo, roomId });
        // Store in invoiceUpdates (for request_sync / late joiners)
        if (!room.invoiceUpdates[msg.invId]) room.invoiceUpdates[msg.invId] = { parts: {} };
        room.invoiceUpdates[msg.invId].parts[msg.partKey] = {
          confirmed: msg.confirmed,
          short: msg.short,
          shortQty: msg.shortQty,
          confirmedBy: msg.initials,
          confirmedColor: msg.color,
          confirmedAt: msg.timestamp,
        };
        // Also apply directly to room.invoices so it persists for future syncs
        if (room.invoices && room.invoices.length > 0) {
          room.invoices = room.invoices.map(inv => {
            if (inv.id !== msg.invId) return inv;
            const parts = inv.parts.map(p => {
              const key = p.partNumber + "_" + (p.lineNo || "0");
              if (key !== msg.partKey) return p;
              return { ...p, confirmed: msg.confirmed, short: msg.short, shortQty: msg.shortQty,
                confirmedBy: msg.initials, confirmedColor: msg.color, confirmedAt: msg.timestamp };
            });
            const done = parts.every(p => p.short || p.confirmed >= p.qty);
            return { ...inv, parts, complete: done || inv.complete,
              completedAt: (done && !inv.complete) ? msg.timestamp : (inv.completedAt || 0) };
          });
        }
        // Count recipients before broadcast
        let broadcastCount = 0;
        for (const [bws, info] of clients.entries()) {
          if (info.roomId === roomId && bws.readyState === 1 && info.id !== msg.userId) broadcastCount++;
        }
        saveRooms();
        console.log(`[part_update] sending to ${broadcastCount} other clients. Room members:`, rooms[roomId]?.members?.map(m => m.initials));
        // Broadcast to ALL others in room (exclude sender by userId)
        broadcastToRoom(roomId, {
          type: "part_update",
          invId: msg.invId,
          partKey: msg.partKey,
          confirmed: msg.confirmed,
          short: msg.short,
          shortQty: msg.shortQty,
          initials: msg.initials,
          color: msg.color,
          timestamp: msg.timestamp,
        }, msg.userId);
        return;
      }

      // ── Host pushes invoices ───────────────────────────────────────────
      if (msg.type === "sync_invoices") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        const room = rooms[roomId];
        if (!room) return;
        // Merge incoming invoices with existing invoiceUpdates so confirms from other phones aren't lost
        const incoming = msg.invoices || [];
        const merged = incoming.map(inv => {
          const upd = room.invoiceUpdates[inv.id];
          if (!upd) return inv;
          const parts = inv.parts.map(p => {
            const key = p.partNumber + "_" + (p.lineNo || "0");
            const pu = upd.parts?.[key];
            if (!pu) return p;
            return pu.confirmed >= p.confirmed
              ? { ...p, confirmed: pu.confirmed, short: pu.short, shortQty: pu.shortQty,
                  confirmedBy: pu.confirmedBy, confirmedColor: pu.confirmedColor, confirmedAt: pu.confirmedAt }
              : p;
          });
          const done = parts.every(p => p.short || p.confirmed >= p.qty);
          return { ...inv, parts, complete: upd.complete || done || inv.complete,
            completedAt: upd.completedAt || inv.completedAt, completedBy: upd.completedBy || inv.completedBy };
        });
        room.invoices = merged;
        saveRooms();
        // Don't broadcast back — only host sends this, others get updates via part_update
        return;
      }

      // ── Any member requests full room sync ─────────────────────────────
      // Merges all stored invoiceUpdates onto stored invoices and broadcasts to ALL members
      if (msg.type === "request_sync") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        const room = rooms[roomId];
        if (!room) return;

        // Merge invoiceUpdates into room.invoices so everyone gets the freshest state
        const mergedInvoices = (room.invoices || []).map(inv => {
          const upd = room.invoiceUpdates[inv.id];
          if (!upd) return inv;
          return {
            ...inv,
            complete: upd.complete || inv.complete,
            completedAt: upd.completedAt || inv.completedAt,
            completedBy: upd.completedBy || inv.completedBy,
            parts: inv.parts.map(p => {
              const key = p.partNumber + "_" + (p.lineNo || "0");
              const pu = upd.parts?.[key];
              if (!pu) return p;
              return { ...p, confirmed: pu.confirmed, short: pu.short, shortQty: pu.shortQty,
                confirmedBy: pu.confirmedBy, confirmedColor: pu.confirmedColor, confirmedAt: pu.confirmedAt };
            }),
          };
        });

        // Save merged back so future joiners get it too
        room.invoices = mergedInvoices;

        // Broadcast merged state to EVERYONE in the room (including requester)
        const str = JSON.stringify({
          type: "full_sync",
          invoices: mergedInvoices,
          invoiceUpdates: room.invoiceUpdates,
        });
        for (const [ws, info] of clients.entries()) {
          if (info.roomId === roomId && ws.readyState === 1) ws.send(str);
        }
        saveRooms();
        console.log(`Full sync triggered by ${msg.userId} in room ${roomId}`);
        return;
      }

      // ── Focus list updated ─────────────────────────────────────────────
      if (msg.type === "focuslist_update") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        const room = rooms[roomId];
        if (!room) return;
        room.focusList = msg.focusList;
        room.pinnedIds = msg.pinnedIds;
        broadcastToRoom(roomId, {
          type: "focuslist_update",
          focusList: msg.focusList,
          pinnedIds: msg.pinnedIds,
          initials: msg.initials,
        }, msg.userId);
        return;
      }

      // ── Invoice reset (all parts cleared) ─────────────────────────────
      if (msg.type === "invoice_reset") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        const room = rooms[roomId];
        if (!room) return;
        // Clear server-side invoiceUpdates for this invoice
        if (room.invoiceUpdates[msg.invId]) delete room.invoiceUpdates[msg.invId];
        // Clear in room.invoices too
        if (room.invoices) {
          room.invoices = room.invoices.map(inv =>
            inv.id !== msg.invId ? inv : {
              ...inv, complete: false, completedAt: 0, completedBy: "",
              parts: inv.parts.map(p => ({ ...p, confirmed: 0, short: false, shortQty: null, confirmedBy: "", confirmedColor: "", confirmedAt: 0 }))
            }
          );
        }
        saveRooms();
        broadcastToRoom(roomId, { type: "invoice_reset", invId: msg.invId, timestamp: msg.timestamp }, msg.userId);
        return;
      }

      // ── Invoice complete ───────────────────────────────────────────────
      if (msg.type === "invoice_complete") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        const room = rooms[roomId];
        if (!room) return;
        if (!clientInfo.roomId && roomId) clients.set(ws, { ...clientInfo, roomId });
        if (!room.invoiceUpdates[msg.invId]) room.invoiceUpdates[msg.invId] = { parts: {} };
        room.invoiceUpdates[msg.invId].complete = true;
        room.invoiceUpdates[msg.invId].completedAt = msg.timestamp;
        room.invoiceUpdates[msg.invId].completedBy = msg.initials;
        // Also update room.invoices directly so future syncs/joiners get it
        if (room.invoices && room.invoices.length > 0) {
          room.invoices = room.invoices.map(inv =>
            inv.id !== msg.invId ? inv :
            { ...inv, complete: true, completedAt: msg.timestamp, completedBy: msg.initials }
          );
        }
        saveRooms();
        broadcastToRoom(roomId, {
          type: "invoice_complete",
          invId: msg.invId,
          initials: msg.initials,
          color: msg.color,
          timestamp: msg.timestamp,
        }, msg.userId);
        return;
      }

      // ── Presence ping ─────────────────────────────────────────────────
      if (msg.type === "presence_ping") {
        const roomId = getRoomIdForClient(clientInfo, msg.userId);
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        const member = room.members.find(m => m.id === msg.userId);
        if (member) member.lastSeen = Date.now();
        broadcastToRoom(roomId, {
          type: "presence_update",
          presence: getRoomPresence(roomId),
        }, msg.userId);
        return;
      }

    } catch(e) { console.error("WS message error:", e); }
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    if (info?.roomId) {
      const room = rooms[info.roomId];
      if (room) {
        broadcastToRoom(info.roomId, { type: "presence_update", presence: getRoomPresence(info.roomId) });
      }
    }
    clients.delete(ws);
    console.log("WS client disconnected. Total:", wss.clients.size);
  });
});

// Heartbeat ping every 5s
setInterval(() => broadcast({ type: "ping" }), 5000);

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

app.get("/watch-status", (req, res) => {
  const meta = readMeta();
  const times = meta.fileTimes || {};
  res.json({ stdpartski: times["stdpartski.csv"] || null, stdpartshy: times["stdpartshy.csv"] || null });
});

app.get("/expo-link", (req, res) => { const meta = readMeta(); res.json({ url: meta.expoLink || null }); });
app.post("/expo-link", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  const meta = readMeta(); meta.expoLink = url; writeMeta(meta);
  res.json({ message: "Expo link updated", url });
});

// ── Room info endpoint (for QR deep link fallback) ─────────────────────────
app.get("/rooms", (req, res) => {
  const midnight = new Date(); midnight.setHours(0,0,0,0);
  const active = Object.entries(rooms)
    .filter(([, room]) => room.createdAt >= midnight.getTime())
    .map(([roomId, room]) => ({
      roomId,
      roomName: room.name,
      hostId: room.hostId,
      hostInitials: room.members.find(m => m.id === room.hostId)?.initials || "?",
      hostColor: room.members.find(m => m.id === room.hostId)?.color || "#00E676",
      memberCount: room.members.length,
      memberInitials: room.members.map(m => ({ initials: m.initials, color: m.color, id: m.id })),
    }));
  res.json({ rooms: active });
});

app.get("/room/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found or expired" });
  res.json({ roomId: req.params.roomId, roomName: room.name, memberCount: room.members.length });
});

app.get("/room/:roomId/updates", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found or expired" });
  res.json({ invoiceUpdates: room.invoiceUpdates || {}, invoices: room.invoices || [], focusList: room.focusList || [], pinnedIds: room.pinnedIds || [] });
});

app.get("/", (req, res) => res.json({ status: "ok", version: "4.0-rooms" }));

server.listen(PORT, () => console.log(`Server + WebSocket running on port ${PORT}`));
