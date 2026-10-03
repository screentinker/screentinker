package com.remotedisplay.player.player

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class Zone(
    val id: String,
    val name: String,
    val xPercent: Float,
    val yPercent: Float,
    val widthPercent: Float,
    val heightPercent: Float,
    val zIndex: Int,
    val zoneType: String,
    val fitMode: String
)

class ZoneManager(
    private val context: Context,
    private val container: FrameLayout,
    private val onAllVideosComplete: () -> Unit
) {
    private val TAG = "ZoneManager"
    private val handler = Handler(Looper.getMainLooper())
    private val zoneViews = mutableMapOf<String, View>()
    private val zoneExoPlayers = mutableMapOf<String, ExoPlayer>()
    // Per-zone rotation timers: each zone cycles its own list of assignments.
    private val zoneRotators = mutableMapOf<String, Runnable>()
    private var zones = listOf<Zone>()
    // Render context kept for rotation re-renders.
    private var renderServerUrl = ""
    private var renderDeviceId = "" // appended to widget render URLs so widgets can report per-device
    // IPTV: a dwell-0 live stream in a rotating zone re-checks eligibility on this slow cadence
    // (stays if it is still the active pick; advances if a daypart opened a sibling). Never a busy-loop.
    private val LIVE_RECHECK_MS = 60_000L
    private var renderCache: com.remotedisplay.player.data.ContentCache? = null

    var currentLayoutId: String? = null
        private set
    var lastAssignmentSig: String? = null
    // Geometry of the zones currently built. Editing a layout in place keeps its id, so the id
    // alone cannot tell "same layout, same zones" from "same layout, zones changed".
    var lastZoneSig: String? = null

    // #74/#75: device-effective IANA timezone for per-item schedule evaluation.
    @Volatile private var effectiveTimezone: String? = null
    fun setTimezone(tz: String?) { effectiveTimezone = tz }

    fun hasZones(): Boolean = zones.isNotEmpty()

    fun setupZones(zonesJson: JSONArray, layoutId: String? = null) {
        currentLayoutId = layoutId
        cleanup()
        zones = (0 until zonesJson.length()).map { i ->
            val z = zonesJson.getJSONObject(i)
            Zone(
                id = z.getString("id"),
                name = z.optString("name", "Zone"),
                xPercent = z.optDouble("x_percent", 0.0).toFloat(),
                yPercent = z.optDouble("y_percent", 0.0).toFloat(),
                widthPercent = z.optDouble("width_percent", 100.0).toFloat(),
                heightPercent = z.optDouble("height_percent", 100.0).toFloat(),
                zIndex = z.optInt("z_index", 0),
                zoneType = z.optString("zone_type", "content"),
                fitMode = z.optString("fit_mode", "cover")
            )
        }
        Log.i(TAG, "Setup ${zones.size} zones")
    }

    fun renderAssignments(assignments: JSONArray, serverUrl: String, contentCache: com.remotedisplay.player.data.ContentCache, deviceId: String = "") {
        // Clear ONLY our own zone views/timers. `container` is the activity root and
        // also holds the static playerView/imageView/youtubeWebView/statusOverlay -
        // removeAllViews() here would detach those and black the screen on switch-back.
        cancelAllRotations()
        zoneViews.values.forEach { container.removeView(it) }
        zoneViews.clear()
        releaseExoPlayers()
        renderServerUrl = serverUrl
        renderDeviceId = deviceId
        renderCache = contentCache

        val containerWidth = container.width
        val containerHeight = container.height
        if (containerWidth == 0 || containerHeight == 0) {
            // Container not laid out yet, retry after layout.
            container.post { renderAssignments(assignments, serverUrl, contentCache, deviceId) }
            return
        }

        // Group assignments by zone_id, ordered by sort_order so rotation is stable.
        // Zone-orphan fallback: an item whose zone_id isn't a zone in the ACTIVE layout
        // (assigned under a different layout, or the layout was duplicated/switched — copies
        // get fresh zone ids) would otherwise be SILENTLY DROPPED: its bucket matches no
        // rendered zone. Re-bucket it into the LARGEST-area zone's rotation so it shares
        // screen time there (one item at a time -> never overlays existing content) and warn
        // via DebugLog (mirrored to the dashboard device-log when debug is on).
        val validZoneIds = zones.map { it.id }.toHashSet()
        val fallbackZone = zones.maxByOrNull { it.widthPercent * it.heightPercent }
        val assignmentsByZone = mutableMapOf<String?, MutableList<JSONObject>>()
        for (i in 0 until assignments.length()) {
            val a = assignments.getJSONObject(i)
            var zoneId = if (a.isNull("zone_id")) null else a.optString("zone_id", null)
            if (zoneId != null && !validZoneIds.contains(zoneId) && fallbackZone != null) {
                val item = a.optString("filename", "").ifEmpty { a.optString("content_id", a.optString("widget_id", "?")) }
                com.remotedisplay.player.util.DebugLog.w("Zone",
                    "orphan zone_id=$zoneId item=$item -> fallback zone '${fallbackZone.name}'")
                zoneId = fallbackZone.id
            }
            assignmentsByZone.getOrPut(zoneId) { mutableListOf() }.add(a)
        }
        assignmentsByZone.values.forEach { list -> list.sortBy { it.optInt("sort_order", 0) } }

        // Unassigned content (zone_id=null) goes to the FIRST zone only.
        var unassignedUsed = false
        for (zone in zones.sortedBy { it.zIndex }) {
            val zoneAssignments: List<JSONObject> = assignmentsByZone[zone.id]
                ?: if (!unassignedUsed) { unassignedUsed = true; assignmentsByZone[null] ?: emptyList() } else emptyList()
            if (zoneAssignments.isEmpty()) continue

            val x = (zone.xPercent / 100f * containerWidth).toInt()
            val y = (zone.yPercent / 100f * containerHeight).toInt()
            val w = (zone.widthPercent / 100f * containerWidth).toInt()
            val h = (zone.heightPercent / 100f * containerHeight).toInt()
            val params = FrameLayout.LayoutParams(w, h).apply { leftMargin = x; topMargin = y }

            com.remotedisplay.player.util.DebugLog.i("Zone", "Zone '${zone.name}' (${zone.widthPercent.toInt()}x${zone.heightPercent.toInt()}%) -> ${zoneAssignments.size} item(s)")
            showZoneItem(zone, zoneAssignments, 0, params)
        }
        Log.i(TAG, "Rendered ${zoneViews.size} zone views")
    }

    // #74/#75 zone schedule helpers.
    private fun assignmentAllows(a: JSONObject): Boolean {
        if (a.optInt("enabled", 1) == 0) return false
        val arr = a.optJSONArray("schedules")
        val blocks = ArrayList<ScheduleEval.Block>()
        if (arr != null) {
            for (j in 0 until arr.length()) {
                val s = arr.getJSONObject(j)
                val d = s.getJSONArray("days")
                val days = HashSet<Int>(d.length())
                for (k in 0 until d.length()) days.add(d.getInt(k))
                blocks.add(
                    ScheduleEval.Block(
                        days, s.getString("start"), s.getString("end"),
                        if (s.isNull("start_date")) null else s.optString("start_date").ifEmpty { null },
                        if (s.isNull("end_date")) null else s.optString("end_date").ifEmpty { null }
                    )
                )
            }
        }
        val window = ScheduleEval.windowOf(
            if (a.isNull("play_from")) null else a.optString("play_from").ifEmpty { null },
            if (a.isNull("play_until")) null else a.optString("play_until").ifEmpty { null }
        )
        return ScheduleEval.isItemActiveNow(blocks, System.currentTimeMillis(), effectiveTimezone, window)
    }

    private fun zoneNextActive(assignments: List<JSONObject>, from: Int): Int {
        for (i in assignments.indices) {
            val idx = (from + i) % assignments.size
            if (assignmentAllows(assignments[idx])) return idx
        }
        return -1
    }

    // Render assignment[index] in a zone, replacing its current view. If the zone
    // has more than one assignment it rotates: images/widgets advance on a duration
    // timer; videos advance when they end (single-item zones loop the video).
    private fun showZoneItem(zone: Zone, assignments: List<JSONObject>, index: Int, params: FrameLayout.LayoutParams) {
        cancelZoneRotation(zone.id)
        zoneViews.remove(zone.id)?.let { container.removeView(it) }
        zoneExoPlayers.remove(zone.id)?.release()

        // #74/#75: skip items whose schedule excludes them now; blank-idle the zone
        // and re-check shortly (a daypart may open) if none are active.
        val activeIdx = zoneNextActive(assignments, index)
        if (activeIdx < 0) {
            scheduleZoneAdvance(zone.id, 30_000L) { showZoneItem(zone, assignments, 0, params) }
            return
        }
        val a = assignments[activeIdx]
        // Scheduled zones cycle even with one active item so windows re-evaluate.
        val multi = assignments.size > 1 || assignments.any {
            (it.optJSONArray("schedules")?.length() ?: 0) > 0
                || !it.isNull("play_from") && it.optString("play_from").isNotEmpty()
                || !it.isNull("play_until") && it.optString("play_until").isNotEmpty()
        }
        val advance: () -> Unit = { showZoneItem(zone, assignments, activeIdx + 1, params) }

        val mimeType = a.optString("mime_type", "")
        val isLive = mimeType == "video/hls" || mimeType == "video/rtsp"   // live stream: bytes never end -> dwell, not STATE_ENDED
        val remoteUrl = if (a.isNull("remote_url")) null else a.optString("remote_url", null)
        val widgetType = if (a.isNull("widget_type")) null else a.optString("widget_type", null)
        val contentId = if (a.isNull("content_id")) null else a.optString("content_id", null)
        val filepath = a.optString("filepath", "")
        val isMuted = a.optInt("muted", 0) == 1
        val durationMs = a.optInt("duration_sec", 10).coerceAtLeast(3) * 1000L

        // Per-zone content switch log (fires on initial render AND each rotation), so
        // the live debug panel shows each zone advancing on its own interval.
        val label = a.optString("filename", "").ifEmpty { widgetType?.let { "widget:$it" } ?: mimeType.ifEmpty { "item" } }
        com.remotedisplay.player.util.DebugLog.i("Zone", "'${zone.name}' [${activeIdx + 1}/${assignments.size}] -> $label (${durationMs / 1000}s)")

        when {
            // Widget - render in WebView
            widgetType != null -> {
                val widgetId = a.optString("widget_id", "")
                val webView = createWebView()
                // rev, exactly as the fullscreen path does: a widget's id does not change when it
                // is edited, so without it a zone kept rendering the old content indefinitely.
                val wRev = a.optLong("widget_rev", 0L)
                val wUrl = "$renderServerUrl/api/widgets/$widgetId/render" +
                    (if (renderDeviceId.isNotEmpty()) "?device=" + android.net.Uri.encode(renderDeviceId) else "?d=") +
                    "&rev=" + wRev
                webView.loadUrl(wUrl)
                webView.layoutParams = params
                container.addView(webView); zoneViews[zone.id] = webView
                if (multi) scheduleZoneAdvance(zone.id, durationMs, advance)
            }
            // HTML bundle - the server's flattened document, in a WebView like a widget. `rev` is
            // content_rev so a replaced archive actually reloads; without this branch a bundle in a
            // zone matched nothing, rendered an empty view and never advanced.
            mimeType == ItemTiming.BUNDLE_MIME -> {
                val webView = createWebView()
                val bRev = a.optLong("content_rev", 0L)
                webView.loadUrl("$renderServerUrl/api/content/" + a.optString("content_id", "") + "/bundle?rev=" + bRev)
                webView.layoutParams = params
                container.addView(webView); zoneViews[zone.id] = webView
                if (multi) scheduleZoneAdvance(zone.id, durationMs, advance)
            }
            // YouTube - render via an embed wrapper with a valid origin (Error 153 fix)
            mimeType == "video/youtube" && !remoteUrl.isNullOrEmpty() -> {
                val webView = createWebView()
                // #129: initial mute from the per-item flag (was hardcoded mute=1). Live
                // per-zone mute isn't wired (device:mute-changed targets the fullscreen item).
                val html = com.remotedisplay.player.util.WebViewSupport.youtubeEmbedHtml(remoteUrl, isMuted)
                if (html != null) webView.loadDataWithBaseURL(com.remotedisplay.player.util.WebViewSupport.EMBED_BASE, html, "text/html", "UTF-8", null)
                else webView.loadUrl(remoteUrl)
                webView.layoutParams = params
                container.addView(webView); zoneViews[zone.id] = webView
                if (multi) scheduleZoneAdvance(zone.id, durationMs, advance)
            }
            // Video
            mimeType.startsWith("video/") -> {
                val src = if (!remoteUrl.isNullOrEmpty()) remoteUrl
                          else if (contentId != null) renderCache?.getCachedFile(contentId)?.let { Uri.fromFile(it).toString() }
                               ?: "$renderServerUrl/uploads/content/$filepath"
                          else { if (multi) scheduleZoneAdvance(zone.id, durationMs, advance); return }
                val playerView = (android.view.LayoutInflater.from(context)
                    .inflate(com.remotedisplay.player.R.layout.zone_player, null) as PlayerView).apply {
                    useController = false
                    layoutParams = params
                }
                val exoPlayer = ExoPlayer.Builder(context).build().apply {
                    if (mimeType == "video/rtsp") {
                        // RTSP camera in a zone: force TCP so it works through NAT/firewalls and on
                        // cameras that refuse UDP (media3-exoplayer-rtsp).
                        setMediaSource(
                            androidx.media3.exoplayer.rtsp.RtspMediaSource.Factory()
                                .setForceUseRtpTcp(true)
                                .createMediaSource(MediaItem.fromUri(src))
                        )
                    } else {
                        setMediaItem(MediaItem.fromUri(src))   // ExoPlayer infers HLS from the .m3u8 (media3-exoplayer-hls)
                    }
                    // A live stream never ends, so REPEAT is moot; a normal clip in a lone zone loops.
                    repeatMode = if (multi && !isLive) Player.REPEAT_MODE_OFF else Player.REPEAT_MODE_ALL
                    volume = if (isMuted) 0f else 1f
                    if (multi) addListener(object : Player.Listener {
                        override fun onPlaybackStateChanged(state: Int) {
                            // A live stream never reaches STATE_ENDED (it advances on its dwell timer
                            // below); a normal clip advances when it finishes.
                            if (!isLive && state == Player.STATE_ENDED) handler.post { advance() }
                        }
                        // Same reason MediaPlayerManager treats a playback error as a completion
                        // ("Root-2: a corrupt/undecodable video used to freeze the playlist
                        // forever"): an error lands in STATE_IDLE, never STATE_ENDED, so without
                        // this the zone stops rotating and goes black until the layout changes or
                        // the app restarts — while every other zone keeps going. Covers a dead
                        // stream URL too, so a live zone skips instead of sitting black.
                        override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                            handler.post { advance() }
                        }
                    })
                    prepare()
                    playWhenReady = true
                }
                playerView.player = exoPlayer
                container.addView(playerView); zoneViews[zone.id] = playerView; zoneExoPlayers[zone.id] = exoPlayer
                // DWELL for a live stream in a rotating zone: it never fires STATE_ENDED, so advance on
                // the dwell timer (duration_sec > 0). A dwell-0 stream stays until it is no longer the
                // active pick (windows still re-evaluate on the slow cadence, without remounting).
                if (multi && isLive) {
                    val liveDwell = a.optInt("duration_sec", 0)
                    if (liveDwell > 0) {
                        scheduleZoneAdvance(zone.id, liveDwell * 1000L, advance)
                    } else {
                        val recheck = object : Runnable {
                            override fun run() {
                                if (zoneNextActive(assignments, activeIdx) == activeIdx) handler.postDelayed(this, LIVE_RECHECK_MS)
                                else advance()
                            }
                        }
                        zoneRotators[zone.id] = recheck
                        handler.postDelayed(recheck, LIVE_RECHECK_MS)
                    }
                }
            }
            // Image
            mimeType.startsWith("image/") -> {
                val imageView = ImageView(context).apply {
                    scaleType = when (a.optString("fit_mode", zone.fitMode).ifEmpty { zone.fitMode }) {
                        "contain" -> ImageView.ScaleType.FIT_CENTER
                        "fill" -> ImageView.ScaleType.FIT_XY
                        else -> ImageView.ScaleType.CENTER_CROP
                    }
                    layoutParams = params
                }
                val targetW = if (params.width > 0) params.width else com.remotedisplay.player.util.ImageLoader.screenWidth(context)
                val targetH = if (params.height > 0) params.height else com.remotedisplay.player.util.ImageLoader.screenHeight(context)
                val file = contentId?.let { renderCache?.getCachedFile(it) }
                if (file != null) {
                    val bitmap = com.remotedisplay.player.util.ImageLoader.decodeFile(file, targetW, targetH)
                    if (bitmap != null) {
                        try { imageView.setImageBitmap(bitmap) } catch (e: Throwable) { Log.e(TAG, "setImageBitmap failed: ${e.message}") }
                    } else {
                        Log.w(TAG, "Zone ${zone.name}: skipping unloadable image $contentId")
                    }
                } else {
                    // #78: not in the local cache yet (first-sync download still in flight, or a
                    // zone whose content the preloader hasn't fetched). Load straight from the
                    // server - mirrors how the video branch above falls back to a server URL -
                    // so the zone isn't blank until a restart populates the cache.
                    val imgUrl = if (!remoteUrl.isNullOrEmpty()) remoteUrl
                                 else if (contentId != null) "$renderServerUrl/api/content/$contentId/file"
                                 else null
                    if (imgUrl != null) {
                        Thread {
                            val bitmap = com.remotedisplay.player.util.ImageLoader.decodeUrl(imgUrl, targetW, targetH)
                            if (bitmap != null) {
                                imageView.post {
                                    try { imageView.setImageBitmap(bitmap) } catch (e: Throwable) { Log.e(TAG, "setImageBitmap failed: ${e.message}") }
                                }
                            } else {
                                Log.w(TAG, "Zone ${zone.name}: unloadable image $contentId via $imgUrl")
                            }
                        }.start()
                    }
                }
                container.addView(imageView); zoneViews[zone.id] = imageView
                if (multi) scheduleZoneAdvance(zone.id, durationMs, advance)
            }
            // Unknown / empty assignment - keep rotating so it doesn't get stuck.
            else -> { if (multi) scheduleZoneAdvance(zone.id, durationMs, advance) }
        }
    }

    private fun scheduleZoneAdvance(zoneId: String, delayMs: Long, advance: () -> Unit) {
        val r = Runnable { advance() }
        zoneRotators[zoneId] = r
        handler.postDelayed(r, delayMs)
    }

    private fun cancelZoneRotation(zoneId: String) {
        zoneRotators.remove(zoneId)?.let { handler.removeCallbacks(it) }
    }

    private fun cancelAllRotations() {
        zoneRotators.values.forEach { handler.removeCallbacks(it) }
        zoneRotators.clear()
    }

    private fun createWebView(): WebView {
        return WebView(context).apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "Zone")
        }
    }

    private fun releaseExoPlayers() {
        zoneExoPlayers.values.forEach { it.release() }
        zoneExoPlayers.clear()
    }

    fun cleanup() {
        cancelAllRotations()
        releaseExoPlayers()
        // Remove ONLY the views we added for zones; the activity's static views live
        // in this same container and must NOT be removed (else single-zone/fullscreen
        // playback, which reuses them, renders black).
        zoneViews.values.forEach { container.removeView(it) }
        zoneViews.clear()
        zones = listOf()
    }
}
