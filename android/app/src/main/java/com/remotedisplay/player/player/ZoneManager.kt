package com.remotedisplay.player.player

import android.content.Context
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.TextureView
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
    /** How often zone videos are checked for a stall (PlaybackStall needs 10 s of no progress to call it). */
    private val HEALTH_TICK_MS = 2_000L
    private val handler = Handler(Looper.getMainLooper())
    private val zoneViews = mutableMapOf<String, View>()
    private val zoneExoPlayers = mutableMapOf<String, ExoPlayer>()
    /*
     * Each zone video's watchdog (StreamHealth) and its pending reconnect, if one is scheduled.
     * Ticked every HEALTH_TICK_MS while any zone shows video: a stalled stream raises no event.
     */
    private val zoneHealth = mutableMapOf<String, StreamHealth>()
    private val zoneReconnect = mutableMapOf<String, Runnable>()
    private var healthTicking = false
    private val healthTick = object : Runnable {
        override fun run() {
            val now = SystemClock.elapsedRealtime()
            for ((id, h) in zoneHealth.toMap()) {
                val p = zoneExoPlayers[id] ?: continue
                try {
                    // Frames actually drawn: for a live camera, the picture changing. ensureUpdated()
                    // because the counters are written on the playback thread.
                    val frames = p.videoDecoderCounters?.let { it.ensureUpdated(); it.renderedOutputBufferCount.toLong() }
                    h.observe(now, p.playbackState, p.playWhenReady, frames, p.currentPosition)
                } catch (_: Throwable) { /* a player released under us: the next mount replaces it */ }
            }
            if (zoneHealth.isNotEmpty()) handler.postDelayed(this, HEALTH_TICK_MS) else healthTicking = false
        }
    }
    // A zone showing a fisheye camera as a normal view: its GL view and the view it is pointed at.
    // Live only while that GL view is still the zone's view (zoneViews), see fisheyeViews().
    private val zoneFisheye = mutableMapOf<String, Pair<FisheyeGlView, Fisheye.View>>()
    // A zone showing the screen's HDMI input holds a hardware session; released like an ExoPlayer.
    private val zoneLiveInputs = mutableMapOf<String, LiveInputPlayer>()
    // Per-zone rotation timers: each zone cycles its own list of assignments.
    private val zoneRotators = mutableMapOf<String, Runnable>()
    // Bumped every time a zone shows something; see showZoneItem.
    private val zoneGeneration = mutableMapOf<String, Int>()
    private var zones = listOf<Zone>()
    // Render context kept for rotation re-renders.
    private var renderServerUrl = ""
    private var renderDeviceId = "" // appended to widget render URLs so widgets can report per-device
    // IPTV: a dwell-0 live stream in a rotating zone re-checks eligibility on this slow cadence
    // (stays if it is still the active pick; advances if a daypart opened a sibling). Never a busy-loop.
    private val LIVE_RECHECK_MS = 60_000L
    // A zone holding only the HDMI input re-tunes this often after its picture is lost.
    private val LIVE_INPUT_RETRY_MS = 10_000L
    private var renderCache: com.remotedisplay.player.data.ContentCache? = null

    // ---- zone transitions (ZoneTransitions.kt / ZoneTransitionEngine.kt) ----
    // What each zone shows now (the outgoing frame a transition can capture) and the index it last
    // showed (a zone transitions only into a DIFFERENT item, after its first — native parity).
    private val zoneFaces = mutableMapOf<String, ZoneFace>()
    private val zoneLastIdx = mutableMapOf<String, Int>()
    private val zoneTx = mutableMapOf<String, ZoneTx>()
    private val txEngine = ZoneTransitionEngine()
    private val txBook: ZoneTransitionBook by lazy {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
        val mi = android.app.ActivityManager.MemoryInfo()
        try { am?.getMemoryInfo(mi) } catch (_: Throwable) {}
        ZoneTransitionBook(ZoneTransitionPolicy.maxConcurrentGl(am?.isLowRamDevice == true, mi.totalMem)).also {
            Log.i(TAG, "zone transitions: up to ${it.maxGl} GL at once, ${it.maxViewFades} view crossfades")
        }
    }

    /** One zone's transition in flight. Everything it holds is freed by cancelZoneTransition. */
    private class ZoneTx(val ticket: ZoneTransitionBook.Ticket) {
        var overlay: View? = null
        var handle: ZoneTransitionEngine.Handle? = null
        var fromFit: Bitmap? = null        // owned until handed to the engine
        var fadeBitmap: Bitmap? = null     // the view crossfade's still
        var animator: android.view.ViewPropertyAnimator? = null
        var mounted = false
        var firstFrame = false
        var startedAt = 0L
        var onVideoFrame: (() -> Unit)? = null
        val timers = ArrayList<Runnable>()
    }

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

    /** 3.0 campaigns: the same schedule / window / enabled gate a zone item gets, for a whole step. */
    fun allows(a: JSONObject): Boolean = assignmentAllows(a)

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
        cancelAllTransitions()
        zoneViews.values.forEach { container.removeView(it) }
        zoneViews.clear()
        zoneFaces.clear()
        zoneLastIdx.clear()
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

    /** Dwell for a live item in a rotating zone: it never ends, so a timer (or, dwell 0, a slow
     *  eligibility re-check) moves the zone on. Shared by streams and the HDMI input. */
    private fun armLiveDwell(zone: Zone, assignments: List<JSONObject>, activeIdx: Int, a: JSONObject, advance: () -> Unit) {
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

    // Render assignment[index] in a zone, replacing its current view. If the zone
    // has more than one assignment it rotates: images/widgets advance on a duration
    // timer; videos advance when they end (single-item zones loop the video).
    private fun showZoneItem(zone: Zone, assignments: List<JSONObject>, index: Int, params: FrameLayout.LayoutParams) {
        cancelZoneRotation(zone.id)
        // Anything the previous item armed (an end/error listener, an input fault) checks this before
        // advancing, so it cannot move the zone on from under whatever is shown now — a frozen frame
        // in particular, whose paused player is still attached.
        val gen = (zoneGeneration[zone.id] ?: 0) + 1
        zoneGeneration[zone.id] = gen
        // A transition still in flight for this zone (or still holding its last frame over a video
        // that has not rendered yet) ends here: its overlay goes, its bitmaps and GL are freed.
        cancelZoneTransition(zone.id)

        // #74/#75: skip items whose schedule excludes them now; blank-idle the zone
        // and re-check shortly (a daypart may open) if none are active.
        val activeIdx = zoneNextActive(assignments, index)
        val prevIdx = zoneLastIdx[zone.id] ?: -1
        zoneLastIdx[zone.id] = activeIdx

        // A HOLD keeps (freeze) or clears (blank) what the zone shows for its duration, so it is
        // decided BEFORE the teardown below — freezing needs the outgoing view and player intact.
        if (activeIdx >= 0 && Hold.isHold(assignments[activeIdx].optString("mime_type", ""))) {
            val h = assignments[activeIdx]
            val remote = if (h.isNull("remote_url")) null else h.optString("remote_url", "")
            if (Hold.mode(remote) == Hold.Mode.FREEZE) {
                zoneExoPlayers[zone.id]?.let { try { it.playWhenReady = false } catch (_: Throwable) {} }
            } else {
                zoneViews.remove(zone.id)?.let { container.removeView(it) }
                zoneExoPlayers.remove(zone.id)?.release()
                zoneLiveInputs.remove(zone.id)?.release()
                zoneFaces[zone.id] = ZoneFace.NONE
            }
            val holdMs = WallZones.slotMs(h.optInt("duration_sec", 10))
            com.remotedisplay.player.util.DebugLog.i("Zone", "'${zone.name}' [${activeIdx + 1}/${assignments.size}] -> hold ${Hold.mode(remote).name.lowercase()} (${holdMs / 1000}s)")
            // A zone of one hold has nothing to advance to; anything else moves on after the hold.
            if (assignments.size > 1) scheduleZoneAdvance(zone.id, holdMs) { showZoneItem(zone, assignments, activeIdx + 1, params) }
            return
        }

        // The item's transition, if it gets one: the swap below then runs when the wipe lands.
        if (activeIdx >= 0 && beginZoneTransition(zone, assignments, activeIdx, params, gen, prevIdx)) return
        mountZoneItem(zone, assignments, activeIdx, params, gen, null)
    }

    /**
     * The plain swap: tear the zone's current view down and mount assignments[activeIdx]. Exactly
     * what showZoneItem always did; a transition calls it when its wipe lands, passing the image it
     * already decoded as [preDecoded] so the picture is not decoded twice.
     */
    private fun mountZoneItem(zone: Zone, assignments: List<JSONObject>, activeIdx: Int, params: FrameLayout.LayoutParams, gen: Int, preDecoded: Bitmap?, txStartedAt: Long = 0L) {
        zoneViews.remove(zone.id)?.let { container.removeView(it) }
        forgetZoneHealth(zone.id)
        zoneExoPlayers.remove(zone.id)?.release()
        zoneLiveInputs.remove(zone.id)?.release()
        zoneFaces[zone.id] = ZoneFace.NONE

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
        // Guarded by the zone's generation: a stale callback from an item already replaced is ignored.
        val advance: () -> Unit = { if (zoneGeneration[zone.id] == gen) showZoneItem(zone, assignments, activeIdx + 1, params) }

        val mimeType = a.optString("mime_type", "")
        val isLive = mimeType == "video/hls" || mimeType == "video/rtsp" || LiveInput.isLiveInput(mimeType)   // live: never ends -> dwell, not STATE_ENDED
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
                    "&rev=" + wRev +
                    com.remotedisplay.player.util.WidgetUrls.transparentParam(a.optInt("transparent_bg", 0) == 1) +
                    com.remotedisplay.player.util.WidgetUrls.panelFragment(a.optString("widget_panel", ""))
                webView.loadUrl(wUrl)
                webView.layoutParams = params
                addZoneView(zone, webView)
                zoneFaces[zone.id] = ZoneFace.WEB
                if (multi) scheduleZoneAdvance(zone.id, durationMs, advance)
            }
            // HTML bundle - the server's flattened document, in a WebView like a widget. `rev` is
            // content_rev so a replaced archive actually reloads; without this branch a bundle in a
            // zone matched nothing, rendered an empty view and never advanced.
            mimeType == ItemTiming.BUNDLE_MIME -> {
                val webView = createWebView()
                val bRev = a.optLong("content_rev", 0L)
                webView.loadUrl("$renderServerUrl/api/content/" + a.optString("content_id", "") + "/bundle?rev=" + bRev +
                    com.remotedisplay.player.util.WidgetUrls.transparentParam(a.optInt("transparent_bg", 0) == 1))
                webView.layoutParams = params
                addZoneView(zone, webView)
                zoneFaces[zone.id] = ZoneFace.WEB
                if (multi) scheduleZoneAdvance(zone.id, durationMs, advance)
            }
            // YouTube - render via an embed wrapper with a valid origin (Error 153 fix)
            mimeType == "video/youtube" && !remoteUrl.isNullOrEmpty() -> {
                val webView = createWebView()
                // #624 play to end: the zone moves on when the video ends; its duration is only the
                // fallback while the page has not reported the video's length. A one-item zone loops.
                val toEnd = multi && a.optInt("play_to_end", 0) == 1
                if (toEnd) webView.addJavascriptInterface(ZoneYoutubeBridge(zone.id, gen, System.currentTimeMillis(), advance), PlayToEnd.BRIDGE)
                // #129: initial mute from the per-item flag (was hardcoded mute=1). Live
                // per-zone mute isn't wired (device:mute-changed targets the fullscreen item).
                val html = com.remotedisplay.player.util.WebViewSupport.youtubeEmbedHtml(remoteUrl, isMuted, if (toEnd) gen.toLong() else null)
                if (html != null) webView.loadDataWithBaseURL(com.remotedisplay.player.util.WebViewSupport.EMBED_BASE, html, "text/html", "UTF-8", null)
                else webView.loadUrl(remoteUrl)
                webView.layoutParams = params
                addZoneView(zone, webView)
                zoneFaces[zone.id] = ZoneFace.WEB
                if (multi) scheduleZoneAdvance(zone.id, if (toEnd) PlayToEnd.waitMs(durationMs) else durationMs, advance)
            }
            // The screen's HDMI input, boxed into the zone (verified on a Fire TV Cube). Before the
            // video branch: it is a video/* mime with a remote_url, but there is nothing to stream.
            LiveInput.isLiveInput(mimeType) -> {
                val holder = FrameLayout(context).apply { layoutParams = params }
                addZoneView(zone, holder)
                zoneFaces[zone.id] = ZoneFace.LIVE
                // A lost picture (source off, cable pulled) skips it in a rotating zone. In a zone
                // that holds ONLY the input there is nothing to skip to, so it re-tunes on a slow
                // cadence instead — otherwise plugging the cable back in would leave the zone black
                // until the layout changed.
                val retry: () -> Unit = { if (zoneGeneration[zone.id] == gen) showZoneItem(zone, assignments, activeIdx, params) }
                val live = LiveInputPlayer(context, holder, 0) {
                    handler.post { if (multi) advance() else scheduleZoneAdvance(zone.id, LIVE_INPUT_RETRY_MS, retry) }
                }
                zoneLiveInputs[zone.id] = live
                if (!live.play(remoteUrl ?: "hdmi://", isMuted)) {
                    // No such input on this box: skip it in a rotating zone, keep looking in a lone one.
                    scheduleZoneAdvance(zone.id, if (multi) 3_000L else LIVE_INPUT_RETRY_MS, if (multi) advance else retry)
                } else if (multi) {
                    armLiveDwell(zone, assignments, activeIdx, a, advance)
                }
            }
            // Video
            mimeType.startsWith("video/") -> {
                val src = if (!remoteUrl.isNullOrEmpty()) remoteUrl
                          else if (contentId != null) renderCache?.getCachedFile(contentId)?.let { Uri.fromFile(it).toString() }
                               ?: "$renderServerUrl/uploads/content/$filepath"
                          else { if (multi) scheduleZoneAdvance(zone.id, durationMs, advance); return }
                // A fisheye camera (the item's `fisheye`) is drawn by a FisheyeGlView, not a PlayerView.
                val fisheye = if (isLive) Fisheye.parse(a.optJSONObject("fisheye"))?.let { Fisheye.View(it, contentId) } else null
                val playerView = (android.view.LayoutInflater.from(context)
                    .inflate(com.remotedisplay.player.R.layout.zone_player, null) as PlayerView).apply {
                    useController = false
                    layoutParams = params
                }
                val setSource: (ExoPlayer) -> Unit = { p ->
                    if (mimeType == "video/rtsp") {
                        // RTSP/RTSPS camera in a zone: TCP-interleaved, TLS for rtsps (RtspSources).
                        p.setMediaSource(RtspSources.create(src, a.optInt("tls_self_signed", 0) == 1))
                    } else {
                        p.setMediaItem(MediaItem.fromUri(src))   // ExoPlayer infers HLS from the .m3u8 (media3-exoplayer-hls)
                    }
                }
                val exoPlayer = ExoPlayer.Builder(context).build().apply {
                    setSource(this)
                    // A live stream never ends, so REPEAT is moot; a normal clip in a lone zone loops.
                    repeatMode = if (multi && !isLive) Player.REPEAT_MODE_OFF else Player.REPEAT_MODE_ALL
                    volume = if (isMuted) 0f else 1f
                    addListener(object : Player.Listener {
                        override fun onPlaybackStateChanged(state: Int) {
                            // A live stream never reaches STATE_ENDED (it advances on its dwell timer
                            // below); a normal clip advances when it finishes.
                            if (multi && !isLive && state == Player.STATE_ENDED) handler.post { advance() }
                        }
                        // Same reason MediaPlayerManager treats a playback error as a completion
                        // ("Root-2: a corrupt/undecodable video used to freeze the playlist
                        // forever"): an error lands in STATE_IDLE, never STATE_ENDED, so without
                        // this the zone stops rotating and goes black until the layout changes or
                        // the app restarts — while every other zone keeps going. Covers a dead
                        // stream URL too, so a live zone skips instead of sitting black. A zone of ONE
                        // item had no listener at all; it now reconnects (watchZoneVideo below).
                        override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                            com.remotedisplay.player.util.DebugLog.w("Zone", "'${zone.name}': video error ${error.errorCodeName}")
                            handler.post { zoneHealth[zone.id]?.error(SystemClock.elapsedRealtime()) }
                        }
                    })
                    // A transition that wiped INTO this clip holds its last frame (= this clip's first)
                    // over the zone until the decoder has actually drawn, so there is no black seam.
                    addListener(object : Player.Listener {
                        override fun onRenderedFirstFrame() { onZoneVideoFirstFrame(zone.id, gen) }
                    })
                    prepare()
                    playWhenReady = true
                }
                if (fisheye != null) {
                    val gl = FisheyeGlView(context).apply { layoutParams = params; view = fisheye }
                    fisheye.onChange = { gl.redraw() }
                    exoPlayer.addListener(object : Player.Listener {
                        override fun onVideoSizeChanged(size: androidx.media3.common.VideoSize) {
                            if (size.width > 0 && size.height > 0) gl.setImageSize(size.width, size.height)
                        }
                    })
                    gl.onSurfaceReady = { surf -> if (surf != null && zoneExoPlayers[zone.id] === exoPlayer) exoPlayer.setVideoSurface(surf) }
                    addZoneView(zone, gl); zoneExoPlayers[zone.id] = exoPlayer
                    zoneFisheye[zone.id] = gl to fisheye
                } else {
                    playerView.player = exoPlayer
                    addZoneView(zone, playerView); zoneExoPlayers[zone.id] = exoPlayer
                }
                zoneFaces[zone.id] = ZoneFace.VIDEO
                watchZoneVideo(zone, exoPlayer, gen, multi, advance) { p -> setSource(p); p.prepare(); p.playWhenReady = true }
                // DWELL for a live stream in a rotating zone: it never fires STATE_ENDED, so advance on
                // the dwell timer (duration_sec > 0). A dwell-0 stream stays until it is no longer the
                // active pick (windows still re-evaluate on the slow cadence, without remounting).
                if (multi && isLive) armLiveDwell(zone, assignments, activeIdx, a, advance)
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
                if (preDecoded != null) {
                    // Decoded already by the transition that just wiped into it.
                    try { imageView.setImageBitmap(preDecoded) } catch (e: Throwable) { Log.e(TAG, "setImageBitmap failed: ${e.message}") }
                } else if (file != null) {
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
                addZoneView(zone, imageView)
                zoneFaces[zone.id] = ZoneFace.IMAGE
                // The transition into this image is part of its dwell (native: the zone timer starts
                // when the item is shown, before its transition). Without the credit every wiped zone
                // ran slow by the wipe's length each cycle.
                if (multi) scheduleZoneAdvance(zone.id, ZoneTransitionPolicy.dwellAfterTransition(durationMs, txStartedAt, android.os.SystemClock.uptimeMillis()), advance)
            }
            // Unknown / empty assignment - keep rotating so it doesn't get stuck.
            else -> { if (multi) scheduleZoneAdvance(zone.id, durationMs, advance) }
        }
    }

    // ============================================================================ zone transitions
    //
    // The item a zone moves INTO carries its zone's transition (server-resolved per zone, #647).
    // What wipes, what crossfades and what cuts is decided by ZoneTransitionPolicy; this is the
    // wiring. Every step re-checks the zone's ticket (ZoneTransitionBook.isLive: still this zone's
    // transition AND still this zone's generation), so an advance, a layout change or a cleanup
    // mid-transition turns every late callback into a no-op, and cancelZoneTransition frees what
    // the transition held. On any failure the zone falls back to the plain swap: never a black frame.

    /** Start [assignments][idx]'s transition. False = no transition; the caller mounts now. */
    private fun beginZoneTransition(zone: Zone, assignments: List<JSONObject>, idx: Int, params: FrameLayout.LayoutParams, gen: Int, prevIdx: Int): Boolean {
        val a = assignments[idx]
        val spec = Transitions.parse(a.optJSONObject("transition")) ?: return false
        val mimeType = a.optString("mime_type", "")
        val widgetType = if (a.isNull("widget_type")) null else a.optString("widget_type", null)
        val remoteUrl = if (a.isNull("remote_url")) null else a.optString("remote_url", null)
        val contentId = if (a.isNull("content_id")) null else a.optString("content_id", null)
        val cached = contentId?.let { renderCache?.getCachedFile(it) }
        val target = ZoneTransitionPolicy.targetKind(mimeType, widgetType, remoteUrl, cached != null)
        val face = zoneFaces[zone.id] ?: ZoneFace.NONE
        val effect = Transitions.pick(spec) ?: return false
        val shaderSrc = TransitionGlsl.loadSource(context.assets, effect.shader)
        val mode = ZoneTransitionPolicy.decide(spec, prevIdx, idx, face, target,
            glUsable = txEngine.usable, glSlotFree = txBook.glSlotFree(zone.id),
            viewSlotFree = txBook.viewSlotFree(zone.id), shaderFound = shaderSrc != null)
        if (mode == ZoneTxMode.CUT) return false

        val (texW, texH) = ZoneTransitionFit.textureSize(params.width, params.height)
        if (texW <= 0 || texH <= 0) return false
        val gl = mode != ZoneTxMode.VIEW_CROSSFADE
        // The outgoing frame, captured NOW (main thread: a TextureView only hands its pixels over here).
        val fromFit = captureZoneFrame(zone.id, face, texW, texH, flipForGl = gl) ?: return false
        val (ticket, _) = txBook.acquire(zone.id, gen, gl) ?: run { fromFit.recycle(); return false }
        val tx = ZoneTx(ticket).also { it.fromFit = fromFit }
        zoneTx[zone.id] = tx
        val fragment = if (mode == ZoneTxMode.SHADER && shaderSrc != null) TransitionGlsl.fragmentFor(shaderSrc) else TransitionGlsl.CROSSFADE
        com.remotedisplay.player.util.DebugLog.i("Zone", "'${zone.name}' transition ${mode.name.lowercase()} " +
            (if (mode == ZoneTxMode.SHADER) effect.shader else "crossfade") + " ${spec.durationMs}ms (${texW}x${texH})")

        val startedAt = android.os.SystemClock.uptimeMillis()
        tx.startedAt = startedAt
        val live = { txBook.isLive(ticket, zoneGeneration[zone.id]) }
        // Give up on the transition and swap plainly — only if it is still this zone's and nothing is mounted yet.
        val cutNow: (Bitmap?) -> Unit = { decoded ->
            if (live() && !tx.mounted) {
                cancelZoneTransition(zone.id)
                mountZoneItem(zone, assignments, idx, params, gen, decoded, startedAt)
            }
        }

        // The incoming frame (and the decoded image the mount will show) are prepared off the main
        // thread: a decode or a frame-0 extract is tens to hundreds of ms on a TV stick.
        val decodeW = if (params.width > 0) params.width else com.remotedisplay.player.util.ImageLoader.screenWidth(context)
        val decodeH = if (params.height > 0) params.height else com.remotedisplay.player.util.ImageLoader.screenHeight(context)
        val imgUrl = if (!remoteUrl.isNullOrEmpty()) remoteUrl
                     else if (contentId != null) "$renderServerUrl/api/content/$contentId/file" else null
        val imageFit = ZoneTransitionPolicy.imageFit(a.optString("fit_mode", ""), zone.fitMode)
        var prepDone = false
        val prepDeadline = Runnable { if (!prepDone) { prepDone = true; Log.w(TAG, "Zone ${zone.name}: transition prep too slow, cutting"); cutNow(null) } }
        tx.timers.add(prepDeadline)
        handler.postDelayed(prepDeadline, ZoneTransitionPolicy.PREP_DEADLINE_MS)
        Thread {
            var decoded: Bitmap? = null
            var toFit: Bitmap? = null
            try {
                if (target == ZoneTarget.IMAGE) {
                    decoded = if (cached != null) com.remotedisplay.player.util.ImageLoader.decodeFile(cached, decodeW, decodeH)
                              else imgUrl?.let { com.remotedisplay.player.util.ImageLoader.decodeUrl(it, decodeW, decodeH) }
                    if (gl && decoded != null) toFit = fitZoneTransitionBitmap(decoded, texW, texH, imageFit, flipForGl = true)
                } else if (target == ZoneTarget.VIDEO_FILE && gl && cached != null) {
                    zoneFirstFrame(cached.absolutePath, texW, texH)?.let { f ->
                        toFit = fitZoneTransitionBitmap(f, texW, texH, "contain", flipForGl = true)
                        f.recycle()
                    }
                }
            } catch (e: Throwable) { Log.w(TAG, "Zone ${zone.name}: transition prep failed: ${e.message}") }
            handler.post {
                if (prepDone || !live()) { toFit?.recycle(); return@post }   // late, or superseded: the zone moved on
                prepDone = true
                handler.removeCallbacks(prepDeadline)
                if (target == ZoneTarget.IMAGE && decoded == null) { cutNow(null); return@post }  // the mount logs the skip
                if (gl) {
                    val to = toFit
                    if (to == null) { cutNow(decoded); return@post }
                    startGlWipe(zone, assignments, idx, params, gen, tx, to, fragment, effect.params, spec.durationMs, texW, texH, target, decoded, cutNow)
                } else {
                    startViewCrossfade(zone, assignments, idx, params, gen, tx, spec.durationMs, target, decoded)
                }
            }
        }.start()
        return true
    }

    private fun startGlWipe(
        zone: Zone, assignments: List<JSONObject>, idx: Int, params: FrameLayout.LayoutParams, gen: Int,
        tx: ZoneTx, to: Bitmap, fragment: String, uniforms: Map<String, Float>, durationMs: Int,
        texW: Int, texH: Int, target: ZoneTarget, decoded: Bitmap?, cutNow: (Bitmap?) -> Unit
    ) {
        val from = tx.fromFit ?: run { to.recycle(); cutNow(decoded); return }
        tx.fromFit = null   // the engine owns both frames from here
        val live = { txBook.isLive(tx.ticket, zoneGeneration[zone.id]) }
        val handle = txEngine.start(context, from, to, fragment, uniforms, durationMs, texW, texH, object : ZoneTransitionEngine.Listener {
            override fun onFirstFrame() { if (live()) tx.firstFrame = true }
            override fun onFailed(reason: String) { cutNow(decoded) }
            override fun onFinished() {
                if (!live() || tx.mounted) return
                tx.mounted = true
                mountZoneItem(zone, assignments, idx, params, gen, decoded, tx.startedAt)   // goes in UNDER the overlay
                finishAfterMount(zone.id, tx, target)
            }
        })
        tx.handle = handle
        if (!placeOverlay(zone, handle.view, params)) { cutNow(decoded); return }
        tx.overlay = handle.view
        // A wipe that has not drawn its first frame in time (a GPU busy compiling, a surface slow to
        // come up) is not worth waiting for: the zone cuts, on time.
        val startDeadline = Runnable {
            if (live() && !tx.firstFrame && !tx.mounted) { Log.w(TAG, "Zone ${zone.name}: wipe did not start in time, cutting"); cutNow(decoded) }
        }
        tx.timers.add(startDeadline)
        handler.postDelayed(startDeadline, ZoneTransitionPolicy.START_DEADLINE_MS)
    }

    /**
     * No GL slot (or no GL): fade a still of the outgoing frame off the new item. One ImageView alpha
     * animation on a hardware layer — the cheapest thing that still reads as a transition.
     */
    private fun startViewCrossfade(zone: Zone, assignments: List<JSONObject>, idx: Int, params: FrameLayout.LayoutParams, gen: Int,
                                   tx: ZoneTx, durationMs: Int, target: ZoneTarget, decoded: Bitmap?) {
        val still = tx.fromFit ?: run { cancelZoneTransition(zone.id); mountZoneItem(zone, assignments, idx, params, gen, decoded); return }
        tx.fromFit = null
        tx.fadeBitmap = still
        val iv = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_XY; setImageBitmap(still) }
        if (!placeOverlay(zone, iv, params)) { cancelZoneTransition(zone.id); mountZoneItem(zone, assignments, idx, params, gen, decoded); return }
        tx.overlay = iv
        tx.mounted = true
        mountZoneItem(zone, assignments, idx, params, gen, decoded, tx.startedAt)
        val live = { txBook.isLive(tx.ticket, zoneGeneration[zone.id]) }
        val fade = {
            if (live()) {
                tx.animator = iv.animate().alpha(0f).setDuration(durationMs.toLong()).withLayer().withEndAction {
                    if (live()) cancelZoneTransition(zone.id)
                }.also { it.start() }
            }
        }
        if (target == ZoneTarget.VIDEO_FILE) awaitVideoFrame(zone.id, tx, fade) else fade()
    }

    /** The wipe landed and the item is mounted under its last frame: take the overlay away once the item has drawn. */
    private fun finishAfterMount(zoneId: String, tx: ZoneTx, target: ZoneTarget) {
        val park = {
            val r = Runnable { if (zoneTx[zoneId] === tx) cancelZoneTransition(zoneId) }
            tx.timers.add(r)
            handler.postDelayed(r, ZoneTransitionPolicy.PARK_MS)
        }
        if (target == ZoneTarget.VIDEO_FILE) awaitVideoFrame(zoneId, tx) { park() } else park()
    }

    /** Run [then] once the zone's new video has rendered its first frame, or after the cap — whichever is first. */
    private fun awaitVideoFrame(zoneId: String, tx: ZoneTx, then: () -> Unit) {
        var fired = false
        val once = { if (!fired) { fired = true; tx.onVideoFrame = null; then() } }
        tx.onVideoFrame = once
        val cap = Runnable { if (zoneTx[zoneId] === tx) once() }
        tx.timers.add(cap)
        handler.postDelayed(cap, ZoneTransitionPolicy.VIDEO_FIRST_FRAME_CAP_MS)
    }

    private fun onZoneVideoFirstFrame(zoneId: String, gen: Int) {
        val tx = zoneTx[zoneId] ?: return
        if (tx.ticket.gen != gen) return
        tx.onVideoFrame?.invoke()
    }

    /** Put [overlay] over the zone, directly above the zone's current view (so higher zones stay on top). */
    private fun placeOverlay(zone: Zone, overlay: View, params: FrameLayout.LayoutParams): Boolean {
        val base = zoneViews[zone.id] ?: return false
        val i = container.indexOfChild(base)
        if (i < 0) return false
        overlay.layoutParams = FrameLayout.LayoutParams(params.width, params.height).apply {
            leftMargin = params.leftMargin; topMargin = params.topMargin
        }
        container.addView(overlay, i + 1)
        return true
    }

    /**
     * The zone's outgoing frame, fitted into a [texW]x[texH] box the way the zone shows it. An image
     * is its bitmap at the ImageView's scale type; a video is its TextureView's current picture
     * (contain, PlayerView resize "fit"), read at the downscaled size so a 4K clip never costs a
     * full-resolution copy. Null when there is nothing capturable (the zone cuts).
     */
    private fun captureZoneFrame(zoneId: String, face: ZoneFace, texW: Int, texH: Int, flipForGl: Boolean): Bitmap? = try {
        when (face) {
            ZoneFace.IMAGE -> {
                val iv = zoneViews[zoneId] as? ImageView
                val bmp = (iv?.drawable as? BitmapDrawable)?.bitmap
                if (iv == null || bmp == null || bmp.isRecycled) null else {
                    val fit = when (iv.scaleType) {
                        ImageView.ScaleType.FIT_CENTER -> "contain"
                        ImageView.ScaleType.FIT_XY -> "fill"
                        else -> "cover"
                    }
                    fitZoneTransitionBitmap(bmp, texW, texH, fit, flipForGl)
                }
            }
            ZoneFace.VIDEO -> {
                val pv = zoneViews[zoneId] as? PlayerView
                val tv = pv?.videoSurfaceView as? TextureView
                val zw = pv?.width ?: 0
                if (tv == null || !tv.isAvailable || tv.width <= 0 || tv.height <= 0 || zw <= 0) null else {
                    val k = minOf(1f, texW.toFloat() / zw)   // zone px -> texture px
                    val raw = tv.getBitmap(maxOf(1, (tv.width * k).toInt()), maxOf(1, (tv.height * k).toInt()))
                    if (raw == null) null else fitZoneTransitionBitmap(raw, texW, texH, "contain", flipForGl).also { raw.recycle() }
                }
            }
            else -> null
        }
    } catch (e: Throwable) { Log.w(TAG, "zone frame capture failed: ${e.message}"); null }

    /** A local clip's first frame, scaled toward the texture box where the platform can (API 27+). Worker thread. */
    private fun zoneFirstFrame(path: String, texW: Int, texH: Int): Bitmap? {
        val r = android.media.MediaMetadataRetriever()
        return try {
            r.setDataSource(path)
            if (android.os.Build.VERSION.SDK_INT >= 27)
                r.getScaledFrameAtTime(0L, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC, texW, texH)
            else r.getFrameAtTime(0L, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } catch (e: Throwable) { Log.w(TAG, "zone first-frame extract failed: ${e.message}"); null }
        finally { try { r.release() } catch (_: Throwable) {} }
    }

    /** End [zoneId]'s transition, whatever stage it is at, and free everything it holds. Idempotent. */
    private fun cancelZoneTransition(zoneId: String) {
        val tx = zoneTx.remove(zoneId) ?: return
        txBook.release(tx.ticket)
        tx.timers.forEach { handler.removeCallbacks(it) }
        tx.timers.clear()
        tx.onVideoFrame = null
        tx.animator?.let { it.setListener(null); it.cancel() }
        tx.handle?.cancel()
        tx.overlay?.let { container.removeView(it) }   // a TextureView's EGL surface goes with it
        (tx.overlay as? ImageView)?.setImageDrawable(null)
        tx.fromFit?.recycle(); tx.fromFit = null
        tx.fadeBitmap?.recycle(); tx.fadeBitmap = null
    }

    private fun cancelAllTransitions() {
        for (id in zoneTx.keys.toList()) cancelZoneTransition(id)
        txBook.cancelAll()
    }

    /*
     * #624: one zone's play-to-end YouTube page reporting back (PlayToEnd.bridgeScript). Counts only
     * while the zone still shows the item it was created for — the same generation check every other
     * zone callback makes.
     */
    private inner class ZoneYoutubeBridge(val zoneId: String, val gen: Int, val startedAt: Long, val advance: () -> Unit) {
        private fun current() = zoneGeneration[zoneId] == gen

        @android.webkit.JavascriptInterface
        fun duration(token: Long, sec: Double) {
            handler.post {
                if (!current()) return@post
                val ms = PlayToEnd.safetyMs(sec, System.currentTimeMillis() - startedAt) ?: return@post
                cancelZoneRotation(zoneId)
                scheduleZoneAdvance(zoneId, ms, advance)
            }
        }

        @android.webkit.JavascriptInterface
        fun ended(token: Long) {
            handler.post {
                if (!current() || !PlayToEnd.endedCounts(System.currentTimeMillis() - startedAt)) return@post
                cancelZoneRotation(zoneId)
                advance()
            }
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

    /**
     * A payload whose assignments are otherwise unchanged may carry new saved fisheye settings (the
     * camera's Edit dialog, read at send time on the server): give each fisheye zone showing that
     * camera its new view without restarting the stream.
     */
    fun updateFisheye(assignments: org.json.JSONArray) {
        for (i in 0 until assignments.length()) {
            val a = assignments.optJSONObject(i) ?: continue
            val cid = a.optString("content_id")
            if (cid.isEmpty()) continue
            val zid = a.optString("zone_id")
            val f = Fisheye.parse(a.optJSONObject("fisheye")) ?: continue
            val (gl, view) = zoneFisheye[zid] ?: continue
            if (zoneViews[zid] !== gl || view.contentId != cid) continue
            if (view.saved != f) view.resave(f)
        }
    }

    /** The fisheye cameras on screen in zones right now (for camera_view). */
    fun fisheyeViews(): List<Fisheye.View> =
        zoneFisheye.filter { (id, p) -> zoneViews[id] === p.first }.map { it.value.second }

    /** The fisheye camera under screen point (x, y) and the view drawing it, for touch; null if none. */
    fun fisheyeAt(x: Float, y: Float): Pair<Fisheye.View, View>? {
        val loc = IntArray(2)
        return zoneFisheye.entries.filter { (id, p) -> zoneViews[id] === p.first }.firstOrNull { (_, p) ->
            val v = p.first
            v.getLocationOnScreen(loc)
            x >= loc[0] && x < loc[0] + v.width && y >= loc[1] && y < loc[1] + v.height
        }?.value?.let { it.second to it.first }
    }

    /*
     * The zone video's watchdog (StreamHealth): on an error or a stall, a zone of several items
     * moves on at once (as an error always did), and a zone of ONE item reconnects the same player in
     * place after FaultBackoff's 2/4/8/15/30 s, keeping its view, fisheye surface and position in
     * the layout. Both guarded by the zone's generation and player: a stale timer from an item
     * already replaced does nothing.
     */
    private fun watchZoneVideo(zone: Zone, player: ExoPlayer, gen: Int, multi: Boolean, advance: () -> Unit, reconnect: (ExoPlayer) -> Unit) {
        val current = { zoneGeneration[zone.id] == gen && zoneExoPlayers[zone.id] === player }
        val health = StreamHealth({ delayMs, reason ->
            if (!current()) return@StreamHealth
            if (multi) {
                com.remotedisplay.player.util.DebugLog.w("Zone", "'${zone.name}': video $reason, moving on")
                handler.post { advance() }
                return@StreamHealth
            }
            com.remotedisplay.player.util.DebugLog.w("Zone", "'${zone.name}': video $reason, reconnecting in ${delayMs / 1000}s")
            zoneReconnect.remove(zone.id)?.let { handler.removeCallbacks(it) }
            val r = Runnable {
                zoneReconnect.remove(zone.id)
                if (!current()) return@Runnable
                try {
                    reconnect(player)
                    com.remotedisplay.player.util.DebugLog.i("Zone", "'${zone.name}': reconnected")
                } catch (e: Throwable) {
                    Log.w(TAG, "zone reconnect failed: ${e.message}")
                }
                zoneHealth[zone.id]?.reconnected()
            }
            zoneReconnect[zone.id] = r
            handler.postDelayed(r, delayMs)
        })
        zoneHealth[zone.id] = health
        if (!healthTicking) { healthTicking = true; handler.postDelayed(healthTick, HEALTH_TICK_MS) }
    }

    private fun forgetZoneHealth(zoneId: String) {
        zoneHealth.remove(zoneId)?.reset()
        zoneReconnect.remove(zoneId)?.let { handler.removeCallbacks(it) }
    }

    private fun releaseExoPlayers() {
        zoneHealth.values.forEach { it.reset() }
        zoneHealth.clear()
        zoneReconnect.values.forEach { handler.removeCallbacks(it) }
        zoneReconnect.clear()
        handler.removeCallbacks(healthTick)
        healthTicking = false
        zoneExoPlayers.values.forEach { it.release() }
        zoneExoPlayers.clear()
        zoneFisheye.clear()
        zoneLiveInputs.values.forEach { it.release() }
        zoneLiveInputs.clear()
    }

    /*
     * ⚠️ IN z_index ORDER, not at the top. A zone's view is re-created every time it changes item,
     * and a plain addView put the new one above every other zone — so z_index held only for the
     * first render. That never mattered while zones sat side by side. It does for an overlay — a
     * channel logo over a live input, a lower-third over a video — and twice over for the HDMI
     * input, whose surface punches a hole through whatever is drawn beneath it: re-rendered on top,
     * it would erase the logo it was meant to carry.
     */
    private fun addZoneView(zone: Zone, view: View) {
        // A transition overlay for this zone stays ON TOP of the view mounted under it until it is
        // removed (it is holding the wipe's last frame while the new view gets its first one).
        zoneTx[zone.id]?.overlay?.let { ov ->
            val i = container.indexOfChild(ov)
            if (i >= 0) { container.addView(view, i); zoneViews[zone.id] = view; return }
        }
        var at = -1
        for ((id, v) in zoneViews) {
            val other = zones.firstOrNull { it.id == id } ?: continue
            if (other.zIndex > zone.zIndex) {
                val i = container.indexOfChild(v)
                if (i >= 0 && (at < 0 || i < at)) at = i
            }
        }
        if (at >= 0) container.addView(view, at) else container.addView(view)
        zoneViews[zone.id] = view
    }

    /** Is any zone showing the screen's HDMI input right now? (screenshots show a placeholder) */
    fun hasLiveInput(): Boolean = zoneLiveInputs.values.any { it.isActive }

    /** The Activity is going: cleanup() plus the zone-transition GL thread. */
    fun release() {
        cleanup()
        txEngine.release()
    }

    fun cleanup() {
        cancelAllRotations()
        cancelAllTransitions()
        txEngine.shutdown()   // the GL context + thread are recreated on the next zone wipe
        zoneFaces.clear()
        zoneLastIdx.clear()
        releaseExoPlayers()
        // Remove ONLY the views we added for zones; the activity's static views live
        // in this same container and must NOT be removed (else single-zone/fullscreen
        // playback, which reuses them, renders black).
        zoneViews.values.forEach { container.removeView(it) }
        zoneViews.clear()
        zones = listOf()
    }
}
