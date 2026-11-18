// Test signaling mesh: 1 broadcaster + 3 viewer, verifikasi relay terarah
import { io } from 'socket.io-client';

const URL = 'https://localhost:8080';
const OPTS = { rejectUnauthorized: false, transports: ['websocket'] };

const received = { offer: [], answer: [], ice: [], roster: [], mediaState: [], roomStatus: [] };
const log = (...a) => console.log('  ', ...a);

function mkClient(label) {
  const s = io(URL, OPTS);
  s.label = label;
  s.inbox = { offer: [], answer: [], ice: [], roster: [], mediaState: [], roomStatus: [], peerJoined: [], peerLeft: [] };
  s.on('offer', p => s.inbox.offer.push(p));
  s.on('answer', p => s.inbox.answer.push(p));
  s.on('ice-candidate', p => s.inbox.ice.push(p));
  s.on('roster', p => s.inbox.roster.push(p));
  s.on('media-state', p => s.inbox.mediaState.push(p));
  s.on('room-status', p => s.inbox.roomStatus.push(p));
  s.on('peer-joined', p => s.inbox.peerJoined.push(p));
  s.on('peer-left', p => s.inbox.peerLeft.push(p));
  s.on('room-created', p => { s.roomCreated = p; });
  s.on('join-error', p => log(`!! ${label} join-error:`, p));
  return s;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const connect = (s) => new Promise((res, rej) => {
  s.on('connect', () => res(s));
  setTimeout(() => rej(new Error(`${s.label} connect timeout`)), 5000);
});

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${detail}`); fail++; }
}

const ROOM = 'TESTMESH1';

const host = mkClient('HOST');
await connect(host);
host.emit('join-room', { roomId: ROOM, name: 'Bu Dosen' });
await wait(400);

console.log('\n== 1. Broadcaster membuat room ==');
check('host dapat room-created', !!host.roomCreated, JSON.stringify(host.roomCreated));
check('host dapat roster awal (1 orang: dirinya)', host.inbox.roster.at(-1)?.participants.length === 1,
  JSON.stringify(host.inbox.roster.at(-1)));

console.log('\n== 2. Viewer bergabung & dapat daftar peer existing ==');
const v1 = mkClient('V1');
await connect(v1);
v1.emit('join-as-viewer', { roomId: ROOM, name: 'Dandie' });
await wait(400);

const v1Status = v1.inbox.roomStatus.at(-1);
check('V1 dapat room-status found', v1Status?.status === 'found', JSON.stringify(v1Status));
check('V1 dapat daftar peer existing (HOST)', v1Status?.participants?.length === 1,
  JSON.stringify(v1Status?.participants));
check('V1 tahu nama host', v1Status?.participants?.[0]?.name === 'Bu Dosen',
  JSON.stringify(v1Status?.participants?.[0]));
check('HOST dinotifikasi peer-joined', host.inbox.peerJoined.length === 1,
  JSON.stringify(host.inbox.peerJoined));
check('HOST tahu nama V1', host.inbox.peerJoined[0]?.name === 'Dandie',
  JSON.stringify(host.inbox.peerJoined[0]));

console.log('\n== 3. Roster berisi 2 peserta ==');
const hostRoster = host.inbox.roster.at(-1)?.participants || [];
check('roster HOST = 2 orang', hostRoster.length === 2, JSON.stringify(hostRoster.map(p => p.name)));

console.log('\n== 4. Viewer ke-2 & ke-3: daftar peer existing bertambah ==');
const v2 = mkClient('V2');
await connect(v2);
v2.emit('join-as-viewer', { roomId: ROOM, name: 'Rani' });
await wait(400);

const v2Status = v2.inbox.roomStatus.at(-1);
check('V2 dapat 2 peer existing (HOST + V1)', v2Status?.participants?.length === 2,
  JSON.stringify(v2Status?.participants?.map(p => p.name)));
check('nama host ikut dikirim ke V2',
  v2Status?.participants?.some(p => p.name === 'Bu Dosen'),
  JSON.stringify(v2Status?.participants?.map(p => p.name)));

const v3 = mkClient('V3');
await connect(v3);
v3.emit('join-as-viewer', { roomId: ROOM, name: 'Yudha' });
await wait(400);
check('V3 dapat 3 peer existing', v3.inbox.roomStatus.at(-1)?.participants?.length === 3,
  JSON.stringify(v3.inbox.roomStatus.at(-1)?.participants?.map(p => p.name)));

console.log('\n== 5. Relay OFFER terarah (hanya target yang terima) ==');
const hostId = host.id;
const v1Id = v1.id;
host.inbox.offer.length = 0; v2.inbox.offer.length = 0; v3.inbox.offer.length = 0;
v1.emit('offer', { target: hostId, sdp: { type: 'offer', sdp: 'FAKE_SDP_V1' } });
await wait(400);

check('HOST menerima offer dari V1', host.inbox.offer.length === 1, `got ${host.inbox.offer.length}`);
check('V2 TIDAK menerima offer (relay terarah)', v2.inbox.offer.length === 0,
  `V2 got ${v2.inbox.offer.length}`);
check('V3 TIDAK menerima offer (relay terarah)', v3.inbox.offer.length === 0,
  `V3 got ${v3.inbox.offer.length}`);
check('senderId benar terisi', host.inbox.offer[0]?.senderId === v1Id,
  JSON.stringify(host.inbox.offer[0]?.senderId));
check('nama pengirim ikut terkirim', host.inbox.offer[0]?.sender?.name === 'Dandie',
  JSON.stringify(host.inbox.offer[0]?.sender));

console.log('\n== 6. Relay ANSWER terarah ==');
host.inbox.answer.length = 0; v2.inbox.answer.length = 0;
host.emit('answer', { target: v1Id, sdp: { type: 'answer', sdp: 'FAKE_ANSWER_HOST' } });
await wait(400);
check('V1 menerima answer dari HOST', v1.inbox.answer.length === 1, `got ${v1.inbox.answer.length}`);
check('V2 tidak menerima answer', v2.inbox.answer.length === 0, `V2 got ${v2.inbox.answer.length}`);

console.log('\n== 7. Relay ICE terarah ==');
v1.inbox.ice.length = 0; v2.inbox.ice.length = 0;
host.emit('ice-candidate', { target: v1Id, candidate: { candidate: 'candidate:fake 1 udp 1 192.168.1.1 5000 typ host' } });
await wait(400);
check('V1 menerima ICE', v1.inbox.ice.length === 1, `got ${v1.inbox.ice.length}`);
check('V2 tidak menerima ICE (dulu bocor ke semua room)', v2.inbox.ice.length === 0,
  `V2 got ${v2.inbox.ice.length}`);

console.log('\n== 8. Peer-to-peer antar viewer (bukan cuma lewat host) ==');
v1.inbox.offer.length = 0; host.inbox.offer.length = 0;
v2.emit('offer', { target: v1Id, sdp: { type: 'offer', sdp: 'V2_TO_V1' } });
await wait(400);
check('V1 menerima offer langsung dari V2', v1.inbox.offer.length === 1, `got ${v1.inbox.offer.length}`);
check('HOST tidak ikut menerima (V2->V1 bukan lewat host)', host.inbox.offer.length === 0,
  `HOST got ${host.inbox.offer.length}`);

console.log('\n== 9. media-state broadcast ke room ==');
v1.inbox.mediaState.length = 0; v2.inbox.mediaState.length = 0; host.inbox.mediaState.length = 0;
v3.emit('media-state', { audioEnabled: false, videoEnabled: true });
await wait(400);
check('V1 menerima media-state V3', v1.inbox.mediaState.some(m => m.peerId === v3.id),
  JSON.stringify(v1.inbox.mediaState));
check('status mic mati tersampaikan',
  v1.inbox.mediaState.find(m => m.peerId === v3.id)?.audioEnabled === false,
  JSON.stringify(v1.inbox.mediaState));
check('host menerima media-state juga', host.inbox.mediaState.some(m => m.peerId === v3.id),
  JSON.stringify(host.inbox.mediaState));

console.log('\n== 10. Disconnect viewer -> peer-left + roster update ==');
v2.inbox.peerLeft.length = 0;
v3.disconnect();
await wait(600);
check('V1 dapat peer-left saat V3 keluar',
  v1.inbox.peerLeft.some(p => p.peerId === v3.id) || v1.inbox.peerLeft.length > 0,
  JSON.stringify(v1.inbox.peerLeft));
const rosterAfter = host.inbox.roster.at(-1)?.participants || [];
check('roster turun jadi 3 (host + V1 + V2)', rosterAfter.length === 3,
  JSON.stringify(rosterAfter.map(p => p.name)));

console.log('\n== 11. Viewer ke room yang tidak ada ==');
const v4 = mkClient('V4');
await connect(v4);
v4.emit('join-as-viewer', { roomId: 'GAKADA123', name: 'Test' });
await wait(400);
check('dapat waiting-broadcaster', v4.inbox.roomStatus.at(-1)?.status === 'waiting-broadcaster',
  JSON.stringify(v4.inbox.roomStatus.at(-1)));

console.log('\n== 12. Disconnect host -> room dihapus ==');
host.disconnect();
await wait(600);
v4.inbox.roster.length = 0;
const v5 = mkClient('V5');
await connect(v5);
v5.emit('join-as-viewer', { roomId: ROOM, name: 'SetelahHostKeluar' });
await wait(400);
check('room tidak ada lagi setelah host keluar',
  v5.inbox.roomStatus.at(-1)?.status === 'waiting-broadcaster',
  JSON.stringify(v5.inbox.roomStatus.at(-1)?.status));

console.log(`\n${'='.repeat(52)}`);
console.log(`HASIL: ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(52));

[v1, v2, v4, v5].forEach(s => { try { s.disconnect(); } catch (e) {} });
process.exit(fail > 0 ? 1 : 0);
