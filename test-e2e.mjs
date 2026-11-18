// E2E: 3 halaman browser nyata (1 host + 2 peserta) dengan webcam palsu.
// Verifikasi: video tile muncul, ontrack benar-benar menerima media, kamera per-peserta jalan.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const BASE = 'https://localhost:8080';
const ROOM = 'E2E' + Math.floor(Math.random() * 9000 + 1000);

const userDir = '/tmp/e2e-chrome-' + Date.now();
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--ignore-certificate-errors',
  '--allow-running-insecure-content',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank'
], { stdio: 'ignore' });

const wait = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      return j.webSocketDebuggerUrl;
    } catch (e) { await wait(300); }
  }
  throw new Error('chrome tidak siap');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const c = new CDP(ws);
    ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        if (c.events.length < 200) c.events.push(m);
      }
    });
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const browser = await CDP.connect(await getWsUrl());

async function newPage(url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Log.enable', {}, sessionId).catch(() => {});
  if (url) {
    await browser.send('Page.navigate', { url }, sessionId);
    await wait(1500);
  }
  return { targetId, sessionId };
}

async function evaluate(sessionId, expr) {
  const r = await browser.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true
  }, sessionId);
  if (r.exceptionDetails) return { error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return { value: r.result.value };
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
};

// ---------- 1. HOST ----------
console.log('\n== 1. Buka halaman Broadcaster ==');
const host = await newPage(`${BASE}/broadcaster.html`);
await wait(2500);

let err = await evaluate(host.sessionId, `return document.body ? 'ok' : 'no-body'`);
check('broadcaster.html dimuat', err.value === 'ok', JSON.stringify(err));

const tokenOnPage = await evaluate(host.sessionId, `
  const t = document.getElementById('token');
  return t ? t.innerText.trim() : null;
`);
console.log('   Token di halaman host:', tokenOnPage.value);
check('token room tampil di halaman host', /^[A-Z0-9]{6,}$/.test(tokenOnPage.value || ''),
  JSON.stringify(tokenOnPage));

// pakai token yang benar-benar dibuat halaman
const TOKEN = tokenOnPage.value;

const hostState = await evaluate(host.sessionId, `
  const bi = document.getElementById('rosterCount');
  return { rosterBadge: bi ? bi.innerText : null, socketConnected: typeof io !== 'undefined' };
`);
check('socket.io client tersedia', hostState.value?.socketConnected === true, JSON.stringify(hostState));

// Beri nama host & aktifkan kamera host
await evaluate(host.sessionId, `
  const n = document.getElementById('hostNameInput');
  n.value = 'Bu Dosen';
  n.dispatchEvent(new Event('input', {bubbles:true}));
  return n.value;
`);

// ---------- 2. PESERTA 1 ----------
console.log('\n== 2. Peserta 1 join dengan kamera sendiri ==');
const v1 = await newPage(`${BASE}/viewer.html?token=${TOKEN}`);
await wait(2000);

await evaluate(v1.sessionId, `
  const n = document.getElementById('nameInput');
  if (n) { n.value = 'Dandie'; n.dispatchEvent(new Event('input',{bubbles:true})); }
  return n ? n.value : null;
`);

const joinInfo = await evaluate(v1.sessionId, `
  window.handleJoin();
  await new Promise(r => setTimeout(r, 4000));
  const lv = document.getElementById('localVideo');
  const stream = lv ? lv.srcObject : null;
  return {
    hasStream: !!stream,
    videoTracks: stream ? stream.getVideoTracks().length : 0,
    audioTracks: stream ? stream.getAudioTracks().length : 0,
    trackEnabled: stream && stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].enabled : null,
    trackLabel: stream && stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].label : null,
    roomPanelVisible: document.getElementById('roomPanel')?.style.display
  };
`);
console.log('   ', JSON.stringify(joinInfo.value));
check('PESERTA 1 dapat stream kamera sendiri', joinInfo.value?.hasStream === true, JSON.stringify(joinInfo));
check('PESERTA 1 punya 1 video track', joinInfo.value?.videoTracks === 1, JSON.stringify(joinInfo));
check('PESERTA 1 punya 1 audio track', joinInfo.value?.audioTracks === 1, JSON.stringify(joinInfo));
check('kamera peserta aktif (enabled)', joinInfo.value?.trackEnabled === true, JSON.stringify(joinInfo));

// ---------- 3. PESERTA 2 ----------
console.log('\n== 3. Peserta 2 join — harus lihat kamera Peserta 1 ==');
const v2 = await newPage(`${BASE}/viewer.html?token=${TOKEN}`);
await wait(2000);
await evaluate(v2.sessionId, `
  const n = document.getElementById('nameInput');
  if (n) { n.value = 'Rani'; n.dispatchEvent(new Event('input',{bubbles:true})); }
  return n ? n.value : null;
`);

