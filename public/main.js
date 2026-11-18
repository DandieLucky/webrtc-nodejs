// =================================================================
// BROADCASTER ENGINE (macOS Frosted White Edition)
// Broadcaster = penyedia video file + peserta mesh (menerima kamera peserta lain)
// Mesin mesh (peer dua arah) ada di mesh.js
// =================================================================

import {
  socket,
  registerUI,
  log,
  showToast,
  joinRoom,
  syncWithRoster,
  connectToExistingPeers,
  getRoster,
  getPeers,
  startScreenShare,
  stopScreenShare
} from './mesh.js';

export { socket, log, showToast };
export { startScreenShare, stopScreenShare };

// Konfigurasi STUN servers handal untuk menembus NAT & jaringan lokal
export const config = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceCandidatePoolSize: 10
};

// State Global
let localStream = null;
let currentRoomId = null;
let currentSourceType = 'file';   // 'file', 'camera', atau 'demo'
let demoAnimationInterval = null;
let serverInfo = { primaryIp: 'localhost', port: 8080, ips: [] };
let broadcasterName = 'Host';


// Inisialisasi awal mengambil info IP LAN server
fetch('/api/server-info')
  .then(res => res.json())
  .then(data => {
    serverInfo = data;
    log(`Server IP terdeteksi: ${serverInfo.primaryIp}:${serverInfo.port}`, 'info');
  })
  .catch(() => {});

// =================================================================
// LOGIKA BROADCASTER (PENYEDIA MEDIA / PENGUNGGAH VIDEO)
// =================================================================

