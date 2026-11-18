// =================================================================
// MESH ENGINE — Konferensi WebRTC Multi-Peserta (Kamera Per-Peserta)
// Setiap peserta mengirim kamera+mic sendiri DAN menerima semua peserta lain.
// Topologi mesh: N peserta = N*(N-1)/2 koneksi. Aman untuk 5-10 orang di LAN.
// =================================================================

export const socket = io();

export const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceCandidatePoolSize: 10
};

// -----------------------------------------------------------------
// STATE GLOBAL
// -----------------------------------------------------------------
const peers = new Map();          // peerId -> { pc, name, role, stream, audioEnabled, videoEnabled }
const pendingCandidates = new Map(); // peerId -> [candidate] sebelum remote description siap
const mediaState = new Map();     // peerId -> { audioEnabled, videoEnabled }

let localStream = null;
let localScreenStream = null;
let currentRoomId = null;
let selfId = null;
let selfRole = 'viewer';
let selfName = 'Peserta';
let roster = [];
const pendingMeta = new Map();  // peerId -> { name, role } sebelum koneksi dibuat
const dialed = new Set();       // peerId yang sudah kita hubungi (cegah glare/duplikat)

// Event handler yang dipasang oleh halaman (viewer.html / broadcaster.html)
const ui = {
  onLocalStream: null,
  onPeerStream: null,
  onPeerRemoved: null,
  onRoster: null,
  onMediaState: null,
  onLog: null
};

export function registerUI(handlers) {
  Object.assign(ui, handlers);
}

function emitLog(message, type = 'info') {
  // Cadangan sederhana untuk halaman tanpa logBox.
  console.log(`[mesh:${type}] ${message}`);
}

// -----------------------------------------------------------------
// PROFIL / IDENTITAS
// -----------------------------------------------------------------
export function getSelfId() { return selfId; }
export function getSelfName() { return selfName; }
export function getRoomId() { return currentRoomId; }
export function getRoster() { return roster; }
export function getPeerCount() { return peers.size; }
export function getMediaState() { return mediaState; }

export function setSelfName(name) {
  const clean = String(name || '').trim().substring(0, 24);
  selfName = clean.length > 0 ? clean : 'Peserta';
  sessionStorage.setItem('webrtc_name', selfName);
  return selfName;
}

export function loadStoredName() {
  return sessionStorage.getItem('webrtc_name') || '';
}

// -----------------------------------------------------------------
// LOG LOKAL (dipakai bersama halaman)
// Menulis ke console DAN ke #logBox kalau ada di halaman.
// -----------------------------------------------------------------
export function log(message, type = 'info') {
  // Guard anti-rekursi: ui.onLog tidak boleh memanggil log() lagi.
  if (log._inFlight) return;
  log._inFlight = true;
  try {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    console.log(`[${time}] ${message}`);

    if (!log._boxMissing) {
      const logBox = document.getElementById('logBox');
      if (logBox) {
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.innerHTML = `<span class="log-time">${time}</span> <span>${escapeHtml(message)}</span>`;
        logBox.appendChild(entry);
        logBox.scrollTop = logBox.scrollHeight;
      } else {
        log._boxMissing = true; // halaman tanpa logBox; berhenti mencari
      }
    }

    if (ui.onLog) ui.onLog(message, type);
  } finally {
    log._inFlight = false;
  }
}