const v2Join = await evaluate(v2.sessionId, `
  window.handleJoin();
  await new Promise(r => setTimeout(r, 9000));
  const tiles = Array.from(document.querySelectorAll('#videoGrid .video-tile'));
  return {
    tileCount: tiles.length,
    tiles: tiles.map(t => {
      const vid = t.querySelector('video');
      const st = vid?.srcObject;
      return {
        name: t.querySelector('.tile-label')?.innerText,
        state: t.dataset.state,
        hasStream: !!st,
        videoTracks: st ? st.getVideoTracks().length : 0,
        live: vid ? (vid.readyState >= 2 && vid.videoWidth > 0) : false,
        width: vid?.videoWidth, height: vid?.videoHeight
      };
    })
  };
`);
console.log('   ', JSON.stringify(v2Join.value, null, 1));

const p2Dandie = v2Join.value?.tiles?.find(t => t.name === 'Dandie');
check('PESERTA 2 melihat kamera Peserta 1 (tile Dandie)',
  !!p2Dandie, JSON.stringify(v2Join.value?.tiles?.map(t => t.name)));

// State sebenarnya dibaca dari PeerConnection hidup (source of truth),
// bukan dari atribut DOM yang bisa tertinggal satu tick.
const p2Real = await evaluate(v2.sessionId, `
  const m = await import('./mesh.js');
  const out = {};
  for (const [pid,p] of m.getPeers().entries()) {
    out[p.name] = { conn: p.pc.connectionState, ice: p.pc.iceConnectionState };
  }
  return out;
`);
console.log('    state nyata:', JSON.stringify(p2Real.value));
const p2Live = Object.entries(p2Real.value || {}).filter(([n,v]) => v.conn === 'connected' || v.ice === 'connected');
check('koneksi P2<->P1 CONNECTED (dari PeerConnection)',
  p2Live.length >= 1, JSON.stringify(p2Real.value));
check('VIDEO PESERTA 1 BENAR-BENAR BERJALAN di P2',
  p2Dandie?.live === true && p2Dandie?.width > 0, JSON.stringify(p2Dandie));

console.log('\n== 4. Peserta 1 harus lihat kamera Peserta 2 (dua arah) ==');
const v1Sees = await evaluate(v1.sessionId, `
  await new Promise(r => setTimeout(r, 3000));
  const tiles = Array.from(document.querySelectorAll('#videoGrid .video-tile'));
  return {
    tileCount: tiles.length,
    names: tiles.map(t => t.querySelector('.tile-label')?.innerText),
    states: tiles.map(t => t.dataset.state),
    live: tiles.map(t => { const v = t.querySelector('video'); return v ? (v.readyState >= 2 && v.videoWidth > 0) : false; }),
    widths: tiles.map(t => t.querySelector('video')?.videoWidth)
  };
`);
console.log('   ', JSON.stringify(v1Sees.value));
const p1Rani = v1Sees.value?.names?.indexOf('Rani');
check('PESERTA 1 melihat kamera Peserta 2',
  p1Rani >= 0, JSON.stringify(v1Sees.value?.names));

const p1Real = await evaluate(v1.sessionId, `
  const m = await import('./mesh.js');
  const out = {};
  for (const [pid,p] of m.getPeers().entries()) {
    out[p.name] = { conn: p.pc.connectionState, ice: p.pc.iceConnectionState };
  }
  return out;
`);
console.log('    state nyata:', JSON.stringify(p1Real.value));
const p1Live = Object.entries(p1Real.value || {}).filter(([n,v]) => v.conn === 'connected' || v.ice === 'connected');
check('koneksi P1<->P2 CONNECTED (dari PeerConnection)',
  p1Live.length >= 1, JSON.stringify(p1Real.value));
check('video Peserta 2 benar-benar render di P1',
  v1Sees.value?.live?.[p1Rani] === true, JSON.stringify(v1Sees.value));

console.log('\n== 5. Host menyalakan kamera -> peserta harus melihat host ==');
await evaluate(host.sessionId, `
  document.getElementById('hostNameInput').value = 'Bu Dosen';
  await window.hostStartMedia();
  await new Promise(r => setTimeout(r, 2000));
  return 'ok';
`);
await wait(6000);
const p1SeesHost = await evaluate(v1.sessionId, `
  const tiles = Array.from(document.querySelectorAll('#videoGrid .video-tile'));
  const t = tiles.find(x => x.querySelector('.tile-label')?.innerText === 'Bu Dosen');
  const v = t?.querySelector('video');
  return {
    found: !!t,
    names: tiles.map(x=>x.querySelector('.tile-label')?.innerText),
    state: t?.dataset.state,
    live: v ? (v.readyState >= 2 && v.videoWidth > 0) : false,
    width: v?.videoWidth
  };
`);
console.log('   ', JSON.stringify(p1SeesHost.value));
check('Peserta 1 melihat tile kamera HOST',
  p1SeesHost.value?.found === true, JSON.stringify(p1SeesHost.value?.names));