export async function startBroadcast() {
  const localVideo = document.getElementById('localVideo');
  const tokenDisplay = document.getElementById('token');
  const copyBtn = document.getElementById('copyTokenBtn');
  const copyPhoneLinkBtn = document.getElementById('copyPhoneLinkBtn');
  const copyLocalLinkBtn = document.getElementById('copyLocalLinkBtn');
  const viewerCountBadge = document.getElementById('viewerCountBadge');
  const statusBadge = document.getElementById('statusBadge');
  const fileInput = document.getElementById('videoFileInput');
  const dropzone = document.getElementById('dropzone');
  const fileDetails = document.getElementById('fileDetails');
  const selectedFileName = document.getElementById('selectedFileName');
  const selectedFileSize = document.getElementById('selectedFileSize');
  const videoControlsBar = document.getElementById('videoControlsBar');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const muteBtn = document.getElementById('muteBtn');
  const videoTimeline = document.getElementById('videoTimeline');
  const timeDisplay = document.getElementById('timeDisplay');
  const resetRoomBtn = document.getElementById('resetRoomBtn');

  // 1. Dapatkan atau pertahankan Room ID agar link di HP tidak hangus saat halaman di-refresh
  let savedRoomId = sessionStorage.getItem('webrtc_room_id');
  if (!savedRoomId) {
    savedRoomId = Math.random().toString(36).substring(2, 10).toUpperCase();
    sessionStorage.setItem('webrtc_room_id', savedRoomId);
  }
  currentRoomId = savedRoomId;

  if (tokenDisplay) {
    tokenDisplay.innerText = currentRoomId;
    tokenDisplay.onclick = () => copyTokenToClipboard();
  }

  if (copyBtn) {
    copyBtn.onclick = () => copyTokenToClipboard();
  }

  // Tombol reset Room ID jika pengguna ingin kode baru
  if (resetRoomBtn) {
    resetRoomBtn.onclick = () => {
      currentRoomId = Math.random().toString(36).substring(2, 10).toUpperCase();
      sessionStorage.setItem('webrtc_room_id', currentRoomId);
      tokenDisplay.innerText = currentRoomId;
      joinRoom({ roomId: currentRoomId, name: broadcasterName, role: 'broadcaster', withMedia: false });
      refreshQrCode();
      showToast(`Token baru dibuat: ${currentRoomId}`);
      log(`Room ID diperbarui ke: ${currentRoomId}`, 'info');
    };
  }

  function getLanViewerLink() {
    let host = serverInfo.primaryIp && serverInfo.primaryIp !== 'localhost' 
      ? serverInfo.primaryIp 
      : window.location.hostname;
    
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      host = window.location.hostname;
    }
    
    return `https://${host}:${serverInfo.port || 8080}/viewer.html?token=${currentRoomId}`;
  }

  function getLocalViewerLink() {
    return `${window.location.origin}/viewer.html?token=${currentRoomId}`;
  }

  // Tombol Salin Link Khusus HP / Perangkat Lain (Menggunakan IP LAN)
  if (copyPhoneLinkBtn) {
    copyPhoneLinkBtn.onclick = () => {
      const link = getLanViewerLink();
      navigator.clipboard.writeText(link).then(() => {
        showToast('Link HP disalin! Buka link ini di browser HP.');
        log(`Link Viewer HP disalin: ${link}`, 'success');
      });
    };
  }

  // Tombol Salin Link untuk Browser Laptop ini (Localhost)
  if (copyLocalLinkBtn) {
    copyLocalLinkBtn.onclick = () => {
      const link = getLocalViewerLink();
      navigator.clipboard.writeText(link).then(() => {
        showToast('Link Localhost berhasil disalin!');
        log(`Link Localhost disalin: ${link}`, 'info');
      });
    };
  }

  function copyTokenToClipboard() {
    navigator.clipboard.writeText(currentRoomId).then(() => {
      showToast(`Token ${currentRoomId} berhasil disalin!`);
      log(`Token ${currentRoomId} disalin ke clipboard`, 'info');
    });
  }

  // Update QR Code dan teks link LAN
  async function refreshQrCode() {
    try {
      const res = await fetch('/api/server-info');
      const latestInfo = await res.json();
      
      // Jika IP berubah (misal ganti Wi-Fi atau Hotspot)
      if (serverInfo.primaryIp !== latestInfo.primaryIp) {
        log(`Alamat IP berubah dari ${serverInfo.primaryIp} ke ${latestInfo.primaryIp}`, 'warn');
        serverInfo = latestInfo;
      }
    } catch (e) {}

    const lanLink = getLanViewerLink();
    const qrImg = document.getElementById('qrCodeImage');
    const lanLinkDisplay = document.getElementById('lanViewerLinkText');
    const liveIpBadge = document.getElementById('liveIpBadge');

    if (lanLinkDisplay) {
      lanLinkDisplay.innerText = lanLink;
    }

    if (liveIpBadge) {
      liveIpBadge.innerText = `IP: ${serverInfo.primaryIp}:${serverInfo.port || 8080}`;
    }

    if (qrImg) {
      try {
        const qrRes = await fetch(`/api/qr?text=${encodeURIComponent(lanLink)}`);
        const qrData = await qrRes.json();
        if (qrData.status === 'success') {
          qrImg.src = qrData.dataUrl;
          qrImg.style.display = 'block';
        }
      } catch (err) {
        console.warn('Gagal memuat QR Code:', err);
      }
    }
  }

  // Generate QR Code pertama kali & polling setiap 4 detik untuk memantau perubahan IP
  setTimeout(refreshQrCode, 300);
  setInterval(refreshQrCode, 4000);

  // 2. Setup mesh (menerima kamera peserta lain) lalu bergabung ke room
  setupMeshUI();

  await joinRoom({ roomId: currentRoomId, name: broadcasterName, role: 'broadcaster', withMedia: false });
  log(`Broadcaster terhubung ke room: ${currentRoomId}`, 'success');

  if (statusBadge) {
    statusBadge.className = 'badge badge-waiting';
    statusBadge.innerHTML = '<span class="badge-dot"></span> Menunggu Video';
  }

  // 3. Setup File Upload & Drag-and-Drop
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleVideoFileSelection(file);
    });
  }

  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('video/')) {
        handleVideoFileSelection(file);
      } else {
        alert('Silakan pilih file video yang valid (.mp4, .webm, dll)');
      }
    });
  }

  // Fungsi memuat & memproses file video dari komputer lokal
  function handleVideoFileSelection(file) {
    stopDemoAnimation();
    log(`Memuat file video: ${file.name} (${formatBytes(file.size)})`, 'info');

    if (selectedFileName) selectedFileName.innerText = file.name;
    if (selectedFileSize) selectedFileSize.innerText = formatBytes(file.size);
    if (fileDetails) fileDetails.style.display = 'flex';
    if (dropzone) dropzone.style.display = 'none';
    if (videoControlsBar) videoControlsBar.style.display = 'flex';

    const videoUrl = URL.createObjectURL(file);
    localVideo.srcObject = null;
    localVideo.src = videoUrl;
    localVideo.loop = true;
    localVideo.muted = true; // Muted pada preview lokal agar tidak audio feedback

    const placeholder = document.getElementById('videoPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    localVideo.onloadedmetadata = async () => {
      try {
        await localVideo.play();
        log(`Video berhasil diputar (${Math.round(localVideo.duration)} detik)`, 'success');

        setupStreamFromVideoElement();

        if (statusBadge) {
          statusBadge.className = 'badge badge-live';
          statusBadge.innerHTML = '<span class="badge-dot"></span> Siaran Video Aktif';
        }

        // Beri tahu server dan viewer bahwa video siap
        socket.emit('broadcaster-video-ready', currentRoomId);
      } catch (err) {
        log(`Gagal memutar video otomatis: ${err.message}`, 'error');
      }
    };
  }

  // Tangkap MediaStream dari tag <video>
  function setupStreamFromVideoElement() {
    try {
      if (localVideo.captureStream) {
        localStream = localVideo.captureStream();
      } else if (localVideo.mozCaptureStream) {
        localStream = localVideo.mozCaptureStream();
      } else {
        throw new Error('Browser Anda tidak mendukung captureStream pada elemen video');
      }

      currentSourceType = 'file';
      log(`Stream WebRTC aktif (${localStream.getTracks().length} track)`, 'success');

      // Update track pada semua peer yang sudah tersambung
      updatePeerTracks(localStream);
    } catch (err) {
      log(`Error captureStream: ${err.message}`, 'error');
    }
  }

  // Kontrol pemutaran video
  if (playPauseBtn) {
    playPauseBtn.onclick = () => {
      if (localVideo.paused) {
        localVideo.play();
        playPauseBtn.innerHTML = '⏸️ Jeda';
        log('Video dilanjutkan', 'info');
      } else {
        localVideo.pause();
        playPauseBtn.innerHTML = '▶️ Putar';
        log('Video dijeda', 'info');
      }
    };
  }

  if (muteBtn) {
    muteBtn.onclick = () => {
      localVideo.muted = !localVideo.muted;
      muteBtn.innerHTML = localVideo.muted ? '🔇 Bisu Monitor' : '🔊 Dengar Monitor';
      log(`Audio monitor lokal: ${localVideo.muted ? 'Muted' : 'Unmuted'}`, 'info');
    };
  }

  if (localVideo && videoTimeline && timeDisplay) {
    localVideo.ontimeupdate = () => {
      if (!isNaN(localVideo.duration)) {
        const pct = (localVideo.currentTime / localVideo.duration) * 100;
        videoTimeline.value = pct;
        timeDisplay.innerText = `${formatTime(localVideo.currentTime)} / ${formatTime(localVideo.duration)}`;
      }
    };

    videoTimeline.oninput = (e) => {
      if (!isNaN(localVideo.duration)) {
        localVideo.currentTime = (e.target.value / 100) * localVideo.duration;
      }
    };
  }

  // Switcher sumber media
  window.switchMediaSource = async function(type) {
    stopDemoAnimation();
    if (type === 'file') {
      currentSourceType = 'file';
      document.getElementById('tabFile').classList.add('active');
      document.getElementById('tabCamera').classList.remove('active');
      document.getElementById('tabDemo').classList.remove('active');
      document.getElementById('fileSourceSection').style.display = 'block';

      if (localVideo.src) {
        localVideo.play();
        setupStreamFromVideoElement();
      }
    } else if (type === 'camera') {
      try {
        currentSourceType = 'camera';
        document.getElementById('tabCamera').classList.add('active');
        document.getElementById('tabFile').classList.remove('active');
        document.getElementById('tabDemo').classList.remove('active');
        document.getElementById('fileSourceSection').style.display = 'none';
        if (videoControlsBar) videoControlsBar.style.display = 'none';

        log('Meminta izin akses Kamera & Mikrofon...', 'info');
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStream = camStream;
        localVideo.src = '';
        localVideo.srcObject = camStream;
        localVideo.muted = true;
        await localVideo.play();

        const placeholder = document.getElementById('videoPlaceholder');
        if (placeholder) placeholder.style.display = 'none';

        if (statusBadge) {
          statusBadge.className = 'badge badge-live';
          statusBadge.innerHTML = '<span class="badge-dot"></span> Kamera Aktif';
        }

        log('Kamera & Mic terhubung, stream aktif', 'success');
        updatePeerTracks(camStream);
        socket.emit('broadcaster-video-ready', currentRoomId);
      } catch (err) {
        log(`Gagal mengakses kamera: ${err.message}`, 'error');
        alert(`Gagal mengakses kamera: ${err.message}`);
      }
    } else if (type === 'demo') {
      currentSourceType = 'demo';
      document.getElementById('tabDemo').classList.add('active');
      document.getElementById('tabFile').classList.remove('active');
      document.getElementById('tabCamera').classList.remove('active');
      document.getElementById('fileSourceSection').style.display = 'none';
      if (videoControlsBar) videoControlsBar.style.display = 'none';

      startSyntheticDemoStream();
    }
  };

  // Demo generator sintetis instan
  function startSyntheticDemoStream() {
    log('Memulai Video Demo Sintetis WebRTC...', 'info');
    let canvas = document.getElementById('demoCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'demoCanvas';
      canvas.width = 640;
      canvas.height = 360;
      canvas.style.display = 'none';
      document.body.appendChild(canvas);
    }
    const ctx = canvas.getContext('2d');
    let ballX = 50, ballY = 50, speedX = 4, speedY = 3;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const dest = audioCtx.createMediaStreamDestination();
    osc.type = 'sine';
    osc.frequency.value = 440;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();

    demoAnimationInterval = setInterval(() => {
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, '#0071e3');
      grad.addColorStop(1, '#1e293b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.beginPath();
      ctx.arc(ballX, ballY, 24, 0, Math.PI * 2);
      ctx.fillStyle = '#34c759';
      ctx.shadowColor = '#34c759';
      ctx.shadowBlur = 18;
      ctx.fill();
      ctx.shadowBlur = 0;

      ballX += speedX;
      ballY += speedY;
      if (ballX < 24 || ballX > canvas.width - 24) speedX = -speedX;
      if (ballY < 24 || ballY > canvas.height - 24) speedY = -speedY;

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px system-ui';
      ctx.fillText('🔴 SIARAN LIVE WEBRTC LOKAL', 40, 60);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '16px system-ui';
      ctx.fillText('Room ID: ' + currentRoomId, 40, 95);

      const now = new Date();
      const timeStr = now.toLocaleTimeString() + '.' + String(now.getMilliseconds()).padStart(3, '0');
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 36px monospace';
      ctx.fillText(timeStr, 40, 160);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '14px system-ui';
      ctx.fillText('✓ Transmisi Berjalan Secara Real-Time', 40, 210);
    }, 1000 / 30);

    const canvasStream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(track => canvasStream.addTrack(track));

    localStream = canvasStream;
    localVideo.src = '';
    localVideo.srcObject = canvasStream;
    localVideo.muted = true;
    localVideo.play();

    const placeholder = document.getElementById('videoPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    if (statusBadge) {
      statusBadge.className = 'badge badge-live';
      statusBadge.innerHTML = '<span class="badge-dot"></span> Demo Animasi Aktif';
    }

    log('Video demo sintetis berhasil dibuat & disiarkan', 'success');
    updatePeerTracks(canvasStream);
    socket.emit('broadcaster-video-ready', currentRoomId);
  }

  function stopDemoAnimation() {
    if (demoAnimationInterval) {
      clearInterval(demoAnimationInterval);
      demoAnimationInterval = null;
    }
  }

  window.triggerChangeVideo = function() {
    if (fileInput) {
      fileInput.value = '';
      fileInput.click();
    }
  };

  // Update track pada RTCPeerConnection viewer aktif
  async function updatePeerTracks(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    const currentPeers = getPeersSnapshot();
    for (const [peerId, peer] of currentPeers) {
      const pc = peer.pc;
      let videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      let audioSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');

      if (videoSender && videoTrack) {
        await videoSender.replaceTrack(videoTrack);
      } else if (videoTrack) {
        pc.addTrack(videoTrack, stream);
      }

      if (audioSender && audioTrack) {
        await audioSender.replaceTrack(audioTrack);
      } else if (audioTrack) {
        pc.addTrack(audioTrack, stream);
      }

      log(`Track media diperbarui untuk Peserta: ${peer.name || peerId}`, 'info');

      // Renegosiasi agar peer menerima track baru
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: peerId, sdp: offer });
      } catch (err) {
        console.warn('Renegotiation notice:', err);
      }
    }
  }

  // =================================================================
  // EVENT LISTENERS SIGNALING SERVER (SOCKET.IO)
  // Signaling dua arah (offer/answer/ICE) ditangani oleh mesh.js.
  // Di sini hanya notifikasi room + render grid kamera peserta.
  // =================================================================

  // 1. Info room
  socket.on('room-created', ({ roomId }) => {
    log(`Room ${roomId} aktif dan siap menerima peserta`, 'success');
  });

  // 2. Update jumlah peserta
  socket.on('viewer-count', ({ count }) => {
    if (viewerCountBadge) {
      viewerCountBadge.innerText = `${count} Peserta Aktif`;
    }
  });

  // 3. Broadcaster lain mengambil room ini
  socket.on('room-taken-over', () => {
    log('Room ini dibuka di tab/perangkat lain. Muat ulang halaman untuk mengambil alih.', 'warn');
  });
}

