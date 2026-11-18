# 🍏 Web Conference Lokal WebRTC & Socket.IO (macOS White Frosted Glass Edition)

Proyek ini adalah implementasi sistem konferensi web lokal berbasis **Node.js**, **Express**, **Socket.IO**, dan **WebRTC** dengan server **HTTPS** mandiri (*self-signed SSL*) serta desain antarmuka **Clean White Glassmorphism** bergaya **macOS Golden Gate / Sequoia**.

Fitur utama mencakup kemampuan **memutar dan menyiarkan file video lokal dari komputer Broadcaster** ke perangkat penonton (**Viewer** di laptop maupun **HP/Smartphone**) melalui jaringan Wi-Fi lokal secara *real-time*.

---

## 📁 Struktur Direktori Proyek

```text
webrtc-nodejs/
├── ssl/
│   ├── cert.pem          # Sertifikat SSL publik (di-generate, tidak di-commit)
│   └── key.pem           # Kunci privat RSA SSL 4096-bit (di-generate, tidak di-commit)
├── scripts/
│   └── gen-cert.sh       # Generator self-signed certificate (openssl)
├── public/
│   ├── index.html        # Portal utama & panduan pengujian 3 skenario
│   ├── broadcaster.html  # Halaman Broadcaster (Penyedia video, QR Code, token)
│   ├── viewer.html       # Halaman Viewer (Penonton siaran video)
│   ├── main.js           # Engine WebRTC, captureStream, QR Code & Socket.IO
│   ├── mesh.js           # Topologi mesh multi-peer (peer-to-peer antar penonton)
│   └── styles.css        # Desain Clean White Glassmorphism tebal (Apple macOS)
├── test-signaling.mjs    # Test signaling Socket.IO
├── test-e2e.mjs          # Test end-to-end
├── iso-test.mjs          # Test isolasi peer
├── server.js             # Server HTTPS, Socket.IO & API QR Code generator
├── package.json          # Konfigurasi dependensi (express, socket.io, qrcode)
└── README.md             # Panduan lengkap penggunaan
```

---

## 🚀 Cara Menjalankan Server

1. Buka terminal di folder proyek:
   ```bash
   cd webrtc-nodejs
   ```
2. Install dependensi:
   ```bash
   npm install
   ```
3. Generate sertifikat SSL lokal (sekali saja):
   ```bash
   npm run gen-cert
   # atau: bash scripts/gen-cert.sh
   ```
4. Jalankan server:
   ```bash
   npm start
   # atau: node server.js
   ```
5. Server HTTPS akan aktif di:
   - **Lokal (Laptop ini):** `https://localhost:8080`
   - **Jaringan LAN (untuk HP / Perangkat lain):** `https://192.168.0.114:8080`

> Alamat IP LAN di atas contoh. Cek IP asli komputer dengan `ipconfig getifaddr en0`.
> Sertifikat `.pem` **tidak di-commit** karena berisi private key — wajib di-generate ulang
> setelah clone (langkah 3). Sertifikat berisi Subject Alternative Name untuk `localhost`,
> `127.0.0.1`, dan IP LAN saat generate.

---

## 📱 Mengapa Link Sebelumnya Tidak Bisa Dibuka di HP?

Ketika Broadcaster dibuka di komputer menggunakan `https://localhost:8080`, tombol salin sebelumnya menyalin link dengan domain `localhost`. Ketika link tersebut dikirim ke HP, HP mencoba membuka `localhost` di perangkat HP itu sendiri (bukan ke komputer Anda), sehingga koneksi ditolak.

**Solusi yang telah diperbaiki:**
1. **Tombol Khusus HP:** Terdapat tombol hijau **"📱 Salin Link Viewer untuk HP / Device Lain"** yang otomatis menyisipkan alamat IP jaringan Wi-Fi Anda (contoh: `https://192.168.0.114:8080/viewer.html?token=...`).
2. **Scan QR Code:** Terdapat gambar **QR Code** di layar Broadcaster yang dapat langsung di-scan menggunakan kamera HP.

---

## 🛡️ Cara Melewati Peringatan HTTPS Self-Signed di HP

Karena menggunakan sertifikat SSL lokal buatan sendiri, browser HP akan menampilkan peringatan keamanan saat pertama kali membuka link. Ini **sangat normal**:

- **Di iPhone (Safari):**
  Ketuk tulisan **"Tampilkan Rincian" (Show Details)** di bagian bawah ➔ Gulir ke bawah dan ketuk **"kunjungi situs web ini" (visit this website)** ➔ Konfirmasi.
- **Di Android (Google Chrome):**
  Ketuk tombol **"Lanjutan" (Advanced)** ➔ Ketuk tautan **"Lanjutkan ke 192.168.0.114 (tidak aman)"**.

Setelah langkah ini, siaran video dari komputer akan langsung streaming secara *real-time* ke HP Anda!
