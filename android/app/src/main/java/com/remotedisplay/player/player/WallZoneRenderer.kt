package com.remotedisplay.player.player

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.remotedisplay.player.util.DebugLog
import org.json.JSONArray
import org.json.JSONObject

/**
 * Wall zones — native port of the web player's renderWallZones / wallZoneTick / mountWallZoneItem
 * (server/player/index.html). The rules live in [WallZones] (pure, tested); this owns the views.
 *
 * The stage is added to the wall-transformed root view, which MainActivity.applyWallTransform has
 * already sized to the whole wall canvas (player_rect) and translated to this panel's slice. Zones
 * are therefore placed in percent of the STAGE, and the crop shows this panel its part of each one —
 * a zone can sit inside a panel, straddle a seam, or cover the wall.
 *
 * ⚠️ The stage measures 0x0 until the transform's layout pass has run, so zone geometry is applied
 * from a layout-change listener, never once at build time: a zone placed from a stale width lands on
 * the wrong panel.
 *
 * ⚠️ PACED BY THE SHARED CLOCK, NOT THE LEADER. Every zone lays its own items on [syncedNow] with the
 * group scheduler's slot rule, so every panel that can see a zone computes the same item and position
 * for it on its own — no panel in charge, nothing needed from the server at play time. WallController
 * relays nothing while this is active.
 *
 * Main thread only.
 */
