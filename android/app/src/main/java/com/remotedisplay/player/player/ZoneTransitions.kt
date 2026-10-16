package com.remotedisplay.player.player

/*
 * Shader transitions INSIDE layout zones — the pure half (no Android graphics, JVM-testable; see
 * ZoneTransitionsTest). The GL half is ZoneTransitionEngine, the wiring is ZoneManager.
 *
 * The model is the native player's (engine.py ZoneRunner + Surface.qml): a transition is a widget
 * placed in a zone, the server resolves it PER ZONE onto each item as `item.transition` (#647), and
 * the zone plays the transition of the item it moves INTO. Every zone runs its own, concurrently —
 * a ticker keeps scrolling while the main zone wipes.
 *
 * What actually wipes follows the Android FULL-SCREEN path (MediaPlayerManager.runWipe), because
 * that is what this hardware has been shown to do safely:
 *
 *   from \ to       image        local video file   stream / web / YouTube / live / hold
 *   image           wipe         wipe (frame 0)     cut
 *   video           wipe         wipe (frame 0)     cut
 *   web / live /
 *   nothing shown   cut          cut                cut
 *
 * A video's outgoing frame is its TextureView's current picture; an incoming video's is its first
 * frame, extracted off the main thread, and the clip starts from frame 0 once the wipe lands, so
 * the seam is invisible. Widgets, bundles and YouTube cut, as they do full screen — a WebView has
 * no reliable way to hand over its pixels. Remote (uncached) videos and streams cut: there is no
 * file to pull a first frame from.
 */

/** What a zone is showing right now, as far as a transition's outgoing frame is concerned. */
enum class ZoneFace { NONE, IMAGE, VIDEO, WEB, LIVE }

/** What a zone item is about to show, as far as a transition's incoming frame is concerned. */
enum class ZoneTarget { IMAGE, VIDEO_FILE, VIDEO_STREAM, WEB, LIVE, HOLD, NONE }

/** How one zone advance is presented. */
enum class ZoneTxMode {
    /** Plain swap — exactly what every zone did before this. */
    CUT,
    /** The item's GL shader, through ZoneTransitionEngine. */
    SHADER,
    /** GL, but with the built-in crossfade: the item's shader is missing (native parity). */
    GL_CROSSFADE,
    /** No GL slot free (or no GL at all): a view-alpha crossfade of the outgoing frame. Cheap. */
    VIEW_CROSSFADE
}

object ZoneTransitionPolicy {

    fun targetKind(mimeType: String, widgetType: String?, remoteUrl: String?, hasCachedFile: Boolean): ZoneTarget = when {
        widgetType != null -> ZoneTarget.WEB
        mimeType == ItemTiming.BUNDLE_MIME -> ZoneTarget.WEB
        Hold.isHold(mimeType) -> ZoneTarget.HOLD
        mimeType == "video/youtube" -> ZoneTarget.WEB
        LiveInput.isLiveInput(mimeType) -> ZoneTarget.LIVE
        mimeType == "video/hls" || mimeType == "video/rtsp" -> ZoneTarget.VIDEO_STREAM
        mimeType.startsWith("video/") ->
            // The zone plays a remote_url, or an uncached item, straight from the network: no file to
            // pull frame 0 from without a second download, so it cuts (full screen: playVideoFromUrl).
            if (remoteUrl.isNullOrEmpty() && hasCachedFile) ZoneTarget.VIDEO_FILE else ZoneTarget.VIDEO_STREAM
        mimeType.startsWith("image/") -> ZoneTarget.IMAGE
        else -> ZoneTarget.NONE
    }

