package com.remotedisplay.player

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.widget.FrameLayout
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.ui.PlayerView
import com.remotedisplay.player.data.ContentCache
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.player.MediaPlayerManager
import com.remotedisplay.player.player.PlaylistController
import com.remotedisplay.player.player.PlaylistItem
import com.remotedisplay.player.player.ZoneManager
import com.remotedisplay.player.remote.ScreenshotCapture
import com.remotedisplay.player.remote.TouchInjector
import com.remotedisplay.player.service.UpdateChecker
import com.remotedisplay.player.service.WebSocketService
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var config: ServerConfig
    private lateinit var contentCache: ContentCache
    private lateinit var screenshotCapture: ScreenshotCapture
    private lateinit var touchInjector: TouchInjector

    private var wsService: WebSocketService? = null
    private var bound = false
    private lateinit var mediaPlayer: MediaPlayerManager
    private lateinit var playlistController: PlaylistController
    private lateinit var updateChecker: UpdateChecker
    private var zoneManager: ZoneManager? = null

    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusOverlay: View
    private lateinit var statusText: TextView
    private lateinit var rootView: View

    private val handler = Handler(Looper.getMainLooper())
    private var remoteStreaming = false
    private var screenshotStreamRunnable: Runnable? = null
    private var playbackStarted = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as WebSocketService.LocalBinder
            wsService = binder.getService()
            bound = true
            setupServiceCallbacks()
            wsService?.connect()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            wsService = null
            bound = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        config = ServerConfig(this)
        val prefs = getSharedPreferences("remote_display", MODE_PRIVATE)

        // Show setup wizard if not completed yet
        if (!prefs.getBoolean("setup_complete", false)) {
            // Auto-mark complete if accessibility is already enabled (existing install)
            if (isAccessibilityEnabled()) {
                prefs.edit().putBoolean("setup_complete", true).apply()
            } else {
                startActivity(Intent(this, SetupActivity::class.java))
                finish()
                return
            }
        }

        // Check provisioning BEFORE inflating the heavy media layout
        if (!config.isProvisioned || !config.isPaired) {
            startActivity(Intent(this, ProvisioningActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)

        // Fullscreen immersive
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        contentCache = ContentCache(this)
        screenshotCapture = ScreenshotCapture()
        touchInjector = TouchInjector()

        playerView = findViewById(R.id.playerView)
        imageView = findViewById(R.id.imageView)
        statusOverlay = findViewById(R.id.statusOverlay)
        statusText = findViewById(R.id.statusText)
        rootView = findViewById(R.id.rootLayout)

        // Hide player controls
        playerView.useController = false

        // Setup zone manager for multi-zone layouts
        zoneManager = ZoneManager(this, rootView as FrameLayout) {
            playlistController.onVideoComplete()
        }

        // Setup playlist controller
        playlistController = PlaylistController(
            onItemChanged = { item -> item?.let { playItem(it) } },
            onPlaylistEmpty = { showStatus("Waiting for content...") },
            onRequestRefresh = { wsService?.requestPlaylistRefresh() }
        )

        // Setup media player
        val youtubeWebView = findViewById<android.webkit.WebView>(R.id.youtubeWebView)
        mediaPlayer = MediaPlayerManager(
            context = this,
            playerView = playerView,
            imageView = imageView,
            youtubeWebView = youtubeWebView,
            onVideoComplete = { playlistController.onVideoComplete() }
        )

        // Restore cached playlist for offline cold-start (play immediately from disk cache)
        val cachedJson = config.cachedPlaylist
        if (cachedJson.isNotEmpty()) {
            try {
                val cached = JSONObject(cachedJson)
                val assignments = cached.getJSONArray("assignments")
                if (assignments.length() > 0) {
                    Log.i("MainActivity", "Restoring cached playlist: ${assignments.length()} items")
                    playlistController.updatePlaylist(assignments)
                    playlistController.startIfNeeded()
                }
            } catch (e: Exception) {
                Log.w("MainActivity", "Failed to restore cached playlist: ${e.message}")
            }
        }

        if (!playlistController.isPlaying) {
            showStatus("Connecting to server...")
        }

        // Start and bind to WebSocket service
        try {
            val serviceIntent = Intent(this, WebSocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
            bindService(serviceIntent, connection, Context.BIND_AUTO_CREATE)
        } catch (e: Exception) {
            Log.e("MainActivity", "Failed to start service: ${e.message}")
            showStatus("Service error: ${e.message}")
        }

        // Start auto-update checker
        updateChecker = UpdateChecker(this)
        updateChecker.startPeriodicCheck()

    }

    private fun setupServiceCallbacks() {
        wsService?.onPlaylistUpdate = { data ->
            try {
            // Check if device is suspended (trial expired / over limit)
            if (data.optBoolean("suspended", false)) {
                val message = data.optString("message", "Account Suspended")
                val detail = data.optString("detail", "Please upgrade your plan.")
                handler.post {
                    showStatus("$message\n$detail")
                    if (::mediaPlayer.isInitialized) mediaPlayer.stop()
                }
            } else {

            val assignments = data.getJSONArray("assignments")

            // Cache playlist JSON for offline cold-start
            config.cachedPlaylist = data.toString()

            // Check for multi-zone layout
            val layoutObj = if (data.isNull("layout")) null else data.optJSONObject("layout")
            val layoutZones = layoutObj?.optJSONArray("zones")

            if (layoutZones != null && layoutZones.length() > 1) {
                // Multi-zone mode - use ZoneManager
                val layoutId = layoutObj?.optString("id", "") ?: ""
                val currentLayoutId = zoneManager?.currentLayoutId

                // Build a signature of current assignments to detect content changes
                val assignmentSig = (0 until assignments.length()).map { i ->
                    val a = assignments.getJSONObject(i)
                    "${a.optString("content_id")}:${a.optString("zone_id")}:${a.optString("widget_id")}"
                }.sorted().joinToString("|")
                val changed = assignmentSig != zoneManager?.lastAssignmentSig

                if (zoneManager?.hasZones() != true || layoutId != currentLayoutId) {
                    Log.i("MainActivity", "Multi-zone layout with ${layoutZones.length()} zones (layout=$layoutId, was=$currentLayoutId)")
                    handler.post {
                        hideStatus()
                        if (::mediaPlayer.isInitialized) mediaPlayer.stop()
                        playlistController.stop()
                        playerView.visibility = View.GONE
                        imageView.visibility = View.GONE
                        zoneManager?.setupZones(layoutZones, layoutId)
                        zoneManager?.renderAssignments(assignments, config.serverUrl, contentCache)
                        zoneManager?.lastAssignmentSig = assignmentSig
                    }
                } else if (changed) {
                    Log.i("MainActivity", "Multi-zone assignments changed, re-rendering")
                    handler.post {
                        zoneManager?.renderAssignments(assignments, config.serverUrl, contentCache)
                        zoneManager?.lastAssignmentSig = assignmentSig
                    }
                } else {
                    Log.i("MainActivity", "Multi-zone unchanged, skipping")
                }
            } else {
                // Single-zone mode - use PlaylistController (existing behavior)
                if (zoneManager?.hasZones() == true) handler.post { zoneManager?.cleanup() }
                playlistController.updatePlaylist(assignments)
            }

            // Download any missing local content (skip remote URLs)
            thread {
                for (i in 0 until assignments.length()) {
                    val item = assignments.getJSONObject(i)
                    val contentId = item.getString("content_id")
                    val filename = item.optString("filename", "content")
                    val remoteUrl = item.optString("remote_url", null)

                    // Skip remote URL content - it streams directly
                    if (!remoteUrl.isNullOrEmpty()) {
                        wsService?.sendContentAck(contentId, "ready")
                        continue
                    }

                    if (!contentCache.isContentCached(contentId)) {
                        Log.i("MainActivity", "Downloading content: $filename")
                        var downloaded = false
                        for (attempt in 1..3) {
                            val file = contentCache.downloadContent(config.serverUrl, contentId, filename)
                            if (file != null) {
                                wsService?.sendContentAck(contentId, "ready")
                                downloaded = true
                                break
                            }
                            Log.w("MainActivity", "Download attempt $attempt failed for $filename")
                            if (attempt < 3) Thread.sleep(2000L * attempt)
                        }
                        if (!downloaded) wsService?.sendContentAck(contentId, "failed")
                    }
                }

                // Start or resume playback after downloads complete
                handler.post {
                    playlistController.startIfNeeded()
                }
            }
            } // end else (not suspended)
            } catch (e: Exception) {
                Log.e("MainActivity", "Playlist update error: ${e.message}")
            }
        }

        wsService?.onContentDelete = { contentId ->
            contentCache.deleteContent(contentId)
            playlistController.removeContent(contentId)
            // Update cached playlist to reflect deletion
            try {
                val cached = JSONObject(config.cachedPlaylist)
                val arr = cached.optJSONArray("assignments")
                if (arr != null) {
                    val filtered = org.json.JSONArray()
                    for (i in 0 until arr.length()) {
                        val item = arr.getJSONObject(i)
                        if (item.optString("content_id") != contentId) filtered.put(item)
                    }
                    cached.put("assignments", filtered)
                    config.cachedPlaylist = cached.toString()
                }
            } catch (_: Exception) {}
        }

        wsService?.onScreenshotRequest = {
            // Handled by service now
        }

        wsService?.onRemoteStart = {
            // Handled by service now
        }

        // Provide screenshot callback to service (composite capture on main thread)
        wsService?.onCaptureScreenshot = {
            screenshotCapture.captureView(rootView, 40)
        }

        wsService?.onRemoteStop = {
            remoteStreaming = false
            stopScreenshotStreaming()
        }

        wsService?.onRemoteTouch = { x, y, action ->
            when (action) {
                "tap" -> touchInjector.injectTap(rootView, x, y)
                "down" -> touchInjector.injectDown(rootView, x, y)
                "move" -> touchInjector.injectMove(rootView, x, y)
                "up" -> touchInjector.injectUp(rootView, x, y)
            }
        }

        wsService?.onRemoteKey = { _ ->
            // Key injection handled in WebSocketService directly
        }

        wsService?.onCommand = { type, payload ->
            Log.i("MainActivity", "Command received: $type")
            when (type) {
                "reboot", "shutdown", "power_menu" -> {
                    val svc = com.remotedisplay.player.service.PowerAccessibilityService.instance
                    if (svc != null) {
                        svc.showPowerDialog()
                        Log.i("MainActivity", "Power dialog shown via accessibility")
                    } else {
                        Log.w("MainActivity", "Accessibility service not enabled - trying fallback")
                        thread {
                            try { Runtime.getRuntime().exec(arrayOf("input", "keyevent", "--longpress", "26")).waitFor() } catch (_: Exception) {}
                        }
                    }
                }
                "screen_off" -> {
                    thread {
                        try {
                            Runtime.getRuntime().exec(arrayOf("input", "keyevent", "26")).waitFor() // POWER key
                        } catch (e: Exception) {
                            Log.e("MainActivity", "Screen off failed: ${e.message}")
                        }
                    }
                }
                "screen_on" -> {
                    thread {
                        try {
                            Runtime.getRuntime().exec(arrayOf("input", "keyevent", "224")).waitFor() // WAKEUP key
                        } catch (e: Exception) {
                            Log.e("MainActivity", "Screen on failed: ${e.message}")
                        }
                    }
                }
                "launch" -> {
                    val intent = android.content.Intent(this@MainActivity, MainActivity::class.java).apply {
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    }
                    startActivity(intent)
                }
                "update" -> {
                    Log.i("MainActivity", "Force update check triggered")
                    if (::updateChecker.isInitialized) updateChecker.checkForUpdate()
                }
                "refresh" -> {
                    wsService?.connect()
                }
            }
        }

        wsService?.onRegistered = { _ ->
            hideStatus()
        }

        wsService?.onUnpaired = {
            Log.w("MainActivity", "Device removed from server, going to provisioning")
            config.clearPlaylistCache()
            handler.post {
                startActivity(Intent(this, ProvisioningActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
                })
                finish()
            }
        }
    }

    private fun playItem(item: PlaylistItem) {
        hideStatus()

        // YouTube content - play in WebView
        if (item.mimeType == "video/youtube" && !item.remoteUrl.isNullOrEmpty()) {
            Log.i("MainActivity", "Playing YouTube: ${item.remoteUrl}")
            mediaPlayer.playYoutube(item.remoteUrl!!, item.durationSec)
            wsService?.sendPlaybackState(item.contentId, 0f)
            return
        }

        // Remote URL content - stream directly, no download
        if (item.isRemote) {
            Log.i("MainActivity", "Playing remote content: ${item.remoteUrl}")
            if (item.mimeType.startsWith("video/")) {
                mediaPlayer.playVideoFromUrl(item.remoteUrl!!, item.muted)
            } else if (item.mimeType.startsWith("image/")) {
                mediaPlayer.showImageFromUrl(item.remoteUrl!!)
            }
            wsService?.sendPlaybackState(item.contentId, 0f)
            return
        }

        // Local content - download if not cached
        val file = contentCache.getCachedFile(item.contentId)
        if (file == null) {
            Log.w("MainActivity", "Content not cached: ${item.contentId}, downloading...")
            showStatus("Downloading ${item.filename}...")
            thread {
                val downloaded = contentCache.downloadContent(config.serverUrl, item.contentId, item.filename)
                handler.post {
                    if (downloaded != null) {
                        playFile(item, downloaded)
                    } else {
                        showStatus("Download failed: ${item.filename}")
                        handler.postDelayed({ playlistController.next() }, 3000)
                    }
                }
            }
            return
        }

        playFile(item, file)
    }

    private fun playFile(item: PlaylistItem, file: java.io.File) {
        if (item.mimeType.startsWith("video/")) {
            mediaPlayer.playVideo(file, item.muted)
        } else if (item.mimeType.startsWith("image/")) {
            mediaPlayer.showImage(file)
        }

        // Report playback state
        wsService?.sendPlaybackState(item.contentId, 0f)
    }

    private fun showStatus(message: String) {
        statusOverlay.visibility = View.VISIBLE
        statusText.text = message
    }

    private fun hideStatus() {
        statusOverlay.visibility = View.GONE
    }

    private fun captureAndSendScreenshot() {
        Log.i("MainActivity", "Capturing screenshot")
        val base64 = screenshotCapture.captureView(rootView, 40)
        if (base64 != null) {
            Log.i("MainActivity", "Screenshot captured, size=${base64.length} chars, sending...")
            wsService?.sendScreenshot(base64)
        } else {
            Log.e("MainActivity", "Screenshot capture returned null!")
        }
    }

    private fun startScreenshotStreaming() {
        stopScreenshotStreaming()
        screenshotStreamRunnable = object : Runnable {
            override fun run() {
                if (remoteStreaming) {
                    captureAndSendScreenshot()
                    handler.postDelayed(this, 1000) // ~1 FPS
                }
            }
        }
        handler.post(screenshotStreamRunnable!!)
    }

    private fun stopScreenshotStreaming() {
        screenshotStreamRunnable?.let { handler.removeCallbacks(it) }
        screenshotStreamRunnable = null
    }

    private fun handleRemoteKey(keycode: String) {
        // Use shell `input keyevent` for system keys (HOME, BACK, etc.)
        // This works from the app process on most Android TV devices
        thread {
            try {
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
                    else -> return@thread
                }
                Log.i("MainActivity", "Injecting key: $keycode ($code)")
                val process = Runtime.getRuntime().exec(arrayOf("input", "keyevent", code))
                process.waitFor()
                Log.i("MainActivity", "Key injection result: ${process.exitValue()}")
            } catch (e: Exception) {
                Log.e("MainActivity", "Key injection failed: ${e.message}")
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // Don't exit the app on back press - this is a kiosk/signage app
        Log.i("MainActivity", "Back press intercepted (kiosk mode)")
    }

    private fun isAccessibilityEnabled(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val myComponent = ComponentName(this, com.remotedisplay.player.service.PowerAccessibilityService::class.java)
        return am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
            it.resolveInfo.serviceInfo.let { si -> ComponentName(si.packageName, si.name) == myComponent }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        // Home press brings us back - just re-apply immersive mode
        Log.i("MainActivity", "onNewIntent - returning to foreground")
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )
    }

    override fun onDestroy() {
        remoteStreaming = false
        zoneManager?.cleanup()
        if (::mediaPlayer.isInitialized) {
            stopScreenshotStreaming()
            mediaPlayer.release()
        }
        if (bound) {
            try { unbindService(connection) } catch (_: Exception) {}
            bound = false
        }
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
        }
    }
}
