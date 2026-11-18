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
// roomId -> { broadcasterId, viewers: Set(), hasVideo: boolean, createdAt: Date }
const rooms = new Map();

// Endpoint info room aktif
app.get('/api/rooms', (req, res) => {
  const activeRooms = [];
  rooms.forEach((data, roomId) => {
    activeRooms.push({
      roomId,
      broadcasterId: data.broadcasterId,
      viewerCount: data.viewers.size,
      hasVideo: data.hasVideo || false
    });
  });
  res.json({ status: 'success', rooms: activeRooms });
});

// Logika Signaling Socket.IO
io.on('connection', (socket) => {
  const clientAddress = socket.handshake.address;
  console.log(`[Socket] User terhubung: ${socket.id} (IP: ${clientAddress})`);

  // Broadcaster bergabung/membuat room
  socket.on('join-room', (roomId) => {
    roomId = roomId.trim().toUpperCase();
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'broadcaster';

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        broadcasterId: socket.id,
        viewers: new Set(),
        hasVideo: false,
        createdAt: new Date()
      });
    } else {
      rooms.get(roomId).broadcasterId = socket.id;
    }

    console.log(`[Room ${roomId}] Broadcaster ${socket.id} siap`);
    socket.emit('room-created', { roomId });
  });

  // Broadcaster memberi tahu bahwa video sudah siap/mulai diputar
  socket.on('broadcaster-video-ready', (roomId) => {
    roomId = (roomId || socket.roomId || '').trim().toUpperCase();
    if (rooms.has(roomId)) {
      rooms.get(roomId).hasVideo = true;
    }
    console.log(`[Room ${roomId}] Video siap disiarkan`);
    // Beri tahu semua viewer di room
    socket.to(roomId).emit('broadcaster-video-ready');
  });

  // Viewer bergabung ke room
  socket.on('join-as-viewer', (roomId) => {
    roomId = roomId.trim().toUpperCase();
    socket.join(roomId);
    socket.roomId = roomId;
    socket.role = 'viewer';

    const roomExists = rooms.has(roomId);
    if (roomExists) {
      rooms.get(roomId).viewers.add(socket.id);
      console.log(`[Room ${roomId}] Viewer ${socket.id} bergabung. Memberi tahu Broadcaster...`);

      // Beri tahu viewer bahwa room valid
      socket.emit('room-status', {
        status: 'found',
        roomId: roomId,
        hasBroadcaster: true,
        hasVideo: rooms.get(roomId).hasVideo
      });

      // Beri tahu broadcaster bahwa ada viewer baru
      socket.to(roomId).emit('viewer-joined', { viewerId: socket.id });

      // Update jumlah viewer ke room
      const viewerCount = rooms.get(roomId).viewers.size;
      io.to(roomId).emit('viewer-count', { count: viewerCount });
    } else {
      console.log(`[Room ${roomId}] Viewer ${socket.id} mencoba bergabung tapi room belum dibuat`);
      socket.emit('room-status', {
        status: 'waiting-broadcaster',
        roomId: roomId,
        hasBroadcaster: false,
        hasVideo: false
      });
    }
  });

  // Relay offer dari broadcaster ke viewer tertentu
  socket.on('offer', (payload) => {
    console.log(`[Relay] Offer dari Broadcaster ${socket.id} -> Viewer ${payload.target}`);
    io.to(payload.target).emit('offer', {
      sdp: payload.sdp,
      broadcasterId: socket.id
    });
  });

  // Relay answer dari viewer ke broadcaster
  socket.on('answer', (payload) => {
    console.log(`[Relay] Answer dari Viewer ${socket.id} -> Broadcaster ${payload.target}`);
    io.to(payload.target).emit('answer', {
      sdp: payload.sdp,
      viewerId: socket.id
    });
  });

  // Relay ICE candidate antara peer
  socket.on('ice-candidate', (payload) => {
    socket.to(payload.roomId).emit('ice-candidate', {
      candidate: payload.candidate,
      senderId: socket.id
    });
  });

  // User disconnect / terputus
  socket.on('disconnect', () => {
    console.log(`[Socket] User terputus: ${socket.id}`);
    const roomId = socket.roomId;

    if (roomId && rooms.has(roomId)) {
      const roomData = rooms.get(roomId);
      if (socket.role === 'viewer') {
        roomData.viewers.delete(socket.id);
        socket.to(roomId).emit('viewer-left', { viewerId: socket.id });
        io.to(roomId).emit('viewer-count', { count: roomData.viewers.size });
      } else if (socket.role === 'broadcaster') {
        socket.to(roomId).emit('broadcaster-left');
        rooms.delete(roomId);
      }
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