// =================================================================
// MESH UI UNTUK BROADCASTER — grid kamera peserta
// =================================================================

const meshTiles = new Map();

function getPeersSnapshot() {
  return getPeers();
}

export function setupMeshUI() {
  registerUI({
    onLog(message, type) {
      // Catatan: jangan panggil log() di sini — log() memanggil onLog ini lagi
      // dan akan terjadi rekursi tak berujung. Cukup biarkan log() menulis DOM.
      void message; void type;
    },

    onPeerStream(peerId, peer) {
      const tile = ensureMeshTile(peerId, peer);
      const video = tile.querySelector('video');
      if (video.srcObject !== peer.stream) {
        video.srcObject = peer.stream;
        video.play().catch(() => {});
      }
      applyMeshTileState(tile, peer);
    },

    onPeerRemoved(peerId) {
      const tile = meshTiles.get(peerId);
      if (tile) { tile.remove(); meshTiles.delete(peerId); }
      updateMeshNotice();
    },

    onRoster(participants) {
      renderRoster(participants);
      // Hanya sinkronkan nama/daftar. Broadcaster TIDAK memanggil peserta —
      // peserta yang menghubungi broadcaster, jadi tidak ada glare.
      syncWithRoster();
    },

    onMediaState(peerId, state) {
      const tile = meshTiles.get(peerId);
      if (!tile) return;
      const v = tile.querySelector('video');
      const flag = tile.querySelector('.tile-flag');
      v.style.opacity = state.videoEnabled ? '1' : '0.15';
      if (!state.audioEnabled) {
        flag.style.display = 'inline-block';
        flag.innerText = '�� Mic Mati';
      } else if (!state.videoEnabled) {
        flag.style.display = 'inline-block';
        flag.innerText = '�� Kamera Mati';
      } else {
        flag.style.display = 'none';
      }
    }
  });
}

