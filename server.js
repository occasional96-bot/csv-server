const express    = require("express");
const multer     = require("multer");
const path       = require("path");
const fs         = require("fs");
const http       = require("http");
const { WebSocketServer } = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT      = process.env.PORT || 3000;
const DATA_DIR  = fs.existsSync("/data") ? "/data" : __dirname;
const UPLOAD    = path.join(DATA_DIR, "uploads");
const META      = path.join(DATA_DIR, "meta.json");

if (!fs.existsSync(UPLOAD)) fs.mkdirSync(UPLOAD, { recursive: true });
console.log("[storage] using data dir:", DATA_DIR);

// Loud warning if running on Railway without /data volume mounted — data will be lost on redeploy.
if (DATA_DIR !== "/data" && (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID)) {
  console.error("!! WARNING: /data volume NOT mounted on Railway — all rooms/invoices/scan logs will be WIPED on every redeploy.");
  console.error("!! Fix: Railway dashboard → Service → Settings → Volumes → New Volume → Mount Path: /data");
}

// Process-level safety net so one bad client message can't take the whole server down.
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));

const readMeta  = () => { try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return {}; } };
const writeMeta = (data) => fs.writeFileSync(META, JSON.stringify(data, null, 2));

// ── Board rooms ─────────────────────────────────────────────────────────────
// rooms[roomId] = { name, hostId, members: [{ id, initials, color, name, lastSeen }], invoices: {...}, focusList: [], pinnedIds: [], createdAt }
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const ROOMS_TMP  = path.join(DATA_DIR, "rooms.tmp.json");
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
    const STALE_MS = 24 * 60 * 60 * 1000; // 24h of silence = stale
    const now = Date.now();
    for (const [id, room] of Object.entries(rooms)) {
      const lastActivity = Math.max(room.createdAt || 0, ...room.members.map(m => m.lastSeen || 0));
      if (now - lastActivity > STALE_MS) continue;
      toSave[id] = { ...room, members: room.members.map(m => ({ ...m })) };
    }
    // Write to temp then rename for atomic write
    fs.writeFileSync(ROOMS_TMP, JSON.stringify(toSave, null, 2));
    fs.renameSync(ROOMS_TMP, ROOMS_FILE);
  } catch(e) { console.error("saveRooms error:", e); }
};
const rooms = readRooms(); // Load persisted rooms on startup
// Defensive backfill: rooms saved by older versions may be missing fields. Avoids crashes in handlers.
for (const room of Object.values(rooms)) {
  if (!Array.isArray(room.members)) room.members = [];
  if (!room.invoiceUpdates || typeof room.invoiceUpdates !== "object") room.invoiceUpdates = {};
  if (!Array.isArray(room.invoices)) room.invoices = [];
  if (!Array.isArray(room.focusList)) room.focusList = [];
  if (!Array.isArray(room.pinnedIds)) room.pinnedIds = [];
}
console.log(`Loaded ${Object.keys(rooms).length} persisted rooms`);

function getRoomByClient(clientId) {
  return Object.values(rooms).find(r => r.members.some(m => m.id === clientId)) || null;
}

function cleanRooms() {
  const STALE_MS = 24 * 60 * 60 * 1000; // 24h of silence = purge
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    const lastActivity = Math.max(room.createdAt || 0, ...room.members.map(m => m.lastSeen || 0));
    if (now - lastActivity > STALE_MS) delete rooms[id];
  }
}
setInterval(cleanRooms, 60 * 1000);

// ── Scan log ──────────────────────────────────────────────────────────────────
const SCANLOG_FILE = path.join(DATA_DIR, "scanlog.json");
const SCANLOG_TMP  = path.join(DATA_DIR, "scanlog.tmp.json");
const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

const readScanLog = () => {
  try { return JSON.parse(fs.readFileSync(SCANLOG_FILE, "utf8")); } catch { return []; }
};
const saveScanLog = (log) => {
  try {
    fs.writeFileSync(SCANLOG_TMP, JSON.stringify(log, null, 2));
    fs.renameSync(SCANLOG_TMP, SCANLOG_FILE);
  } catch(e) { console.error("saveScanLog error:", e); }
};
const purgeScanLog = (log) => log.filter(e => Date.now() - e.timestamp < FOURTEEN_DAYS);

// ── Invoice store ────────────────────────────────────────────────────────────
const INVOICES_FILE = path.join(DATA_DIR, "invoices.json");
const INVOICES_TMP  = path.join(DATA_DIR, "invoices.tmp.json");

