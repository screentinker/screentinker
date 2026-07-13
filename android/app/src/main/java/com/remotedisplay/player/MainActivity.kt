package com.remotedisplay.player

import android.accessibilityservice.AccessibilityServiceInfo
import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.EditText
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
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.ui.PlayerView
import com.remotedisplay.player.data.ContentCache
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.player.MediaPlayerManager
import com.remotedisplay.player.player.PlaylistController
import com.remotedisplay.player.player.PlaylistItem
import com.remotedisplay.player.player.PipOverlay
import com.remotedisplay.player.player.WallController
import com.remotedisplay.player.player.GroupScheduleController
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
    private lateinit var downloadCoordinator: com.remotedisplay.player.data.DownloadCoordinator
    private lateinit var screenshotCapture: ScreenshotCapture
    private lateinit var touchInjector: TouchInjector

    private var wsService: WebSocketService? = null
    private var bound = false
    private lateinit var mediaPlayer: MediaPlayerManager
    private lateinit var playlistController: PlaylistController
    private lateinit var updateChecker: UpdateChecker
    private var zoneManager: ZoneManager? = null
    private lateinit var wallController: WallController
    private lateinit var groupSchedule: GroupScheduleController
    private lateinit var pipOverlay: PipOverlay // #109: PiP overlay layer

    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusOverlay: View
    private lateinit var statusText: TextView
    private lateinit var rootView: View
    private lateinit var pipLayout: FrameLayout       // #109: reparented above rootView (see onCreate)
    private lateinit var captureRoot: View            // window content; capture source (includes pipLayout)
    private var currentOrientation: String? = null

    private val handler = Handler(Looper.getMainLooper())
    private var remoteStreaming = false
    private var screenshotStreamRunnable: Runnable? = null
    private var playbackStarted = false

    // Multi-tap BACK/ESC for hidden settings menu.
    // Collect taps in a 2-second window; on expiry: 2 taps → PIN → settings, 3+ taps → exit.
    private val backTapTimes = mutableListOf<Long>()
    private var backTapRunnable: Runnable? = null
    private val TAP_WINDOW_MS = 1800L
    // Connection-failure auto-prompt threshold.
    private var failureBannerShown = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as WebSocketService.LocalBinder
            wsService = binder.getService()
            bound = true
            setupServiceCallbacks()
            wsService?.connect()
            // If the service is ALREADY connected+registered when we bind (MainActivity relaunched
            // via CLEAR_TASK right after a re-pair/reclaim, so the onRegistered that clears the boot
            // "Connecting to server…" status fired before this Activity existed), catch the UI up by
            // pulling a fresh playlist — its update drives the real status (playing / waiting-for-
            // content / nothing-scheduled), replacing the stale "Connecting to server…". Without this
            // a fully-online device could sit on "Connecting to server…" indefinitely. We keep the
            // boot status until the playlist arrives (no blank screen) rather than blindly hiding it.
            if (wsService?.isConnected() == true && !playlistController.isPlaying) {
                ackedContent.clear()
                wsService?.requestPlaylistRefresh()
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            wsService = null
            bound = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        config = ServerConfig(this)
        // #device-owner: undo any prior restrictive permitted-accessibility policy set by an older
        // build. Runs on every launch (cheap, idempotent, owner-guarded) so a panel enrolled before
        // this change gets the restriction cleared after it OTA-updates — no re-provision needed.
        try { com.remotedisplay.player.admin.STPolicy(this).clearAccessibilityRestriction() } catch (_: Throwable) {}
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
        // #160: re-apply the persisted per-window brightness so it survives a relaunch.
        try { systemControl.applyPersistedWindowBrightness(window) } catch (_: Throwable) {}

        contentCache = ContentCache(this)
        // Coordinated background downloads (single-flight + bounded pool + backoff) — reconnect-safe.
        downloadCoordinator = com.remotedisplay.player.data.DownloadCoordinator(
            cache = contentCache,
            serverUrl = { config.serverUrl },
            socketAlive = { wsService?.isConnected() == true },
            onAck = { cid, status -> ackContentOnce(cid, status) }
        )
        screenshotCapture = ScreenshotCapture()
        touchInjector = TouchInjector()

        playerView = findViewById(R.id.playerView)
        imageView = findViewById(R.id.imageView)
        statusOverlay = findViewById(R.id.statusOverlay)
        statusText = findViewById(R.id.statusText)
        rootView = findViewById(R.id.rootLayout)

        // Hide player controls
        playerView.useController = false

        val youtubeWebView = findViewById<android.webkit.WebView>(R.id.youtubeWebView)

        // #109 fix (1): the PiP layer must render ABOVE the YouTube WebView's video plane.
        // As the last child of rootLayout it sat in the SAME compositing band as the WebView
        // and was occluded by the playing video surface. Reparent it OUT of rootLayout to the
        // window content (android.R.id.content), as a top-level sibling drawn AFTER rootLayout
        // — so it composites above the WebView. applyOrientation()/applyWallTransform() mirror
        // rootView's transform onto it so corner positions still track the rotated content,
        // and the remote-view screenshot captures `captureRoot` (content) so the PiP is still
        // included. See docs/109-android-pip-visibility.md.
        captureRoot = findViewById(android.R.id.content)
        pipLayout = findViewById(R.id.pipLayout)
        (pipLayout.parent as? ViewGroup)?.removeView(pipLayout)
        (captureRoot as ViewGroup).addView(
            pipLayout,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        )

        // #109: PiP overlay layer. Reports show/clear over device:log (tag "pip"); rootView +
        // youtubeWebView are passed for pipDebug geometry logging only.
        pipOverlay = PipOverlay(this, pipLayout, rootView, youtubeWebView) { level, message ->
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
            onNothingScheduled = { if (::mediaPlayer.isInitialized) mediaPlayer.stop(); showStatus(getString(R.string.nothing_scheduled)) },
            // Screen-resilience: the defined "waiting for content" state — ONLY on a fresh device
            // with nothing to show yet (never while content is on screen; that path keeps current).
            onWaitingForContent = { if (::mediaPlayer.isInitialized) mediaPlayer.stop(); showStatus(getString(R.string.waiting_for_content)) }
        )
        // Screen-resilience: an item is playable only when its content is actually available —
        // a widget, a remote stream, or a fully-downloaded local file. A not-yet/failed download is
        // skipped (kept in the background) instead of blanking the screen on a loading state.
        playlistController.setContentReadyCheck { item ->
            item.isWidget || item.isRemote || contentCache.isContentCached(item.contentId)
        }

        // Setup media player
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
            emitSync = { isGroup, id, idx, contentId, posSec ->
                if (isGroup) wsService?.emitGroupSync(id, idx, contentId, posSec)
                else wsService?.emitWallSync(id, idx, contentId, posSec)
            },
            emitSyncRequest = { isGroup, id ->
                if (isGroup) wsService?.emitGroupSyncRequest(id) else wsService?.emitWallSyncRequest(id)
            },
            applyTransform = { cfg -> applyWallTransform(cfg) }
        )

        // #group-sync: clock/schedule group sync (no leader, offline-native). Reads the disciplined
        // clock from the bound service; streams diagnostics to the dashboard live-log (tag 'sync').
        groupSchedule = GroupScheduleController(
            playlist = playlistController,
            media = mediaPlayer,
            syncedNow = { wsService?.syncedNowMs() ?: System.currentTimeMillis() },
            report = { msg -> wsService?.sendLog("sync", "info", msg) },
            // Double buffer: warm the NEXT clip's second player if it's a locally-cached video, so the
            // boundary switch is a warm swap (no black hold). Non-video / uncached items just skip it.
            onPreloadNext = { idx ->
                val next = playlistController.itemAt(idx)
                if (next != null && !next.isRemote && next.mimeType.startsWith("video/")) {
                    contentCache.getCachedFile(next.contentId)?.let { mediaPlayer.preloadVideo(it) }
                }
            }
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
                    // #group-sync: if this device was in a sync group, resume the schedule immediately
                    // from the cached clock offset — a reboot mid-outage comes back aligned, no server.
                    val cg = if (cached.isNull("group_sync")) null else cached.optJSONObject("group_sync")
                    if (cg != null) groupSchedule.apply(cg.optString("group_id"))
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
        // #139: surface OTA status (applying / backing off / manual-update-required) to the
        // dashboard. wsService is read lazily — it binds after this runs.
        updateChecker.otaLogReporter = { level, msg -> wsService?.sendLog("ota", level, msg) }
        // #139 Phase 2 (Option B): announce OTA status transitions (clear / enter-backoff) so the
        // dashboard badge clears/lights up promptly without waiting for a reconnect.
        updateChecker.otaStatusReporter = { wsService?.sendOtaStatus() }
        updateChecker.startPeriodicCheck()

        // Periodic connection-failure check so the "Stuck connecting?" banner appears
        // without waiting for the next playlist update
        val failureCheck = object : Runnable {
            override fun run() {
                checkConnectionFailureBanner()
                handler.postDelayed(this, 30_000L)
            }
        }
        handler.postDelayed(failureCheck, 15_000L)

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
        mirrorTransformToPip()
        Log.i("MainActivity", "Applied orientation: $orientation (rotation=$rot, swap=$swap)")
    }

    // #109: pipLayout was reparented out of rootView (to draw above the WebView), so it no
    // longer inherits the orientation/wall transform. Copy rootView's current size + transform
    // onto it verbatim so the PiP box still lands in the same rotated coordinate space as the
    // visible content (mirrors the web/Tizen players, which apply the same transform to #pip
    // as to #stage). Called after every rootView transform change.
    private fun mirrorTransformToPip() {
        if (!::pipLayout.isInitialized) return
        val rl = rootView.layoutParams
        val pl = pipLayout.layoutParams
        pl.width = rl.width
        pl.height = rl.height
        pipLayout.layoutParams = pl
        pipLayout.translationX = rootView.translationX
        pipLayout.translationY = rootView.translationY
        pipLayout.rotation = rootView.rotation
        pipLayout.scaleX = rootView.scaleX
        pipLayout.scaleY = rootView.scaleY
        pipLayout.requestLayout()
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

    // #group-sync: fullscreen synchronized playback — no tile geometry, just id + leader role.
    private fun parseGroupConfig(gs: JSONObject): WallController.WallConfig {
        val zero = WallController.Rect(0f, 0f, 0f, 0f)
        return WallController.WallConfig(
            wallId = gs.optString("group_id", ""),
            screen = zero, player = zero, rotation = 0,
            isLeader = gs.optBoolean("is_leader", false),
            mode = WallController.Mode.GROUP
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
            mirrorTransformToPip()
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
        mirrorTransformToPip()
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
                groupSchedule.exit()                 // wall and group are mutually exclusive
                wallController.apply(parseWallConfig(wallObj))
                playlistController.updatePlaylist(assignments)
            } else {
            // #group-sync: not a wall — enter clock/schedule group sync if the payload carries a
            // group_sync block, else leave it. No leader/relay: the schedule tick drives index +
            // position locally (offline-native). Content renders through the normal path below.
            wallController.exit()                    // never in wall mode here
            val groupObj = if (data.isNull("group_sync")) null else data.optJSONObject("group_sync")
            if (groupObj != null) groupSchedule.apply(groupObj.optString("group_id")) else groupSchedule.exit()
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
                    // org.json's optString(key, null) returns the STRING "null" when the value is JSON
                    // null (not the fallback) — so a local item with "remote_url": null was being
                    // misclassified as a remote stream, ack'd "ready", and NEVER downloaded, stranding
                    // the screen on "waiting for content". Guard with isNull() like widget_id/content_id above.
                    val remoteUrl = if (item.isNull("remote_url")) null else item.optString("remote_url", null)

                    // Skip remote URL content - it streams directly
                    if (!remoteUrl.isNullOrEmpty()) {
                        ackContentOnce(contentId, "ready")
                        continue
                    }

                    // Background download is now COORDINATED: single-flight per contentId + a bounded
                    // pool + failure backoff. So a watchdog/ConnectionGuard reconnect mid-fetch can't
                    // spawn a duplicate racing the .part, orphan/pile up threads, or storm a failing
                    // URL. ensure() is non-blocking and idempotent: it re-acks cached content (SEED-A),
                    // defers when the socket is down (watchdog owns recovery), respects backoff, and
                    // downloads at most once. It acks ready/failed itself (deduped via onAck).
                    downloadCoordinator.ensure(contentId, filename)
                }

                // Start/resume playback immediately — do NOT wait on downloads (they're async now).
                // Screen-resilience plays whatever is cached and skips not-yet-ready items; the 3s
                // recheck swaps new content in once its download completes. Single-zone only; in
                // multi-zone, ZoneManager drives each zone.
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
            downloadCoordinator.forget(contentId) // drop in-flight/backoff state so a re-add re-downloads
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

        // Provide screenshot callback to service (composite capture on main thread).
        // Capture the window content (not just rootView) so the reparented #109 PiP layer
        // is included in remote-view screenshots.
        wsService?.onCaptureScreenshot = {
            screenshotCapture.captureView(captureRoot, 40)
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
                // #161 Tier-2: real reboot on a device owner. The `input keyevent`/power-dialog hacks
                // are retired — off-owner we best-effort the accessibility power dialog, else report
                // unsupported (never the denied exec, which was theater on a non-rooted panel).
                "reboot", "shutdown", "power_menu" -> {
                    if (stPolicy().reboot()) {
                        Log.i("MainActivity", "Reboot via device owner")
                    } else {
                        val svc = com.remotedisplay.player.service.PowerAccessibilityService.instance
                        if (svc != null) svc.showPowerDialog()
                        else Log.w("MainActivity", "reboot: not device owner and no accessibility — unsupported on this panel")
                    }
                }
                // Screen off = real lock on owner/admin (FORCE_LOCK), else accessibility lock. Exec retired.
                "screen_off", "lock_now" -> {
                    if (!stPolicy().lockNow()) {
                        com.remotedisplay.player.service.PowerAccessibilityService.instance?.lockScreen()
                            ?: Log.w("MainActivity", "screen_off/lock_now: no owner/admin/accessibility — unsupported")
                    }
                }
                // No reliable privileged wake on a non-rooted panel (the old keyevent 224 was denied);
                // retired to a logged no-op.
                "screen_on" -> Log.w("MainActivity", "screen_on: no privileged wake path on a non-rooted panel — no-op")
                // #161 Tier-2 (all no-op off-owner via STPolicy): kiosk lock-task, time/tz, status bar,
                // uninstall block. Device owner enters lock-task silently; others get screen-pinning.
                "kiosk_lock" -> {
                    stPolicy().setLockTaskAllowed(true)
                    try { startLockTask() } catch (e: Throwable) { Log.w("MainActivity", "startLockTask: ${e.message}") }
                }
                "kiosk_unlock" -> {
                    try { stopLockTask() } catch (e: Throwable) { Log.w("MainActivity", "stopLockTask: ${e.message}") }
                    stPolicy().setLockTaskAllowed(false)
                }
                "set_time" -> { val ms = payload?.optLong("millis", 0L) ?: 0L; if (ms > 0) stPolicy().setTime(ms) }
                "set_timezone" -> { val tz = payload?.optString("timezone", "") ?: ""; if (tz.isNotEmpty()) stPolicy().setTimeZone(tz) }
                "status_bar" -> stPolicy().setStatusBarDisabled(payload?.optBoolean("disabled", true) ?: true)
                "block_uninstall" -> stPolicy().setUninstallBlocked(true)
                "unblock_uninstall" -> stPolicy().setUninstallBlocked(false)
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
                // #161 device-owner tooling: push + silently install an arbitrary APK from a URL.
                "install_apk" -> {
                    val url = payload?.optString("url", "") ?: ""
                    if (url.isNotBlank() && ::updateChecker.isInitialized) {
                        Log.i("MainActivity", "install_apk from $url")
                        updateChecker.installFromUrl(url)
                    }
                }
                "refresh" -> {
                    wsService?.connect()
                }
                // #160 Track-A system control — NO device owner required. All best-effort (no-op if
                // unsupported at this panel's tier). Tier 0: media volume + per-window brightness.
                "set_volume" -> {
                    val f = payload?.optDouble("level", -1.0) ?: -1.0   // 0..1 of media stream
                    if (f >= 0) { systemControl.setMediaVolume(f); wsService?.reportInfoNow() }
                }
                "set_brightness" -> {                                    // per-window (Tier 0); -1 = follow system
                    val f = payload?.optDouble("level", -1.0) ?: -1.0
                    runOnUiThread { systemControl.setWindowBrightness(window, f); wsService?.reportInfoNow() }
                }
                // Tier 1: system-wide brightness. WRITE_SETTINGS OR a device owner (setSystemSetting).
                "set_system_brightness" -> {
                    val f = payload?.optDouble("level", -1.0) ?: -1.0
                    if (f >= 0) { systemControl.setSystemBrightness(f); wsService?.reportInfoNow() }
                }
                "set_screen_timeout" -> {                                // ms; <=0 = never
                    val ms = payload?.optInt("ms", -1) ?: -1
                    if (ms != -1) { systemControl.setScreenOffTimeout(ms); wsService?.reportInfoNow() }
                }
                // #109 debug: toggle the PiP magenta-box + geometry logging (default off).
                // device:command {type:"pip_debug", payload:{enabled:true}}.
                "pip_debug" -> {
                    val on = payload?.optBoolean("enabled", false) ?: false
                    if (::pipOverlay.isInitialized) pipOverlay.pipDebug = on
                    Log.i("MainActivity", "PiP debug ${if (on) "ENABLED" else "disabled"}")
                }
            }
        }

        wsService?.onWallSync = { data -> if (::wallController.isInitialized) wallController.onSync(data) }
        wsService?.onWallSyncRequest = { data -> if (::wallController.isInitialized) wallController.onSyncRequest(data) }
        // #group-sync is clock/schedule now (no leader relay). The server only nudges an immediate
        // re-align (dashboard "Resync now"); the schedule tick otherwise runs entirely locally.
        wsService?.onGroupResync = { if (::groupSchedule.isInitialized) groupSchedule.resync() }

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
            // Root-2 (SEED-B): a disconnect may have dropped in-flight content-acks. Clear the
            // de-dup set so the next playlist-update re-acks all content and the CMS re-syncs.
            ackedContent.clear()
        }

        wsService?.onUnpaired = {
            Log.w("MainActivity", "Device removed from server, going to provisioning for re-pair")
            config.clearPlaylistCache()
            handler.post {
                startActivity(Intent(this, ProvisioningActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
                    // Tell provisioning this is a server-initiated re-pair (known-good URL) so it
                    // shows a "waiting for re-pair" status + the code instead of the URL entry.
                    putExtra("EXTRA_REPAIR", true)
                })
                finish()
            }
        }
    }

    // Root-2 content-ack de-dup. Re-acking content state (SEED-A) fixes the CMS "stuck downloading"
    // label, but we must not re-ack the same (content,status) every 60s playlist refresh. This set
    // is cleared on each (re)registration (see onRegistered) so a reconnect re-acks everything the
    // server may have missed while we were disconnected (SEED-B), but is quiet within a session.
    private val ackedContent = java.util.Collections.synchronizedSet(HashSet<String>())

    private fun ackContentOnce(contentId: String, status: String) {
        if (ackedContent.add("$contentId:$status")) {
            // a status change for this content supersedes the opposite one
            ackedContent.remove("$contentId:${if (status == "ready") "failed" else "ready"}")
            wsService?.sendContentAck(contentId, status)
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
            mediaPlayer.playYoutube(item.remoteUrl!!, item.durationSec, item.muted)
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

        // Local content - play from cache. Screen-resilience: the controller only advances to
        // items whose content is READY, so reaching here uncached is a rare race (e.g. the file
        // was evicted between selection and play). NEVER blank or show a "Downloading…" screen —
        // keep whatever is on screen and move on; the background download loop (onPlaylistUpdate)
        // fetches it and it plays once fully + validly downloaded. Content update is a BACKGROUND
        // operation; we only ever SWAP to fully-downloaded content.
        val file = contentCache.getCachedFile(item.contentId)
        if (file == null) {
            Log.i("MainActivity", "Content not ready at play time (${item.filename}) — keeping screen, advancing (bg download continues)")
            downloadCoordinator.ensure(item.contentId, item.filename) // ensure it's being fetched (single-flight)
            handler.post { playlistController.next() }
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
        val base64 = screenshotCapture.captureView(captureRoot, 40)
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
        // Don't exit the app on back press - this is a kiosk/signage app.
        // Multi-tap detection is handled in dispatchKeyEvent.
        Log.i("MainActivity", "Back press intercepted (kiosk mode)")
    }

    // Multi-tap BACK/ESC detection — 2 taps → settings, 3+ taps → exit dialog.
    // Catches hardware BACK, D-pad BACK (KEYCODE_BACK=4), and ESC (111).
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                    handleBackTap()
                    return true  // consume — never let the system handle it
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun handleBackTap() {
        val now = System.currentTimeMillis()
        backTapTimes.add(now)

        // Trim taps older than the window
        while (backTapTimes.isNotEmpty() && now - backTapTimes.first() > TAP_WINDOW_MS) {
            backTapTimes.removeAt(0)
        }

        // Cancel any pending evaluation and re-schedule
        backTapRunnable?.let { handler.removeCallbacks(it) }
        backTapRunnable = Runnable {
            val count = backTapTimes.size
            backTapTimes.clear()
            when {
                count >= 3 -> showExitDialog()
                count == 2 -> showPinDialog()
                // count == 1 → ignored (kiosk)
            }
        }
        handler.postDelayed(backTapRunnable!!, TAP_WINDOW_MS)
    }

    private fun showPinDialog() {
        val input = EditText(this).apply {
            inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.settings_pin_hint)
            setSingleLine()
        }
        val container = FrameLayout(this).apply {
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.settings_pin_title))
            .setView(container)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                if (input.text.toString() == config.settingsPin) {
                    showSettingsDialog()
                } else {
                    Toast.makeText(this, getString(R.string.settings_pin_wrong), Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun showSettingsDialog() {
        val serverUrl = config.serverUrl
        val connected = wsService?.isConnected() == true
        val version = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
        } catch (_: Exception) { "?" }

        // #161: live privilege tier for the Hardware control entry.
        val tier = try { com.remotedisplay.player.admin.STPolicy(this).tier() } catch (_: Throwable) { 0 }
        val items = arrayOf(
            "${getString(R.string.settings_change_server)}\n  ${if (serverUrl.isEmpty()) "—" else serverUrl}",
            getString(R.string.settings_reconfigure),
            getString(R.string.settings_permissions),
            "${getString(R.string.settings_hardware_control)}\n  ${hwTierShort(tier)}",
            "${getString(R.string.settings_device_info)}\n  ${getString(R.string.settings_info_device)}: ${config.deviceId.take(8)}…  |  v$version  |  ${if (connected) "●" else "○"}",
            getString(R.string.settings_exit)
        )

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.settings_title))
            .setItems(items) { _, which ->
                when (which) {
                    0 -> showChangeServerDialog(serverUrl)
                    1 -> {
                        config.clearDeviceCredentials()
                        navigateToProvisioning(serverUrl)
                    }
                    2 -> showPermissionsDialog()
                    3 -> showHardwareControlDialog()
                    5 -> showExitDialog()
                    // 4 = info (read-only, dismiss)
                }
            }
            .setOnCancelListener { /* dismissed, back to kiosk */ }
            .show()
    }

    // #161: device-policy wrapper (degrades safely off-tier — every Tier-2 call no-ops when not owner).
    private fun stPolicy() = com.remotedisplay.player.admin.STPolicy(this)
    // #160 Track-A: no-device-owner system control (media volume, brightness, screen-off timeout).
    private val systemControl by lazy { com.remotedisplay.player.system.SystemControl(this) }

    // #161: one-line tier label for the settings list.
    private fun hwTierShort(tier: Int): String = when (tier) {
        2 -> getString(R.string.hw_tier_owner)
        1 -> getString(R.string.hw_tier_admin)
        else -> getString(R.string.hw_tier_none)
    }

    // #161 first-run/guidance surface: show the live privilege tier and, when not owner (and not
    // MDM-managed), the exact ADB enrollment one-liner. "Re-check" re-reads the tier live, so it
    // flips as soon as `dpm set-device-owner` succeeds.
    private fun showHardwareControlDialog() {
        val policy = com.remotedisplay.player.admin.STPolicy(this)
        val tier = policy.tier()
        val foreign = policy.hasForeignDeviceOwner()
        val component = "com.remotedisplay.player/.admin.STDeviceAdminReceiver"
        val msg = buildString {
            append(hwTierShort(tier)); append("\n\n")
            when {
                policy.isDeviceOwner() -> append(getString(R.string.hw_owner_note))
                foreign -> append(getString(R.string.hw_managed_note))
                else -> {
                    append(getString(R.string.hw_enroll_intro)); append("\n\n")
                    append("adb shell dpm set-device-owner\n  $component\n\n")
                    append(getString(R.string.hw_enroll_constraints))
                }
            }
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.settings_hardware_control))
            .setMessage(msg)
            .setPositiveButton(getString(R.string.hw_recheck)) { _, _ -> showHardwareControlDialog() }
            .setNegativeButton(android.R.string.ok, null)
            .show()
    }

    private fun showChangeServerDialog(currentUrl: String) {
        val input = EditText(this).apply {
            setText(currentUrl)
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://screentinker.com"
            setSingleLine()
        }
        val container = FrameLayout(this).apply {
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.settings_change_server))
            .setView(container)
            .setPositiveButton(getString(R.string.settings_save)) { _, _ ->
                val url = input.text.toString().trim().trimEnd('/')
                if (url.isNotEmpty() && url != currentUrl) {
                    config.clearDeviceCredentials()
                    navigateToProvisioning(url)
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun showPermissionsDialog() {
        val accEnabled = isAccessibilityEnabled()
        val notifyGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else true

        val lines = buildString {
            appendLine("${getString(R.string.settings_perm_accessibility)}: ${if (accEnabled) "✓" else "✗"}")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                appendLine("${getString(R.string.settings_perm_notifications)}: ${if (notifyGranted) "✓" else "✗"}")
            }
            appendLine("")
            appendLine(getString(R.string.settings_perm_hint))
        }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.settings_permissions))
            .setMessage(lines)
            .setPositiveButton(getString(R.string.settings_perm_open)) { _, _ ->
                val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun showExitDialog() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.settings_exit_title))
            .setMessage(getString(R.string.settings_exit_confirm))
            .setPositiveButton(getString(R.string.settings_exit_yes)) { _, _ ->
                try {
                    wsService?.disconnect()
                    if (bound) { unbindService(connection); bound = false }
                } catch (_: Exception) {}
                finishAffinity()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun navigateToProvisioning(url: String? = null) {
        try { wsService?.disconnect() } catch (_: Exception) {}
        if (bound) { try { unbindService(connection) } catch (_: Exception) {}; bound = false }
        val intent = Intent(this, ProvisioningActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
            url?.let { putExtra("EXTRA_SERVER_URL", it) }
        }
        startActivity(intent)
        finish()
    }

    private fun checkConnectionFailureBanner() {
        val failures = wsService?.consecutiveFailures ?: 0
        if (failures > 10 && !failureBannerShown && wsService?.isConnected() != true) {
            failureBannerShown = true
            showStatus("${getString(R.string.settings_connection_failed)}\n${getString(R.string.settings_connection_hint)}")
        }
        if (failures == 0) {
            failureBannerShown = false
        }
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
        // Kill the wall/group leader tick BEFORE releasing media. The Handler is on the main looper
        // (outlives this Activity), so a surviving tick would keep broadcasting sync frames against
        // the released player forever — the zombie-leader / split-brain / garbage-position leak.
        if (::wallController.isInitialized) wallController.shutdown()
        if (::groupSchedule.isInitialized) groupSchedule.shutdown()
        if (::downloadCoordinator.isInitialized) downloadCoordinator.shutdown() // cancel in-flight downloads (no orphan/leak)
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