// Tampilkan state tile dari kondisi nyata koneksi. `iceConnectionState` sering
// lebih dulu 'connected' daripada `connectionState`, jadi ikuti yang sudah siap.
function applyMeshTileState(tile, peer) {
  const conn = peer.pc.connectionState;
  const ice = peer.pc.iceConnectionState;
  const state = (conn === 'connected' || ice === 'connected' || ice === 'completed')
    ? 'connected'
    : (conn === 'failed' || ice === 'failed') ? 'failed'
    : (conn === 'connecting' || ice === 'checking') ? 'connecting'
    : conn;

  tile.dataset.state = state;
  const label = tile.querySelector('.tile-state');
  if (label) {
    label.innerText =
      state === 'connected' ? '● Live' :
      state === 'connecting' ? '◌ Menghubungkan' :
      state === 'failed' ? '✕ Gagal' : state;
  }
}

function ensureMeshTile(peerId, peer) {
  if (meshTiles.has(peerId)) {
    const t = meshTiles.get(peerId);
    t.querySelector('.tile-label').innerText = peer.name || 'Peserta';
    return t;
  }

  const grid = document.getElementById('participantGrid');
  if (!grid) return document.createElement('div'); // halaman tanpa grid

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.dataset.peerId = peerId;
  tile.innerHTML = `
    <video autoplay playsinline muted></video>
    <span class="tile-label">${(peer.name || 'Peserta').replace(/</g, '&lt;')}</span>
    <span class="tile-state">◌ Menghubungkan</span>
    <span class="tile-flag" style="display:none;"></span>
  `;
  grid.appendChild(tile);
  meshTiles.set(peerId, tile);
  updateMeshNotice();
  return tile;
}