const readInvoices = () => {
  try { return JSON.parse(fs.readFileSync(INVOICES_FILE, "utf8")); } catch { return []; }
};
const saveInvoices = (list) => {
  try {
    fs.writeFileSync(INVOICES_TMP, JSON.stringify(list, null, 2));
    fs.renameSync(INVOICES_TMP, INVOICES_FILE);
  } catch(e) { console.error("saveInvoices error:", e); }
};
const purgeInvoices = (list) => {
  const midnight = new Date(); midnight.setHours(0,0,0,0);
  return list.filter(inv => inv.savedAt >= midnight.getTime());
};

// ── Precount snapshots (resumable panel-counter sessions) ─────────────────────
// A full snapshot of a partly-counted dispatch invoice (every part + its count),
// keyed by invoice id. Lives in its own file so "Clear All Data" does NOT wipe it.
// Auto-expires after 14 days. Lets a cleared invoice be pulled back exactly where left off.
const PRECOUNTS_FILE = path.join(DATA_DIR, "precounts.json");
const PRECOUNTS_TMP  = path.join(DATA_DIR, "precounts.tmp.json");
const readPrecounts  = () => { try { return JSON.parse(fs.readFileSync(PRECOUNTS_FILE, "utf8")); } catch { return []; } };
const savePrecounts  = (list) => {
  try {
    fs.writeFileSync(PRECOUNTS_TMP, JSON.stringify(list, null, 2));
    fs.renameSync(PRECOUNTS_TMP, PRECOUNTS_FILE);
  } catch(e) { console.error("savePrecounts error:", e); }
};
const purgePrecounts = (list) => list.filter(e => Date.now() - (e.updatedAt || 0) < FOURTEEN_DAYS);

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

wss.on("error", (err) => console.error("[wss error]", err));

