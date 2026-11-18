#!/usr/bin/env bash
# Generate self-signed SSL certificate untuk server HTTPS lokal.
# Jalankan sekali sebelum `npm start`.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p ssl

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
SAN="DNS:localhost,IP:127.0.0.1"
[ -n "$LAN_IP" ] && SAN="$SAN,IP:$LAN_IP"

echo "→ Generating ssl/cert.pem + ssl/key.pem (SAN: $SAN)"
openssl req -x509 -newkey rsa:4096 -sha256 -days 825 -nodes \
  -keyout ssl/key.pem -out ssl/cert.pem \
  -subj "/C=ID/ST=DKI Jakarta/L=Jakarta/O=Local Dev/CN=webrtc-nodejs.local" \
  -addext "subjectAltName=$SAN" 2>/dev/null

chmod 600 ssl/key.pem
echo "✓ Selesai. Jalankan: npm start"
