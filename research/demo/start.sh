#!/bin/bash
# Local demo of the templates library: fresh data dir, the example catalog signed with a THROWAWAY
# key (never the real catalog key), server on :3098. Re-running wipes and rebuilds the demo.
set -e
HERE=$(cd "$(dirname "$0")/../.." && pwd)
DEMO="$HERE/research/data/demo"
export PATH="$HOME/.nvm/versions/node/v20.20.1/bin:$PATH"
rm -rf "$DEMO"; mkdir -p "$DEMO"
cd "$HERE"
node scripts/template-catalog.js keygen "$DEMO/demo-key.pem" > /dev/null
openssl pkey -in "$DEMO/demo-key.pem" -pubout -out "$DEMO/demo-pub.pem"
node scripts/template-catalog.js build catalog/templates -o "$DEMO/dist" > /dev/null
node scripts/template-catalog.js sign "$DEMO/dist" --key "$DEMO/demo-key.pem" --source catalog/templates > /dev/null
node scripts/template-catalog.js bundle "$DEMO/dist" -o "$DEMO/offline.zip" > /dev/null
cd server
DATA_DIR="$DEMO/data" SELF_HOSTED=true PORT=3098 TEMPLATE_CATALOG_PUBLIC_KEY="$(cat "$DEMO/demo-pub.pem")" \
  nohup node server.js > "$DEMO/server.log" 2>&1 &
echo $! > "$DEMO/server.pid"
for i in $(seq 1 60); do curl -sf http://127.0.0.1:3098/api/status > /dev/null && break; sleep 1; done
node "$HERE/research/demo/seed.js" "$DEMO"