export function showToast(message) {
  let toast = document.getElementById('toastNotification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastNotification';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span>⚡</span> <span>${escapeHtml(message)}</span>`;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3500);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// -----------------------------------------------------------------
// MEDIA LOKAL
// -----------------------------------------------------------------
export async function acquireLocalMedia({ video = true, audio = true } = {}) {
  const constraints = {
    video: video ? {
      width: { ideal: 640, max: 1280 },
      height: { ideal: 480, max: 720 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: 'user'
    } : false,
    audio: audio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    } : false
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  setLocalStream(stream);

  const vt = stream.getVideoTracks()[0];
  const at = stream.getAudioTracks()[0];
  if (vt) vt.enabled = video;
  if (at) at.enabled = audio;

  if (ui.onLocalStream) ui.onLocalStream(stream);
  log(`Kamera & mikrofon aktif (${stream.getTracks().length} track)`, 'success');
  broadcastMediaState();
  return stream;
}

function setLocalStream(stream) {
  localStream = stream;
  // Ganti track di semua peer yang sudah tersambung (tanpa renegotiation penuh).
  for (const [peerId, peer] of peers.entries()) {
    (async () => {
      try {
        const videoTrack = stream.getVideoTracks()[0] || null;
        const audioTrack = stream.getAudioTracks()[0] || null;
        const videoSender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        const audioSender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'audio');

        let reneg = false;

        if (videoTrack) {
          if (videoSender) await videoSender.replaceTrack(videoTrack);
          else { peer.pc.addTrack(videoTrack, stream); reneg = true; }
        }
        if (audioTrack) {
          if (audioSender) await audioSender.replaceTrack(audioTrack);
          else { peer.pc.addTrack(audioTrack, stream); reneg = true; }
        }

        // Kalau track ditambahkan (bukan replace), perlu renegosiasi supaya peer tahu.
        if (reneg) {
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          socket.emit('offer', { target: peerId, sdp: offer, extra: true });
          log(`Menawarkan kamera ke ${peer.name}...`, 'info');
        }
      } catch (err) {
        console.warn(`Gagal memasang track lokal ke ${peerId}:`, err.message);
      }
    })();
  }
}

export function getLocalStream() { return localStream; }
export function getPeers() { return peers; }
export function getPeer(peerId) { return peers.get(peerId); }

export function toggleLocalAudio() {
  if (!localStream) return false;
  const track = localStream.getAudioTracks()[0];
  if (!track) return false;
  track.enabled = !track.enabled;
  broadcastMediaState();
  return track.enabled;
}

export function toggleLocalVideo() {
  if (!localStream) return false;
  const track = localStream.getVideoTracks()[0];
  if (!track) return false;
  track.enabled = !track.enabled;
  broadcastMediaState();
  return track.enabled;
}

function broadcastMediaState() {
  if (!localStream) return;
  const audioEnabled = !!(localStream.getAudioTracks()[0] && localStream.getAudioTracks()[0].enabled);
  const videoEnabled = !!(localStream.getVideoTracks()[0] && localStream.getVideoTracks()[0].enabled);
  socket.emit('media-state', { audioEnabled, videoEnabled });
}

// -----------------------------------------------------------------
// SCREEN SHARE: kirim layar ke peer sebagai track video tambahan
// -----------------------------------------------------------------
export async function startScreenShare() {
  try {
    localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false
    });
    const screenTrack = localScreenStream.getVideoTracks()[0];

    for (const peer of peers.values()) {
      const sender = peer.pc.addTrack(screenTrack, localScreenStream);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      socket.emit('offer', { target: peer.remoteId, sdp: offer, extra: true, senderKind: 'screen' });
      void sender;
    }

    screenTrack.onended = () => stopScreenShare();
    log('Screen share dimulai', 'success');
    return localScreenStream;
  } catch (err) {
    log(`Screen share dibatalkan: ${err.message}`, 'warn');
    return null;
  }
}

export function stopScreenShare() {
  if (!localScreenStream) return;
  localScreenStream.getTracks().forEach(t => t.stop());
  localScreenStream = null;
  log('Screen share dihentikan', 'info');
}

// -----------------------------------------------------------------
// MANAJEMEN PEER
// -----------------------------------------------------------------

function createPeer(peerId, meta = {}) {
  if (peers.has(peerId)) {
    const existing = peers.get(peerId);
    if (meta.name) existing.name = meta.name;
    if (meta.role) existing.role = meta.role;
    return existing;
  }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  const peer = {
    pc,
    remoteId: peerId,
    name: meta.name || 'Peserta',
    role: meta.role || 'viewer',
    stream: new MediaStream(),
    audioEnabled: true,
    videoEnabled: true
  };

  peers.set(peerId, peer);
  if (!pendingCandidates.has(peerId)) pendingCandidates.set(peerId, []);

  // Kirim media lokal sendiri (dua arah — ini inti fitur kamera per-viewer)
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  } else {
    // Siapkan jalur walau media belum siap, supaya SDP langsung punya m-line
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { target: peerId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    const inbound = event.streams[0];
    if (inbound) {
      inbound.getTracks().forEach(t => {
        if (!peer.stream.getTracks().some(x => x.id === t.id)) {
          peer.stream.addTrack(t);
        }
      });
    } else if (!peer.stream.getTracks().some(x => x.id === event.track.id)) {
      peer.stream.addTrack(event.track);
    }

    // Jangan render tile untuk track yang tidak membawa media (mis. m-line kosong).
    if (event.track.kind === 'video' && event.track.muted) {
      event.track.onunmute = () => { if (ui.onPeerStream) ui.onPeerStream(peerId, peer); };
    }

    const kind = event.track.kind === 'video' ? 'Kamera' : 'Mikrofon';
    log(`${kind} dari ${peer.name} diterima`, 'success');
    if (ui.onPeerStream) ui.onPeerStream(peerId, peer);
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    log(`Koneksi ${peer.name}: ${state}`, state === 'connected' ? 'success' : 'info');
    if (state === 'failed') {
      log(`Koneksi ke ${peer.name} gagal — mencoba ICE restart`, 'warn');
      try { pc.restartIce(); } catch (e) {}
    }
    if (ui.onPeerStream) ui.onPeerStream(peerId, peer);
  };

  if (ui.onPeerStream) ui.onPeerStream(peerId, peer);
  return peer;
}

async function flushCandidates(peerId) {
  const peer = peers.get(peerId);
  const queue = pendingCandidates.get(peerId);
  if (!peer || !queue || queue.length === 0) return;
  for (const cand of queue) {
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
  }
  pendingCandidates.set(peerId, []);
}

// Kita sebagai PEMANGGIL: buat offer ke peer yang sudah ada.
// Guard `dialed` mencegah glare: satu peer hanya dihubungi sekali.
async function callPeer(peerId, meta = {}) {
  if (dialed.has(peerId)) return;
  dialed.add(peerId);
  try {
    const peer = createPeer(peerId, meta);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('offer', { target: peerId, sdp: offer });
    log(`Menghubungi ${peer.name}...`, 'info');
  } catch (err) {
    dialed.delete(peerId);
    log(`Gagal memanggil peer ${peerId}: ${err.message}`, 'error');
  }
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) {
    try { peer.pc.close(); } catch (e) {}
    peer.stream.getTracks().forEach(t => t.stop());
    peers.delete(peerId);
  }
  pendingCandidates.delete(peerId);
  pendingMeta.delete(peerId);
  dialed.delete(peerId);
  if (ui.onPeerRemoved) ui.onPeerRemoved(peerId);
}

// -----------------------------------------------------------------
// SIGNALING LISTENERS
// -----------------------------------------------------------------

let listenersBound = false;

function bindSignaling() {
  if (listenersBound) return;
  listenersBound = true;

  // Hook audit — memungkinkan inspeksi handler dari luar (test E2E).
  window.__meshDebug = {
    bindSignalingRan: true,
    listeners: {},
    get socketId() { return socket.id; },
    get socketConnected() { return socket.connected; },
    get role() { return selfRole; },
    get roomId() { return currentRoomId; },
    get peerCount() { return peers.size; },
    get hasLocalStream() { return !!localStream; },
    get offerHandlerCount() { return socket.listeners('offer').length; }
  };
  ['offer', 'answer', 'ice-candidate', 'peer-joined', 'peer-left', 'roster', 'media-state', 'room-status', 'room-created', 'join-error'].forEach(evt => {
    window.__meshDebug.listeners[evt] = () => socket.listeners(evt).length;
  });

  socket.on('connect', () => {
    selfId = socket.id;
    log(`Socket terhubung (${selfId})`, 'success');
  });
  selfId = socket.id;

  // --- Sisi CALLEE: menerima offer dari peer (mereka yang menghubungi kita) ---
  socket.on('offer', async (payload) => {
    if (window.__meshDebug) window.__meshDebug.offerEvents = (window.__meshDebug.offerEvents || 0) + 1;
    const { sdp, senderId, sender, extra } = payload || {};
    if (window.__meshDebug) window.__meshDebug.lastOffer = { senderId: senderId ? senderId.slice(0,6) : null, at: Date.now() };
    if (!senderId || senderId === socket.id) return;

    const meta = pendingMeta.get(senderId) || { name: sender ? sender.name : 'Peserta' };
    if (sender && sender.name) meta.name = sender.name;

    // RENEGOSIASI (extra): peer sudah tersambung dan menambahkan track baru
    // (mis. host baru menyalakan kamera). Pakai koneksi yang sudah ada.
    if (extra) {
      const peer = peers.get(senderId);
      if (!peer) { log(`Renegosiasi dari ${meta.name} tapi koneksi tidak ada — dilewati`, 'warn'); return; }
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await flushCandidates(senderId);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('answer', { target: senderId, sdp: answer });
        log(`Renegosiasi dengan ${peer.name} selesai`, 'success');
      } catch (err) {
        log(`Gagal renegosiasi dengan ${meta.name}: ${err.message}`, 'error');
      }
      return;
    }

    // GLARE GUARD: kalau kita sudah pernah menghubungi peer ini, kita adalah pihak
    // yang seharusnya mengirim offer. Offer balik dari dia = tabrakan → abaikan yang masuk.
    if (dialed.has(senderId)) {
      log(`Mengabaikan offer balik dari ${meta.name} (kita sudah menghubunginya)`, 'info');
      return;
    }

    log(`Offer masuk dari ${meta.name}`, 'info');

    // Koneksi yang sudah punya remote description tidak boleh ditimpa offer baru.
    const existing = peers.get(senderId);
    if (existing && existing.pc.remoteDescription && existing.pc.remoteDescription.type) {
      log(`Sudah terhubung dengan ${meta.name} — offer duplikat diabaikan`, 'info');
      return;
    }

    const peer = createPeer(senderId, meta);

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushCandidates(senderId);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('answer', { target: senderId, sdp: answer });
      log(`Answer terkirim ke ${peer.name}`, 'success');
    } catch (err) {
      log(`Gagal memproses offer: ${err.message}`, 'error');
      console.error('[mesh] OFFER FAIL', err);
    }
  });

  // --- Sisi CALLER: menerima answer ---
  socket.on('answer', async ({ sdp, senderId }) => {
    if (!senderId) return;
    const peer = peers.get(senderId);
    if (!peer) return;
    // Abaikan answer untuk state yang tidak menunggu (mis. dari renegosiasi yang gagal).
    if (peer.pc.signalingState !== 'have-local-offer') {
      log(`Answer dari ${peer.name} diabaikan (state: ${peer.pc.signalingState})`, 'info');
      return;
    }
    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushCandidates(senderId);
      log(`Sambungan dengan ${peer.name} siap`, 'success');
    } catch (err) {
      log(`Gagal memproses answer: ${err.message}`, 'error');
    }
  });

  // --- ICE candidate ---
  socket.on('ice-candidate', async ({ candidate, senderId }) => {
    if (!senderId || senderId === socket.id || !candidate) return;
    const peer = peers.get(senderId);
    if (peer && peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    } else {
      if (!pendingCandidates.has(senderId)) pendingCandidates.set(senderId, []);
      pendingCandidates.get(senderId).push(candidate);
    }
  });

  // --- Peserta baru masuk: JANGAN buat koneksi di sini ---
  // Peserta baru yang menghubungi kita (dia dialer). Kita hanya mencatat metadatanya.
  // Kalau kita buat peer sekarang, localStream mungkin belum siap → PC mati tanpa track.
  socket.on('peer-joined', ({ peerId, name, role }) => {
    if (!peerId || peerId === socket.id) return;
    log(`${name} (${role}) bergabung ke room`, 'info');
    // Simpan nama saja; koneksi dibuat saat offer-nya tiba.
    pendingMeta.set(peerId, { name: name || 'Peserta', role: role || 'viewer' });
  });

  socket.on('peer-left', ({ peerId }) => {
    const peer = peers.get(peerId);
    log(`${peer ? peer.name : peerId} keluar dari room`, 'warn');
    removePeer(peerId);
  });

  socket.on('roster', ({ participants }) => {
    roster = participants || [];
    if (ui.onRoster) ui.onRoster(roster);
  });

  socket.on('media-state', ({ peerId, audioEnabled, videoEnabled }) => {
    mediaState.set(peerId, { audioEnabled, videoEnabled });
    const peer = peers.get(peerId);
    if (peer) { peer.audioEnabled = audioEnabled; peer.videoEnabled = videoEnabled; }
    if (ui.onMediaState) ui.onMediaState(peerId, { audioEnabled, videoEnabled });
  });

  socket.on('room-taken-over', () => {
    log('Room ini diambil alih oleh Broadcaster lain. Halaman akan dimuat ulang.', 'warn');
    setTimeout(() => window.location.reload(), 1500);
  });

  socket.on('join-error', ({ message }) => {
    log(`Gagal bergabung: ${message}`, 'error');
  });

  socket.on('disconnect', () => {
    log('Socket terputus dari server', 'error');
  });
}

// -----------------------------------------------------------------
// JOIN KE ROOM (dipakai broadcaster & viewer)
// -----------------------------------------------------------------

export async function joinRoom({ roomId, name, role = 'viewer', withMedia = true }) {
  bindSignaling();

  currentRoomId = String(roomId).trim().toUpperCase();
  selfRole = role;
  selfName = setSelfName(name || loadStoredName() || (role === 'broadcaster' ? 'Host' : 'Peserta'));

  if (withMedia) {
    try {
      await acquireLocalMedia();
    } catch (err) {
      log(`Tidak bisa mengakses kamera: ${err.message}. Bergabung tanpa media (hanya menerima).`, 'warn');
    }
  }

  if (role === 'broadcaster') {
    socket.emit('join-room', { roomId: currentRoomId, name: selfName });
  } else {
    socket.emit('join-as-viewer', { roomId: currentRoomId, name: selfName });
  }

  return { roomId: currentRoomId, name: selfName };
}

// Viewer baru memanggil semua peer existing (assign offer), supaya tidak glare.
export async function connectToExistingPeers(participants) {
  for (const p of (participants || [])) {
    if (p.id === socket.id) continue;
    await callPeer(p.id, { name: p.name, role: p.role });
  }
}

// Broadcaster: sinkronkan daftar peserta DI SIDEBAR saja.
// Penting: JANGAN memanggil callPeer di sini. Broadcaster adalah callee untuk semua
// peserta (mereka yang menghubungi), jadi memanggil di sini = glare.
export function syncWithRoster() {
  for (const p of roster) {
    if (p.id === socket.id) continue;
    const peer = peers.get(p.id);
    if (peer) peer.name = p.name || peer.name;
    else if (!pendingMeta.has(p.id)) pendingMeta.set(p.id, { name: p.name, role: p.role });
  }
  // Hapus peer yang sudah tidak ada di roster
  for (const peerId of Array.from(peers.keys())) {
    if (!roster.some(p => p.id === peerId)) removePeer(peerId);
  }
}

// Ubah nama tampilan sendiri dan sebarkan ke semua peer + roster server.
export function setDisplayName(name) {
  if (!name) return;
  selfName = name;
  for (const peer of peers.values()) {
    if (!peer.name || peer.name === 'Host' || peer.name === 'Peserta') peer.name = name;
  }
  socket.emit('set-name', { name });
}

export function leaveRoom() {
  for (const peerId of Array.from(peers.keys())) removePeer(peerId);
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  stopScreenShare();
  if (currentRoomId) socket.emit('leave-room', { roomId: currentRoomId });
  roster = [];
}
