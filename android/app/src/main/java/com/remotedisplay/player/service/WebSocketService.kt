package com.remotedisplay.player.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import kotlin.random.Random
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.remotedisplay.player.MainActivity
import com.remotedisplay.player.RemoteDisplayApp
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.telemetry.DeviceInfo
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.net.URI

class WebSocketService : Service() {

    private var socket: Socket? = null
    // #148 root-cause guard: the single-socket invariant. currentUrl + socketActive track the
    // ONE socket so connect() is idempotent across every entry point (boot, service start,
    // activity bind, foreground re-bind) — a re-bind can never open a duplicate. See
    // ConnectionGuard. socketActive == "connected OR Socket.IO is auto-reconnecting it".
    @Volatile private var socketActive = false
    @Volatile private var currentUrl: String? = null
    private var reopenRunnable: Runnable? = null
    private var reconnectWatchdog: Runnable? = null
    private lateinit var config: ServerConfig
    private lateinit var deviceInfo: DeviceInfo
    private val handler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private val binder = LocalBinder()

    // v4 liveness watchdog state (see LivenessWatchdog for the pure decision logic).
    // lastServerMessageAt: ANY inbound server message refreshes it (markAlive, wired into safeOn) —
    // uses the monotonic elapsedRealtime clock so an NTP/wall-clock jump can't false-fire or blind
    // the watchdog. livenessConfirmed: ARMED only after a device:heartbeat-ack (degrade-safe — an
    // ack-less/old server never arms us, so no false-fire storm). currentThresholdMs: per-connection
    // jittered 45s ± up to 10s. watchdogAttempt/lastWatchdogAttemptAt: exponential-backoff gate.
    @Volatile private var lastServerMessageAt = 0L
    @Volatile private var livenessConfirmed = false
    @Volatile private var currentThresholdMs = LivenessWatchdog.THRESHOLD_BASE_MS
    private var watchdogAttempt = 0
    private var lastWatchdogAttemptAt = 0L

    private fun markAlive() { lastServerMessageAt = SystemClock.elapsedRealtime() }

    // feat/offline-cause-log: device-diagnostics / incident-log. All ADDITIVE and fully guarded — a
    // panel whose ROM lacks any of these APIs must degrade to silence, never crash.
    //  - disconnectedAtMs: elapsedRealtime of the FIRST socket 'disconnect' of the current offline
    //    gap (0 = currently connected / no in-process gap). On 'connect' after a gap we emit a
    //    device:connectivity-report so the server can tell "app survived the gap" (network/router)
    //    from a reboot (the app can't report its own reboot — cold_start best-effort covers that).
    //  - linkLostDuringGap: set by the default-network callback's onLost — "the physical link went
    //    away at some point during the gap" (Wi-Fi/Ethernet down) vs "link up but server unreachable".
    //  - lastIpSnapshot: last observed local IPv4, to compute ip_changed (DHCP/router change).
    //  - sawFirstConnect: gates the one-shot cold-start report to the process's very first connect.
    @Volatile private var disconnectedAtMs = 0L
    @Volatile private var linkLostDuringGap = false
    private var lastIpSnapshot: String? = null
    @Volatile private var sawFirstConnect = false
    // A connectivity-report needs device auth on the (re)connected socket, so it is ARMED at
    // 'connect' but FLUSHED from device:registered (once the server knows who we are).
    @Volatile private var pendingReport = false
    private var pendingOfflineMs = 0L
    private var pendingLinkLost = false
    private var pendingColdStart = false
    // Registered-once diagnostics plumbing; unregistered in onDestroy. Nullable so a register
    // failure (locked-down ROM) just leaves the feature dark.
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private var screenReceiver: BroadcastReceiver? = null

    companion object {
        // feat/offline-cause-log: if the process's FIRST connect happens within this long of boot
        // (elapsedRealtime, which is wall-time since boot), treat it as a cold start (power/reboot)
        // rather than a network gap. Generous so a slow panel's boot→launch→network still counts.
        private const val COLD_START_WINDOW_MS = 120_000L
        // #148: backoff before re-opening the single socket after a disconnect that Socket.IO
        // does NOT auto-reconnect (io server/client disconnect) — never a blind immediate re-open.
        private const val RECONNECT_AFTER_EVICT_MS = 3000L
        // Reconnect backstop: tick period + how long a disconnect/silence must persist before we FORCE
        // a fresh socket. Long enough to let Socket.IO reconnect on its own first; short enough that a
        // wedged manager (network change, stuck reconnect) can't strand a panel offline for good.
        private const val RECONNECT_WATCHDOG_TICK_MS = 20_000L
        private const val RECONNECT_WATCHDOG_STALL_MS = 45_000L
        // Fix 2: re-pair re-register backoff bounds (see handleServerRejection / scheduleRepairRegister).
        private const val REPAIR_BACKOFF_MIN_MS = 3000L
        private const val REPAIR_BACKOFF_MAX_MS = 60_000L
    }

    // Callbacks
    var onPaired: ((String, String) -> Unit)? = null
    var onUnpaired: (() -> Unit)? = null
    var onRegistered: ((String) -> Unit)? = null
    var onPlaylistUpdate: ((JSONObject) -> Unit)? = null
    var onContentDelete: ((String) -> Unit)? = null
    var onScreenshotRequest: (() -> Unit)? = null
    var onRemoteStart: (() -> Unit)? = null
    var onRemoteStop: (() -> Unit)? = null
    var onRemoteTouch: ((Float, Float, String) -> Unit)? = null
    var onRemoteKey: ((String) -> Unit)? = null
    var onCommand: ((String, JSONObject?) -> Unit)? = null
    var onWallSync: ((JSONObject) -> Unit)? = null
    var onWallSyncRequest: ((JSONObject) -> Unit)? = null
    var onGroupSync: ((JSONObject) -> Unit)? = null            // legacy leader-relay (unused by clock/schedule)
    var onGroupSyncRequest: ((JSONObject) -> Unit)? = null     // legacy leader-relay (unused by clock/schedule)
    var onGroupResync: (() -> Unit)? = null                    // #group-sync: server-nudged immediate re-align
    var onPipShow: ((JSONObject) -> Unit)? = null
    var onPipClear: ((JSONObject) -> Unit)? = null
    var onMuteChanged: ((JSONObject) -> Unit)? = null

    inner class LocalBinder : Binder() {
        fun getService(): WebSocketService = this@WebSocketService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    private var wakeLock: android.os.PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        config = ServerConfig(this)
        deviceInfo = DeviceInfo(this)
        // #5: claim ONLY the mediaPlayback FGS type. The 2-arg startForeground
        // claims every manifest-declared type, and on Android 14+ claiming
        // mediaProjection without a consent token throws and kills the service at
        // boot (the "app won't run on newer Android" symptom). Screen capture has
        // its own mediaProjection-typed service (MediaProjectionService).
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            startForeground(1, createNotification(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(1, createNotification())
        }

        // Keep CPU alive so the WebSocket connection stays alive in background
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "RemoteDisplay:WebSocket")
        wakeLock?.acquire()

        startReconnectWatchdog()

        // feat/offline-cause-log: best-effort diagnostics plumbing (both guarded, both cleaned up in
        // onDestroy). Failure to register either just leaves that signal dark — never fatal.
        registerNetworkCallback()
        registerScreenReceiver()
    }