class WallZoneRenderer(
    private val context: Context,
    private val root: FrameLayout,
    // Where in [root] the stage goes: just above the static fullscreen views, below the status
    // overlay and anything added later (trigger layer, kiosk).
    private val stageIndex: () -> Int,
    private val syncedNow: () -> Long,
    private val report: (String) -> Unit = {}
) {
    private val TAG = "WallZones"
    private val handler = Handler(Looper.getMainLooper())

    private data class LZone(
        val geom: WallZones.ZoneGeom,
        val name: String,
        val zIndex: Int,
        val fitMode: String,
        val background: Int?
    )

    /** One thing mounted in a zone: a view and whatever plays into it. */
    private inner class Media(val view: View, val player: ExoPlayer? = null, val live: LiveInputPlayer? = null) {
        var released = false
        // True for a clip the clock aligns; false for stills, web, live streams and frozen frames.
        var alignable = false
        // Whether this clip loops (decided once its length is known — WallZones.shouldLoop).
        var looping = false
        fun pause() { try { player?.playWhenReady = false } catch (_: Throwable) {} }
        fun release(holder: ViewGroup) {
            if (released) return
            released = true
            try { player?.release() } catch (_: Throwable) {}
            try { live?.release() } catch (_: Throwable) {}
            if (view is WebView) try { view.loadUrl("about:blank"); view.destroy() } catch (_: Throwable) {}
            try { holder.removeView(view) } catch (_: Throwable) {}
        }
    }

    private inner class ZoneState(val z: LZone, val holder: FrameLayout, val audio: Boolean) {
        var key: String? = null
        var index = -1
        val medias = mutableListOf<Media>()          // oldest first; the last is the current one
        val current: Media? get() = medias.lastOrNull()
        var alignPending = true
        var lastSeekAt = 0L
    }

    private var stage: FrameLayout? = null
    private var zones = listOf<ZoneState>()
    private var audioSet: Set<String> = emptySet()
    private var items: List<JSONObject> = emptyList()
    private var buckets: Map<String, List<Int>> = emptyMap()
    private var builtSig: String? = null
    private var serverUrl = ""
    private var deviceId = ""
    private var cache: com.remotedisplay.player.data.ContentCache? = null
    @Volatile private var timezone: String? = null
    private val tick = object : Runnable {
        override fun run() { doTick(); handler.postDelayed(this, TICK_MS) }
    }

    val isActive: Boolean get() = stage != null

    fun setTimezone(tz: String?) { timezone = tz }

    /** Is any zone showing the screen's HDMI input right now? (screenshots show a placeholder) */
    fun hasLiveInput(): Boolean = zones.any { zs -> zs.medias.any { it.live?.isActive == true } }

    /**
     * Enter or refresh wall zones. The zones (and this panel's view of them) are rebuilt only when the
     * geometry or the wall config changed; a new item list alone is swapped in live, so a routine
     * refresh never restarts a zone that is still playing the same item.
     */
    fun apply(
        layoutZones: JSONArray,
        assignments: JSONArray,
        configKey: String,
        screen: WallController.Rect,
        player: WallController.Rect,
        audioZones: Collection<String>,
        serverUrl: String,
        deviceId: String,
        cache: com.remotedisplay.player.data.ContentCache
    ) {
        this.serverUrl = serverUrl
        this.deviceId = deviceId
        this.cache = cache
        val lz = parseZones(layoutZones)
        items = (0 until assignments.length()).mapNotNull { assignments.optJSONObject(it) }
        buckets = WallZones.buckets(
            lz.map { it.geom },
            items.map { if (it.isNull("zone_id")) null else it.optString("zone_id", "").ifEmpty { null } },
            items.map { it.optInt("sort_order", 0) }
        )
        val sig = configKey + "|" + lz.joinToString(";") { z ->
            "${z.geom.id}:${z.geom.xPercent}:${z.geom.yPercent}:${z.geom.widthPercent}:${z.geom.heightPercent}:${z.zIndex}:${z.fitMode}:${z.background}"
        }
        if (sig == builtSig && stage != null) { doTick(); return }
        stop()
        builtSig = sig
        audioSet = audioZones.toHashSet()

        val st = FrameLayout(context)
        st.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.addView(st, stageIndex().coerceIn(0, root.childCount))
        stage = st
        val audio = audioSet
        val built = ArrayList<ZoneState>()
        // Added in z_index order (stable): the holders persist across item changes, so the stacking
        // set here holds for the life of the layout — unlike a view re-added on every swap.
        for (z in lz.sortedBy { it.zIndex }) {
            if (!WallZones.visibleOnPanel(z.geom, player, screen)) continue
            val holder = FrameLayout(context)
            z.background?.let { holder.setBackgroundColor(it) }
            st.addView(holder, FrameLayout.LayoutParams(0, 0))
            built.add(ZoneState(z, holder, z.geom.id in audio))
        }
        zones = built
        st.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or_, ob ->
            if (r - l != or_ - ol || b - t != ob - ot) st.post { placeHolders() }
        }
        st.post { placeHolders() }
        val msg = "wall zones: ${built.size}/${lz.size} visible on this panel, audio for ${audio.size}"
        DebugLog.i(TAG, msg); report(msg)
        handler.post(tick)
    }

    /** Leave wall-zone mode: every zone's media and the tick go. Idempotent. */
    fun stop() {
        handler.removeCallbacks(tick)
        for (zs in zones) releaseZone(zs)
        zones = emptyList()
        stage?.let { try { root.removeView(it) } catch (_: Throwable) {} }
        stage = null
        builtSig = null
    }

    private fun parseZones(arr: JSONArray): List<LZone> = (0 until arr.length()).mapNotNull { i ->
        val z = arr.optJSONObject(i) ?: return@mapNotNull null
        val id = z.optString("id", "").ifEmpty { return@mapNotNull null }
        LZone(
            geom = WallZones.ZoneGeom(
                id,
                z.optDouble("x_percent", 0.0).toFloat(), z.optDouble("y_percent", 0.0).toFloat(),
                z.optDouble("width_percent", 100.0).toFloat(), z.optDouble("height_percent", 100.0).toFloat()
            ),
            name = z.optString("name", "Zone"),
            zIndex = z.optInt("z_index", 0),
            fitMode = z.optString("fit_mode", "cover").ifEmpty { "cover" },
            background = WallZones.parseCssColor(if (z.isNull("background_color")) null else z.optString("background_color"))
        )
    }

    private fun placeHolders() {
        val st = stage ?: return
        val w = st.width; val h = st.height
        if (w <= 0 || h <= 0) return
        for (zs in zones) {
            val g = zs.z.geom
            val lp = FrameLayout.LayoutParams(
                Math.round(g.widthPercent / 100f * w), Math.round(g.heightPercent / 100f * h)
            ).apply {
                leftMargin = Math.round(g.xPercent / 100f * w)
                topMargin = Math.round(g.yPercent / 100f * h)
            }
            zs.holder.layoutParams = lp
        }
    }

    // ------------------------------------------------------------------------------------ clock

    private fun mimeOf(a: JSONObject): String = if (a.isNull("mime_type")) "" else a.optString("mime_type", "")
    private fun remoteOf(a: JSONObject): String? = if (a.isNull("remote_url")) null else a.optString("remote_url", "").ifEmpty { null }
    private fun isLive(mime: String) = mime == "video/hls" || mime == "video/rtsp" || LiveInput.isLiveInput(mime)

    private fun allows(a: JSONObject): Boolean = try {
        if (a.optInt("enabled", 1) == 0) false
        else {
            val blocks = ArrayList<ScheduleEval.Block>()
            a.optJSONArray("schedules")?.let { arr ->
                for (j in 0 until arr.length()) {
                    val s = arr.getJSONObject(j)
                    val d = s.getJSONArray("days")
                    val days = HashSet<Int>(d.length())
                    for (k in 0 until d.length()) days.add(d.getInt(k))
                    blocks.add(ScheduleEval.Block(days, s.getString("start"), s.getString("end"),
                        if (s.isNull("start_date")) null else s.optString("start_date").ifEmpty { null },
                        if (s.isNull("end_date")) null else s.optString("end_date").ifEmpty { null }))
                }
            }
            val window = ScheduleEval.windowOf(
                if (a.isNull("play_from")) null else a.optString("play_from").ifEmpty { null },
                if (a.isNull("play_until")) null else a.optString("play_until").ifEmpty { null })
            if (!ScheduleEval.isItemActiveNow(blocks, System.currentTimeMillis(), timezone, window)) false
            else {
                val cond = ScheduleEval.parseCondition(a.optJSONObject("play_when"))
                when (cond?.type) {
                    "tag" -> {
                        val t = a.optJSONArray("tags")
                        ScheduleEval.tagOk(cond, if (t == null) emptyList() else (0 until t.length()).map { t.optString(it, "").trim() }.filter { it.isNotEmpty() })
                    }
                    "meta" -> ScheduleEval.conditionOk(cond, a.optJSONObject("meta") ?: JSONObject())
                    else -> ScheduleEval.conditionOk(cond, a.optJSONObject("_ds"))
                }
            }
        }
    } catch (e: Throwable) { true }

    /** Which item this is, for "has the zone moved on" — identity, not every field. */
    private fun identity(a: JSONObject): String =
        a.optString("content_id") + "|" + a.optString("widget_id") + "|" + a.optLong("widget_rev", 0L) + "|" +
            a.optLong("content_rev", 0L) + "|" + mimeOf(a) + "|" + (remoteOf(a) ?: "")

    private fun doTick() {
        if (stage == null) return
        val now = syncedNow()
        for (zs in zones) {
            val list = (buckets[zs.z.geom.id] ?: emptyList()).mapNotNull { items.getOrNull(it) }
            val t = WallZones.target(
                list.map { WallZones.SlotItem(it.optInt("duration_sec", 10), allows(it), isLive(mimeOf(it))) }, now)
            if (t == null) {
                if (zs.index != -1 || zs.medias.isNotEmpty()) releaseZone(zs)
                continue
            }
            val item = list[t.index]
            val m0 = mimeOf(item)
            val key = WallZones.mountKey(t.index, identity(item),
                m0.startsWith("video/") && !isLive(m0) && m0 != "video/youtube", t.cycle)
            if (key != zs.key) {
                try { mount(zs, item, t, list.getOrNull(t.prevIndex)) } catch (e: Throwable) {
                    Log.w(TAG, "zone ${zs.z.name}: mount failed: ${e.message}")
                }
                zs.key = key; zs.index = t.index
                zs.alignPending = true
                continue
            }
            correct(zs, t)
        }
    }

    /** The group-sync seek/nudge maths, per zone, toward this zone's slot on the clock. */
    private fun correct(zs: ZoneState, t: WallZones.Target) {
        val m = zs.current ?: return
        val p = m.player ?: return
        if (!m.alignable || m.released) return
        if (p.playbackState != Player.STATE_READY && p.playbackState != Player.STATE_ENDED) return
        val durMs = p.duration
        if (durMs == C.TIME_UNSET || durMs <= 0) return
        val clip = durMs / 1000f
        // A one-shot clip whose slot outlasted it stays on its last frame — nothing to correct.
        if (WallZones.clipDone(t.posSec, clip, m.looping)) { zs.alignPending = false; return }
        val target = WallZones.clipTargetSec(t.posSec, clip, m.looping)
        val drift = p.currentPosition / 1000f - target
        val nowMs = System.currentTimeMillis()
        when (val c = WallZones.correction(drift, zs.alignPending, nowMs - zs.lastSeekAt)) {
            WallZones.Correction.SEEK_ALIGN, WallZones.Correction.SEEK -> {
                seekExact(p, (target * 1000).toLong()); p.setPlaybackSpeed(1.0f); zs.lastSeekAt = nowMs
            }
            else -> if (p.playbackParameters.speed != WallZones.rateFor(c)) p.setPlaybackSpeed(WallZones.rateFor(c))
        }
        zs.alignPending = false
    }

    private fun seekExact(p: ExoPlayer, ms: Long) {
        try { p.setSeekParameters(SeekParameters.EXACT); p.seekTo(ms.coerceAtLeast(0L)) } catch (_: Throwable) {}
    }

    // ------------------------------------------------------------------------------------ mount

    private fun releaseZone(zs: ZoneState) {
        for (m in zs.medias) m.release(zs.holder)
        zs.medias.clear()
        zs.index = -1; zs.key = null
    }

    private fun mount(zs: ZoneState, a: JSONObject, t: WallZones.Target, prev: JSONObject?) {
        val mime = mimeOf(a)
        if (Hold.isHold(mime)) {
            val action = WallZones.holdAction(
                Hold.mode(remoteOf(a)),
                zoneHasPicture = zs.current?.released == false,
                prevIsHold = prev != null && Hold.isHold(mimeOf(prev)),
                hasPrev = prev != null
            )
            when (action) {
                WallZones.HoldAction.RELEASE -> releaseZone(zs)
                // FREEZE: the outgoing frame stays up, paused, and the clock stops correcting it.
                WallZones.HoldAction.PAUSE_CURRENT -> zs.medias.forEach { it.pause(); it.alignable = false }
                // A panel that arrives mid-hold builds what the others are showing: the previous
                // slot's item at its last frame.
                WallZones.HoldAction.BUILD_PREVIOUS_AT_END -> {
                    releaseZone(zs)
                    build(zs, prev!!, t, frozenAtEnd = true)?.let { m ->
                        zs.medias.add(m); zs.holder.addView(m.view, matchParent())
                    }
                }
                WallZones.HoldAction.NOTHING -> {}
            }
            DebugLog.i(TAG, "'${zs.z.name}' -> hold ${Hold.mode(remoteOf(a)).name.lowercase()} (${t.slotSec}s)")
            return
        }
        val built = build(zs, a, t, frozenAtEnd = false)
        if (built == null) { releaseZone(zs); return }
        DebugLog.i(TAG, "'${zs.z.name}' -> ${a.optString("filename", "").ifEmpty { mime.ifEmpty { "item" } }} @${"%.2f".format(t.posSec)}s/${t.slotSec}s")
        // Buffered swap: the new view mounts invisible above the old one and replaces it once it has
        // something to show — no black blink at every boundary in a zone.
        built.view.alpha = 0f
        zs.medias.add(built)
        zs.holder.addView(built.view, matchParent())
        armReveal(zs, built)
    }

    private fun matchParent() = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

    // Reveal hooks per media; the timeout guarantees one even if no first-frame event ever comes.
    private val revealers = HashMap<Media, () -> Unit>()

    private fun armReveal(zs: ZoneState, m: Media) {
        var done = false
        val reveal: () -> Unit = {
            if (!done) {
                done = true
                revealers.remove(m)
                if (!m.released) {
                    m.view.alpha = 1f
                    val i = zs.medias.indexOf(m)
                    if (i > 0) {
                        val older = zs.medias.subList(0, i).toList()
                        older.forEach { it.release(zs.holder) }
                        zs.medias.removeAll(older)
                    }
                }
            }
        }
        revealers[m] = reveal
        handler.postDelayed({ reveal() }, REVEAL_TIMEOUT_MS)
    }

    private fun revealNow(m: Media) { handler.post { revealers[m]?.invoke() } }

    private fun fitOf(a: JSONObject, z: LZone): String =
        (if (a.isNull("fit_mode")) "" else a.optString("fit_mode", "")).ifEmpty { z.fitMode }

    private fun srcOf(a: JSONObject): String? {
        remoteOf(a)?.let { return it }
        val cid: String = (if (a.isNull("content_id")) null else a.optString("content_id", "").ifEmpty { null }) ?: return null
        cache?.getCachedFile(cid)?.let { return Uri.fromFile(it).toString() }
        val fp = a.optString("filepath", "")
        return if (fp.isNotEmpty()) "$serverUrl/uploads/content/$fp" else "$serverUrl/api/content/$cid/file"
    }

    private fun build(zs: ZoneState, a: JSONObject, t: WallZones.Target, frozenAtEnd: Boolean): Media? {
        val mime = mimeOf(a)
        val widgetType = if (a.isNull("widget_type")) null else a.optString("widget_type", "").ifEmpty { null }
        val widgetId = if (a.isNull("widget_id")) null else a.optString("widget_id", "").ifEmpty { null }
        val muted = a.optInt("muted", 0) == 1
        val audible = WallZones.audible(zs.z.geom.id, audioSet, muted)
        return when {
            widgetType != null || widgetId != null -> {
                val wv = WebView(context).also { com.remotedisplay.player.util.WebViewSupport.configure(it, "WallZone") }
                wv.loadUrl("$serverUrl/api/widgets/$widgetId/render" +
                    (if (deviceId.isNotEmpty()) "?device=" + Uri.encode(deviceId) else "?d=") + "&rev=" + a.optLong("widget_rev", 0L) +
                    com.remotedisplay.player.util.WidgetUrls.panelFragment(a.optString("widget_panel", "")))
                Media(wv)
            }
            mime == ItemTiming.BUNDLE_MIME -> {
                val wv = WebView(context).also { com.remotedisplay.player.util.WebViewSupport.configure(it, "WallZone") }
                wv.loadUrl("$serverUrl/api/content/" + a.optString("content_id", "") + "/bundle?rev=" + a.optLong("content_rev", 0L))
                Media(wv)
            }
            LiveInput.isLiveInput(mime) -> {
                val box = FrameLayout(context)
                val live = LiveInputPlayer(context, box, 0) { reason -> DebugLog.w(TAG, "'${zs.z.name}': HDMI input $reason") }
                if (!live.play(remoteOf(a) ?: "hdmi://", !audible)) { live.release(); null }
                else Media(box, live = live).also { revealNow(it) }
            }
            mime.startsWith("image/") -> {
                val iv = ImageView(context).apply {
                    scaleType = when (fitOf(a, zs.z)) {
                        "contain" -> ImageView.ScaleType.FIT_CENTER
                        "fill" -> ImageView.ScaleType.FIT_XY
                        else -> ImageView.ScaleType.CENTER_CROP
                    }
                }
                val m = Media(iv)
                val bw = zs.holder.width.takeIf { it > 0 } ?: com.remotedisplay.player.util.ImageLoader.screenWidth(context)
                val bh = zs.holder.height.takeIf { it > 0 } ?: com.remotedisplay.player.util.ImageLoader.screenHeight(context)
                val cid = if (a.isNull("content_id")) null else a.optString("content_id", "").ifEmpty { null }
                val file = if (remoteOf(a) == null && cid != null) cache?.getCachedFile(cid) else null
                val url = if (file == null) srcOf(a) else null
                Thread {
                    val bmp = try {
                        if (file != null) com.remotedisplay.player.util.ImageLoader.decodeFile(file, bw, bh)
                        else if (url != null) com.remotedisplay.player.util.ImageLoader.decodeUrl(url, bw, bh) else null
                    } catch (e: Throwable) { null }
                    handler.post {
                        if (m.released) return@post
                        if (bmp != null) try { iv.setImageBitmap(bmp) } catch (_: Throwable) {}
                        else DebugLog.w(TAG, "'${zs.z.name}': unloadable image ${cid ?: url}")
                        revealers[m]?.invoke()
                    }
                }.start()
                m
            }
            mime.startsWith("video/") && mime != "video/youtube" -> buildVideo(zs, a, t, mime, audible, frozenAtEnd)
            // YouTube (cannot be put on a clock) and unknown types: the zone shows its background.
            else -> null
        }
    }

    private fun buildVideo(zs: ZoneState, a: JSONObject, t: WallZones.Target, mime: String, audible: Boolean, frozenAtEnd: Boolean): Media? {
        val src = srcOf(a) ?: return null
        val pv = (android.view.LayoutInflater.from(context)
            .inflate(com.remotedisplay.player.R.layout.zone_player, null) as PlayerView).apply {
            useController = false
            resizeMode = when (fitOf(a, zs.z)) {
                "contain" -> AspectRatioFrameLayout.RESIZE_MODE_FIT
                "fill" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                else -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            }
        }
        val p = ExoPlayer.Builder(context).build()
        val m = Media(pv, player = p)
        val live = isLive(mime)
        m.alignable = !live && !frozenAtEnd
        val mountedAt = syncedNow()
        if (mime == "video/rtsp") {
            p.setMediaSource(androidx.media3.exoplayer.rtsp.RtspMediaSource.Factory().setForceUseRtpTcp(true)
                .createMediaSource(MediaItem.fromUri(src)))
        } else p.setMediaItem(MediaItem.fromUri(src))
        p.volume = if (audible) 1f else 0f
        p.repeatMode = Player.REPEAT_MODE_OFF
        p.addListener(object : Player.Listener {
            var placed = false
            override fun onPlaybackStateChanged(state: Int) {
                if (state != Player.STATE_READY || placed || m.released) return
                placed = true
                val d = p.duration
                if (d == C.TIME_UNSET || d <= 0) return
                if (frozenAtEnd) {
                    // What the other panels are holding: this clip's last frame, paused.
                    seekExact(p, (d - 50).coerceAtLeast(0L)); p.playWhenReady = false
                    return
                }
                if (live) return
                val clip = d / 1000f
                // ⚠️ Loop ONLY a clip shorter than its slot (WallZones.shouldLoop).
                val loop = WallZones.shouldLoop(clip, t.slotSec)
                m.looping = loop
                p.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                // Start where the clock says, not at 0: a panel that joins mid-clip lands on the
                // same frame as the others.
                val pos = t.posSec + (syncedNow() - mountedAt) / 1000f
                if (WallZones.clipDone(pos, clip, loop)) {
                    // Joined after the clip ended: show what the others hold — its last frame.
                    seekExact(p, (d - 50).coerceAtLeast(0L)); p.playWhenReady = false
                    return
                }
                seekExact(p, (WallZones.clipTargetSec(pos, clip, loop) * 1000).toLong())
            }
            override fun onRenderedFirstFrame() { revealNow(m) }
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                // The clock moves the zone on at its boundary; until then it shows its background.
                DebugLog.w(TAG, "'${zs.z.name}': video error ${error.errorCodeName}")
                revealNow(m)
            }
        })
        pv.player = p
        p.prepare()
        p.playWhenReady = !frozenAtEnd
        if (frozenAtEnd) revealNow(m)
        return m
    }

    private companion object {
        const val TICK_MS = 250L
        const val REVEAL_TIMEOUT_MS = 1500L
    }
}