wss.on("connection", (ws) => {
  console.log("WS client connected. Total:", wss.clients.size);
  ws.isAlive = true; // liveness flag — any inbound frame re-arms it; sweep terminates stale sockets
  ws.send(JSON.stringify({ type: "connected" }));

  // Without this, a network error on any single socket throws an unhandled 'error' event
  // and crashes the entire Node process — taking every other connected client down with it.
  ws.on("error", (err) => console.error("[ws error]", err.message));

  ws.on("message", (raw) => {
    ws.isAlive = true; // any message proves the socket is alive
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
        if (rooms[roomId]) { sendToClient(ws, { type: "room_error", error: "Room already exists" }); return; }
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
          const parts = (inv.parts || []).map(p => {
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
          dataClearedAt: room.dataClearedAt || 0,
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
          saveRooms();
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
        saveRooms();
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
            const parts = (inv.parts || []).map(p => {
              const key = p.partNumber + "_" + (p.lineNo || "0");
              if (key !== msg.partKey) return p;
              return { ...p, confirmed: msg.confirmed, short: msg.short, shortQty: msg.shortQty,
                confirmedBy: msg.initials, confirmedColor: msg.color, confirmedAt: msg.timestamp };
            });
            const done = parts.every(p => p.short || p.confirmed >= p.qty);
            return { ...inv, parts, complete: done || inv.complete,
              completedAt: (done && !inv.complete) ? msg.timestamp : (inv.completedAt || 0),
              completedBy: (done && !inv.completedBy) ? msg.initials : (inv.completedBy || "") };
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
        // Ack back to sender so its reliable-send queue can clear this update
        if (msg.seq != null) sendToClient(ws, { type: "ack", seq: msg.seq });
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
          const parts = (inv.parts || []).map(p => {
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
            parts: (inv.parts || []).map(p => {
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
              parts: (inv.parts || []).map(p => ({ ...p, confirmed: 0, short: false, shortQty: null, confirmedBy: "", confirmedColor: "", confirmedAt: 0 }))
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

      // ── Clear ALL data (admin wipe from dashboard — keeps scan logs) ──
      if (msg.type === "clear_all_data") {
        const now = Date.now();
        // Wipe ALL rooms (not just one)
        for (const [rid, room] of Object.entries(rooms)) {
          room.focusList = [];
          room.pinnedIds = [];
          room.invoices = [];
          room.invoiceUpdates = {};
          room.dataClearedAt = now;
        }
        saveRooms();
        // Wipe invoices.json (NOT scanlog.json)
        saveInvoices([]);
        // Wipe all CSV files from uploads/
        try {
          const csvFiles = fs.readdirSync(UPLOAD).filter(f => f.endsWith(".csv"));
          csvFiles.forEach(f => { try { fs.unlinkSync(path.join(UPLOAD, f)); } catch {} });
          // Clear file timestamps in meta
          const meta = readMeta();
          meta.fileTimes = {};
          writeMeta(meta);
          console.log(`[clear_all_data] Deleted ${csvFiles.length} CSV files from uploads/`);
        } catch(e) { console.error("[clear_all_data] CSV cleanup error:", e); }
        // Broadcast to ALL connected clients (every room)
        const clearMsg = JSON.stringify({ type: "clear_all_data", clearedAt: now, clearedBy: msg.initials || "ADMIN" });
        for (const [cws] of clients.entries()) {
          if (cws.readyState === 1) cws.send(clearMsg);
        }
        console.log(`[clear_all_data] All rooms + invoices + CSVs wiped by ${msg.initials || "ADMIN"} (scan logs preserved)`);
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

// Heartbeat ping every 5s (keeps Railway from closing idle sockets; clients reply "pong")
setInterval(() => broadcast({ type: "ping" }), 5000);

// Liveness sweep every 30s: terminate sockets that sent nothing since the last sweep.
// terminate() fires 'close', which runs the existing presence-cleanup handler.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_e) {} return; }
    ws.isAlive = false;
  });
}, 30000);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Filename sanitizer (prevent path traversal) ──────────────────────────
function safeName(raw) {
  return path.basename(raw).replace(/[^a-zA-Z0-9._\-]/g, "_");
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD),
  filename:    (_, file, cb) => {
    cb(null, safeName(file.originalname));
  },
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
  const fn = safeName(req.params.filename);
  const meta = readMeta();
  const uploadedAt = (meta.fileTimes || {})[fn] || null;
  res.json({ filename: fn, uploadedAt });
});

app.get("/file/:filename", (req, res) => {
  const fn = safeName(req.params.filename);
  const fp = path.join(UPLOAD, fn);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.sendFile(fp);
});

app.delete("/file/:filename", (req, res) => {
  const fn = safeName(req.params.filename);
  const fp = path.join(UPLOAD, fn);
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
  const ACTIVE_MS = 30 * 60 * 1000; // any member seen in last 30 min = live
  const now = Date.now();
  const active = Object.entries(rooms)
    .filter(([, room]) => {
      const lastSeen = Math.max(room.createdAt || 0, ...room.members.map(m => m.lastSeen || 0));
      return (now - lastSeen) <= ACTIVE_MS;
    })
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

// ── Scan log endpoints ────────────────────────────────────────────────────────
app.post("/log-scan", (req, res) => {
  const { initials, color, invoiceId, orderRef, brand, partNumber, description, action, note, qty, confirmed, lineNo, customer } = req.body;
  if (!initials || !invoiceId || !partNumber || !action) return res.status(400).json({ error: "Missing fields" });
  if (action === "not_found") return res.json({ ok: true, skipped: true });
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
    action, // "confirmed" | "manual" | "not_found" | "short" | "over" | "missing" | "undo" | "on_board" | "off_board"
    note: note || "",
    qty: qty || 0,
    confirmed: confirmed || 0,
    lineNo: lineNo || "0",
    customer: customer || "",
  };
  log.unshift(entry);
  saveScanLog(log);
  broadcast({ type: "scan_log_update", entry });
  res.json({ ok: true, entry });
});

app.get("/scan-logs", (req, res) => {
  let log = purgeScanLog(readScanLog());
  const { brand, invoiceId, initials, partNumber, action, from, to } = req.query;
  if (brand)       log = log.filter(e => e.brand === brand);
  if (invoiceId)   log = log.filter(e => e.invoiceId.includes(invoiceId.toUpperCase()));
  if (initials)    log = log.filter(e => e.initials === initials.toUpperCase());
  if (partNumber)  log = log.filter(e => e.partNumber.includes(partNumber.toUpperCase()));
  if (action)      log = log.filter(e => action.split(",").includes(e.action));
  if (from)        log = log.filter(e => e.timestamp >= parseInt(from));
  if (to)          log = log.filter(e => e.timestamp <= parseInt(to));
  res.json({ logs: log, total: log.length });
});

app.get("/scan-log-stats", (req, res) => {
  const log = purgeScanLog(readScanLog());
  const today = new Date(); today.setHours(0,0,0,0);
  const todayLog = log.filter(e => e.timestamp >= today.getTime());
  const stats = {
    confirmed: todayLog.filter(e => e.action === "confirmed").length,
    manual:    todayLog.filter(e => e.action === "manual").length,
    not_found: todayLog.filter(e => e.action === "not_found").length,
    users:     [...new Set(todayLog.map(e => e.initials))],
  };
  res.json(stats);
});

// Distinct driver initials: everyone in the scan log + anyone currently connected
app.get("/known-drivers", (req, res) => {
  const set = new Set();
  readScanLog().forEach(e => { if (e.initials && e.initials !== "?") set.add(e.initials.toUpperCase()); });
  for (const info of clients.values()) {
    if (info.initials && info.initials !== "?") set.add(info.initials.toUpperCase());
  }
  for (const room of Object.values(rooms)) {
    (room.members || []).forEach(m => { if (m.initials && m.initials !== "?") set.add(m.initials.toUpperCase()); });
  }
  res.json({ drivers: [...set].sort() });
});

// ── Invoice sync endpoints ───────────────────────────────────────────────────
app.post("/sync-invoices", (req, res) => {
  const { invoices } = req.body;
  if (!Array.isArray(invoices)) return res.status(400).json({ error: "invoices must be array" });
  let stored = purgeInvoices(readInvoices());
  const now = Date.now();
  invoices.forEach(inv => {
    const existing = stored.findIndex(s => s.id === inv.id);
    const entry = {
      id: inv.id,
      orderRef: inv.orderRef || "",
      brand: inv.id.startsWith("L") ? "KIA" : inv.id.startsWith("F") ? "HY" : "?",
      savedAt: now,
      parts: (inv.parts || []).map(p => ({
        partNumber: p.partNumber,
        description: p.description || "",
        qty: p.qty || 1,
        lineNo: p.lineNo || "0",
      })),
    };
    if (existing === -1) stored.push(entry);
    else stored[existing] = entry;
  });
  saveInvoices(stored);
  console.log("[sync-invoices] stored " + invoices.length + " invoices. Total: " + stored.length);
  res.json({ ok: true, stored: stored.length });
});

// Clear all data (HTTP fallback for dashboard when no active rooms)
app.post("/clear-invoices", (req, res) => {
  // Wipe invoices.json
  saveInvoices([]);
  // Wipe all CSV files from uploads/
  try {
    const csvFiles = fs.readdirSync(UPLOAD).filter(f => f.endsWith(".csv"));
    csvFiles.forEach(f => { try { fs.unlinkSync(path.join(UPLOAD, f)); } catch {} });
    const meta = readMeta();
    meta.fileTimes = {};
    writeMeta(meta);
  } catch {}
  // Wipe all rooms' data too
  for (const [rid, room] of Object.entries(rooms)) {
    room.focusList = [];
    room.pinnedIds = [];
    room.invoices = [];
    room.invoiceUpdates = {};
    room.dataClearedAt = Date.now();
  }
  saveRooms();
  console.log("[clear-invoices] Everything wiped via HTTP (scan logs preserved)");
  res.json({ ok: true, message: "All data cleared" });
});

app.get("/invoices", (req, res) => {
  const list = purgeInvoices(readInvoices());
  const { brand, invoiceId } = req.query;
  let result = list;
  if (brand) result = result.filter(i => i.brand === brand);
  if (invoiceId) result = result.filter(i => i.id.includes(invoiceId.toUpperCase()));
  res.json({ invoices: result, total: result.length });
});

// ── Precount snapshot endpoints (resume a partly-counted invoice) ─────────────
app.post("/save-precount", (req, res) => {
  const snap = req.body && req.body.snapshot;
  if (!snap || !snap.id) return res.status(400).json({ ok: false, error: "snapshot.id required" });
  let list = purgePrecounts(readPrecounts());
  const entry = { ...snap, updatedAt: Date.now() };
  const i = list.findIndex(s => s.id === entry.id);
  if (i === -1) list.push(entry); else list[i] = entry;
  savePrecounts(list);
  res.json({ ok: true });
});

app.get("/precount/:invoiceId", (req, res) => {
  const id = String(req.params.invoiceId || "");
  const list = purgePrecounts(readPrecounts());
  const snap = list.find(s => s.id === id) || list.find(s => String(s.id).toUpperCase() === id.toUpperCase());
  if (!snap) return res.status(404).json({ ok: false });
  res.json({ ok: true, snapshot: snap });
});

// List all non-expired snapshots, newest first (for the Restore picker).
app.get("/precounts", (req, res) => {
  const list = purgePrecounts(readPrecounts()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ ok: true, snapshots: list });
});

// ── Health / keep-alive ───────────────────────────────────────────────────────
app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  const fp = path.join(__dirname, "dashboard.html");
  if (!fs.existsSync(fp)) return res.status(404).send("dashboard.html not found — deploy it alongside server.js");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.sendFile(fp);
});

// Debug: verify which dashboard is deployed
app.get("/dashboard-check", (req, res) => {
  const fp = path.join(__dirname, "dashboard.html");
  try {
    const content = fs.readFileSync(fp, "utf8");
    const hasStat = content.includes("stat-confirmed");
    const hasRailway = content.includes("railway.app");
    const lines = content.split("\n").length;
    res.json({ hasStat, hasRailway, lines, dirname: __dirname });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/", (req, res) => res.json({ status: "ok", version: "4.0-rooms" }));

server.listen(PORT, () => console.log(`Server + WebSocket running on port ${PORT}`));
