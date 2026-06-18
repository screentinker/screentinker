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
import android.view.ViewGroup
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
import com.remotedisplay.player.player.PipOverlay
import com.remotedisplay.player.player.WallController
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
    private lateinit var wallController: WallController
    private lateinit var pipOverlay: PipOverlay // #109: PiP overlay layer

    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusOverlay: View
    private lateinit var statusText: TextView
    private lateinit var rootView: View
    private var currentOrientation: String? = null

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

        // The display is up now — clear the boot "Starting display…" notification.
        (getSystemService(Context.NOTIFICATION_SERVICE) as? android.app.NotificationManager)?.cancel(999)

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

        // #109: PiP overlay layer (top child of rootLayout; inherits the orientation
        // transform). Reports show/clear over device:log (tag "pip").
        pipOverlay = PipOverlay(this, findViewById(R.id.pipLayout)) { level, message ->
            wsService?.sendLog("pip", level, message)
        }

        // Setup zone manager for multi-zone layouts
        zoneManager = ZoneManager(this, rootView as FrameLayout) {
            playlistController.onVideoComplete()
        }

        // Setup playlist controller
        playlistController = PlaylistController(
            onItemChanged = { item -> item?.let { playItem(it) } },
            // #74/#75: clear the last frame when going idle (else a now-filtered item lingers on screen)
            onPlaylistEmpty = { if (::mediaPlayer.isInitialized) mediaPlayer.stop(); showStatus(getString(R.string.waiting_for_content)) },
            onRequestRefresh = { wsService?.requestPlaylistRefresh() },
            onNothingScheduled = { if (::mediaPlayer.isInitialized) mediaPlayer.stop(); showStatus(getString(R.string.nothing_scheduled)) }
        )

        // Setup media player
        val youtubeWebView = findViewById<android.webkit.WebView>(R.id.youtubeWebView)
        mediaPlayer = MediaPlayerManager(
            context = this,
            playerView = playerView,
            imageView = imageView,
            youtubeWebView = youtubeWebView,
            onVideoComplete = { playlistController.onVideoComplete() },
            onImageError = {
                Log.w("MainActivity", "Image failed to load, skipping to next item")
                handler.postDelayed({ playlistController.next() }, 500)
            }
        )

        // Video-wall controller. The emit lambdas read wsService lazily (it's bound after
        // onCreate), and they no-op until the socket is connected (guarded in the service).
        wallController = WallController(
            media = mediaPlayer,
            playlist = playlistController,
            deviceId = { config.deviceId },
            emitSync = { wallId, idx, contentId, posSec -> wsService?.emitWallSync(wallId, idx, contentId, posSec) },
            emitSyncRequest = { wallId -> wsService?.emitWallSyncRequest(wallId) },
            applyTransform = { cfg -> applyWallTransform(cfg) }
        )

        // Restore cached playlist for offline cold-start (play immediately from disk cache).
        // Catch Throwable (not just Exception) so an OOM or corrupt entry can't kill the app
        // before the WebSocket connects — that's the crash-loop scenario. If the cache is
        // unusable for any reason, drop it and continue; the server will resend on connect.
        val cachedJson = config.cachedPlaylist
        if (cachedJson.isNotEmpty()) {
            try {
                val cached = JSONObject(cachedJson)
                val assignments = cached.getJSONArray("assignments")
                if (assignments.length() > 0) {
                    Log.i("MainActivity", "Restoring cached playlist: ${assignments.length()} items")
                    // #74/#75: restore the cached effective timezone too (offline schedules)
                    playlistController.setTimezone(if (cached.isNull("timezone")) null else cached.optString("timezone", "").ifEmpty { null })
                    playlistController.updatePlaylist(assignments)
                    playlistController.startIfNeeded()
                }
            } catch (e: Throwable) {
                Log.w("MainActivity", "Failed to restore cached playlist, clearing cache: ${e.message}")
                try { config.clearPlaylistCache() } catch (_: Throwable) {}
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

    // Rotate the whole stage in software so portrait / flipped signage works even on
    // fixed-landscape hardware (Fire TV, Android TV and most signage sticks ignore
    // setRequestedOrientation - they can't physically rotate the panel). Resizes
    // rootView to the rotated dimensions, recenters, and rotates. Covers single-zone
    // (playerView/imageView/youtubeWebView) and multi-zone (ZoneManager renders into
    // the same rootView). Values mirror the dashboard: landscape / portrait /
    // landscape-flipped / portrait-flipped.
    private fun applyOrientation(orientation: String) {
        if (orientation == currentOrientation) return
        currentOrientation = orientation
        val m = resources.displayMetrics
        val w = m.widthPixels.toFloat()
        val h = m.heightPixels.toFloat()
        val (rot, swap) = when (orientation) {
            "portrait" -> 90f to true
            "portrait-flipped" -> 270f to true
            "landscape-flipped" -> 180f to false
            else -> 0f to false   // landscape
        }
        val lp = rootView.layoutParams
        lp.width = (if (swap) h else w).toInt()
        lp.height = (if (swap) w else h).toInt()
        rootView.layoutParams = lp
        rootView.translationX = if (swap) (w - h) / 2f else 0f
        rootView.translationY = if (swap) (h - w) / 2f else 0f
        rootView.rotation = rot
        rootView.requestLayout()
        Log.i("MainActivity", "Applied orientation: $orientation (rotation=$rot, swap=$swap)")
    }

    private fun parseWallConfig(wc: JSONObject): WallController.WallConfig {
        fun rect(key: String): WallController.Rect {
            val o = wc.optJSONObject(key)
            return WallController.Rect(
                x = o?.optDouble("x", 0.0)?.toFloat() ?: 0f,
                y = o?.optDouble("y", 0.0)?.toFloat() ?: 0f,
                w = o?.optDouble("w", 0.0)?.toFloat() ?: 0f,
                h = o?.optDouble("h", 0.0)?.toFloat() ?: 0f
            )
        }
        return WallController.WallConfig(
            wallId = wc.optString("wall_id", ""),
            screen = rect("screen_rect"),
            player = rect("player_rect"),
            isLeader = wc.optBoolean("is_leader", false),
            rotation = wc.optInt("rotation", 0)
        )
    }

    // Video-wall slice transform. The content view represents the whole wall (player_rect);
    // size + offset rootView so this screen's screen_rect fills the device viewport, content
    // stretched to fill (object-fit:fill parity, set on the views via MediaPlayerManager).
    // Mirrors the web player's vw/vh stage math. Per-tile rotation is intentionally not
    // applied (web/Tizen parity). cfg == null restores full screen.
    private fun applyWallTransform(cfg: WallController.WallConfig?) {
        val lp = rootView.layoutParams
        if (cfg == null) {
            lp.width = ViewGroup.LayoutParams.MATCH_PARENT
            lp.height = ViewGroup.LayoutParams.MATCH_PARENT
            rootView.layoutParams = lp
            rootView.translationX = 0f
            rootView.translationY = 0f
            rootView.rotation = 0f
            rootView.scaleX = 1f
            rootView.scaleY = 1f
            rootView.requestLayout()
            // Force the next playlist update to re-apply orientation (applyOrientation
            // early-returns when the value is unchanged).
            currentOrientation = null
            Log.i("MainActivity", "Wall transform cleared (restored full screen)")
            return
        }
        val s = cfg.screen
        val p = cfg.player
        if (s.w == 0f || s.h == 0f) {
            Log.w("MainActivity", "Wall screen_rect has zero size; skipping transform")
            return
        }
        val dw = resources.displayMetrics.widthPixels.toFloat()
        val dh = resources.displayMetrics.heightPixels.toFloat()
        lp.width = ((p.w / s.w) * dw).toInt()
        lp.height = ((p.h / s.h) * dh).toInt()
        rootView.layoutParams = lp
        rootView.translationX = ((p.x - s.x) / s.w) * dw   // negative for right/lower tiles
        rootView.translationY = ((p.y - s.y) / s.h) * dh
        rootView.rotation = 0f                              // per-tile rotation: TODO (parity = none)
        rootView.scaleX = 1f
        rootView.scaleY = 1f
        rootView.requestLayout()
        // Orientation no longer reflects reality; ensure it re-applies after wall exit.
        currentOrientation = null
        Log.i("MainActivity", "Wall transform: size=${lp.width}x${lp.height} tx=${rootView.translationX} ty=${rootView.translationY}")
    }

    private fun setupServiceCallbacks() {
        wsService?.onPlaylistUpdate = { data ->
            try {
            // Orientation is applied in the non-wall branch below; wall mode owns the
            // root-view transform itself and must not be rotated.
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

            // #74/#75: device-effective IANA timezone for per-item schedule evaluation
            val effectiveTz = if (data.isNull("timezone")) null else data.optString("timezone", "").ifEmpty { null }
            playlistController.setTimezone(effectiveTz)
            zoneManager?.setTimezone(effectiveTz)

            // Cache playlist JSON for offline cold-start
            config.cachedPlaylist = data.toString()

            // Video-wall mode takes precedence over orientation + multi-zone: the wall is
            // fullscreen, and WallController owns the root-view slice transform and the
            // leader/follower role. (We're on the main thread here — onPlaylistUpdate is
            // posted to the main looper by WebSocketService.)
            val wallObj = if (data.isNull("wall_config")) null else data.optJSONObject("wall_config")
            if (wallObj != null) {
                com.remotedisplay.player.util.DebugLog.i("Player", "Layout: VIDEO-WALL (${assignments.length()} assignments)")
                if (zoneManager?.hasZones() == true) zoneManager?.cleanup()
                wallController.apply(parseWallConfig(wallObj))
                playlistController.updatePlaylist(assignments)
            } else {
            wallController.exit()
            applyOrientation(data.optString("orientation", "landscape"))

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

                com.remotedisplay.player.util.DebugLog.i("Player", "Layout: MULTI-ZONE (${layoutZones.length()} zones, layout=$layoutId), ${assignments.length()} assignments")
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
                com.remotedisplay.player.util.DebugLog.i("Player", "Layout: SINGLE/FULLSCREEN (${layoutZones?.length() ?: 0} zones), ${assignments.length()} assignments")
                if (zoneManager?.hasZones() == true) handler.post { zoneManager?.cleanup() }
                playlistController.updatePlaylist(assignments)
            }
            } // end else (not a video wall)

            // Download any missing local content (skip remote URLs).
            // Runs for wall + single-zone; multi-zone drives its own rendering via ZoneManager
            // (the startIfNeeded below is guarded so it won't run behind zones).
            thread {
                for (i in 0 until assignments.length()) {
                    val item = assignments.getJSONObject(i)
                    // Widget assignments have no downloadable content file - skip
                    // (also avoids getString throwing on a null content_id).
                    val widgetId = if (item.isNull("widget_id")) "" else item.optString("widget_id", "")
                    if (widgetId.isNotEmpty()) continue
                    val contentId = if (item.isNull("content_id")) "" else item.optString("content_id", "")
                    if (contentId.isEmpty()) continue
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

                // Start or resume playback after downloads complete — but ONLY in
                // single-zone/fullscreen mode. In multi-zone, ZoneManager drives each
                // zone; restarting the fullscreen controller here made it keep playing
                // items behind the zones (wasted work + phantom audio for videos).
                handler.post {
                    if (zoneManager?.hasZones() != true) playlistController.startIfNeeded()
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

        wsService?.onWallSync = { data -> if (::wallController.isInitialized) wallController.onSync(data) }
        wsService?.onWallSyncRequest = { data -> if (::wallController.isInitialized) wallController.onSyncRequest(data) }

        // #109: PiP overlay show/clear (posted to the main thread by the service).
        wsService?.onPipShow = { data -> if (::pipOverlay.isInitialized) pipOverlay.show(data) }
        wsService?.onPipClear = { data -> if (::pipOverlay.isInitialized) pipOverlay.clearFrom(data) }

        // #129: real-time mute. Apply immediately if the toggled item is the one playing now;
        // otherwise it's already persisted server-side and lands via the next playlist update.
        wsService?.onMuteChanged = { data ->
            val contentId = if (data.isNull("content_id")) "" else data.optString("content_id", "")
            val current = playlistController.currentContentId ?: ""
            if (contentId.isNotEmpty() && contentId == current && ::mediaPlayer.isInitialized) {
                mediaPlayer.setVideoMuted(data.optBoolean("muted", false))
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
        com.remotedisplay.player.util.DebugLog.i("Player", "playItem: ${item.filename} mime=${item.mimeType} widget=${item.widgetId ?: "-"} zone=fullscreen")

        // Widget content - render fullscreen in a WebView (single-zone / fullscreen
        // layouts; multi-zone widgets go through ZoneManager). Previously unhandled,
        // so widgets were blank/broken in default-fullscreen and the fullscreen template.
        if (item.isWidget) {
            val url = "${config.serverUrl}/api/widgets/${item.widgetId}/render"
            Log.i("MainActivity", "Playing widget fullscreen: $url")
            mediaPlayer.showWidget(url)
            wsService?.sendPlaybackState(item.contentId.ifEmpty { item.widgetId ?: "" }, 0f)
            return
        }

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
        if (::pipOverlay.isInitialized) pipOverlay.clear(null) // #109: tear down overlay WebView
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
