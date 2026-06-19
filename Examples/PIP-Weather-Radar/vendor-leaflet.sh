#!/usr/bin/env bash
# Download Leaflet (MIT) into this directory so it can be served same-origin from the
# signage server (the server CSP is script-src 'self', so a CDN won't load).
set -eu
VER=1.9.4
base="https://unpkg.com/leaflet@${VER}/dist"
cd "$(dirname "$0")"
echo "fetching Leaflet ${VER}..."
curl -fsSL "${base}/leaflet.js"  -o leaflet.js
curl -fsSL "${base}/leaflet.css" -o leaflet.css
echo "ok: $(wc -c < leaflet.js) bytes leaflet.js, $(wc -c < leaflet.css) bytes leaflet.css"
echo "next: copy leaflet.js, leaflet.css, radar-overlay.html, radar-overlay.js into your signage server's frontend dir."
