package com.remotedisplay.player.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
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
    private lateinit var config: ServerConfig
    private lateinit var deviceInfo: DeviceInfo
    private val handler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private val binder = LocalBinder()

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
    var onPipShow: ((JSONObject) -> Unit)? = null
    var onPipClear: ((JSONObject) -> Unit)? = null

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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    // Wrap every Socket.IO listener body in try/catch. A malformed payload from the server
    // (or a transient state error during disconnect) used to surface as an unhandled
    // exception on the Socket.IO IO thread and crash the whole app.
    private fun Socket.safeOn(event: String, handler: (Array<Any?>) -> Unit): Socket {
        on(event) { args ->
            try {
                @Suppress("UNCHECKED_CAST")
                handler(args as Array<Any?>)
            } catch (e: Throwable) {
                Log.e("WebSocketService", "Listener for '$event' failed: ${e.message}", e)
            }
        }
        return this
    }

    fun connect(serverUrl: String? = null) {
        val url = serverUrl ?: config.serverUrl
        if (url.isEmpty()) {
            Log.e("WebSocketService", "No server URL configured")
            return
        }

        disconnect()

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
                    register()
                }

                safeOn(Socket.EVENT_DISCONNECT) { args ->
                    val reason = args.firstOrNull()?.toString() ?: "unknown"
                    Log.w("WebSocketService", "Disconnected from server: $reason")
                    // Stop heartbeat while disconnected; player keeps showing cached content.
                    // Socket.IO will reconnect automatically per the options above.
                    stopHeartbeat()
                }

                safeOn(Socket.EVENT_CONNECT_ERROR) { args ->
                    Log.e("WebSocketService", "Connection error: ${args.firstOrNull()}")
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
                    handler.post { try { onRegistered?.invoke(newDeviceId) } catch (e: Throwable) { Log.e("WebSocketService", "onRegistered cb: ${e.message}") } }
                    startHeartbeat()
                }

                safeOn("device:unpaired") {
                    Log.w("WebSocketService", "Device not found on server - clearing credentials")
                    config.clearDeviceCredentials()
                    handler.post { try { onUnpaired?.invoke() } catch (e: Throwable) { Log.e("WebSocketService", "onUnpaired cb: ${e.message}") } }
                }

                safeOn("device:auth-error") { args ->
                    val msg = (args.firstOrNull() as? JSONObject)?.optString("error", "Authentication failed") ?: "Authentication failed"
                    Log.w("WebSocketService", "Device auth rejected: $msg — clearing credentials for re-pair")
                    config.clearDeviceCredentials()
                    handler.post { try { onUnpaired?.invoke() } catch (e: Throwable) { Log.e("WebSocketService", "onUnpaired cb: ${e.message}") } }
                }

                safeOn("device:paired") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    val id = data.optString("device_id", "")
                    val name = data.optString("name", "Display")
                    config.setPaired(true)
                    config.deviceName = name
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
                    if (svc != null && action == "tap") {
                        handler.post { try { svc.injectTap(x, y) } catch (e: Throwable) { Log.e("WebSocketService", "injectTap: ${e.message}") } }
                    } else {
                        handler.post { try { onRemoteTouch?.invoke(x, y, action) } catch (e: Throwable) { Log.e("WebSocketService", "onRemoteTouch cb: ${e.message}") } }
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

                // #109: PiP overlay. Post to the main thread — the handlers build Views.
                safeOn("device:pip-show") { args ->
                    val data = args.firstOrNull() as? JSONObject ?: return@safeOn
                    handler.post { try { onPipShow?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onPipShow cb: ${e.message}") } }
                }
                safeOn("device:pip-clear") { args ->
                    val data = (args.firstOrNull() as? JSONObject) ?: JSONObject()
                    handler.post { try { onPipClear?.invoke(data) } catch (e: Throwable) { Log.e("WebSocketService", "onPipClear cb: ${e.message}") } }
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
                        "screen_off" -> {
                            val a11y = PowerAccessibilityService.instance
                            if (a11y != null) {
                                handler.post { try { a11y.lockScreen() } catch (e: Throwable) { Log.e("WebSocketService", "lockScreen: ${e.message}") } }
                            } else {
                                Thread { try { Runtime.getRuntime().exec(arrayOf("input", "keyevent", "26")).waitFor() } catch (_: Exception) {} }.start()
                            }
                        }
                        "screen_on" -> {
                            Thread { try { Runtime.getRuntime().exec(arrayOf("input", "keyevent", "224")).waitFor() } catch (_: Exception) {} }.start()
                        }
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
                        else -> handler.post { try { onCommand?.invoke(type, payload) } catch (e: Throwable) { Log.e("WebSocketService", "onCommand cb: ${e.message}") } }
                    }
                }

                connect()
            }
        } catch (e: Throwable) {
            Log.e("WebSocketService", "Socket setup error: ${e.message}", e)
        }
    }

    private fun register() {
        try {
            val data = JSONObject().apply {
                if (config.isProvisioned && config.isPaired) {
                    put("device_id", config.deviceId)
                    val token = config.deviceToken
                    if (token.isNotEmpty()) {
                        put("device_token", token)
                    }
                } else {
                    val pairingCode = (100000..999999).random().toString()
                    put("pairing_code", pairingCode)
                    config.deviceId = ""
                    getSharedPreferences("remote_display", MODE_PRIVATE)
                        .edit().putString("pairing_code", pairingCode).apply()
                }
                try { put("device_info", deviceInfo.getDeviceInfo()) } catch (e: Throwable) { Log.w("WebSocketService", "device_info: ${e.message}") }
                try { put("fingerprint", deviceInfo.getFingerprint()) } catch (e: Throwable) { Log.w("WebSocketService", "fingerprint: ${e.message}") }
            }
            socket?.emit("device:register", data)
        } catch (e: Throwable) {
            Log.e("WebSocketService", "register failed: ${e.message}", e)
        }
    }

    fun getPairingCode(): String {
        return getSharedPreferences("remote_display", MODE_PRIVATE)
            .getString("pairing_code", "") ?: ""
    }

    private var heartbeatCount = 0

    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatCount = 0
        heartbeatRunnable = object : Runnable {
            override fun run() {
                sendHeartbeat()
                heartbeatCount++
                // Every 4th heartbeat (60s), request a fresh playlist
                if (heartbeatCount % 4 == 0) {
                    requestPlaylistRefresh()
                }
                handler.postDelayed(this, 15000) // Every 15 seconds
            }
        }
        handler.post(heartbeatRunnable!!)
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

    private fun sendHeartbeat() {
        if (socket?.connected() != true) return
        try {
            val data = JSONObject().apply {
                put("device_id", config.deviceId)
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
            try {
                val b64 = captureScreen()
                if (b64 != null) {
                    sendScreenshot(b64)
                    Log.d("WebSocketService", "Screenshot streamed: ${b64.length} chars")
                } else {
                    Log.w("WebSocketService", "Screenshot capture returned null")
                }
            } catch (e: Exception) {
                Log.e("WebSocketService", "Stream error: ${e.message}")
            }
            if (streaming) handler.postDelayed(streamRunnable ?: return@Thread, 1000)
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
        // Priority 1: MediaProjection (system-wide, works in background)
        if (ScreenCaptureService.isReady) {
            val result = ScreenCaptureService.captureScreen(40)
            if (result != null) return result
        }

        // Priority 2: Activity callback (view-based, only when app is foreground)
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

    fun disconnect() {
        stopHeartbeat()
        try { socket?.disconnect() } catch (e: Throwable) { Log.w("WebSocketService", "disconnect: ${e.message}") }
        try { socket?.off() } catch (e: Throwable) { Log.w("WebSocketService", "off: ${e.message}") }
        socket = null
    }

    fun isConnected(): Boolean = socket?.connected() == true

    override fun onDestroy() {
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
