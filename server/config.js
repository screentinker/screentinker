const path = require('path');

// Data locations. Everything defaults to the in-repo layout, so existing installs
// (including production) are byte-for-byte unchanged when these are unset. Set
// DATA_DIR - or the individual *_PATH / *_DIR vars - to relocate state onto a
// mounted volume (used by the Docker image). UNSET resolves to exactly the legacy
// paths: server/db/remote_display.db, server/uploads/, server/certs/.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const uploadsDir = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
const certsDir = process.env.CERTS_DIR || path.join(DATA_DIR, 'certs');

// #146 billing: optional JSON override for the rate card (else the agreement defaults).
// Must be a non-empty array of {minScreens, rate}; anything malformed falls back to null.
function parseBillingRateTable(raw) {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    if (Array.isArray(t) && t.length && t.every(r => typeof r.minScreens === 'number' && typeof r.rate === 'number')) return t;
  } catch (_) { /* fall through to defaults */ }
  return null;
}

module.exports = {
  port: process.env.PORT || 3001,
  httpsPort: process.env.HTTPS_PORT || 3443,
  dataDir: DATA_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'db', 'remote_display.db'),
  uploadsDir,
  contentDir: path.join(uploadsDir, 'content'),
  screenshotsDir: path.join(uploadsDir, 'screenshots'),
  certsDir,
  frontendDir: path.join(__dirname, '..', 'frontend'),
  // #155/#161: self-update (OTA) master switch. When false, the server offers NO update
  // to ANY device (/api/update/check returns update_available:false), so an MDM/operator
  // owns updates instead of the app self-installing (which prompts a confirm dialog on
  // managed panels). Per-device override lives on devices.ota_enabled; the app additionally
  // stands down on its own when a foreign device owner (MDM) manages it.
  otaEnabled: process.env.OTA_ENABLED !== 'false',
  // App-level heartbeat. Checker runs every heartbeatInterval and marks
  // devices offline if last_heartbeat is older than heartbeatTimeout.
  // Env override for self-hosters on slow/jittery networks (issue #3:
  // reporter found raising HEARTBEAT_TIMEOUT to 60s reduced false offlines).
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 10000,
  heartbeatTimeout:  parseInt(process.env.HEARTBEAT_TIMEOUT)  || 45000,
  // How long the server holds commands/playlist-updates for a device that's
  // offline at emit time (ms). On reconnect within this window, queued events
  // are flushed in order. Past TTL they're dropped. See lib/command-queue.js.
  commandQueueTtlMs: parseInt(process.env.COMMAND_QUEUE_TTL_MS) || 30000,
  // Engine.IO transport-level ping/pong. Raised from Socket.IO defaults
  // (25000/20000) because TV WebKits (LG webOS, older Tizen) miss pongs
  // under decode load - tighter values cause spurious transport drops.
  // #148: faster half-open detection WITHOUT reintroducing that risk — we lower only the
  // PING INTERVAL (probe more often), keeping the deliberately-generous 30s pong TIMEOUT so a
  // decode-loaded TV WebKit still has the full window to answer. Detection = interval +
  // timeout = 45s (was 60s); the client inherits these via the handshake so BOTH ends detect
  // a dead peer ~25% sooner. Do NOT drop pingTimeout below ~30s (see the decode-load note).
  pingInterval: parseInt(process.env.PING_INTERVAL) || 15000,
  pingTimeout:  parseInt(process.env.PING_TIMEOUT)  || 30000,
  // #148 Item 4: TCP SO_KEEPALIVE idle delay — OS-level dead-peer probing independent of the
  // app ping, so a half-open TCP can't persist indefinitely.
  tcpKeepAliveMs: parseInt(process.env.TCP_KEEPALIVE_MS) || 20000,
  maxFileSize: 500 * 1024 * 1024, // 500MB
  thumbnailWidth: 320,
  screenshotQuality: 70,
  // SSL: drop your Cloudflare Origin cert + key in certs/ folder
  // or set env vars SSL_CERT and SSL_KEY to custom paths
  sslCert: process.env.SSL_CERT || path.join(certsDir, 'cert.pem'),
  sslKey: process.env.SSL_KEY || path.join(certsDir, 'key.pem'),
  // Auth
  jwtSecret: process.env.JWT_SECRET || (() => {
    const secretFile = path.join(certsDir, '.jwt_secret');
    const fs = require('fs');
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
    const secret = require('crypto').randomBytes(64).toString('hex');
    try { fs.mkdirSync(path.dirname(secretFile), { recursive: true }); fs.writeFileSync(secretFile, secret); } catch {}
    return secret;
  })(),
  jwtExpiry: '7d',
  // Google OAuth - set these in env or here
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Microsoft OAuth - set these in env or here
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  microsoftTenantId: process.env.MICROSOFT_TENANT_ID || 'common',
  // Stripe (optional - for paid subscriptions)
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // Microsoft Graph email sender (services/email.js). Required for actual
  // delivery; absent values short-circuit to a stdout fallback for local dev.
  graphTenantId: process.env.GRAPH_TENANT_ID || '',
  graphClientId: process.env.GRAPH_CLIENT_ID || '',
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET || '',
  graphSenderEmail: process.env.GRAPH_SENDER_EMAIL || '',
  graphSenderName: process.env.GRAPH_SENDER_NAME || 'ScreenTinker',
  // Dev safety net: comma-separated allow-list of recipient emails. When set,
  // sends to any address NOT in the list are suppressed (logged but not posted
  // to Graph). Intended for local dev that pulls fresh prod DB copies - keeps
  // us from accidentally emailing real prod users. UNSET on prod systemd unit.
  graphDevRestrictTo: process.env.GRAPH_DEV_RESTRICT_TO || '',
  // Email transport selector for services/email.js: "graph" (default, Microsoft
  // Graph) or "smtp" (nodemailer). Lets self-hosters without an Azure/M365 setup
  // use a standard mail server (Postfix, Gmail, Mailgun, SendGrid, corp relay).
  emailTransport: process.env.EMAIL_TRANSPORT || 'graph',
  // SMTP transport (used when EMAIL_TRANSPORT=smtp). SMTP_SECURE=true is implicit
  // TLS on 465; false is STARTTLS on 587. User/password are optional so an
  // unauthenticated localhost relay works; if SMTP_USER is set, SMTP_PASSWORD is
  // required. SMTP_FROM is the envelope/display From ("Name <addr>" or "addr").
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 0,
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPassword: process.env.SMTP_PASSWORD || '',
  smtpFrom: process.env.SMTP_FROM || '',
  // Self-hosted mode: if true, first user gets enterprise plan and no billing
  selfHosted: process.env.SELF_HOSTED === 'true',
  // #116: opt-in UI gate. When true, hides the Subscription nav item + billing view
  // and bounces #/billing to the dashboard. Default off, so existing deployments are
  // unchanged. UI-only — /api/subscription/* stays in place (internal usage reads).
  hideBilling: process.env.HIDE_BILLING === 'true',
  // Disable public registration (OAuth auto-signup is also blocked when set).
  // First-user setup is still allowed so a fresh install can be initialized.
  disableRegistration: ['true', '1'].includes(String(process.env.DISABLE_REGISTRATION || '').toLowerCase()),
  // Redirect / -> /app instead of serving the marketing landing page.
  // For self-hosted internal deployments that don't want the public homepage.
  disableHomepage: ['true', '1'].includes(String(process.env.DISABLE_HOMEPAGE || '').toLowerCase()),
  // Issue #12: auto-create a personal org + Default workspace for self-service
  // signups (public register + OAuth). Defaults TRUE so single-tenant and the
  // hosted self-service flow are unaffected; set AUTO_CREATE_ORG_ON_SIGNUP=false
  // on MSP-style deployments where an admin/operator assigns users to existing
  // orgs after signup instead.
  autoCreateOrgOnSignup: !['false', '0'].includes(String(process.env.AUTO_CREATE_ORG_ON_SIGNUP || '').toLowerCase()),

  // #142 event-loop lag telemetry (services/loop-lag.js). perf_hooks
  // monitorEventLoopDelay is C++-backed, so continuous sampling is cheap. Each
  // window's p99 is persisted to event_loop_lag (bounded: indexed + pruned from
  // day one) and drives the banded load level the reconnect throttle reads.
  lagSampleIntervalMs: parseInt(process.env.LAG_SAMPLE_INTERVAL_MS) || 1000,
  lagResolutionMs: parseInt(process.env.LAG_RESOLUTION_MS) || 20,
  lagTelemetryRetentionDays: parseFloat(process.env.LAG_TELEMETRY_RETENTION_DAYS) || 3,
  lagPruneIntervalMs: parseInt(process.env.LAG_PRUNE_INTERVAL_MS) || 3600000,
  // Banded load levels from the window p99 (ms). Asymmetric by design: a band is
  // entered immediately when its up-threshold is crossed (tighten fast), but
  // released only one step at a time after lagReleaseSamples consecutive samples
  // fall below a deadband (release slow), so small fluctuations don't flap it.
  // Bands ONLY scale how hard an already-flagged device is throttled; a healthy
  // device is never gated by global lag.
  lagElevatedMs: parseInt(process.env.LAG_ELEVATED_MS) || 100,
  lagCriticalMs: parseInt(process.env.LAG_CRITICAL_MS) || 250,
  lagReleaseSamples: parseInt(process.env.LAG_RELEASE_SAMPLES) || 5,

  // #142 load-aware per-device reconnect throttle (lib/reconnect-throttle.js).
  // The verdict of WHO is misbehaving is ALWAYS per-device (keyed on device_id):
  // a device is flagged only when it exceeds reconnectBaseMax genuine reconnects
  // per reconnectWindowMs. Global lag never flags a healthy device — the lag band
  // only MULTIPLIES how hard an already-flagged device is backed off.
  reconnectWindowMs: parseInt(process.env.RECONNECT_WINDOW_MS) || 10000,
  reconnectBaseMax: parseInt(process.env.RECONNECT_BASE_MAX) || 5,
  // Absolute per-device ceiling, independent of band AND of warm-up: no device may
  // exceed this many reconnects/window no matter what the adaptive logic computes,
  // so a slow-ramp attacker can't train its way through.
  reconnectHardCeiling: parseInt(process.env.RECONNECT_HARD_CEILING) || 20,
  // Server-enforced backoff for a flagged device: baseBackoff * 2^(level-1) * band
  // multiplier, capped at maxBackoff. Level escalates while it keeps storming
  // (tighten fast) and decays one step per reconnectReleaseMs of calm (release slow).
  reconnectBaseBackoffMs: parseInt(process.env.RECONNECT_BASE_BACKOFF_MS) || 1000,
  reconnectMaxBackoffMs: parseInt(process.env.RECONNECT_MAX_BACKOFF_MS) || 60000,
  reconnectMaxLevel: parseInt(process.env.RECONNECT_MAX_LEVEL) || 10,
  reconnectReleaseMs: parseInt(process.env.RECONNECT_RELEASE_MS) || 30000,
  // #146 evict idle reconnect-throttle buckets so per-device state can't grow
  // unbounded over churned device_ids (the sweep ota-breaker has but the #142
  // throttle lacked). A device quiet this long has its bucket dropped.
  reconnectIdleResetMs: parseInt(process.env.RECONNECT_IDLE_RESET_MS) || 60 * 60 * 1000,
  // #146 hardening — SUSTAINED flap limiter (lib/flap-limiter.js). The #142 burst
  // throttle trips at reconnectBaseMax/reconnectWindowMs (5/10s) — a device flapping
  // every 3-5s does ~2-3/10s and passes clean, yet each cycle is an expensive
  // register+playlist build+acks and one status_log row. This SEPARATE limiter catches
  // sustained flapping over a long window. Keyed via the identity fallback chain
  // (device_id -> fingerprint -> device_token -> ONE global anon bucket), NEVER IP
  // (SNAT collapses the fleet into one key). In-memory (persists now that Item A ends
  // the restart loop); bounded by an idle sweep + the single anon bucket.
  flapLimiterEnabled: process.env.FLAP_LIMITER_ENABLED !== 'false',              // #146 P1.3 kill switch
  connectRateWindowMs: parseInt(process.env.CONNECT_RATE_WINDOW_MS) || 300000,   // 5 min
  connectRateMax: parseInt(process.env.CONNECT_RATE_MAX) || 20,                  // per identity per window
  connectRateAnonMax: parseInt(process.env.CONNECT_RATE_ANON_MAX) || 60,         // the shared global anon bucket, higher (collective)
  connectRateCooldownMs: parseInt(process.env.CONNECT_RATE_COOLDOWN_MS) || 60000, // refuse window after a trip
  connectRateIdleMs: parseInt(process.env.CONNECT_RATE_IDLE_MS) || 2 * 300000,   // sweep buckets idle this long
  // after this many trips within a window the identity is auto-quarantined — an
  // IN-MEMORY, TIME-LIMITED refusal (NOT a DB block; the devices.blocked column is only
  // ever written by an operator). Self-heals after connectRateQuarantineMs. 0 = off.
  connectRateQuarantineTrips: parseInt(process.env.CONNECT_RATE_QUARANTINE_TRIPS) || 5,
  connectRateQuarantineMs: parseInt(process.env.CONNECT_RATE_QUARANTINE_MS) || 30 * 60 * 1000,
  // Cold start: for this long after process start, lag is high while the whole
  // fleet reconnects at once. Treat leniently — force the 'normal' band and apply
  // only the hard ceiling (no rate-band throttle) so a deploy can't throttle
  // healthy screens. Throttle state is in-memory and resets on restart.
  reconnectWarmupMs: parseInt(process.env.RECONNECT_WARMUP_MS) || 30000,
  // #148 patch2: per-device session-settle debounce window. A device opening duplicate/rapid
  // sockets within this window keeps its LIVE incumbent and the duplicate is soft-refused, so
  // it converges on one connection and stays online (closes the reconnect-throttle warm-up
  // gap). Warm-up-independent. ~2-3s: long enough to swallow a burst, short enough that a
  // genuine move (after the incumbent is gone / the window passes) is accepted within seconds.
  sessionSettleWindowMs: parseInt(process.env.SESSION_SETTLE_WINDOW_MS) || 2500,
  reconnectBandElevatedMult: parseFloat(process.env.RECONNECT_BAND_ELEVATED_MULT) || 2,
  reconnectBandCriticalMult: parseFloat(process.env.RECONNECT_BAND_CRITICAL_MULT) || 4,

  // #142 device_status_log retention. A GLOBAL scheduled sweep (pruneStatusLog in
  // db/database.js, run on startup + the heartbeat interval) deletes rows older
  // than this across ALL devices — covering what the per-device insert-time prune
  // in deviceSocket.js misses: removed/idle devices that never insert again, and
  // the heartbeat.js offline_timeout insert that bypasses logDeviceStatus. Default
  // is LOWER than the old hardcoded 7 days (the reporter's bloat happened under 7d);
  // 2-3 days is plenty for the dashboard's 24h uptime view + diagnostics.
  statusLogRetentionDays: parseFloat(process.env.STATUS_LOG_RETENTION_DAYS) || 3,
  // #146 HARD per-device row-count ceiling on device_status_log, enforced by the
  // global sweep alongside the age delete above. Age-based retention can't bound a
  // write storm (rows are all younger than the window), so a reconnect storm grew
  // the table to 1.1M. This cap keeps only the newest N transitions per device, so
  // the table is bounded by (devices * N) REGARDLESS of churn — and the very first
  // sweep trims the existing backlog (table healthy now, not in retentionDays).
  statusLogMaxRowsPerDevice: parseInt(process.env.STATUS_LOG_MAX_ROWS_PER_DEVICE) || 500,
  // #146 hardening: max rows any single synchronous maintenance DELETE may touch. All
  // table-growth sweeps (status_log, play_logs, provisioning cascade, event_loop_lag,
  // telemetry) delete in batches of this size, yielding to the event loop between
  // batches, so no sweep can block the loop regardless of table size. Keep well under
  // the ~50ms invariant per batch.
  statusLogPruneBatch: parseInt(process.env.STATUS_LOG_PRUNE_BATCH) || 2000,
  // #146 P1.3 kill switch: when false, interval maintenance runs regardless of loop-lag
  // band (disables the band-gate that skips maintenance while loaded). Startup prune is
  // never band-gated regardless.
  maintenanceBandGateEnabled: process.env.MAINTENANCE_BAND_GATE_ENABLED !== 'false',
  // #146 hardening (Item C) — /download/apk GLOBAL guards (NOT per-IP; SNAT collapses
  // the fleet to one IP). Concurrency + rate caps + critical-band shed protect the loop
  // and IO from a download flood; the aggregate counter makes a flood VISIBLE (the old
  // per-IP-per-10min log throttle hid it under SNAT).
  otaDownloadGuardEnabled: process.env.OTA_DOWNLOAD_GUARD_ENABLED !== 'false',  // #146 P1.3 kill switch
  otaDownloadMaxConcurrent: parseInt(process.env.OTA_DOWNLOAD_MAX_CONCURRENT) || 10,
  otaDownloadMaxPerWindow: parseInt(process.env.OTA_DOWNLOAD_MAX_PER_WINDOW) || 120,
  otaDownloadWindowMs: parseInt(process.env.OTA_DOWNLOAD_WINDOW_MS) || 60000,
  otaApkRefreshMs: parseInt(process.env.OTA_APK_REFRESH_MS) || 60000,
  // #146 observability: rolling window for the /api/status.debug throughput counters, so
  // "lastWindow" is comparable across subsystems.
  debugStatsWindowMs: parseInt(process.env.DEBUG_STATS_WINDOW_MS) || 60000,
  // #146: env DEFAULT for the /api/status debug block; a persisted app_settings value
  // (admin toggle) overrides this once set. Default on (matches prior behavior).
  statusDebugEnabled: process.env.STATUS_DEBUG_ENABLED !== 'false',

  // #146 BILLING — usage metering per the ByteTinker–Bold Media distribution agreement.
  // This is the contractual system-of-record; the DEFAULTS BELOW ARE THE AGREEMENT. Change
  // them only if the contract changes. Single GLOBAL rate card for now — per-tenant rate
  // cards are a future concern (would key the table by workspace/org).
  billing: {
    // ASD (Active Screen-Day) denominator = a "standard 8-hour day" → 8*3600 = 28800s.
    hoursPerDay: parseInt(process.env.BILLING_HOURS_PER_DAY) || 8,
    // FLAT (not marginal) tier: the single rate whose minScreens is the greatest ≤ the
    // month's total Billable Screens applies to ALL of them. Ascending by minScreens.
    rateTable: parseBillingRateTable(process.env.BILLING_RATE_TABLE) || [
      { minScreens: 1,    rate: 1.50 },
      { minScreens: 500,  rate: 1.25 },
      { minScreens: 1000, rate: 1.00 },
    ],
    // device_usage_daily is tiny (1 row/device/day) and retained long; pruned (chunked)
    // beyond this so it can never bloat-then-freeze.
    usageRetentionDays: parseInt(process.env.BILLING_USAGE_RETENTION_DAYS) || 400,
    // Accumulator: UPSERT chunk size per transaction (chunked so a huge fleet can't block
    // the loop), and the max seconds credited per accrual tick — a stall/restart guard so a
    // long gap between ticks can't inject a bogus large credit (default 30s = 3× the 10s tick).
    accrualBatch: parseInt(process.env.BILLING_ACCRUAL_BATCH) || 2000,
    accrualCapSeconds: parseInt(process.env.BILLING_ACCRUAL_CAP_SECONDS) || 30,
  },
  // #146 Item E — coalescing log flush + batched event_loop_lag telemetry.
  logCoalesceFlushMs: parseInt(process.env.LOG_COALESCE_FLUSH_MS) || 30000,
  lagFlushMs: parseInt(process.env.LAG_FLUSH_MS) || 10000,
  lagBufferMax: parseInt(process.env.LAG_BUFFER_MAX) || 2000,

  // Off-main-thread WAL checkpointer (db/wal-checkpointer). SQLite's default
  // wal_autocheckpoint (1000 pages) runs a SYNCHRONOUS, fsync-heavy checkpoint inline
  // on whichever write trips it — on slow storage that blocks the event loop ~600-750ms
  // on a regular ~60s beat (the periodic p99 spike). We set wal_autocheckpoint=0 on the
  // MAIN connection and checkpoint from a worker_threads worker instead.
  // Interval: at a typical ~4MB/60s write rate the WAL grows ~1MB between runs — well under
  // the old 4MB inline threshold — so each PASSIVE (and any rare escalation TRUNCATE) is
  // cheap, while PASSIVE still reclaims frames promptly. 15s balances small-WAL vs worker load.
  walCheckpointIntervalMs: parseInt(process.env.WAL_CHECKPOINT_INTERVAL_MS) || 15000,
  // Starvation bound: PASSIVE skips frames held by active readers/writers, so under
  // continuous writes it can perpetually under-checkpoint and the WAL grows unbounded. If the
  // -wal file exceeds this high-water mark, the worker escalates to a (blocking) TRUNCATE.
  walCheckpointHighWaterMB: parseInt(process.env.WAL_CHECKPOINT_HIGH_WATER_MB) || 16,
  // ...or escalate if the WAL grew across this many consecutive PASSIVE runs (PASSIVE not
  // keeping up even below the high-water). Belt-and-suspenders with the MB bound above.
  walCheckpointStarvationRuns: parseInt(process.env.WAL_CHECKPOINT_STARVATION_RUNS) || 3,
  // Worker-death handling: with autocheckpoint=0 a dead worker means nothing checkpoints and
  // the WAL grows until the disk fills. An unexpectedly-dead worker is respawned up to
  // RespawnMax times per RespawnWindowMs (with a small backoff); if that's exhausted we
  // re-arm a conservative inline autocheckpoint of FallbackPages on the main connection
  // (degraded-but-safe: occasional inline stall beats unbounded WAL growth).
  walCheckpointRespawnMax: parseInt(process.env.WAL_CHECKPOINT_RESPAWN_MAX) || 5,
  walCheckpointRespawnWindowMs: parseInt(process.env.WAL_CHECKPOINT_RESPAWN_WINDOW_MS) || 60000,
  walCheckpointRespawnBackoffMs: parseInt(process.env.WAL_CHECKPOINT_RESPAWN_BACKOFF_MS) || 1000,
  walCheckpointFallbackPages: parseInt(process.env.WAL_CHECKPOINT_FALLBACK_PAGES) || 1000,
  // #146 device_status_log write batching (lib/status-log-writer.js). Status
  // transitions are buffered and coalesced to the NET state per device per flush,
  // so a flapping device writes ~1 row/flush instead of a row per transition —
  // breaking the storm -> table-growth -> slow-writes -> more-lag feedback loop.
  statusLogFlushMs: parseInt(process.env.STATUS_LOG_FLUSH_MS) || 1000,

  // #142 content-ack dedup window (deviceSocket.js). A device (esp. older apps)
  // can spam "content <id>: ready" for the same item; suppress identical
  // (device_id, content_id, status) reports within this window. A status CHANGE
  // has a different key and passes immediately. In-memory; resets on restart.
  contentAckDedupMs: parseInt(process.env.CONTENT_ACK_DEDUP_MS) || 10000,

  // #143 content-ack RATE budget (lib/content-ack-limiter.js), layered on top of the
  // dedup above. Caps TOTAL acks per device per window REGARDLESS of differing
  // content_id — the flood the dedup misses (a device cycling 2-4 ids makes every
  // ack look unique, so dedup never fires, yet aggregate volume blocks the loop).
  // TUNING GUESSES — validate against Bold's real fleet. Legit playlist cadence is
  // roughly <=1 ack/s/device; the flood is many/s. 20 per 10s (=2/s) sits above
  // legit and below the flood. Easy to retune via env.
  contentAckMaxPerWindow: parseInt(process.env.CONTENT_ACK_MAX_PER_WINDOW) || 20,
  contentAckRateWindowMs: parseInt(process.env.CONTENT_ACK_RATE_WINDOW_MS) || 10000,

  // Version update indicator — polls GHCR for the latest Docker image tag via
  // anonymous token flow. All optional with safe defaults.
  dockerUpdateEnabled: process.env.DOCKER_UPDATE_ENABLED === 'true',
  ghcrCheckIntervalHours: parseInt(process.env.GHCR_CHECK_INTERVAL_HOURS) || 36,
  composeFilePath: process.env.COMPOSE_FILE_PATH || '/opt/screentinker/docker-compose.yml',

  // #143 fingerprint-reclaim liveness. A reinstalled app (same fingerprint, no
  // device_id, has pairing_code) may reclaim its old device's identity once that
  // device is gone by RUNTIME signals: no live socket AND last heartbeat older than
  // this settle window. Previously an effective 24h calendar grace treated a device
  // merely offline <24h as "active", so a legitimately-gone device (liveConn=false,
  // status=offline, stale heartbeat) could never reclaim and retried every ~2s,
  // flooding logs (Bold beta1). Settle = the max reclaim wait; keep it comfortably
  // above heartbeatTimeout (45s) so a brief blip isn't mistaken for "gone".
  // SECURITY TRADEOFF: this also shortens the anti-(fingerprint-theft) window from
  // 24h — raise it to re-tighten, at the cost of reinstall latency. Tuning guess.
  reclaimSettleSeconds: parseInt(process.env.RECLAIM_SETTLE_SECONDS) || 300,
  // #143 throttle the reclaim-deferred log to once per device per window, so a
  // retrying/stuck device can't flood stdout (same discipline as the content-ack shed log).
  reclaimRejectLogWindowMs: parseInt(process.env.RECLAIM_REJECT_LOG_WINDOW_MS) || 60000,
};
