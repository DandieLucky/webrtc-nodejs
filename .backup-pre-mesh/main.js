// =================================================================
// WEBRTC & SOCKET.IO CLIENT ENGINE (macOS Frosted White Edition)
// Web Conference Lokal (Broadcaster & Viewer) - Multi-Device Optimized
// =================================================================

export const socket = io();

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
export const peerConnections = {}; // viewerId -> RTCPeerConnection
const candidateQueue = {};        // viewerId -> Array candidate yang menunggu remote description
let localStream = null;
let currentRoomId = null;
let currentSourceType = 'file';   // 'file', 'camera', atau 'demo'
let demoAnimationInterval = null;
let serverInfo = { primaryIp: 'localhost', port: 8080, ips: [] };

// Helper Logger ke UI & Console
export function log(message, type = 'info') {
  const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
  console.log(`[${time}] ${message}`);

  const logBox = document.getElementById('logBox');
  if (logBox) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span> <span>${escapeHtml(message)}</span>`;
    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Helper Toast Notification
export function showToast(message) {
  let toast = document.getElementById('toastNotification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastNotification';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span>⚡</span> <span>${message}</span>`;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

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
      socket.emit('join-room', currentRoomId);
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

  // 2. Bergabung ke room di Socket.IO
  socket.emit('join-room', currentRoomId);
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

    for (const [viewerId, pc] of Object.entries(peerConnections)) {
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

      log(`Track media diperbarui untuk Viewer: ${viewerId}`, 'info');

      // Buat penawaran baru (renegotiation) jika perlu
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: viewerId, sdp: offer });
        log(`Offer pembaharuan terkirim ke ${viewerId}`, 'info');
      } catch (err) {
        console.warn('Renegotiation notice:', err);
      }
    }
  }

  // =================================================================
  // EVENT LISTENERS SIGNALING SERVER (SOCKET.IO)
  // =================================================================

  // 1. Viewer bergabung ke room
  socket.on('viewer-joined', async ({ viewerId }) => {
    log(`Viewer terdeteksi: ${viewerId}. Menyiapkan koneksi WebRTC...`, 'info');
    
    // Tutup koneksi lama jika ada
    if (peerConnections[viewerId]) {
      try { peerConnections[viewerId].close(); } catch (e) {}
    }

    const pc = new RTCPeerConnection(config);
    peerConnections[viewerId] = pc;
    candidateQueue[viewerId] = [];

    // Tambahkan track dari stream lokal (File Video / Kamera)
    if (localStream && localStream.getTracks().length > 0) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
      log(`Menambahkan ${localStream.getTracks().length} track media ke Viewer ${viewerId}`, 'info');
    } else {
      // Jika broadcaster belum memilih video, tambahkan transceiver agar jalur siap
      pc.addTransceiver('video', { direction: 'sendonly' });
      pc.addTransceiver('audio', { direction: 'sendonly' });
      log(`Menyiapkan transceiver video & audio untuk Viewer ${viewerId} (Menunggu video dipilih)`, 'warn');
    }

    // ICE Candidate
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          roomId: currentRoomId,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      log(`Status koneksi dengan Viewer [${viewerId}]: ${state}`,
        state === 'connected' ? 'success' : 'info');
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      log(`Status ICE dengan Viewer [${viewerId}]: ${state}`, 
        state === 'connected' || state === 'completed' ? 'success' : 'info');
    };

    // Buat Offer SDP & kirim ke Viewer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { target: viewerId, sdp: offer });
      log(`Offer SDP terkirim ke Viewer: ${viewerId}`, 'info');
    } catch (err) {
      log(`Gagal membuat Offer SDP: ${err.message}`, 'error');
    }
  });

  // 2. Menerima Answer SDP dari Viewer
  socket.on('answer', async ({ sdp, viewerId }) => {
    log(`Menerima Answer SDP dari Viewer: ${viewerId}`, 'info');
    const pc = peerConnections[viewerId];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        log(`Remote description diset untuk Viewer: ${viewerId}`, 'success');

        if (candidateQueue[viewerId] && candidateQueue[viewerId].length > 0) {
          for (const cand of candidateQueue[viewerId]) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          }
          candidateQueue[viewerId] = [];
        }
      } catch (err) {
        log(`Error setRemoteDescription: ${err.message}`, 'error');
      }
    }
  });

  // 3. Menerima ICE Candidate dari Viewer
  socket.on('ice-candidate', async ({ candidate, senderId }) => {
    if (senderId === socket.id) return;
    const pc = peerConnections[senderId];
    if (pc) {
      try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          if (!candidateQueue[senderId]) candidateQueue[senderId] = [];
          candidateQueue[senderId].push(candidate);
        }
      } catch (err) {
        console.warn('Notice addIceCandidate:', err.message);
      }
    }
  });

  // 4. Viewer keluar
  socket.on('viewer-left', ({ viewerId }) => {
    log(`Viewer ${viewerId} telah keluar`, 'warn');
    if (peerConnections[viewerId]) {
      peerConnections[viewerId].close();
      delete peerConnections[viewerId];
      delete candidateQueue[viewerId];
    }
  });

  // 5. Update jumlah viewer
  socket.on('viewer-count', ({ count }) => {
    if (viewerCountBadge) {
      viewerCountBadge.innerText = `${count} Penonton Aktif`;
    }
  });
}

