/**
 * BLADE — WebSocket Signaling Server
 * Pure Node.js — zero dependencies
 * Handles: user registration, messaging, WebRTC signaling
 * 
 * Run: node server.js
 * Default port: 8080
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ── Connected clients: userId -> { ws, id }
const clients = new Map();

// ── Message history per pair (optional, last 100 msgs)
const history = new Map(); // "A:B" -> [{...}]

function pairKey(a, b) {
  return [a, b].sort().join(':');
}

function addHistory(a, b, msg) {
  const k = pairKey(a, b);
  if (!history.has(k)) history.set(k, []);
  const arr = history.get(k);
  arr.push(msg);
  if (arr.length > 100) arr.shift();
}

// ─────────────────────────────────────────
// Minimal WebSocket server (RFC 6455) - NO external deps
// ─────────────────────────────────────────

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('base64');
}

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const acceptKey = sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
}

function wsSend(socket, data) {
  if (socket.destroyed) return;
  const json = JSON.stringify(data);
  const payload = Buffer.from(json, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch (_) {}
}

function wsDecodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x8) return { opcode: 'close' };
  if (opcode === 0x9) return { opcode: 'ping' };
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + (masked ? 4 : 0) + payloadLen) return null;
  let data;
  if (masked) {
    const mask = buf.slice(offset, offset + 4); offset += 4;
    data = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) data[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    data = buf.slice(offset, offset + payloadLen);
  }
  return { opcode: opcode === 1 ? 'text' : 'binary', data: data.toString('utf8') };
}

// ─────────────────────────────────────────
// Handle a WebSocket connection
// ─────────────────────────────────────────
function handleWS(socket, req) {
  wsHandshake(req, socket);
  let userId = null;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const frame = wsDecodeFrame(buffer);
      if (!frame) break;
      // Advance buffer past this frame
      let payloadLen = buffer[1] & 0x7f;
      let offset = 2;
      if (payloadLen === 126) { payloadLen = buffer.readUInt16BE(2); offset = 4; }
      else if (payloadLen === 127) { payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = (buffer[1] & 0x80) !== 0;
      if (masked) offset += 4;
      buffer = buffer.slice(offset + payloadLen);

      if (frame.opcode === 'close') { socket.destroy(); return; }
      if (frame.opcode === 'ping') { /* send pong */ continue; }
      if (frame.opcode !== 'text') continue;

      let msg;
      try { msg = JSON.parse(frame.data); } catch { continue; }
      handleMessage(socket, msg, () => userId);
      if (msg.type === 'register') userId = msg.userId;
    }
  });

  socket.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(`[BLADE] ${userId} disconnected. Online: ${clients.size}`);
      // Notify all that user went offline
      broadcast({ type: 'user_offline', userId });
    }
  });

  socket.on('error', () => { if (userId) clients.delete(userId); });
}

function relay(toUserId, data) {
  const client = clients.get(toUserId);
  if (client) wsSend(client.socket, data);
}

function broadcast(data) {
  for (const [, c] of clients) wsSend(c.socket, data);
}

function handleMessage(socket, msg, getUserId) {
  const from = msg.from || getUserId();

  switch (msg.type) {

    case 'register': {
      const uid = msg.userId;
      if (!uid || !/^[A-Z0-9_]{2,20}$/.test(uid)) {
        wsSend(socket, { type: 'register_fail', reason: 'INVALID ID' });
        return;
      }
      if (clients.has(uid)) {
        wsSend(socket, { type: 'register_fail', reason: 'ID ALREADY TAKEN' });
        return;
      }
      clients.set(uid, { socket, userId: uid });
      wsSend(socket, { type: 'register_ok', userId: uid });
      console.log(`[BLADE] ${uid} connected. Online: ${clients.size}`);
      // Send online user list
      wsSend(socket, { type: 'online_list', users: [...clients.keys()].filter(k => k !== uid) });
      // Notify others
      broadcast({ type: 'user_online', userId: uid });
      break;
    }

    case 'message': {
      const { to, payload, time, msgId } = msg;
      if (!from || !to || !payload) return;
      // Store in history
      addHistory(from, to, { from, payload, time, msgId });
      // Deliver to recipient if online
      relay(to, { type: 'message', from, to, payload, time, msgId });
      // Ack to sender
      relay(from, { type: 'message_ack', msgId, to });
      break;
    }

    case 'call_invite':
    case 'call_offer':
    case 'call_accept':
    case 'call_decline':
    case 'call_end':
    case 'ice_candidate': {
      const { to } = msg;
      if (!to || !from) return;
      relay(to, { ...msg, from });
      break;
    }

    case 'ping': {
      wsSend(socket, { type: 'pong', ts: Date.now() });
      break;
    }

    case 'history_request': {
      const { peer } = msg;
      const k = pairKey(from, peer);
      const msgs = history.get(k) || [];
      wsSend(socket, { type: 'history', peer, messages: msgs });
      break;
    }
  }
}

// ─────────────────────────────────────────
// HTTP server — serves index.html + handles WS upgrade
// ─────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('index.html not found');
    }
  } else if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ online: clients.size, users: [...clients.keys()] }));
  } else {
    res.writeHead(404); res.end('Not Found');
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers['upgrade']?.toLowerCase() === 'websocket') {
    handleWS(socket, req);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║   ⚔  BLADE COMMS SERVER  ⚔       ║');
  console.log('  ╠══════════════════════════════════╣');
  console.log(`  ║  http://localhost:${PORT}           ║`);
  console.log(`  ║  ws://localhost:${PORT}             ║`);
  console.log('  ║  Zero dependencies · Pure Node   ║');
  console.log('  ╚══════════════════════════════════╝');
  console.log('');
});
