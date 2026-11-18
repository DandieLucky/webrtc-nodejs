const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require("socket.io");
const QRCode = require('qrcode');

const app = express();
const port = 8080;

// Konfigurasi Sertifikat SSL Self-Signed
const options = {
  key: fs.readFileSync(path.join(__dirname, 'ssl', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl', 'cert.pem'))
};

// Logging HTTP Requests untuk memantau akses dari HP / Laptop lain
app.use((req, res, next) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (!req.url.startsWith('/api/qr')) {
    console.log(`[HTTP ${req.method}] ${req.url} (Klien: ${clientIp})`);
  }
  next();
});

// Serve folder static public
app.use(express.static(path.join(__dirname, 'public')));

// Helper fungsi mendapatkan daftar IP aktif komputer
function getNetworkIps() {
  const interfaces = os.networkInterfaces();
  const ipAddresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ipAddresses.push({
          interface: name,
          address: net.address
        });
      }
    }
  }

  // Prioritaskan interface WiFi (en0 di macOS, wlan0 di Linux, Wi-Fi di Windows)
  const wifiInterface = ipAddresses.find(i =>
    i.interface === 'en0' ||
    i.interface.toLowerCase().includes('wi-fi') ||
    i.interface.toLowerCase().includes('wlan')
  );

  const primaryIp = wifiInterface ? wifiInterface.address : (ipAddresses.length > 0 ? ipAddresses[0].address : 'localhost');
  return { ipAddresses, primaryIp };
}

// Helper API untuk mengetahui IP lokal server
app.get('/api/server-info', (req, res) => {
  const { ipAddresses, primaryIp } = getNetworkIps();
  res.json({
    status: 'success',
    port: port,
    ips: ipAddresses,
    primaryIp: primaryIp
  });
});