// =================================================================
// LOGIKA VIEWER (KLIEN PENONTON SIARAN)
// =================================================================

export async function startView(roomId) {
  if (!roomId || roomId.trim() === '') {
    alert('Silakan masukkan Token Room terlebih dahulu!');
    return;
  }

  roomId = roomId.trim().toUpperCase();
  currentRoomId = roomId;

  const remoteVideo = document.getElementById('remoteVideo');
  const statusBadge = document.getElementById('statusBadge');
  const audioPrompt = document.getElementById('audioPromptOverlay');
  const placeholder = document.getElementById('videoPlaceholder');
  const joinBtn = document.getElementById('joinBtn');
  const troubleNotice = document.getElementById('troubleshootingNotice');

  // Pastikan atribut ramah mobile terpasang
  if (remoteVideo) {
    remoteVideo.muted = true;
    remoteVideo.setAttribute('playsinline', '');
    remoteVideo.setAttribute('webkit-playsinline', '');
    remoteVideo.autoplay = true;
  }

  if (joinBtn) {
    joinBtn.disabled = true;
    joinBtn.innerText = 'Menghubungkan...';
  }

  if (statusBadge) {
    statusBadge.className = 'badge badge-waiting';
    statusBadge.innerHTML = '<span class="badge-dot"></span> Mencari Siaran...';
  }

  log(`Mencari siaran dengan Room Token: ${roomId}...`, 'info');

  let peerConnection = null;
  const pendingCandidates = [];
  let connectionTimeoutTimer = null;

  // Pasang timer 10 detik jika tidak kunjung terhubung (membantu mendeteksi AP isolation)
  if (troubleNotice) troubleNotice.style.display = 'none';
  connectionTimeoutTimer = setTimeout(() => {
    if (!peerConnection || peerConnection.connectionState !== 'connected') {
      if (troubleNotice) troubleNotice.style.display = 'block';
      log('Tips: Jika tidak kunjung terhubung di Wi-Fi publik/kampus, gunakan Hotspot HP untuk kedua perangkat.', 'warn');
    }
  }, 9000);

  // 1. Emit ke server bahwa viewer bergabung
  socket.emit('join-as-viewer', roomId);

  // Status room dari server
  socket.on('room-status', ({ status, hasVideo }) => {
    if (status === 'found') {
      log(`Room ${roomId} ditemukan! Menunggu sambungan dari Broadcaster...`, 'info');
      if (placeholder) {
        const title = placeholder.querySelector('h3');
        const desc = placeholder.querySelector('p');
        if (title) title.innerText = 'Tersambung ke Broadcaster';
        if (desc) desc.innerText = hasVideo ? 'Sedang menerima aliran video...' : 'Menunggu Broadcaster memilih dan memutar file video...';
      }
    } else if (status === 'waiting-broadcaster') {
      log(`Room ${roomId} belum aktif di Broadcaster. Pastikan Broadcaster sudah membuka halamannya.`, 'warn');
      if (statusBadge) {
        statusBadge.className = 'badge badge-waiting';
        statusBadge.innerHTML = '<span class="badge-dot"></span> Token Menunggu';
      }
      if (joinBtn) {
        joinBtn.disabled = false;
        joinBtn.innerText = 'Coba Lagi';
      }
      if (placeholder) {
        const title = placeholder.querySelector('h3');
        const desc = placeholder.querySelector('p');
        if (title) title.innerText = 'Broadcaster Belum Siap';
        if (desc) desc.innerText = `Token "${roomId}" belum aktif. Pastikan halaman Broadcaster di laptop sudah dibuka dan kodenya sesuai.`;
      }
    }
  });

  // Notifikasi bahwa broadcaster sudah menyiapkan video
  socket.on('broadcaster-video-ready', () => {
    log('Broadcaster telah memulai pemutaran video!', 'success');
  });

  // 2. Menerima Offer SDP dari Broadcaster
  socket.on('offer', async ({ sdp, broadcasterId }) => {
    log(`Menerima Offer SDP dari Broadcaster (${broadcasterId})`, 'info');

    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
    }

    peerConnection = new RTCPeerConnection(config);

    // Menerima MediaStream dari broadcaster
    peerConnection.ontrack = (event) => {
      log(`Trek media diterima: ${event.track.kind}`, 'success');
      
      if (remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
      }

      if (placeholder) placeholder.style.display = 'none';
      if (troubleNotice) troubleNotice.style.display = 'none';
      if (connectionTimeoutTimer) clearTimeout(connectionTimeoutTimer);

      // Jalankan video
      remoteVideo.play().then(() => {
        log('Video siaran berhasil diputar secara real-time!', 'success');
        if (statusBadge) {
          statusBadge.className = 'badge badge-live';
          statusBadge.innerHTML = '<span class="badge-dot"></span> Live Streaming';
        }
        if (joinBtn) {
          joinBtn.innerText = 'Tersambung';
          joinBtn.classList.add('btn-success');
        }
      }).catch((err) => {
        log(`Autoplay ditahan oleh kebijakan browser HP: ${err.message}. Memerlukan sentuhan layar.`, 'warn');
        if (audioPrompt) audioPrompt.style.display = 'flex';
      });
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          roomId: currentRoomId,
          candidate: event.candidate
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      log(`Status koneksi WebRTC: ${state}`, state === 'connected' ? 'success' : 'info');

      if (state === 'connected') {
        if (troubleNotice) troubleNotice.style.display = 'none';
        if (connectionTimeoutTimer) clearTimeout(connectionTimeoutTimer);
        if (joinBtn) {
          joinBtn.innerText = 'Tersambung';
          joinBtn.classList.add('btn-success');
        }
        if (statusBadge) {
          statusBadge.className = 'badge badge-live';
          statusBadge.innerHTML = '<span class="badge-dot"></span> Live Streaming';
        }
      } else if (state === 'disconnected' || state === 'failed') {
        if (statusBadge) {
          statusBadge.className = 'badge badge-waiting';
          statusBadge.innerHTML = '<span class="badge-dot"></span> Terputus';
        }
        if (joinBtn) {
          joinBtn.disabled = false;
          joinBtn.innerText = 'Hubungkan Ulang';
          joinBtn.classList.remove('btn-success');
        }
      }
    };

    // Set Remote Description & Kirimkan Answer SDP
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      log('Remote description diset, membuat Answer SDP...', 'info');

      while (pendingCandidates.length > 0) {
        const cand = pendingCandidates.shift();
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      }

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', { target: broadcasterId, sdp: answer });
      log('Answer SDP terkirim ke Broadcaster', 'success');
    } catch (err) {
      log(`Gagal memproses offer: ${err.message}`, 'error');
    }
  });

  // 3. Listener ICE candidate dari Broadcaster
  socket.on('ice-candidate', async ({ candidate, senderId }) => {
    if (senderId === socket.id) return;
    if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Notice addIceCandidate:', err.message);
      }
    } else {
      pendingCandidates.push(candidate);
    }
  });

  // 4. Broadcaster keluar
  socket.on('broadcaster-left', () => {
    log('Broadcaster telah menutup siaran.', 'warn');
    if (statusBadge) {
      statusBadge.className = 'badge badge-waiting';
      statusBadge.innerHTML = '<span class="badge-dot"></span> Siaran Selesai';
    }
    if (remoteVideo) remoteVideo.srcObject = null;
    if (placeholder) {
      placeholder.style.display = 'flex';
      const p = placeholder.querySelector('p');
      if (p) p.innerText = 'Siaran telah berakhir.';
    }
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.innerText = 'Join Lagi';
      joinBtn.classList.remove('btn-success');
    }
  });
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