    /**
     * feat/offline-cause-log: watch the DEFAULT network so a connectivity-report can distinguish a
     * lost physical link (Wi‑Fi/Ethernet down) from "link up but the server is unreachable". onLost
     * of the default network during an offline gap flips linkLostDuringGap; it is reset after the
     * next report. registerDefaultNetworkCallback is API 24 (== minSdk), so no version gate needed,
     * but everything is still wrapped so a locked-down ROM can't crash the service.
     */
    private fun registerNetworkCallback() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onLost(network: Network) {
                    // Only meaningful mid-gap; if we're still connected this is a transient handoff.
                    if (disconnectedAtMs != 0L) linkLostDuringGap = true
                }
            }
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (e: Throwable) { Log.w("WebSocketService", "registerNetworkCallback: ${e.message}") }
    }

    /**
     * feat/offline-cause-log: ACTION_SCREEN_ON/OFF can ONLY be delivered to a context-registered
     * receiver (the framework refuses them from the manifest), so we register here and drop a
     * device:event display_on/display_off — "the screen went black" as an incident, not an outage.
     */
    private fun registerScreenReceiver() {
        try {
            val r = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    when (intent?.action) {
                        Intent.ACTION_SCREEN_OFF -> emitEvent("display_off", detail = "Screen off / sleep")
                        Intent.ACTION_SCREEN_ON -> emitEvent("display_on", detail = "Screen on")
                    }
                }
            }
            val filter = IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_SCREEN_OFF)
            }
            // Protected system broadcasts (SCREEN_ON/OFF) are exempt from the API 34 export-flag
            // rule, but pass RECEIVER_NOT_EXPORTED explicitly so no OEM ROM can reject the register.
            ContextCompat.registerReceiver(this, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            screenReceiver = r
        } catch (e: Throwable) { Log.w("WebSocketService", "registerScreenReceiver: ${e.message}") }
    }

    /**
     * App-level reconnect backstop. Runs continuously (independent of the heartbeat, which STOPS on
     * disconnect — so the #146 half-open watchdog can't cover a disconnected socket). If we've been
     * disconnected + silent past the stall threshold, Socket.IO's own reconnect has likely wedged, so
     * reset the guard and force ONE fresh socket. Idempotent while connected (does nothing).
     */
    private fun startReconnectWatchdog() {
        reconnectWatchdog?.let { handler.removeCallbacks(it) }
        reconnectWatchdog = object : Runnable {
            override fun run() {
                try {
                    val connected = socket?.connected() == true
                    val silenceMs = SystemClock.elapsedRealtime() - lastServerMessageAt
                    if (!connected && silenceMs > RECONNECT_WATCHDOG_STALL_MS && config.serverUrl.isNotEmpty()) {
                        Log.w("WebSocketService", "reconnect backstop: disconnected+silent ${silenceMs}ms — forcing a fresh socket")
                        socketActive = false        // let ConnectionGuard permit a new socket over the wedged one
                        connect()
                    }
                } catch (e: Throwable) { Log.w("WebSocketService", "reconnect backstop: ${e.message}") }
                handler.postDelayed(this, RECONNECT_WATCHDOG_TICK_MS)
            }
        }
        handler.postDelayed(reconnectWatchdog!!, RECONNECT_WATCHDOG_TICK_MS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // #148 single owner: the SERVICE owns the one connection. Idempotent (ConnectionGuard),
        // so a START_STICKY restart / re-delivery / boot start reuses a live socket and never
        // opens a duplicate. No-op until a server url is configured (provisioning).
        connect()
        return START_STICKY
    }

    // Wrap every Socket.IO listener body in try/catch. A malformed payload from the server
    // (or a transient state error during disconnect) used to surface as an unhandled
    // exception on the Socket.IO IO thread and crash the whole app.
    private fun Socket.safeOn(event: String, handler: (Array<Any?>) -> Unit): Socket {
        on(event) { args ->
            // v4: ANY inbound server message refreshes liveness (not just acks). The half-open
            // decision additionally requires socket.connected(), so refreshing on a disconnect
            // event is harmless. This is the single central receive-path hook.
            markAlive()
            try {
                @Suppress("UNCHECKED_CAST")
                handler(args as Array<Any?>)
            } catch (e: Throwable) {
                Log.e("WebSocketService", "Listener for '$event' failed: ${e.message}", e)
            }
        }
        return this
    }

    /**
     * Idempotent connect — the #148 root-cause guard. Safe to call from EVERY entry point
     * (service start, activity bind, foreground transition, reconnect). If we already hold a
     * live or self-healing socket to the same url, REUSE it; only ever open ONE socket per
     * device. @Synchronized so racing entry points can't open two.
     */
    @Synchronized
    fun connect(serverUrl: String? = null) {
        val url = serverUrl ?: config.serverUrl
        if (url.isEmpty()) {
            consecutiveFailures++
            Log.e("WebSocketService", "No server URL configured (${consecutiveFailures} consecutive)")
            return
        }
        if (!ConnectionGuard.shouldOpenNewSocket(socket != null, currentUrl == url, socketActive)) {
            Log.i("WebSocketService", "connect(): reusing existing socket to $url — no duplicate (#148)")
            return
        }
        openSocket(url)
    }

    @Synchronized
    private fun openSocket(url: String) {
        disconnect()
        currentUrl = url
        socketActive = true

        // v4 watchdog: a fresh socket is assumed alive; DIS-arm until it earns an ack again
        // (degrade-safe), and pick a new jittered threshold for this connection so a fleet doesn't
        // declare half-open in lockstep. watchdogAttempt is intentionally NOT reset here — it
        // tracks repeated reconnect failures across sockets and resets on a healthy ack.
        lastServerMessageAt = SystemClock.elapsedRealtime()
        livenessConfirmed = false
        currentThresholdMs = LivenessWatchdog.thresholdMs(Random.nextDouble())

        try {
            val options = IO.Options().apply {
                forceNew = true
                reconnection = true
                reconnectionAttempts = Integer.MAX_VALUE
                // Exponential backoff: starts at 1s, doubles each attempt, capped at 60s,
                // ±50% jitter so a fleet doesn't reconnect in lockstep after a server blip.
                reconnectionDelay = 1000
                reconnectionDelayMax = 60_000
                randomizationFactor = 0.5
                timeout = 20000
            }

            socket = IO.socket(URI.create("$url/device"), options).apply {
                safeOn(Socket.EVENT_CONNECT) {
                    Log.i("WebSocketService", "Connected to server")
                    consecutiveFailures = 0
                    armConnectivityReport()   // feat/offline-cause-log: capture the gap, flush post-auth
                    register()
                }

                safeOn(Socket.EVENT_DISCONNECT) { args ->
                    val reason = args.firstOrNull()?.toString() ?: "unknown"
                    Log.w("WebSocketService", "Disconnected from server: $reason")
                    // feat/offline-cause-log: mark the START of an in-process offline gap. Keep the
                    // EARLIEST timestamp if several disconnects fire before we reconnect, so offline_ms
                    // spans the whole gap. elapsedRealtime = monotonic (immune to wall-clock jumps).
                    if (disconnectedAtMs == 0L) disconnectedAtMs = SystemClock.elapsedRealtime()
                    // Stop heartbeat while disconnected; player keeps showing cached content.
                    stopHeartbeat()
                    // #148 reconnect discipline: Socket.IO auto-reconnects the SAME socket on a
                    // transport drop (reconnection=true) — leave socketActive true so connect()
                    // keeps reusing it. But on a server- or client-initiated disconnect it does
                    // NOT auto-reconnect, so mark the socket inert and bring up exactly ONE new
                    // connection after a backoff — never a blind re-open that gets evicted again.
                    if (reason == "io server disconnect" || reason == "io client disconnect") {
                        socketActive = false
                        scheduleReopen(RECONNECT_AFTER_EVICT_MS)
                    }
                }

                safeOn(Socket.EVENT_CONNECT_ERROR) { args ->
                    consecutiveFailures++
                    Log.e("WebSocketService", "Connection error (${consecutiveFailures} consecutive): ${args.firstOrNull()}")
                }

                safeOn("device:registered") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    val newDeviceId = data.optString("device_id", "")
                    if (newDeviceId.isEmpty()) {
                        Log.w("WebSocketService", "device:registered missing device_id")
                        return@safeOn
                    }
                    config.deviceId = newDeviceId
                    // Persist device_token (issued on first register, or refreshed on reconnect)
                    if (data.has("device_token")) {
                        config.deviceToken = data.optString("device_token", "")
                    }
                    Log.i("WebSocketService", "Registered as: $newDeviceId")
                    pairingCodeLive = true // server accepted this registration — any shown code is now pairable
                    if (config.isPaired) {
                        resetRepairBackoff() // normal authenticated reconnect — fully exit repair mode
                    } else if (awaitingRepair) {
                        // Re-pair code ISSUED (settle window cleared): stop retrying and keep the code on
                        // screen until an admin claims it (device:paired) — don't re-register on reconnect.
                        repairRetryPending = false; repairBackoffMs = 0L; repairHoldUntilMs = 0L
                    }
                    handler.post { try { onRegistered?.invoke(newDeviceId) } catch (e: Throwable) { Log.e("WebSocketService", "onRegistered cb: ${e.message}") } }
                    startHeartbeat()
                    // feat/offline-cause-log: now authenticated on this socket — safe to flush the
                    // connectivity-report armed at 'connect' (requireDeviceAuth gates it server-side).
                    flushConnectivityReport()
                }

                // v4 degrade-safe ARM: the watchdog arms ONLY after the first heartbeat-ack, so a
                // server that never acks (old/pre-contract) never arms us -> no false-fire storm.
                // markAlive already fired via safeOn (any inbound); a healthy ack also resets the
                // reconnect backoff. Known ack-gap (reconnecting-not-yet-re-registered) is benign:
                // arm-after-ack + any-inbound-refresh keep the watchdog from firing in that window.
                safeOn("device:heartbeat-ack") { args ->
                    if (!livenessConfirmed) Log.i("WebSocketService", "v4 watchdog: ARMED (first heartbeat-ack)")
                    livenessConfirmed = true
                    watchdogAttempt = 0
                    (args.firstOrNull() as? JSONObject)?.let { ingestClockSample(it.optLong("server_ms", 0L), it.optLong("client_ms", 0L)) }
                }

                safeOn("device:unpaired") { handleServerRejection("device:unpaired (removed on server)") }

                safeOn("device:auth-error") { args ->
                    val msg = (args.firstOrNull() as? JSONObject)?.optString("error", "Authentication failed") ?: "Authentication failed"
                    handleServerRejection("auth-error: $msg")
                }

                safeOn("device:paired") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    val id = data.optString("device_id", "")
                    val name = data.optString("name", "Display")
                    config.setPaired(true)
                    pairingCodeLive = false
                    resetRepairBackoff() // re-pair complete — exit the re-pair/hold state
                    // Pairing code consumed — drop it so a future re-pair mints a fresh one.
                    getSharedPreferences("remote_display", MODE_PRIVATE).edit().remove("pairing_code").apply()
                    config.deviceName = name
                    // Server-provisioned settings PIN — unique per device, stored encrypted.
                    // If the server doesn't send one (old server), ServerConfig generates a
                    // random PIN on first access so the gate is never left with a hardcoded default.
                    val pin = data.optString("settings_pin", "")
                    if (pin.isNotEmpty()) {
                        config.settingsPin = pin
                    }
                    Log.i("WebSocketService", "Paired as: $name")
                    handler.post { try { onPaired?.invoke(id, name) } catch (e: Throwable) { Log.e("WebSocketService", "onPaired cb: ${e.message}") } }
                }

                safeOn("device:playlist-update") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: run {
                        Log.w("WebSocketService", "playlist-update with non-JSONObject payload: ${args.firstOrNull()}")
                        return@safeOn
                    }
                    Log.i("WebSocketService", "Playlist update received, assignments=${data.optJSONArray("assignments")?.length() ?: "null"}")
                    handler.post { try { onPlaylistUpdate?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onPlaylistUpdate cb: ${e.message}") } }
                }

                safeOn("device:content-delete") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    val contentId = data.optString("content_id", "")
                    if (contentId.isNotEmpty()) {
                        handler.post { try { onContentDelete?.invoke(contentId) } catch (e: Throwable) { Log.e("WebSocketService", "onContentDelete cb: ${e.message}") } }
                    }
                }

                safeOn("device:screenshot-request") {
                    captureAndSendScreenshot()
                    handler.post { try { onScreenshotRequest?.invoke() } catch (e: Throwable) { Log.e("WebSocketService", "onScreenshotRequest cb: ${e.message}") } }
                }

                safeOn("device:remote-start") {
                    startScreenshotStream()
                    handler.post { try { onRemoteStart?.invoke() } catch (e: Throwable) { Log.e("WebSocketService", "onRemoteStart cb: ${e.message}") } }
                }

                safeOn("device:remote-stop") {
                    stopScreenshotStream()
                    handler.post { try { onRemoteStop?.invoke() } catch (e: Throwable) { Log.e("WebSocketService", "onRemoteStop cb: ${e.message}") } }
                }

                safeOn("device:remote-touch") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    val x = data.optDouble("x", 0.0).toFloat()
                    val y = data.optDouble("y", 0.0).toFloat()
                    val action = data.optString("action", "tap")
                    val svc = PowerAccessibilityService.instance
                    when {
                        // #159: drag = a swipe gesture (scroll). Dashboard sends normalized end point + duration.
                        svc != null && action == "swipe" -> {
                            val x2 = data.optDouble("x2", x.toDouble()).toFloat()
                            val y2 = data.optDouble("y2", y.toDouble()).toFloat()
                            val dur = data.optLong("duration", 300L).coerceIn(50L, 3000L)
                            handler.post { try { svc.injectSwipe(x, y, x2, y2, dur) } catch (e: Throwable) { Log.e("WebSocketService", "injectSwipe: ${e.message}") } }
                        }
                        svc != null && action == "tap" -> {
                            handler.post { try { svc.injectTap(x, y) } catch (e: Throwable) { Log.e("WebSocketService", "injectTap: ${e.message}") } }
                        }
                        else -> {
                            handler.post { try { onRemoteTouch?.invoke(x, y, action) } catch (e: Throwable) { Log.e("WebSocketService", "onRemoteTouch cb: ${e.message}") } }
                        }
                    }
                }

                safeOn("device:remote-key") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    val keycode = data.optString("keycode", "")
                    if (keycode.isEmpty()) return@safeOn
                    injectKey(keycode)
                    handler.post { try { onRemoteKey?.invoke(keycode) } catch (e: Throwable) { Log.e("WebSocketService", "onRemoteKey cb: ${e.message}") } }
                }

                // Video wall. Post to the main thread: the handlers drive ExoPlayer
                // (seek/speed/position), which is main-thread-only.
                safeOn("wall:sync") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    handler.post { try { onWallSync?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onWallSync cb: ${e.message}") } }
                }

                safeOn("wall:sync-request") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    handler.post { try { onWallSyncRequest?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onWallSyncRequest cb: ${e.message}") } }
                }

                safeOn("group:sync") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    handler.post { try { onGroupSync?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onGroupSync cb: ${e.message}") } }
                }

                safeOn("group:sync-request") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    handler.post { try { onGroupSyncRequest?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onGroupSyncRequest cb: ${e.message}") } }
                }

                // #group-sync: server-nudged immediate re-align (dashboard "Resync now").
                safeOn("group:resync") {
                    handler.post { try { onGroupResync?.invoke() } catch (e: Throwable) { Log.e("WebSocketService", "onGroupResync cb: ${e.message}") } }
                }

                // #109: PiP overlay. Post to the main thread — the handlers build Views.
                safeOn("device:pip-show") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    handler.post { try { onPipShow?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onPipShow cb: ${e.message}") } }
                }
                safeOn("device:pip-clear") { args ->
                    val data = (args.firstOrNull() as? JSONObject) ?: JSONObject()
                    handler.post { try { onPipClear?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onPipClear cb: ${e.message}") } }
                }

                // #129: real-time mute toggle. Post to the main thread — it touches the player.
                safeOn("device:mute-changed") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    handler.post { try { onMuteChanged?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onMuteChanged cb: ${e.message}") } }
                }

                safeOn("device:command") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    val type = data.optString("type", "")
                    if (type.isEmpty()) return@safeOn
                    val payload = data.optJSONObject("payload")
                    Log.i("WebSocketService", "Command received: $type")

                    when (type) {
                        "launch" -> {
                            handler.post {
                                try {
                                    val intent = Intent(this@WebSocketService, MainActivity::class.java).apply {
                                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                                    }
                                    startActivity(intent)
                                    Log.i("WebSocketService", "Launched MainActivity from service")
                                } catch (e: Throwable) { Log.e("WebSocketService", "launch cmd: ${e.message}") }
                            }
                        }
                        "settings" -> {
                            handler.post {
                                try {
                                    val intent = Intent(android.provider.Settings.ACTION_SETTINGS).apply {
                                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    }
                                    startActivity(intent)
                                } catch (e: Throwable) { Log.e("WebSocketService", "settings cmd: ${e.message}") }
                            }
                        }
                        "enable_system_capture" -> {
                            handler.post {
                                try {
                                    com.remotedisplay.player.ScreenCapturePermissionActivity.requestPermission(this@WebSocketService)
                                } catch (e: Throwable) { Log.e("WebSocketService", "enable_system_capture: ${e.message}") }
                            }
                        }
                        // #161: real lock on owner/admin (FORCE_LOCK), else accessibility lock. The
                        // `input keyevent 26` exec (denied for an unprivileged UID) is retired.
                        "screen_off" -> handler.post {
                            try {
                                if (!com.remotedisplay.player.admin.STPolicy(this@WebSocketService).lockNow()) {
                                    PowerAccessibilityService.instance?.lockScreen()
                                        ?: Log.w("WebSocketService", "screen_off: no owner/admin/accessibility — unsupported")
                                }
                            } catch (e: Throwable) { Log.e("WebSocketService", "screen_off: ${e.message}") }
                        }
                        // No privileged wake on a non-rooted panel (keyevent 224 was denied); retired.
                        "screen_on" -> Log.w("WebSocketService", "screen_on: no privileged wake path — no-op")
                        "set_debug" -> {
                            val on = payload?.optBoolean("enabled", false) ?: false
                            // Point the sink at this socket, then flip the flag. When on,
                            // DebugLog.* mirrors player/zone lines to the dashboard.
                            com.remotedisplay.player.util.DebugLog.sink = { tag, level, msg ->
                                try {
                                    socket?.emit("device:log", JSONObject().apply {
                                        put("tag", tag); put("level", level); put("message", msg)
                                    })
                                } catch (_: Throwable) {}
                            }
                            com.remotedisplay.player.util.DebugLog.enabled = on
                            Log.i("WebSocketService", "Remote debug logging ${if (on) "ENABLED" else "disabled"}")
                            com.remotedisplay.player.util.DebugLog.i("Debug", "Remote debug logging ${if (on) "ON" else "OFF"}")
                        }
                        // #161 device-owner tooling: a remote shell. NOTE it runs as the APP's UID (not
                        // root/shell) — device owner does not grant a privileged shell — so it's for
                        // diagnostics (getprop, ls, dumpsys reads, am/pm where allowed). Output streamed
                        // back to the dashboard. Gated server-side (admin/full scope in ALLOWED_COMMANDS).
                        "shell" -> {
                            val cmd = payload?.optString("cmd", "") ?: ""
                            if (cmd.isNotBlank()) Thread {
                                var out = ""; var exit = -1
                                try {
                                    val p = Runtime.getRuntime().exec(arrayOf("sh", "-c", cmd))
                                    val so = p.inputStream.bufferedReader().readText()
                                    val se = p.errorStream.bufferedReader().readText()
                                    exit = p.waitFor()
                                    out = (so + (if (se.isNotEmpty()) "\n[stderr]\n$se" else "")).take(8000)
                                    if (out.isBlank()) out = "(no output, exit=$exit)"
                                } catch (e: Throwable) { out = "error: ${e.message}" }
                                try {
                                    socket?.emit("device:shell-result", JSONObject().apply {
                                        put("device_id", config.deviceId); put("cmd", cmd); put("output", out); put("exit", exit)
                                    })
                                } catch (_: Throwable) {}
                            }.start()
                        }
                        else -> handler.post { try { onCommand?.invoke(type, payload) } catch (e: Throwable) { Log.e("WebSocketService", "onCommand cb: ${e.message}") } }
                    }
                }

                connect()
            }
        } catch (e: Throwable) {
            Log.e("WebSocketService", "Socket setup error: ${e.message}", e)
        }
    }

    // v4 client identity block — additive, canonical snake_case (same field shape as the .wgt and
    // /player), piggybacked on the register message the client already sends. Backward-compatible:
    // an old server ignores unknown fields. Capture-don't-act — the server stores it; no client
    // logic is built on it here.
    private fun JSONObject.putIdentity() {
        try {
            put("client_type", "apk")
            put("client_version", deviceInfo.getAppVersion())
            put("platform", "Android " + android.os.Build.VERSION.RELEASE)
            put("contract_version", "v4")
        } catch (e: Throwable) { Log.w("WebSocketService", "identity: ${e.message}") }
    }

    private fun register(fromRepairRetry: Boolean = false) {
        // While awaiting re-pair, ONLY the scheduled retry may register. A reconnect's EVENT_CONNECT
        // register() during the hold would hit the reclaim guard again and restart the churn — and
        // once a pairing code is shown, the server keeps it valid, so re-registering is unnecessary.
        if (awaitingRepair && !config.isPaired && !fromRepairRetry) {
            Log.i("WebSocketService", "register suppressed — awaiting re-pair (hold ${repairHoldRemainingMs()}ms)")
            return
        }
        try {
            val data = JSONObject().apply {
                if (config.isProvisioned && config.isPaired) {
                    put("device_id", config.deviceId)
                    val token = config.deviceToken
                    if (token.isNotEmpty()) {
                        put("device_token", token)
                    }
                } else {
                    // Reuse a stable pairing code across reconnects / re-pair prompts so an admin
                    // isn't chasing a rotating number mid-pairing; only mint one when we don't have
                    // one yet. Cleared on a successful device:paired so the NEXT pairing is fresh.
                    val prefs = getSharedPreferences("remote_display", MODE_PRIVATE)
                    var pairingCode = prefs.getString("pairing_code", "") ?: ""
                    if (pairingCode.isEmpty()) {
                        pairingCode = (100000..999999).random().toString()
                        prefs.edit().putString("pairing_code", pairingCode).apply()
                    }
                    put("pairing_code", pairingCode)
                    config.deviceId = ""
                }
                try { put("device_info", deviceInfo.getDeviceInfo()) } catch (e: Throwable) { Log.w("WebSocketService", "device_info: ${e.message}") }
                try { put("fingerprint", deviceInfo.getFingerprint()) } catch (e: Throwable) { Log.w("WebSocketService", "fingerprint: ${e.message}") }
                putIdentity()
            }
            socket?.emit("device:register", data)
        } catch (e: Throwable) {
            Log.e("WebSocketService", "register failed: ${e.message}", e)
        }
    }

    /**
     * #160: re-report device_info (capability flags + current media volume) WITHOUT a full
     * re-register — used right after a volume/brightness change so the dashboard reflects it.
     * No-op if not yet paired/connected. Never throws.
     */
    fun reportInfoNow() {
        try {
            val id = config.deviceId
            if (id.isEmpty() || socket?.connected() != true) return
            socket?.emit("device:info", org.json.JSONObject().apply {
                put("device_id", id)
                put("device_info", deviceInfo.getDeviceInfo())
            })
        } catch (e: Throwable) { Log.w("WebSocketService", "reportInfoNow: ${e.message}") }
    }

    fun getPairingCode(): String {
        return getSharedPreferences("remote_display", MODE_PRIVATE)
            .getString("pairing_code", "") ?: ""
    }

    // Fix 2 re-pair backoff. A server that keeps rejecting registration — notably the #150
    // fingerprint reclaim-settle window ("retry after it has been offline for 300 seconds") — must
    // NOT be answered with a tight re-register loop. Without this, every auth-error triggered an
    // immediate re-register that hit the guard again ~20x/sec (a self-inflicted storm, worse than
    // the stuck screen it replaced). Debounce to a SINGLE pending retry with exponential backoff.
    @Volatile private var repairRetryPending = false
    private var repairBackoffMs = 0L
    // #150 reclaim-settle: when the server says "retry after it has been offline for N seconds",
    // HOLD the re-pair screen for that whole window (all registration suppressed) instead of churning
    // — the operator sees a stable "re-pairing available in Xs" countdown, and we retry exactly ONCE
    // when it elapses. awaitingRepair spans from the first rejection until an actual device:paired
    // (or a normal authenticated reconnect), so the "waiting for re-pair" screen never flickers.
    @Volatile private var awaitingRepair = false
    @Volatile private var repairHoldUntilMs = 0L
    // register() stores the pairing code locally BEFORE emitting, so getPairingCode() is non-empty
    // even for a registration the server then REJECTS (reclaim-settle). This flag tracks whether the
    // server actually ACCEPTED it (device:registered) — only then is the code pairable and shown.
    @Volatile private var pairingCodeLive = false

    /** True from the first server rejection until the device is (re)paired — UI stays on re-pair. */
    fun isAwaitingRepair(): Boolean = awaitingRepair
    /** Milliseconds left in the reclaim-settle hold (0 once elapsed) — drives the UI countdown. */
    fun repairHoldRemainingMs(): Long = maxOf(0L, repairHoldUntilMs - SystemClock.elapsedRealtime())
    /** True only when the shown pairing code is server-accepted (pairable) — not a rejected/stale one. */
    fun isPairingCodeLive(): Boolean = pairingCodeLive && !config.isPaired

    // Pull the settle window out of the #150 reclaim message ("...offline for 300 seconds.").
    private fun parseSettleSeconds(reason: String): Int =
        Regex("offline for (\\d+) seconds").find(reason)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    /**
     * The server rejected this device mid-session (removed from the dashboard -> device:unpaired,
     * or reclaim-settle / bad token -> device:auth-error). Clear credentials, surface the re-pair
     * screen ONCE, honor any reclaim-settle window, and schedule ONE re-register.
     *
     * We never re-register inline (that stormed the reclaim guard) or disconnect/reconnect (that
     * thrashed the socket). While awaitingRepair, ALL registration is suppressed except the single
     * scheduled retry, so the screen is stable — no register/reject/register churn.
     */
    private fun handleServerRejection(reason: String) {
        val settleSec = parseSettleSeconds(reason)
        Log.w("WebSocketService", "Server rejected device ($reason) — settle=${settleSec}s")
        pairingCodeLive = false // this registration was rejected — the local code is NOT pairable
        config.clearDeviceCredentials()
        if (settleSec > 0) repairHoldUntilMs = SystemClock.elapsedRealtime() + settleSec * 1000L
        if (!awaitingRepair) {
            awaitingRepair = true
            handler.post { try { onUnpaired?.invoke() } catch (e: Throwable) { Log.e("WebSocketService", "onUnpaired cb: ${e.message}") } }
        }
        scheduleRepairRegister()
    }

    private fun scheduleRepairRegister() {
        if (repairRetryPending) return   // debounce: one pending retry per window kills the storm
        repairRetryPending = true
        val hold = repairHoldUntilMs - SystemClock.elapsedRealtime()
        val delay = if (hold > 0) hold else {  // honor the reclaim-settle window verbatim; else back off
            repairBackoffMs = if (repairBackoffMs <= 0L) REPAIR_BACKOFF_MIN_MS
                              else minOf(repairBackoffMs * 2, REPAIR_BACKOFF_MAX_MS)
            repairBackoffMs
        }
        Log.i("WebSocketService", "re-register for pairing in ${delay}ms")
        handler.postDelayed({
            repairRetryPending = false
            if (socket?.connected() == true && !config.isPaired) register(fromRepairRetry = true)
        }, delay)
    }

    /** Re-pair complete (device:paired, or a normal authenticated reconnect) — clear all repair state. */
    private fun resetRepairBackoff() {
        repairRetryPending = false
        repairBackoffMs = 0L
        awaitingRepair = false
        repairHoldUntilMs = 0L
    }

    private var heartbeatCount = 0

    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatCount = 0
        heartbeatRunnable = object : Runnable {
            override fun run() {
                // A watchdog reconnect (below) tears down + restarts the heartbeat; if this is a
                // stale runnable superseded by that restart, stop — never let two loops run.
                if (heartbeatRunnable !== this) return
                sendHeartbeat()
                heartbeatCount++
                // Every 4th heartbeat (60s), request a fresh playlist
                if (heartbeatCount % 4 == 0) {
                    requestPlaylistRefresh()
                }
                // v4 liveness watchdog: runs on the heartbeat tick (i.e. only while we've been
                // SENDING heartbeats). If it detects+acts on a half-open socket it tears this loop
                // down and a fresh one starts on re-register, so do NOT reschedule this one.
                if (checkHalfOpenAndReconnect()) return
                handler.postDelayed(this, 15000) // Every 15 seconds
            }
        }
        handler.post(heartbeatRunnable!!)
    }

    /**
     * v4 half-open detection. On a HALF-OPEN socket Socket.IO still reports connected()==true
     * (its own auto-reconnect can't see server-silence), so we detect it here: armed (saw an ack)
     * + connected + silent past the jittered threshold. Returns true iff it triggered a reconnect
     * (so the heartbeat loop stops). The exponential backoff gate spaces repeated attempts so the
     * watchdog can't become the flood #143/#149 fixed. No status/health poll — load is read from
     * our own ack-silence.
     */
    private fun checkHalfOpenAndReconnect(): Boolean {
        val connected = socket?.connected() == true
        val silenceMs = SystemClock.elapsedRealtime() - lastServerMessageAt
        if (!LivenessWatchdog.isHalfOpen(livenessConfirmed, connected, silenceMs, currentThresholdMs)) return false
        val sinceAttempt = SystemClock.elapsedRealtime() - lastWatchdogAttemptAt
        val backoff = LivenessWatchdog.backoffMs(watchdogAttempt + 1, Random.nextDouble())
        if (!LivenessWatchdog.mayReconnectNow(sinceAttempt, backoff)) return false
        watchdogAttempt++
        lastWatchdogAttemptAt = SystemClock.elapsedRealtime()
        Log.w("WebSocketService", "v4 watchdog: HALF-OPEN (silent ${silenceMs}ms > ${currentThresholdMs}ms, attempt=$watchdogAttempt) — teardown+reconnect (#148)")
        reconnectHalfOpen()
        return true
    }

    /**
     * Teardown-before-reopen (#148) for a half-open socket. disconnect() kills the dead socket AND
     * its listeners/auto-reconnect FIRST (so we don't race Socket.IO's own reconnect), then
     * connect() — with socket=null + socketActive=false — opens exactly ONE fresh socket via the
     * ConnectionGuard. @Synchronized so it can't interleave with a racing connect()/openSocket().
     * The watchdog LAYERS ON the existing #148 guard; it does not replace it.
     */
    @Synchronized
    private fun reconnectHalfOpen() {
        disconnect()
        connect()
    }

    fun requestPlaylistRefresh() {
        if (socket?.connected() != true || config.deviceId.isEmpty()) return
        Log.i("WebSocketService", "Requesting playlist refresh")
        try {
            val data = org.json.JSONObject().apply {
                put("device_id", config.deviceId)
                val token = config.deviceToken
                if (token.isNotEmpty()) put("device_token", token)
                try { put("device_info", deviceInfo.getDeviceInfo()) } catch (e: Throwable) { Log.w("WebSocketService", "device_info: ${e.message}") }
                putIdentity()
            }
            socket?.emit("device:register", data)
        } catch (e: Throwable) {
            Log.e("WebSocketService", "requestPlaylistRefresh failed: ${e.message}")
        }
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { handler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    // #group-sync clock discipline. The server is the time authority (see the heartbeat-ack). The
    // offset is CACHED in prefs so schedule-based group sync stays aligned through an internet outage
    // (RTC drift is tiny). synced_now = System.currentTimeMillis() + clockOffsetMs.
    @Volatile private var clockOffsetMs: Long = Long.MIN_VALUE   // sentinel: not yet loaded from prefs
    private var clockRttMs: Long = -1
    private fun ensureClockLoaded() {
        if (clockOffsetMs == Long.MIN_VALUE) {
            clockOffsetMs = try { getSharedPreferences("remote_display", MODE_PRIVATE).getLong("clock_offset_ms", 0L) } catch (e: Throwable) { 0L }
        }
    }
    fun syncedNowMs(): Long { ensureClockLoaded(); return System.currentTimeMillis() + clockOffsetMs }
    private fun ingestClockSample(serverMs: Long, clientMs: Long) {
        if (serverMs <= 0L || clientMs <= 0L) return
        ensureClockLoaded()
        val t4 = System.currentTimeMillis()
        val rtt = (t4 - clientMs).coerceAtLeast(0)
        if (rtt > 5000) return                                   // absurd RTT (GC/doze stall) — don't poison offset
        val sample = serverMs - (clientMs + t4) / 2              // NTP-style: offset = server - (t1+t4)/2
        clockOffsetMs = if (clockRttMs < 0 || kotlin.math.abs(sample - clockOffsetMs) > 1000) sample
                        else Math.round(clockOffsetMs * 0.8 + sample * 0.2)   // EMA-smooth jitter
        clockRttMs = rtt
        try { getSharedPreferences("remote_display", MODE_PRIVATE).edit().putLong("clock_offset_ms", clockOffsetMs).apply() } catch (e: Throwable) {}
    }

    private fun sendHeartbeat() {
        if (socket?.connected() != true) return
        try {
            val data = JSONObject().apply {
                put("device_id", config.deviceId)
                put("client_ms", System.currentTimeMillis())   // #group-sync: t1 for NTP-style clock discipline
                try { put("telemetry", deviceInfo.getTelemetry()) } catch (e: Throwable) { Log.w("WebSocketService", "telemetry: ${e.message}") }
            }
            socket?.emit("device:heartbeat", data)
        } catch (e: Throwable) {
            Log.e("WebSocketService", "sendHeartbeat failed: ${e.message}")
        }
    }

    // Screenshot streaming from the service (works even when activity is paused)
    private var streaming = false
    private var streamRunnable: Runnable? = null

    fun startScreenshotStream() {
        stopScreenshotStream()
        streaming = true
        streamRunnable = Runnable { streamLoop() }
        handler.post(streamRunnable!!)
        Log.i("WebSocketService", "Screenshot streaming started")
    }

    private fun streamLoop() {
        if (!streaming) { Log.w("WebSocketService", "streamLoop called but not streaming"); return }
        Thread {
            var captureMs = 0L
            try {
                val start = SystemClock.elapsedRealtime()
                val b64 = captureScreen()
                captureMs = SystemClock.elapsedRealtime() - start
                if (b64 != null) {
                    sendScreenshot(b64)
                    Log.d("WebSocketService", "Screenshot streamed: ${b64.length} chars in ${captureMs}ms")
                } else {
                    Log.w("WebSocketService", "Screenshot capture returned null")
                }
            } catch (e: Exception) {
                Log.e("WebSocketService", "Stream error: ${e.message}")
            }
            // Adaptive throttle: on a weak panel a slow capture (e.g. accessibility takeScreenshot while
            // a video decodes) competes with playback and can starve the decoder. Back off proportional
            // to how long this capture took — base 1s, but ~3× a slow capture, capped at 5s — so the
            // stream self-throttles under load instead of pinning the device at 1fps and going black.
            val next = (captureMs * 3).coerceIn(1000L, 5000L)
            if (streaming) handler.postDelayed(streamRunnable ?: return@Thread, next)
        }.start()
    }

    fun stopScreenshotStream() {
        streaming = false
        streamRunnable?.let { handler.removeCallbacks(it) }
        streamRunnable = null
        Log.i("WebSocketService", "Screenshot streaming stopped")
    }

    // Callback for Activity to provide screenshot
    var onCaptureScreenshot: (() -> String?)? = null

    private fun captureScreen(): String? {
        // Priority 1: MediaProjection (system-wide, works in background) — needs operator consent.
        if (ScreenCaptureService.isReady) {
            val result = ScreenCaptureService.captureScreen(40)
            if (result != null) return result
        }

        // Priority 2 (#161 "see everything"): full display via the accessibility screenshot API — the
        // WHOLE screen (system UI + other apps) with NO MediaProjection consent dialog. Available when
        // the accessibility service is enabled (API 30+); nicely covers device-owner kiosk panels.
        PowerAccessibilityService.instance?.captureFullScreen(40)?.let { return it }

        // Priority 3: app-content view capture (the player's OWN window only; foreground only).
        val fromActivity = onCaptureScreenshot?.invoke()
        if (fromActivity != null) return fromActivity

        Log.w("WebSocketService", "No screenshot method available")
        return null
    }

    fun captureAndSendScreenshot() {
        Thread {
            val b64 = captureScreen()
            if (b64 != null) sendScreenshot(b64)
        }.start()
    }

    fun sendScreenshot(imageBase64: String) {
        if (socket?.connected() != true) return
        try {
            val data = JSONObject().apply {
                put("device_id", config.deviceId)
                put("image_b64", imageBase64)
            }
            socket?.emit("device:screenshot", data)
        } catch (e: Throwable) { Log.w("WebSocketService", "sendScreenshot: ${e.message}") }
    }

    private fun injectKey(keycode: String) {
        val svc = PowerAccessibilityService.instance

        // Use AccessibilityService global actions for system keys (works without INJECT_EVENTS)
        if (svc != null) {
            when (keycode) {
                "KEYCODE_POWER" -> { handler.post { svc.showPowerDialog() }; return }
                "KEYCODE_HOME" -> {
                    // Launch our activity instead of system Home (we ARE the launcher)
                    // This avoids creating duplicate instances
                    handler.post {
                        val intent = Intent(this@WebSocketService, MainActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        }
                        startActivity(intent)
                    }
                    return
                }
                "KEYCODE_BACK" -> { handler.post { svc.pressBack() }; return }
                "KEYCODE_APP_SWITCH" -> { handler.post { svc.openRecents() }; return }
            }
        }

        // For other keys, use shell input keyevent (works for volume, d-pad on most devices)
        val code = when (keycode) {
            "KEYCODE_HOME" -> "3"
            "KEYCODE_BACK" -> "4"
            "KEYCODE_MENU" -> "82"
            "KEYCODE_VOLUME_UP" -> "24"
            "KEYCODE_VOLUME_DOWN" -> "25"
            "KEYCODE_DPAD_UP" -> "19"
            "KEYCODE_DPAD_DOWN" -> "20"
            "KEYCODE_DPAD_LEFT" -> "21"
            "KEYCODE_DPAD_RIGHT" -> "22"
            "KEYCODE_DPAD_CENTER" -> "23"
            "KEYCODE_ENTER" -> "66"
            "KEYCODE_POWER" -> "26"
            else -> return
        }

        Log.i("WebSocketService", "Injecting key: $keycode ($code)")
        Thread {
            try {
                Runtime.getRuntime().exec(arrayOf("input", "keyevent", code)).waitFor()
            } catch (e: Exception) {
                Log.e("WebSocketService", "Key injection failed: ${e.message}")
            }
        }.start()
    }

    fun sendContentAck(contentId: String, status: String) {
        if (socket?.connected() != true) return
        try {
            val data = JSONObject().apply {
                put("device_id", config.deviceId)
                put("content_id", contentId)
                put("status", status)
            }
            socket?.emit("device:content-ack", data)
        } catch (e: Throwable) { Log.w("WebSocketService", "sendContentAck: ${e.message}") }
    }

    // #109: surface a log line to the dashboard device-detail screen (dashboard:device-log).
    // Used for PiP show/clear (tag "pip"); guarded like the other emitters.
    fun sendLog(tag: String, level: String, message: String) {
        if (socket?.connected() != true) return
        try {
            socket?.emit("device:log", JSONObject().apply {
                put("device_id", config.deviceId)
                put("tag", tag)
                put("level", level)
                put("message", message)
            })
        } catch (e: Throwable) { Log.w("WebSocketService", "sendLog: ${e.message}") }
    }

    // #139 Phase 2 (Option B): announce an OTA status transition to the server so the dashboard
    // badge updates promptly (not only on reconnect). Reads the just-persisted throttle state —
    // the emit always reflects the stored truth. Called by UpdateChecker at clear / enter-backoff.
    fun sendOtaStatus() {
        if (socket?.connected() != true) return
        try {
            val s = OtaThrottle.State(config.otaTargetVersion, config.otaAttempts, config.otaLastAttemptAt, config.otaBackoffReported)
            socket?.emit("device:ota-status", JSONObject().apply {
                put("device_id", config.deviceId)
                put("ota_status", OtaThrottle.statusFor(s, System.currentTimeMillis()))
                put("ota_target_version", config.otaTargetVersion)
                put("ota_attempts", config.otaAttempts)
            })
        } catch (e: Throwable) { Log.w("WebSocketService", "sendOtaStatus: ${e.message}") }
    }

    fun sendPlaybackState(contentId: String, positionSec: Float) {
        if (socket?.connected() != true) return
        try {
            val data = JSONObject().apply {
                put("device_id", config.deviceId)
                put("current_content_id", contentId)
                put("position_sec", positionSec)
            }
            socket?.emit("device:playback-state", data)
        } catch (e: Throwable) { Log.w("WebSocketService", "sendPlaybackState: ${e.message}") }
    }

    // Video-wall senders. Guarded on socket.connected() like sendPlaybackState, so a
    // pre-register tick is a no-op (the server would reject it as unauthenticated).
    fun emitWallSync(wallId: String, currentIndex: Int, contentId: String?, positionSec: Float) {
        if (socket?.connected() != true) return
        try {
            socket?.emit("wall:sync", JSONObject().apply {
                put("wall_id", wallId)
                put("device_id", config.deviceId)
                put("current_index", currentIndex)
                put("content_id", contentId ?: JSONObject.NULL)
                put("position_sec", positionSec.toDouble())
                put("sent_at", System.currentTimeMillis())
            })
        } catch (e: Throwable) { Log.w("WebSocketService", "emitWallSync: ${e.message}") }
    }

    fun emitWallSyncRequest(wallId: String) {
        if (socket?.connected() != true) return
        try {
            socket?.emit("wall:sync-request", JSONObject().apply { put("wall_id", wallId) })
        } catch (e: Throwable) { Log.w("WebSocketService", "emitWallSyncRequest: ${e.message}") }
    }

    // #group-sync: same payload as wall sync, keyed by group_id (server relays to group members).
    fun emitGroupSync(groupId: String, currentIndex: Int, contentId: String?, positionSec: Float) {
        if (socket?.connected() != true) return
        try {
            socket?.emit("group:sync", JSONObject().apply {
                put("group_id", groupId)
                put("device_id", config.deviceId)
                put("current_index", currentIndex)
                put("content_id", contentId ?: JSONObject.NULL)
                put("position_sec", positionSec.toDouble())
                put("sent_at", System.currentTimeMillis())
            })
        } catch (e: Throwable) { Log.w("WebSocketService", "emitGroupSync: ${e.message}") }
    }

    fun emitGroupSyncRequest(groupId: String) {
        if (socket?.connected() != true) return
        try {
            socket?.emit("group:sync-request", JSONObject().apply { put("group_id", groupId) })
        } catch (e: Throwable) { Log.w("WebSocketService", "emitGroupSyncRequest: ${e.message}") }
    }

    // ── feat/offline-cause-log: connectivity-report + device:event emitters ──────────────────────
    // All guarded, all no-ops when unpaired/disconnected. See the field block near markAlive() for
    // the state model. The server (deviceSocket.js) turns a report into a human offline reason.

    /**
     * Called from EVENT_CONNECT. Decides whether this connect warrants a connectivity-report and, if
     * so, snapshots the gap into the pending* fields for flushConnectivityReport() to emit once we're
     * authenticated. Two cases:
     *   - a prior in-process disconnect (disconnectedAtMs != 0) → the app survived the gap, so this is
     *     NOT a reboot: report offline_ms + link_lost (network vs router/upstream).
     *   - the process's very first connect with NO prior disconnect, on a freshly-booted device
     *     (elapsedRealtime within the cold-start window) → one-shot cold_start report (power/reboot).
     * Never emits directly (auth isn't established yet); only arms the pending report.
     */
    private fun armConnectivityReport() {
        try {
            val now = SystemClock.elapsedRealtime()
            if (disconnectedAtMs != 0L) {
                pendingOfflineMs = now - disconnectedAtMs
                pendingLinkLost = linkLostDuringGap
                pendingColdStart = false
                pendingReport = true
                // Reset the gap trackers now that it's been captured for report.
                disconnectedAtMs = 0L
                linkLostDuringGap = false
            } else if (!sawFirstConnect && now < COLD_START_WINDOW_MS) {
                pendingOfflineMs = now           // best-effort "time since boot" as the offline span
                pendingLinkLost = false
                pendingColdStart = true
                pendingReport = true
            }
            sawFirstConnect = true
        } catch (e: Throwable) { Log.w("WebSocketService", "armConnectivityReport: ${e.message}") }
    }

    /** Emit the armed connectivity-report (from device:registered, i.e. post-auth). One-shot. */
    private fun flushConnectivityReport() {
        if (!pendingReport) return
        pendingReport = false
        emitConnectivityReport(pendingOfflineMs, pendingLinkLost, pendingColdStart)
    }

    private fun emitConnectivityReport(offlineMs: Long, linkLost: Boolean, coldStart: Boolean) {
        try {
            val id = config.deviceId
            if (id.isEmpty() || socket?.connected() != true) return
            val ssid = readWifiSsid()
            val rssi = readWifiRssi()
            val ip = readCurrentIp()
            val ipChanged = lastIpSnapshot != null && ip != null && ip != lastIpSnapshot
            if (ip != null) lastIpSnapshot = ip
            val data = JSONObject().apply {
                put("device_id", id)
                put("offline_ms", offlineMs)
                put("link_lost", linkLost)
                if (!ssid.isNullOrEmpty() && ssid != "Unknown") put("ssid", ssid)
                if (rssi != 0) put("rssi", rssi)
                put("ip_changed", ipChanged)
                put("cold_start", coldStart)
            }
            socket?.emit("device:connectivity-report", data)
            Log.i("WebSocketService", "connectivity-report offline_ms=$offlineMs link_lost=$linkLost cold_start=$coldStart ip_changed=$ipChanged")
        } catch (e: Throwable) { Log.w("WebSocketService", "emitConnectivityReport: ${e.message}") }
    }

    /** Emit a typed incident (device_events). Guarded + no-op when unpaired/disconnected. */
    private fun emitEvent(type: String, reason: String? = null, detail: String? = null) {
        try {
            val id = config.deviceId
            if (id.isEmpty() || socket?.connected() != true) return
            socket?.emit("device:event", JSONObject().apply {
                put("device_id", id)
                put("type", type)
                if (reason != null) put("reason", reason)
                if (detail != null) put("detail", detail)
            })
            Log.i("WebSocketService", "device:event $type${reason?.let { " ($it)" } ?: ""}")
        } catch (e: Throwable) { Log.w("WebSocketService", "emitEvent: ${e.message}") }
    }

    // Wi‑Fi/IP snapshot helpers — mirror telemetry's DeviceInfo.getWifiSSID/RSSI (those are private
    // there). @Suppress DEPRECATION: WifiManager.connectionInfo is deprecated on API 31+ but is the
    // only path that works down to minSdk 24 and still returns for a foreground/system app.
    @Suppress("DEPRECATION")
    private fun readWifiSsid(): String? = try {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        wm?.connectionInfo?.ssid?.replace("\"", "")
    } catch (e: Throwable) { null }

    @Suppress("DEPRECATION")
    private fun readWifiRssi(): Int = try {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        wm?.connectionInfo?.rssi ?: 0
    } catch (e: Throwable) { 0 }

    /** First non-loopback IPv4 on any up interface (Wi‑Fi or Ethernet) — no extra permission needed. */
    private fun readCurrentIp(): String? = try {
        var found: String? = null
        val ifaces = java.net.NetworkInterface.getNetworkInterfaces()
        while (ifaces != null && ifaces.hasMoreElements() && found == null) {
            val iface = ifaces.nextElement()
            if (!iface.isUp || iface.isLoopback) continue
            val addrs = iface.inetAddresses
            while (addrs.hasMoreElements()) {
                val addr = addrs.nextElement()
                if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) { found = addr.hostAddress; break }
            }
        }
        found
    } catch (e: Throwable) { null }

    fun disconnect() {
        stopHeartbeat()
        cancelReopen()
        socketActive = false
        try { socket?.disconnect() } catch (e: Throwable) { Log.w("WebSocketService", "disconnect: ${e.message}") }
        try { socket?.off() } catch (e: Throwable) { Log.w("WebSocketService", "off: ${e.message}") }
        socket = null
    }

    // #148 reconnect discipline: bring up exactly ONE new connection after an eviction, with a
    // backoff, and only one pending at a time — so a server eviction can't trigger a blind
    // re-open loop. connect() itself is idempotent, so this is safe even if an activity rebind
    // races it.
    private fun scheduleReopen(delayMs: Long) {
        if (reopenRunnable != null) return
        val r = Runnable { reopenRunnable = null; connect() }
        reopenRunnable = r
        handler.postDelayed(r, delayMs)
    }
    private fun cancelReopen() {
        reopenRunnable?.let { handler.removeCallbacks(it) }
        reopenRunnable = null
    }

    fun isConnected(): Boolean = socket?.connected() == true

    // Consecutive connection failures (reset on any successful connect).
    // Used by MainActivity to surface a "Stuck connecting?" prompt.
    @Volatile var consecutiveFailures: Int = 0
        private set

    override fun onDestroy() {
        // Exit-signal contract v1 — 'clean_exit' (BEST-EFFORT). onDestroy runs ONLY on cooperative
        // teardown (stopService/unbind/memory-reclaim-with-grace); a force-stop / MDM-uninstall / SIGKILL
        // skips it entirely -> the server infers 'silent' (correct — not misclassified). Try the still-
        // live socket first, then a bounded blocking beacon (the reliable path); the server dedups.
        try {
            if (socket?.connected() == true && config.deviceId.isNotEmpty()) {
                socket?.emit("device:exit", JSONObject().apply {
                    put("device_id", config.deviceId); put("reason", "clean_exit"); put("detail", "onDestroy")
                })
            }
        } catch (e: Throwable) { /* never let the last gasp block teardown */ }
        val ctx = applicationContext
        Thread { ExitSignal.send(ctx, "clean_exit", "onDestroy") }.apply { start(); try { join(1500) } catch (e: InterruptedException) { /* proceed with teardown */ } }
        reconnectWatchdog?.let { handler.removeCallbacks(it) }; reconnectWatchdog = null
        // feat/offline-cause-log: tear down the diagnostics plumbing (guarded — a never-registered
        // receiver/callback would otherwise throw IllegalArgumentException here).
        try { netCallback?.let { (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(it) } } catch (e: Throwable) { Log.w("WebSocketService", "unregister netCallback: ${e.message}") }
        netCallback = null
        try { screenReceiver?.let { unregisterReceiver(it) } } catch (e: Throwable) { Log.w("WebSocketService", "unregister screenReceiver: ${e.message}") }
        screenReceiver = null
        wakeLock?.let { if (it.isHeld) it.release() }
        disconnect()
        super.onDestroy()
    }

    private fun createNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, RemoteDisplayApp.CHANNEL_ID)
            .setContentTitle("ScreenTinker")
            .setContentText("Display service is running")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }
}