function updateMeshNotice() {
  const notice = document.getElementById('emptyGridNotice');
  if (notice) notice.style.display = meshTiles.size === 0 ? 'flex' : 'none';
}

function renderRoster(participants) {
  const list = document.getElementById('rosterList');
  const badge = document.getElementById('rosterCount');
  if (badge) badge.innerText = `${participants.length} Peserta`;
  if (!list) return;

  list.innerHTML = '';
  participants.forEach(p => {
    const row = document.createElement('div');
    row.className = 'roster-item';
    row.innerHTML = `
      <span class="roster-dot"></span>
      <span class="roster-name">${(p.name || 'Peserta').replace(/</g, '&lt;')}</span>
      <span class="roster-role">${p.role === 'broadcaster' ? 'Host' : 'Peserta'}</span>
    `;
    list.appendChild(row);
  });
}

export function setPeerSnapshotter() {
  // Dipertahankan sebagai no-op untuk kompatibilitas API lama.
}

export function getRosterList() {
  return getRoster();
}

// =================================================================
// SCREEN SHARE (dipakai broadcaster & peserta)
// =================================================================
export function toggleScreenShare(btn) {
  if (!btn) return;
  if (!btn._sharing) {
    startScreenShare().then(s => {
      if (s) {
        btn._sharing = true;
        btn.innerText = 'STOP Bagikan Layar';
        btn.classList.add('btn-success');
      }
    });
  } else {
    stopScreenShare();
    btn._sharing = false;
    btn.innerText = 'Bagikan Layar';
    btn.classList.remove('btn-success');
  }
}

// Helpers
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
