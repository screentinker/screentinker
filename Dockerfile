# ScreenTinker server image: serves the dashboard, the web player, and the
# device API. All mutable state (db, uploads, jwt secret) lives under /data so it
# survives container restarts - mount a volume there. A built ScreenTinker.apk
# can be mounted at /data/ScreenTinker.apk to enable OTA APK downloads.
#
# No TLS in the image: it listens on plain HTTP :3001. Front it with a
# TLS-terminating reverse proxy / Cloudflare in production.

# --- builder: install production deps (better-sqlite3 is the only native one left; image
# decoding is pure JS + WASM since sharp was dropped, and sharp is now a devDependency that
# --omit=dev leaves out entirely) ---
FROM node:20-slim AS builder
WORKDIR /app/server
# build toolchain in case a native prebuild is missing for the target arch
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---
FROM node:20-slim
# ffmpeg (ships ffprobe) powers video thumbnails + duration extraction at upload.
# Without it videos still upload and play, but arrive with no thumbnail or duration.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Relocate all state onto the volume (config.js reads DATA_DIR; unset would use
# the in-repo paths, which we do not want in a container).
ENV DATA_DIR=/data
WORKDIR /app/server
# App source (node_modules/test/db/uploads/certs are excluded via .dockerignore),
# then the built deps, the frontend the server serves, and the VERSION file it
# reads as ../VERSION.
COPY server/ /app/server/
COPY --from=builder /app/server/node_modules /app/server/node_modules
COPY frontend/ /app/frontend/
# shared/Transitions is a RUNTIME dependency: server/lib/transition-config.js + transition-bundle.js
# require the shader manifest/params/sources from ../../shared at load time (the server won't boot
# without it). Small, and keeps the .glsl files the single source across server + player + Tizen.
COPY shared/ /app/shared/
COPY VERSION /app/VERSION
# the /openapi.yaml route serves ../docs/openapi.yaml (the spec Redoc on /docs fetches);
# without this it 404s in the image even though it serves fine from a dev checkout.
COPY docs/openapi.yaml /app/docs/openapi.yaml
# database.js requires scripts/migrate-multitenancy at boot
COPY scripts/ /app/scripts/
# The BrightSign bridge and sync modules are served to the player from ../brightsign so the copy
# the player loads can never drift from the one on the player's own storage. That RUNTIME path
# does not exist unless the directory is in the image: without this the routes 404 in a container
# while working perfectly from a dev checkout — and a missing player asset fails silently, because
# the SPA fallback answers 200 with HTML where JavaScript was expected.
COPY brightsign/ /app/brightsign/
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "server.js"]
