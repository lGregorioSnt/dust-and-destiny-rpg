const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── GAME STATE ──────────────────────────────────────────────
const rooms = {}; // roomId => { players, chat, created }
const playerRooms = {}; // socketId => roomId

function createRoom(roomId) {
  rooms[roomId] = {
    id: roomId,
    players: {},
    chat: [],
    created: Date.now(),
  };
}

function broadcastRoom(roomId, event, data) {
  io.to(roomId).emit(event, data);
}

function getRoomPlayers(roomId) {
  if (!rooms[roomId]) return [];
  return Object.values(rooms[roomId].players);
}

function getRoomSummary(roomId) {
  if (!rooms[roomId]) return null;
  const players = getRoomPlayers(roomId);
  return {
    id: roomId,
    playerCount: players.length,
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      className: p.className,
      icon: p.icon,
      level: p.level,
      region: p.region,
      stage: p.stage,
      hp: p.hp,
      maxHp: p.maxHp,
      alive: p.hp > 0,
    }))
  };
}

// ── SOCKET EVENTS ──────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // List available rooms
  socket.on('list-rooms', () => {
    const list = Object.values(rooms)
      .filter(r => Object.keys(r.players).length > 0)
      .map(r => ({
        id: r.id,
        playerCount: Object.keys(r.players).length,
        players: Object.values(r.players).map(p => ({
          name: p.name, className: p.className, icon: p.icon, level: p.level
        }))
      }));
    socket.emit('rooms-list', list);
  });

  // Create or join room
  socket.on('join-room', ({ roomId, player }) => {
    const rid = roomId || uuidv4().slice(0, 6).toUpperCase();

    if (!rooms[rid]) createRoom(rid);

    // Leave old room
    const oldRoom = playerRooms[socket.id];
    if (oldRoom && rooms[oldRoom]) {
      delete rooms[oldRoom].players[socket.id];
      socket.leave(oldRoom);
      broadcastRoom(oldRoom, 'player-left', { id: socket.id });
      broadcastRoom(oldRoom, 'room-update', getRoomSummary(oldRoom));
    }

    // Join new room
    playerRooms[socket.id] = rid;
    rooms[rid].players[socket.id] = {
      ...player,
      id: socket.id,
      socketId: socket.id,
    };
    socket.join(rid);

    socket.emit('room-joined', { roomId: rid, room: getRoomSummary(rid) });
    broadcastRoom(rid, 'player-joined', {
      player: rooms[rid].players[socket.id],
      room: getRoomSummary(rid)
    });
    broadcastRoom(rid, 'room-update', getRoomSummary(rid));

    // Send recent chat
    const recentChat = rooms[rid].chat.slice(-30);
    socket.emit('chat-history', recentChat);
  });

  // Update player state (hp, level, region, etc)
  socket.on('update-player', (playerData) => {
    const rid = playerRooms[socket.id];
    if (!rid || !rooms[rid]) return;
    rooms[rid].players[socket.id] = {
      ...rooms[rid].players[socket.id],
      ...playerData,
      id: socket.id,
    };
    broadcastRoom(rid, 'room-update', getRoomSummary(rid));
  });

  // Combat event (for spectating)
  socket.on('combat-event', (data) => {
    const rid = playerRooms[socket.id];
    if (!rid) return;
    socket.to(rid).emit('player-combat', { playerId: socket.id, ...data });
  });

  // Super attack broadcast (triggers cutscene on all clients)
  socket.on('super-attack', (data) => {
    const rid = playerRooms[socket.id];
    if (!rid) return;
    broadcastRoom(rid, 'witness-super', {
      playerId: socket.id,
      playerName: data.playerName,
      superName: data.superName,
      icon: data.icon,
      enemyName: data.enemyName,
      damage: data.damage,
    });
  });

  // Chat message
  socket.on('chat', ({ message }) => {
    const rid = playerRooms[socket.id];
    if (!rid || !rooms[rid]) return;
    const player = rooms[rid].players[socket.id];
    if (!player) return;
    const msg = {
      id: uuidv4(),
      playerId: socket.id,
      playerName: player.name,
      playerIcon: player.icon,
      message: message.slice(0, 200),
      time: Date.now(),
    };
    rooms[rid].chat.push(msg);
    if (rooms[rid].chat.length > 100) rooms[rid].chat.shift();
    broadcastRoom(rid, 'chat-message', msg);
  });

  // Trade request
  socket.on('trade-offer', ({ targetId, item }) => {
    io.to(targetId).emit('trade-incoming', {
      fromId: socket.id,
      fromName: rooms[playerRooms[socket.id]]?.players[socket.id]?.name,
      item,
    });
  });

  socket.on('trade-accept', ({ fromId, item }) => {
    io.to(fromId).emit('trade-accepted', { item });
    socket.emit('trade-completed', { item });
  });

  socket.on('trade-reject', ({ fromId }) => {
    io.to(fromId).emit('trade-rejected');
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const rid = playerRooms[socket.id];
    if (rid && rooms[rid]) {
      delete rooms[rid].players[socket.id];
      broadcastRoom(rid, 'player-left', { id: socket.id });
      broadcastRoom(rid, 'room-update', getRoomSummary(rid));
      if (Object.keys(rooms[rid].players).length === 0) {
        setTimeout(() => {
          if (rooms[rid] && Object.keys(rooms[rid].players).length === 0) {
            delete rooms[rid];
          }
        }, 300000); // clean up empty rooms after 5 min
      }
    }
    delete playerRooms[socket.id];
  });
});

// ── CLEANUP OLD ROOMS ──────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(rid => {
    if (Object.keys(rooms[rid].players).length === 0 && now - rooms[rid].created > 600000) {
      delete rooms[rid];
    }
  });
}, 120000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🤠 Dust & Destiny RPG server running on port ${PORT}`);
});
