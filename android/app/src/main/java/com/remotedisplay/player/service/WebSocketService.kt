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

    inner class LocalBinder : Binder() {
        fun getService(): WebSocketService = this@WebSocketService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    private var wakeLock: android.os.PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        config = ServerConfig(this)
        deviceInfo = DeviceInfo(this)
        startForeground(1, createNotification())

        // Keep CPU alive so the WebSocket connection stays alive in background
        val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
        wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "RemoteDisplay:WebSocket")
        wakeLock?.acquire()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
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
                reconnectionDelay = 2000
                reconnectionDelayMax = 10000
                timeout = 20000
            }

            socket = IO.socket(URI.create("$url/device"), options).apply {
                on(Socket.EVENT_CONNECT) {
                    Log.i("WebSocketService", "Connected to server")
                    register()
                }

                on(Socket.EVENT_DISCONNECT) {
                    Log.w("WebSocketService", "Disconnected from server")
                }

                on(Socket.EVENT_CONNECT_ERROR) { args ->
                    Log.e("WebSocketService", "Connection error: ${args.firstOrNull()}")
                }

                on("device:registered") { args ->
                    val data = args[0] as JSONObject
                    val newDeviceId = data.getString("device_id")
                    config.deviceId = newDeviceId
                    // Persist device_token (issued on first register, or refreshed on reconnect)
                    if (data.has("device_token")) {
                        config.deviceToken = data.getString("device_token")
                    }
                    Log.i("WebSocketService", "Registered as: $newDeviceId")
                    handler.post { onRegistered?.invoke(newDeviceId) }
                    startHeartbeat()
                }

                on("device:unpaired") {
                    Log.w("WebSocketService", "Device not found on server - clearing credentials")
                    config.clearDeviceCredentials()
                    handler.post { onUnpaired?.invoke() }
                }

                on("device:auth-error") { args ->
                    val msg = (args.firstOrNull() as? JSONObject)?.optString("error", "Authentication failed") ?: "Authentication failed"
                    Log.w("WebSocketService", "Device auth rejected: $msg — clearing credentials for re-pair")
                    config.clearDeviceCredentials()
                    handler.post { onUnpaired?.invoke() }
                }

                on("device:paired") { args ->
                    val data = args[0] as JSONObject
                    val id = data.getString("device_id")
                    val name = data.optString("name", "Display")
                    config.setPaired(true)
                    config.deviceName = name
                    Log.i("WebSocketService", "Paired as: $name")
                    handler.post { onPaired?.invoke(id, name) }
                }

                on("device:playlist-update") { args ->
                    Log.i("WebSocketService", "Playlist raw args: ${args.size} items, type=${args[0]?.javaClass?.name}, data=${args[0]}")
                    val data = args[0] as JSONObject
                    Log.i("WebSocketService", "Playlist update received, keys=${data.keys().asSequence().toList()}, assignments=${data.optJSONArray("assignments")?.length() ?: "null"}")
                    handler.post { onPlaylistUpdate?.invoke(data) }
                }

                on("device:content-delete") { args ->
                    val data = args[0] as JSONObject
                    val contentId = data.getString("content_id")
                    handler.post { onContentDelete?.invoke(contentId) }
                }

                on("device:screenshot-request") {
                    captureAndSendScreenshot()
                    handler.post { onScreenshotRequest?.invoke() }
                }

                on("device:remote-start") {
                    startScreenshotStream()
                    handler.post { onRemoteStart?.invoke() }
                }

                on("device:remote-stop") {
                    stopScreenshotStream()
                    handler.post { onRemoteStop?.invoke() }
                }

                on("device:remote-touch") { args ->
                    val data = args[0] as JSONObject
                    val x = data.getDouble("x").toFloat()
                    val y = data.getDouble("y").toFloat()
                    val action = data.optString("action", "tap")
                    // Use AccessibilityService for system-wide touch (works on dialogs too)
                    val svc = PowerAccessibilityService.instance
                    if (svc != null && action == "tap") {
                        handler.post { svc.injectTap(x, y) }
                    } else {
                        handler.post { onRemoteTouch?.invoke(x, y, action) }
                    }
                }

                on("device:remote-key") { args ->
                    val data = args[0] as JSONObject
                    val keycode = data.getString("keycode")
                    // Always inject via shell (works even when app not in foreground)
                    injectKey(keycode)
                    handler.post { onRemoteKey?.invoke(keycode) }
                }

                on("device:command") { args ->
                    val data = args[0] as JSONObject
                    val type = data.getString("type")
                    val payload = data.optJSONObject("payload")
                    Log.i("WebSocketService", "Command received: $type")

                    // Handle system commands directly in the service
                    when (type) {
                        "launch" -> {
                            handler.post {
                                val intent = Intent(this@WebSocketService, MainActivity::class.java).apply {
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                                }
                                startActivity(intent)
                                Log.i("WebSocketService", "Launched MainActivity from service")
                            }
                        }
                        "settings" -> {
                            handler.post {
                                val intent = Intent(android.provider.Settings.ACTION_SETTINGS).apply {
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                                startActivity(intent)
                                Log.i("WebSocketService", "Opened system settings")
                            }
                        }
                        "enable_system_capture" -> {
                            // Trigger MediaProjection permission request on device
                            handler.post {
                                com.remotedisplay.player.ScreenCapturePermissionActivity.requestPermission(this@WebSocketService)
                                Log.i("WebSocketService", "Requesting system capture permission")
                            }
                        }
                        "screen_off" -> {
                            val a11y = PowerAccessibilityService.instance
                            if (a11y != null) {
                                handler.post { a11y.lockScreen() }
                            } else {
                                Thread { try { Runtime.getRuntime().exec(arrayOf("input", "keyevent", "26")).waitFor() } catch (_: Exception) {} }.start()
                            }
                        }
                        "screen_on" -> {
                            // WAKEUP keyevent works from shell on most devices
                            Thread { try { Runtime.getRuntime().exec(arrayOf("input", "keyevent", "224")).waitFor() } catch (_: Exception) {} }.start()
                        }
                        else -> handler.post { onCommand?.invoke(type, payload) }
                    }
                }

                connect()
            }
        } catch (e: Exception) {
            Log.e("WebSocketService", "Socket setup error: ${e.message}")
        }
    }

    private fun register() {
        val data = JSONObject().apply {
            if (config.isProvisioned && config.isPaired) {
                put("device_id", config.deviceId)
                // Send device_token for authentication (may be empty for legacy devices)
                val token = config.deviceToken
                if (token.isNotEmpty()) {
                    put("device_token", token)
                }
            } else {
                // Generate a pairing code if we don't have one
                val pairingCode = (100000..999999).random().toString()
                put("pairing_code", pairingCode)
                config.deviceId = "" // Will be set on registered event
                // Store pairing code temporarily
                getSharedPreferences("remote_display", MODE_PRIVATE)
                    .edit().putString("pairing_code", pairingCode).apply()
            }
            put("device_info", deviceInfo.getDeviceInfo())
            put("fingerprint", deviceInfo.getFingerprint())
        }
        socket?.emit("device:register", data)
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
        // Re-register triggers the server to send current playlist
        val data = org.json.JSONObject().apply {
            put("device_id", config.deviceId)
            val token = config.deviceToken
            if (token.isNotEmpty()) {
                put("device_token", token)
            }
            put("device_info", deviceInfo.getDeviceInfo())
        }
        socket?.emit("device:register", data)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { handler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    private fun sendHeartbeat() {
        if (socket?.connected() != true) return
        val data = JSONObject().apply {
            put("device_id", config.deviceId)
            put("telemetry", deviceInfo.getTelemetry())
        }
        socket?.emit("device:heartbeat", data)
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
        val data = JSONObject().apply {
            put("device_id", config.deviceId)
            put("image_b64", imageBase64)
        }
        socket?.emit("device:screenshot", data)
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
        val data = JSONObject().apply {
            put("device_id", config.deviceId)
            put("content_id", contentId)
            put("status", status)
        }
        socket?.emit("device:content-ack", data)
    }

    fun sendPlaybackState(contentId: String, positionSec: Float) {
        if (socket?.connected() != true) return
        val data = JSONObject().apply {
            put("device_id", config.deviceId)
            put("current_content_id", contentId)
            put("position_sec", positionSec)
        }
        socket?.emit("device:playback-state", data)
    }

    fun disconnect() {
        stopHeartbeat()
        socket?.disconnect()
        socket?.off()
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