    /**
     * Decide one advance. [prevIdx] is the index the zone showed last (-1 on its first show after a
     * render); a zone transitions only into a DIFFERENT item after its first, like the native
     * player — a zone left with one playable item re-shows it every dwell, and must not play an
     * effect into itself, and the very first paint has nothing to wipe from.
     */
    fun decide(
        spec: TransitionSpec?,
        prevIdx: Int,
        nextIdx: Int,
        from: ZoneFace,
        to: ZoneTarget,
        glUsable: Boolean,
        glSlotFree: Boolean,
        viewSlotFree: Boolean,
        shaderFound: Boolean
    ): ZoneTxMode {
        if (spec == null || spec.effects.isEmpty()) return ZoneTxMode.CUT
        if (prevIdx < 0 || prevIdx == nextIdx) return ZoneTxMode.CUT
        if (from != ZoneFace.IMAGE && from != ZoneFace.VIDEO) return ZoneTxMode.CUT
        if (to != ZoneTarget.IMAGE && to != ZoneTarget.VIDEO_FILE) return ZoneTxMode.CUT
        if (glUsable && glSlotFree) return if (shaderFound) ZoneTxMode.SHADER else ZoneTxMode.GL_CROSSFADE
        return if (viewSlotFree) ZoneTxMode.VIEW_CROSSFADE else ZoneTxMode.CUT
    }

    /** The fit an image item uses in a zone: its own fit_mode, else the zone's, else cover. */
    fun imageFit(itemFit: String?, zoneFit: String?): String {
        val f = (itemFit ?: "").ifEmpty { zoneFit ?: "" }
        return when (f) { "contain", "fill" -> f; else -> "cover" }
    }

    /**
     * How many GL zone wipes may run at once. Each costs two textures and a per-frame draw + swap on
     * the shared GL thread; the shader fill is bounded by the zone areas (zones tile the screen, so
     * four concurrent zone wipes cost about one full-screen wipe), so the budget is about the swaps
     * and the shader compiles, which is what a Fire TV Stick's Mali chokes on. Zones laid out
     * together usually advance together, so the overflow is common and must be cheap: it gets a
     * view crossfade, never a stall.
     */
    fun maxConcurrentGl(lowRam: Boolean, totalMemBytes: Long): Int =
        if (lowRam || (totalMemBytes in 1 until LOW_MEM_BYTES)) 2 else 4

    const val LOW_MEM_BYTES = 2_500L * 1024 * 1024
    /** View crossfades are a single ImageView alpha animation each; bounded anyway. */
    const val MAX_VIEW_FADES = 4

    /**
     * The dwell left for an item once the transition into it has landed: the wipe (and its prep) is
     * counted inside the item's duration, as the native zone timer does, so a zone keeps its cadence.
     * Never less than half the duration — a slow device still shows the item properly. [startedAt] 0
     * = no transition, the full duration.
     */
    fun dwellAfterTransition(durationMs: Long, startedAt: Long, now: Long): Long {
        if (startedAt <= 0L || now <= startedAt) return durationMs
        return (durationMs - (now - startedAt)).coerceAtLeast(durationMs / 2)
    }

    /** Outgoing frame + incoming frame must be ready (decode, frame-0 extract) within this. */
    const val PREP_DEADLINE_MS = 2_500L
    /** From handing a job to the GL engine to its first drawn frame. Missed -> the zone cuts. */
    const val START_DEADLINE_MS = 1_200L
    /** A video target keeps the wipe's last frame up until the decoder renders, capped by this. */
    const val VIDEO_FIRST_FRAME_CAP_MS = 2_500L
    /** Hold the finished overlay a few frames so its removal never beats the new view's first draw. */
    const val PARK_MS = 64L
}

object ZoneTransitionFit {
    /** Captured frames are downscaled so their long edge is at most this (Vega's player does the same). */
    const val MAX_LONG_EDGE = 960

