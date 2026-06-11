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
    private var renderCache: com.remotedisplay.player.data.ContentCache? = null

    var currentLayoutId: String? = null
        private set
    var lastAssignmentSig: String? = null

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

    fun renderAssignments(assignments: JSONArray, serverUrl: String, contentCache: com.remotedisplay.player.data.ContentCache) {
        // Clear ONLY our own zone views/timers. `container` is the activity root and
        // also holds the static playerView/imageView/youtubeWebView/statusOverlay -
        // removeAllViews() here would detach those and black the screen on switch-back.
        cancelAllRotations()
        zoneViews.values.forEach { container.removeView(it) }
        zoneViews.clear()
        releaseExoPlayers()
        renderServerUrl = serverUrl
        renderCache = contentCache

        val containerWidth = container.width
        val containerHeight = container.height
        if (containerWidth == 0 || containerHeight == 0) {
            // Container not laid out yet, retry after layout.
            container.post { renderAssignments(assignments, serverUrl, contentCache) }
            return
        }

        // Group assignments by zone_id, ordered by sort_order so rotation is stable.
        val assignmentsByZone = mutableMapOf<String?, MutableList<JSONObject>>()
        for (i in 0 until assignments.length()) {
            val a = assignments.getJSONObject(i)
            val zoneId = if (a.isNull("zone_id")) null else a.optString("zone_id", null)
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
        val arr = a.optJSONArray("schedules") ?: return true
        if (arr.length() == 0) return true
        val blocks = ArrayList<ScheduleEval.Block>(arr.length())
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
        return ScheduleEval.isItemActiveNow(blocks, System.currentTimeMillis(), effectiveTimezone)
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
        val multi = assignments.size > 1 || assignments.any { (it.optJSONArray("schedules")?.length() ?: 0) > 0 }
        val advance: () -> Unit = { showZoneItem(zone, assignments, activeIdx + 1, params) }

        val mimeType = a.optString("mime_type", "")
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
                webView.loadUrl("$renderServerUrl/api/widgets/$widgetId/render")
                webView.layoutParams = params
                container.addView(webView); zoneViews[zone.id] = webView
                if (multi) scheduleZoneAdvance(zone.id, durationMs, advance)
            }
            // YouTube - render via an embed wrapper with a valid origin (Error 153 fix)
            mimeType == "video/youtube" && !remoteUrl.isNullOrEmpty() -> {
                val webView = createWebView()
                val html = com.remotedisplay.player.util.WebViewSupport.youtubeEmbedHtml(remoteUrl)
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
                    setMediaItem(MediaItem.fromUri(src))
                    repeatMode = if (multi) Player.REPEAT_MODE_OFF else Player.REPEAT_MODE_ALL
                    volume = if (isMuted) 0f else 1f
                    if (multi) addListener(object : Player.Listener {
                        override fun onPlaybackStateChanged(state: Int) {
                            if (state == Player.STATE_ENDED) handler.post { advance() }
                        }
                    })
                    prepare()
                    playWhenReady = true
                }
                playerView.player = exoPlayer
                container.addView(playerView); zoneViews[zone.id] = playerView; zoneExoPlayers[zone.id] = exoPlayer
            }
            // Image
            mimeType.startsWith("image/") -> {
                val imageView = ImageView(context).apply {
                    scaleType = when (zone.fitMode) {
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
                } else if (!remoteUrl.isNullOrEmpty()) {
                    Thread {
                        val bitmap = com.remotedisplay.player.util.ImageLoader.decodeUrl(remoteUrl, targetW, targetH)
                        if (bitmap != null) {
                            imageView.post {
                                try { imageView.setImageBitmap(bitmap) } catch (e: Throwable) { Log.e(TAG, "setImageBitmap failed: ${e.message}") }
                            }
                        } else {
                            Log.w(TAG, "Zone ${zone.name}: skipping unloadable remote image")
                        }
                    }.start()
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