check('VIDEO KAMERA HOST render di Peserta 1',
  p1SeesHost.value?.live === true && p1SeesHost.value?.width > 0, JSON.stringify(p1SeesHost.value));

console.log('\n== 6. Host menerima kamera kedua peserta ==');
const hostSees = await evaluate(host.sessionId, `
  await new Promise(r => setTimeout(r, 4000));
  const tiles = Array.from(document.querySelectorAll('#participantGrid .video-tile'));
  const roster = Array.from(document.querySelectorAll('#rosterList .roster-item .roster-name'));
  return {
    tileCount: tiles.length,
    tileNames: tiles.map(t => t.querySelector('.tile-label')?.innerText),
    liveCount: tiles.filter(t => { const v = t.querySelector('video'); return v ? v.readyState>=2 : false; }).length,
    rosterNames: roster.map(r => r.innerText),
    badge: document.getElementById('rosterCount')?.innerText
  };
`);
console.log('   ', JSON.stringify(hostSees.value, null, 1));
check('HOST melihat 2 tile kamera peserta',
  hostSees.value?.tileCount === 2, JSON.stringify(hostSees.value?.tileCount));
check('nama peserta benar di host',
  hostSees.value?.tileNames?.includes('Dandie') && hostSees.value?.tileNames?.includes('Rani'),
  JSON.stringify(hostSees.value?.tileNames));
check('KEDUA kamera render (bukan cuma terhubung)',
  hostSees.value?.liveCount === 2, JSON.stringify(hostSees.value?.liveCount));
check('roster host menampilkan 3 orang (host + 2 peserta)',
  hostSees.value?.rosterNames?.length === 3, JSON.stringify(hostSees.value?.rosterNames));

console.log('\n== 7. Mute mic peserta tersampaikan ke host ==');
const muteTest = await evaluate(v2.sessionId, `
  window.toggleMic();
  await new Promise(r => setTimeout(r, 1500));
  const btn = document.getElementById('micBtn');
  return { btn: btn?.innerText };
`);
await wait(1500);
const hostFlag = await evaluate(host.sessionId, `
  const tiles = Array.from(document.querySelectorAll('#participantGrid .video-tile'));
  const rani = tiles.find(t => t.querySelector('.tile-label')?.innerText === 'Rani');
  return {
    flag: rani ? rani.querySelector('.tile-flag')?.innerText : null,
    flagVisible: rani ? rani.querySelector('.tile-flag')?.style.display : null
  };
`);
console.log('   P2 button:', JSON.stringify(muteTest.value), '| host flag:', JSON.stringify(hostFlag.value));
check('tombol mic peserta berubah jadi OFF',
  /OFF/.test(muteTest.value?.btn || ''), JSON.stringify(muteTest.value));
check('host melihat indikator mic mati di tile Rani',
  /Mic Mati/i.test(hostFlag.value?.flag || '') && hostFlag.value?.flagVisible === 'inline-block',
  JSON.stringify(hostFlag.value));

console.log('\n== 8. Peserta keluar -> tile hilang dari host ==');
await browser.send('Target.closeTarget', { targetId: v2.targetId });
await wait(2500);
const afterLeave = await evaluate(host.sessionId, `
  const tiles = Array.from(document.querySelectorAll('#participantGrid .video-tile'));
  return {
    tileCount: tiles.length,
    names: tiles.map(t => t.querySelector('.tile-label')?.innerText),
    roster: Array.from(document.querySelectorAll('#rosterList .roster-item .roster-name')).map(r=>r.innerText)
  };
`);
console.log('   ', JSON.stringify(afterLeave.value));
check('tile peserta yang keluar dihapus dari host',
  afterLeave.value?.tileCount === 1, JSON.stringify(afterLeave.value?.tileCount));
check('roster host turun ke 2 orang',
  afterLeave.value?.roster?.length === 2, JSON.stringify(afterLeave.value?.roster));

console.log(`\n${'='.repeat(56)}`);
console.log(`E2E HASIL: ${pass} PASS / ${fail} FAIL`);
console.log(`${'='.repeat(56)}`);

browser.close();
chrome.kill('SIGKILL');
process.exit(fail > 0 ? 1 : 0);
