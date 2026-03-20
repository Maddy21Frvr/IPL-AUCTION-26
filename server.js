const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── Static file server ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, 'public', file);
  const ext = path.extname(filePath);
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── Room state ──────────────────────────────────────────────────────────────
const rooms = {};   // roomId -> { meta, clients: Set<ws> }

function roomMeta(id) {
  return rooms[id] ? rooms[id].meta : null;
}

function broadcast(roomId, msg, excludeWs = null) {
  if (!rooms[roomId]) return;
  const json = JSON.stringify(msg);
  rooms[roomId].clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === 1) ws.send(json);
  });
}

function broadcastAll(roomId, msg) {
  broadcast(roomId, msg, null);
}

function roomList() {
  return Object.values(rooms).map(r => r.meta);
}

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.roomId = null;
  ws.playerId = null;
  ws.isBidder = false;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Lobby: list rooms ─────────────────────────────────────────────────
      case 'GET_ROOMS':
        ws.send(JSON.stringify({ type: 'ROOM_LIST', rooms: roomList() }));
        break;

      // ── Create room ───────────────────────────────────────────────────────
      case 'CREATE_ROOM': {
        const id = 'ROOM-' + Math.random().toString(36).substring(2,7).toUpperCase();
        rooms[id] = {
          meta: {
            id, name: msg.roomName, budget: msg.budget,
            status: 'waiting',
            bidders: {},    // playerId -> {name, team, budget, squad}
            spectators: {}, // playerId -> {name}
            maxBidders: 2,
            auctionState: null,
          },
          clients: new Set()
        };
        ws.roomId = id;
        ws.playerId = msg.playerId;
        ws.isBidder = true;
        rooms[id].clients.add(ws);
        rooms[id].meta.bidders[msg.playerId] = { name: msg.name, team: msg.team, budget: msg.budget, squad: [], isHost: true };
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomId: id, room: rooms[id].meta }));
        break;
      }

      // ── Join room ─────────────────────────────────────────────────────────
      case 'JOIN_ROOM': {
        const room = rooms[msg.roomId];
        if (!room) { ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room not found' })); break; }

        const bidderCount = Object.keys(room.meta.bidders).length;
        const isFull = bidderCount >= room.meta.maxBidders;

        // Check team not taken
        const takenTeams = Object.values(room.meta.bidders).map(b => b.team);
        if (!isFull && takenTeams.includes(msg.team)) {
          ws.send(JSON.stringify({ type: 'ERROR', msg: 'Team already taken! Pick another.' }));
          break;
        }

        ws.roomId = msg.roomId;
        ws.playerId = msg.playerId;
        ws.isBidder = !isFull;
        room.clients.add(ws);

        if (!isFull) {
          room.meta.bidders[msg.playerId] = { name: msg.name, team: msg.team, budget: msg.budget, squad: [], isHost: false };
        } else {
          room.meta.spectators[msg.playerId] = { name: msg.name };
        }

        // Send full room state to joiner
        ws.send(JSON.stringify({
          type: 'JOINED',
          room: room.meta,
          isBidder: ws.isBidder,
          auctionState: room.meta.auctionState,
        }));

        // Tell everyone else someone joined
        broadcast(msg.roomId, {
          type: ws.isBidder ? 'BIDDER_JOINED' : 'SPECTATOR_JOINED',
          playerId: msg.playerId,
          name: msg.name,
          team: msg.team,
          room: room.meta,
        }, ws);

        break;
      }

      // ── Leave room ────────────────────────────────────────────────────────
      case 'LEAVE_ROOM': {
        handleLeave(ws);
        break;
      }

      // ── Start auction ─────────────────────────────────────────────────────
      case 'AUCTION_START': {
        const room = rooms[ws.roomId];
        if (!room) break;
        room.meta.status = 'live';
        broadcastAll(ws.roomId, { type: 'AUCTION_START', room: room.meta });
        break;
      }

      // ── Generic relay: bid, sold, unsold, call player, chat ──────────────
      case 'CALL_PLAYER':
      case 'BID':
      case 'SOLD':
      case 'UNSOLD':
      case 'CHAT':
      case 'WR_CHAT':
      case 'VOICE_JOIN':
      case 'VOICE_LEAVE':
      case 'VOICE_MIC':
      case 'VOICE_HAND':
      case 'VOICE_ADMIN_MUTE':
      case 'VOICE_FLOOR':
      case 'BOT_ACTION': {
        // Relay to everyone in room except sender
        broadcast(ws.roomId, { ...msg, from: ws.playerId, fromName: msg.fromName, fromTeam: msg.fromTeam }, ws);
        // Keep auction state snapshot on server for late joiners
        if (msg.type === 'SOLD' || msg.type === 'UNSOLD' || msg.type === 'CALL_PLAYER' || msg.type === 'BID') {
          if (rooms[ws.roomId]) rooms[ws.roomId].meta.auctionState = msg;
        }
        break;
      }

      // ── Promote spectator to bidder ───────────────────────────────────────
      case 'PROMOTE_TO_BIDDER': {
        const room = rooms[ws.roomId];
        if (!room) break;
        const bidderCount = Object.keys(room.meta.bidders).length;
        if (bidderCount >= room.meta.maxBidders) {
          ws.send(JSON.stringify({ type: 'ERROR', msg: 'Room still full' }));
          break;
        }
        const takenTeams = Object.values(room.meta.bidders).map(b => b.team);
        if (takenTeams.includes(msg.team)) {
          ws.send(JSON.stringify({ type: 'ERROR', msg: 'Team taken' }));
          break;
        }
        delete room.meta.spectators[ws.playerId];
        room.meta.bidders[ws.playerId] = { name: msg.name, team: msg.team, budget: msg.budget, squad: [] };
        ws.isBidder = true;
        ws.send(JSON.stringify({ type: 'PROMOTED', team: msg.team, room: room.meta }));
        broadcast(ws.roomId, { type: 'BIDDER_JOINED', playerId: ws.playerId, name: msg.name, team: msg.team, room: room.meta }, ws);
        break;
      }
    }
  });

  ws.on('close', () => handleLeave(ws));
  ws.on('error', () => handleLeave(ws));
});

function handleLeave(ws) {
  if (!ws.roomId || !rooms[ws.roomId]) return;
  const room = rooms[ws.roomId];
  room.clients.delete(ws);

  const wasBidder = !!room.meta.bidders[ws.playerId];
  delete room.meta.bidders[ws.playerId];
  delete room.meta.spectators[ws.playerId];

  // If room empty, delete it
  if (room.clients.size === 0) { delete rooms[ws.roomId]; return; }

  // If a bidder left, promote first spectator if any
  if (wasBidder) {
    const firstSpec = Object.keys(room.meta.spectators)[0];
    if (firstSpec) {
      // Find their ws
      room.clients.forEach(clientWs => {
        if (clientWs.playerId === firstSpec) {
          clientWs.send(JSON.stringify({ type: 'SLOT_AVAILABLE', room: room.meta }));
        }
      });
    }
  }

  broadcast(ws.roomId, { type: 'PLAYER_LEFT', playerId: ws.playerId, room: room.meta });
  ws.roomId = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`IPL Auction server running on port ${PORT}`));