// Endpoint untuk generate QR Code instan untuk HP
app.get('/api/qr', async (req, res) => {
  try {
    const text = req.query.text || '';
    if (!text) {
      return res.status(400).json({ error: 'Text query parameter is required' });
    }
    const dataUrl = await QRCode.toDataURL(text, {
      margin: 2,
      width: 280,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });
    res.json({ status: 'success', dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inisialisasi HTTPS Server & Socket.IO
const server = https.createServer(options, app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Data tracking room
// roomId -> { broadcasterId, broadcasterName, viewers: Map<socketId,{id,name}>, hasVideo, createdAt }
const rooms = new Map();

// Endpoint info room aktif
app.get('/api/rooms', (req, res) => {
  const activeRooms = [];
  rooms.forEach((data, roomId) => {
    activeRooms.push({
      roomId,
      broadcasterId: data.broadcasterId,
      broadcasterName: data.broadcasterName || 'Host',
      viewerCount: data.viewers.size,
      hasVideo: data.hasVideo || false
    });
  });
  res.json({ status: 'success', rooms: activeRooms });
});

// =================================================================
// HELPER SIGNALING
// =================================================================

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const clean = raw.trim().replace(/[<>]/g, '').substring(0, 24);
  return clean.length > 0 ? clean : fallback;
}

function normalizeRoomId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().substring(0, 24);
}

// Snapshot seluruh peserta room (broadcaster + semua viewer)
function roomRoster(roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return [];
  const list = [];
  if (roomData.broadcasterId) {
    list.push({ id: roomData.broadcasterId, name: roomData.broadcasterName || 'Host', role: 'broadcaster' });
  }
  roomData.viewers.forEach((v) => {
    list.push({ id: v.id, name: v.name, role: 'viewer' });
  });
  return list;
}

// Kirim roster terbaru + jumlah peserta ke seluruh room
function broadcastRoster(roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return;
  io.to(roomId).emit('roster', { participants: roomRoster(roomId) });
  io.to(roomId).emit('viewer-count', { count: roomData.viewers.size });
}

// Logika Signaling Socket.IO
io.on('connection', (socket) => {
  const clientAddress = socket.handshake.address;
  console.log(`[Socket] User terhubung: ${socket.id} (IP: ${clientAddress})`);

  // -----------------------------------------------------------------
  // BROADCASTER: bergabung / membuat room
  // -----------------------------------------------------------------
  socket.on('join-room', (payload) => {
    const isObj = payload && typeof payload === 'object';
    const roomId = normalizeRoomId(isObj ? payload.roomId : payload);
    const name = sanitizeName(isObj ? payload.name : null, 'Host');

    if (!roomId) {
      socket.emit('join-error', { message: 'Room ID tidak valid.' });
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'broadcaster';
    socket.displayName = name;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        broadcasterId: socket.id,
        broadcasterName: name,
        viewers: new Map(),
        hasVideo: false,
        createdAt: new Date()
      });
    } else {
      const existing = rooms.get(roomId);
      // Broadcaster lama masih hidup? Tendang supaya tidak ada dua owner di room sama.
      if (existing.broadcasterId && existing.broadcasterId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existing.broadcasterId);
        if (oldSocket && oldSocket.connected) {
          oldSocket.emit('room-taken-over', { roomId });
          oldSocket.leave(roomId);
          oldSocket.roomId = null;
          oldSocket.role = null;
        }
      }
      existing.broadcasterId = socket.id;
      existing.broadcasterName = name;
    }

    console.log(`[Room ${roomId}] Broadcaster "${name}" ${socket.id} siap`);
    socket.emit('room-created', { roomId });
    socket.emit('roster', { participants: roomRoster(roomId) });
    broadcastRoster(roomId);
  });

  // -----------------------------------------------------------------
  // VIEWER: bergabung ke room sebagai peserta berkamera
  // -----------------------------------------------------------------
  socket.on('join-as-viewer', (payload) => {
    const isObj = payload && typeof payload === 'object';
    const roomId = normalizeRoomId(isObj ? payload.roomId : payload);
    const name = sanitizeName(isObj ? payload.name : null, 'Peserta');

    if (!roomId) {
      socket.emit('join-error', { message: 'Room ID tidak valid.' });
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'viewer';
    socket.displayName = name;

    if (!rooms.has(roomId)) {
      console.log(`[Room ${roomId}] Viewer ${socket.id} bergabung tapi room belum dibuat`);
      socket.emit('room-status', {
        status: 'waiting-broadcaster',
        roomId,
        hasBroadcaster: false,
        hasVideo: false,
        participants: []
      });
      return;
    }

    const roomData = rooms.get(roomId);

    // Roster SEBELUM peserta baru masuk → daftar peer yang harus dia hubungi (dialer)
    const existingPeers = roomRoster(roomId);

    roomData.viewers.set(socket.id, { id: socket.id, name, joinedAt: new Date() });
    console.log(`[Room ${roomId}] Viewer "${name}" ${socket.id} bergabung. ${existingPeers.length} peer existing.`);

    // Viewer baru dapat daftar peer existing → dia yang initiate koneksi (hindari glare)
    socket.emit('room-status', {
      status: 'found',
      roomId,
      hasBroadcaster: true,
      hasVideo: roomData.hasVideo,
      participants: existingPeers
    });

    // Peer existing hanya dinotifikasi → mereka callee, tidak membuat offer
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      name,
      role: 'viewer'
    });

    broadcastRoster(roomId);
  });

  // -----------------------------------------------------------------
  // Broadcaster memberi tahu video sudah siap
  // -----------------------------------------------------------------
  socket.on('broadcaster-video-ready', (roomIdPayload) => {
    const roomId = normalizeRoomId(roomIdPayload) || socket.roomId;
    if (!roomId) return;
    if (rooms.has(roomId)) {
      rooms.get(roomId).hasVideo = true;
    }
    console.log(`[Room ${roomId}] Video siap disiarkan`);
    socket.to(roomId).emit('broadcaster-video-ready');
  });

  // -----------------------------------------------------------------
  // RELAY SIGNALING TERARAH — tujuan socket id spesifik.
  // Tanpa ini, offer/answer/ICE nyasar ke semua peserta di room.
  // -----------------------------------------------------------------
  function relay(eventName, payload) {
    if (!payload || typeof payload !== 'object') {
      console.log(`[Relay] ${eventName} diabaikan — payload tidak valid`);
      return;
    }
    const target = payload.target;
    if (!target || typeof target !== 'string') {
      console.log(`[Relay] ${eventName} diabaikan — target kosong (${JSON.stringify(target)})`);
      return;
    }
    const targetSocket = io.sockets.sockets.get(target);
    console.log(`[Relay] ${eventName} dari ${socket.id.slice(0,6)} -> ${target.slice(0,6)} | target ada: ${!!targetSocket} | room sender: ${socket.roomId}`);
    io.to(target).emit(eventName, {
      ...payload,
      senderId: socket.id,
      sender: { id: socket.id, name: socket.displayName || 'Peserta' }
    });
  }

  socket.on('offer', (payload) => relay('offer', payload));
  socket.on('answer', (payload) => relay('answer', payload));
  socket.on('ice-candidate', (payload) => relay('ice-candidate', payload));

  // Ganti nama tampilan: perbarui identitas socket dan sebar roster baru ke room.
  socket.on('set-name', ({ name } = {}) => {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return;
    socket.displayName = clean;

    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;
    const roomData = rooms.get(roomId);

    if (roomData.broadcasterId === socket.id) roomData.broadcasterName = clean;
    const viewerEntry = roomData.viewers.get(socket.id);
    if (viewerEntry) viewerEntry.name = clean;

    io.to(roomId).emit('roster', { participants: roomRoster(roomId) });
    console.log(`[Name] ${socket.id.slice(0, 6)} -> "${clean}"`);
  });

  // Status mic/kamera untuk ditampilkan di tile masing-masing peserta
  socket.on('media-state', (payload) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('media-state', {
      peerId: socket.id,
      audioEnabled: !!(payload && payload.audioEnabled),
      videoEnabled: !!(payload && payload.videoEnabled)
    });
  });

  // -----------------------------------------------------------------
  // DISCONNECT
  // -----------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`[Socket] User terputus: ${socket.id}`);
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const roomData = rooms.get(roomId);

    if (socket.role === 'viewer') {
      roomData.viewers.delete(socket.id);
      socket.to(roomId).emit('peer-left', { peerId: socket.id });
      broadcastRoster(roomId);
    } else if (socket.role === 'broadcaster') {
      socket.to(roomId).emit('broadcaster-left');
      rooms.delete(roomId);
    }
  });
});

// Jalankan server HTTPS
server.listen(port, () => {
  const { ipAddresses, primaryIp } = getNetworkIps();
  console.log('====================================================');
  console.log(`🚀 Server HTTPS aktif dan berjalan di:`);
  console.log(`   - Lokal (Laptop ini): https://localhost:${port}`);
  console.log(`   - IP Utama Jaringan (HP / Laptop Lain): https://${primaryIp}:${port}`);
  for (const item of ipAddresses) {
    if (item.address !== primaryIp) {
      console.log(`   - Alternatif (${item.interface}): https://${item.address}:${port}`);
    }
  }
  console.log('====================================================');
});