    /** Texture size for a zone box: the box itself, scaled down so the long edge fits [maxLongEdge]. */
    fun textureSize(boxW: Int, boxH: Int, maxLongEdge: Int = MAX_LONG_EDGE): Pair<Int, Int> {
        if (boxW <= 0 || boxH <= 0) return 0 to 0
        val long = maxOf(boxW, boxH)
        if (long <= maxLongEdge) return boxW to boxH
        val s = maxLongEdge.toDouble() / long
        return maxOf(1, Math.round(boxW * s).toInt()) to maxOf(1, Math.round(boxH * s).toInt())
    }

    /**
     * Where a [srcW]x[srcH] picture lands in a [dstW]x[dstH] box for [fit] — `contain` (letterbox,
     * ImageView FIT_CENTER / PlayerView resize "fit"), `fill` (stretch, FIT_XY), anything else
     * `cover` (CENTER_CROP; the rect overflows the box and is clipped by it). Returned as
     * [left, top, right, bottom]. Matches the view the zone shows, so the wipe's first and last frames
     * are pixel-for-pixel the pictures on either side of it.
     */
    fun destRect(srcW: Int, srcH: Int, dstW: Int, dstH: Int, fit: String?): FloatArray {
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return floatArrayOf(0f, 0f, dstW.toFloat(), dstH.toFloat())
        if (fit == "fill") return floatArrayOf(0f, 0f, dstW.toFloat(), dstH.toFloat())
        val sx = dstW.toFloat() / srcW; val sy = dstH.toFloat() / srcH
        val s = if (fit == "contain") minOf(sx, sy) else maxOf(sx, sy)
        val w = srcW * s; val h = srcH * s
        val l = (dstW - w) / 2f; val t = (dstH - h) / 2f
        return floatArrayOf(l, t, l + w, t + h)
    }
}

/**
 * Who holds a zone transition right now, and how many GL ones are in flight. One transition per
 * zone; a new one for the same zone replaces (cancels) the old. A ticket is LIVE only while it is
 * still the zone's ticket AND the zone's generation is the one it was issued under — the same
 * zoneGeneration guard every other zone callback checks, so a layout change or a fresh advance
 * turns every late callback of the old transition into a no-op.
 */
class ZoneTransitionBook(val maxGl: Int, val maxViewFades: Int = ZoneTransitionPolicy.MAX_VIEW_FADES) {
    class Ticket internal constructor(val zoneId: String, val gen: Int, val gl: Boolean, val serial: Long)

    private val active = HashMap<String, Ticket>()
    private var serial = 0L

    val glActive: Int get() = active.values.count { it.gl }
    val viewActive: Int get() = active.values.count { !it.gl }

    /** Free slots, NOT counting [zoneId]'s own (it is about to be replaced). */
    fun glSlotFree(zoneId: String): Boolean = active.values.count { it.gl && it.zoneId != zoneId } < maxGl
    fun viewSlotFree(zoneId: String): Boolean = active.values.count { !it.gl && it.zoneId != zoneId } < maxViewFades

    /** Take a slot for [zoneId]. Returns the ticket, plus the zone's previous ticket (to cancel), or null if full. */
    fun acquire(zoneId: String, gen: Int, gl: Boolean): Pair<Ticket, Ticket?>? {
        if (gl && !glSlotFree(zoneId)) return null
        if (!gl && !viewSlotFree(zoneId)) return null
        val prev = active.remove(zoneId)
        val t = Ticket(zoneId, gen, gl, ++serial)
        active[zoneId] = t
        return t to prev
    }

    fun isLive(t: Ticket, currentGen: Int?): Boolean = active[t.zoneId] === t && currentGen == t.gen

    /** Release [t] if it still holds its zone. Idempotent; a stale ticket never frees a newer one. */
    fun release(t: Ticket): Boolean {
        if (active[t.zoneId] !== t) return false
        active.remove(t.zoneId)
        return true
    }

    fun current(zoneId: String): Ticket? = active[zoneId]
    fun cancelZone(zoneId: String): Ticket? = active.remove(zoneId)
    fun cancelAll(): List<Ticket> { val all = active.values.toList(); active.clear(); return all }
}
