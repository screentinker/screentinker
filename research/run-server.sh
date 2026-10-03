#!/bin/bash
# Isolated research server on :3098 with its own data dir.
# ⚠️ server.js ignores HOST and always binds 0.0.0.0, so this is reachable from the LAN while it
# runs — and on a fresh data dir the FIRST account registered becomes platform admin. Register
# your own account immediately after starting it, and stop it when done.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$HOME/.nvm/versions/node/v20.20.1/bin:$PATH"
cd "$HERE/server"
DATA_DIR="$HERE/research/data" SELF_HOSTED=true PORT=3098 exec node server.js
