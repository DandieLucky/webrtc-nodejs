// Test isolasi: apakah emit ke socket-id target sampai saat sender belum join room?
import { io } from 'socket.io-client';
const O = { rejectUnauthorized: false, transports: ['websocket'] };
const c1 = io('https://localhost:8080', O);

c1.on('connect', () => {
  console.log('c1 id:', c1.id.slice(0, 6));
  c1.on('offer', p => {
    console.log('✅ c1 MENERIMA offer:', p.senderId ? p.senderId.slice(0,6) : '?', '| msg:', (p.sdp?.sdp || '').slice(0,20));
    process.exit(0);
  });
  c1.emit('join-room', { roomId: 'SELFTEST1', name: 'SelfHost' });

  setTimeout(() => {
    const c2 = io('https://localhost:8080', O);
    c2.on('connect', () => {
      console.log('c2 id:', c2.id.slice(0, 6));
      c2.emit('offer', { target: c1.id, sdp: { type: 'offer', sdp: 'hello' } });
    });
  }, 600);
});
setTimeout(() => { console.log('❌ TIMEOUT — c1 tidak menerima'); process.exit(1); }, 6000);
