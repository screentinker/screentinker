package com.remotedisplay.player.remote

import android.app.Activity
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.remotedisplay.player.R
import org.webrtc.EglBase
import org.webrtc.VideoTrack

/**
 * 3.0 screen share — what the Android player SHOWS (the receivers are ScreenShareReceiver). The same
 * picture the web player draws (server/lib/screen-share-player.js):
 *
 *  - every share on screen in its own TILE over the (ducked) content, on black: one fills the
 *    screen, two sit side by side (stacked on a portrait screen), three or four make a 2x2 grid
 *    (ScreenShareProtocol.rects), with a 2 px black frame round each tile when more than one shows.
 *    Each is letterboxed in its tile, "Connecting to …" until its first frame, with its own small
 *    "Shared by <name>" badge bottom-left (" · guest" for a guest);
 *  - device:screenshare-layout's spotlight: only that share is shown, full screen; the others stay
 *    CONNECTED (their tiles are just made invisible — the decoder and surface keep going, so going
 *    back to tiles is instant). Sound is not decided here: ScreenShareController does that;
 *  - the meeting-room code — QR, "Share your screen here", the address, the code — full size
 *    bottom-right when nobody shares, and a compact card top-right above the tiles while people
 *    share (the server only sends a code then while a slot is still free).
 *
 * Everything lives in [parent] (MainActivity's pipLayout), so it turns with the panel's orientation
 * and is in the remote-view capture (ShareVideoView is a TextureView; ScreenshotCapture composites
 * those, tile by tile). The tiles are children of ONE black container tagged [TAG]. Tiles are laid
 * out again on every start, end and layout, and whenever the container changes size.
 * The name is only ever set with TextView.setText — it is whatever a guest typed.
 */
class ScreenShareOverlay(private val activity: Activity, private val parent: FrameLayout) : ScreenShareBus.Listener {
    companion object {
        const val TAG = "st-share-overlay"
        const val TILE_TAG = "st-share-tile"
    }

    /** One share on screen. [frameW]x[frameH] is its video's (rotated) size, 0 until the first frame. */
    private class Tile(
        val start: ScreenShareProtocol.Start,
        val frame: FrameLayout,
        val video: ShareVideoView,
        val wait: TextView,
        val badge: TextView,
    ) {
        var track: VideoTrack? = null
        var frameW = 0
        var frameH = 0
        var border = 0
    }

    private val tiles = LinkedHashMap<String, Tile>()   // start order, oldest first
    private var layout = ScreenShareProtocol.Layout.NONE
    private var container: FrameLayout? = null
    private var codeView: LinearLayout? = null
    private var code: ScreenShareProtocol.Code? = null

    private fun vw(pct: Float): Float = parent.width.takeIf { it > 0 }?.let { it * pct / 100f }
        ?: (activity.resources.displayMetrics.widthPixels * pct / 100f)
    private fun sp(min: Float, pct: Float): Float = maxOf(min * activity.resources.displayMetrics.scaledDensity, vw(pct))

    // A rotation / resize moves every tile: lay out again once the new size is known. Posted, so the
    // tiles' new layout params are not set from inside a layout pass.
    private val onResize = View.OnLayoutChangeListener { v, l, t, r, b, oldL, oldT, oldR, oldB ->
        if (r - l != oldR - oldL || b - t != oldB - oldT) v.post { relayout() }
    }

    fun attach() { ScreenShareBus.listener = this }

    fun detach() {
        if (ScreenShareBus.listener === this) ScreenShareBus.listener = null
        for (id in tiles.keys.toList()) onShareEnd(id)
        codeView?.let { try { parent.removeView(it) } catch (_: Throwable) {} }
        codeView = null
    }

    // ------------------------------------------------------------------------------ the shares
    private fun container(): FrameLayout = container ?: FrameLayout(activity).apply {
        setBackgroundColor(Color.BLACK)
        translationZ = 10_000f            // above the PiP and trigger layers sharing pipLayout
        tag = TAG                         // ScreenshotCapture.drawScreenShare finds it by this
        isClickable = false
        addOnLayoutChangeListener(onResize)
        this@ScreenShareOverlay.parent.addView(this, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        bringToFront()
    }.also { container = it }

    override fun onShareStart(start: ScreenShareProtocol.Start) {
        if (tiles.containsKey(start.sessionId)) return
        val f = FrameLayout(activity).apply {
            setBackgroundColor(Color.BLACK)
            tag = TILE_TAG
            isClickable = false
        }
        val v = ShareVideoView(activity).apply { visibility = View.INVISIBLE }
        f.addView(v, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        val w = TextView(activity).apply {
            setTextColor(Color.rgb(0xcb, 0xd5, 0xe1))
            setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(16f, 2.2f))
            gravity = Gravity.CENTER
            val p = vw(1f).toInt()
            setPadding(p, 0, p, 0)
            text = ScreenShareProtocol.fmt(activity.getString(R.string.screen_share_connecting), start.sharedBy)
        }
        f.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        val pad = vw(0.9f).toInt()
        val badge = TextView(activity).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_PX, sp(12f, 1.05f))
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
            setSingleLine(true); ellipsize = TextUtils.TruncateAt.END
            maxWidth = vw(60f).toInt()
            setPadding(pad, pad / 2, pad, pad / 2)
            background = GradientDrawable().apply { setColor(Color.argb(184, 15, 23, 42)); cornerRadius = vw(0.5f) }
            text = ScreenShareProtocol.badgeText(activity.getString(R.string.screen_share_shared_by),
                activity.getString(R.string.screen_share_guest), start.sharedBy, start.guest)
        }
        val margin = vw(1.2f).toInt()
        f.addView(badge, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM or Gravity.START).apply { setMargins(margin, margin, margin, margin) })
        val tile = Tile(start, f, v, w, badge)
        v.onFrameSize = { fw, fh ->
            tile.frameW = fw; tile.frameH = fh
            letterbox(tile)
        }
        tiles[start.sessionId] = tile
        container().addView(f, FrameLayout.LayoutParams(0, 0, Gravity.TOP or Gravity.START))
        relayout()
    }

    override fun onShareTrack(sessionId: String, track: VideoTrack, egl: EglBase.Context) {
        val t = tiles[sessionId] ?: return
        if (t.track != null) return
        try {
            t.video.init(egl)
            track.addSink(t.video)
            t.track = track
        } catch (_: Throwable) {}
    }

    override fun onShareEnd(sessionId: String) {
        val t = tiles.remove(sessionId) ?: return
        // Order matters: stop frames, drop the surface (releases the EGL surface), then the renderer.
        try { t.track?.removeSink(t.video) } catch (_: Throwable) {}
        t.track = null
        container?.let { c -> try { c.removeView(t.frame) } catch (_: Throwable) {} }
        t.video.release()
        if (tiles.isEmpty()) {
            container?.let { c ->
                c.removeOnLayoutChangeListener(onResize)
                try { parent.removeView(c) } catch (_: Throwable) {}
            }
            container = null
            layout = ScreenShareProtocol.Layout.NONE   // web: layoutState reset with the last tile
        } else relayout()
        paintCode()
    }

    override fun onLayout(layout: ScreenShareProtocol.Layout) {
        this.layout = layout
        relayout()
    }

    /*
     * Put every tile where ScreenShareProtocol says, in pixels of the container (its parent's size
     * until it has been laid out itself): the visible ones at their rects with the 2 px frame when
     * there are several, the rest INVISIBLE — never removed, that would destroy the TextureView's
     * surface under a session that is still connected.
     */
    private fun relayout() {
        if (tiles.isEmpty()) return
        val c = container ?: return
        val dm = activity.resources.displayMetrics
        val cw = c.width.takeIf { it > 0 } ?: parent.width.takeIf { it > 0 } ?: dm.widthPixels
        val ch = c.height.takeIf { it > 0 } ?: parent.height.takeIf { it > 0 } ?: dm.heightPixels
        val order = tiles.keys.toList()
        val vis = ScreenShareProtocol.visibleIds(order, layout)
        val rs = ScreenShareProtocol.rects(vis.size, ch > cw)
        val border = ScreenShareProtocol.tileBorderPx(vis.size)
        for ((id, t) in tiles) {
            val at = vis.indexOf(id)
            if (at < 0) { t.frame.visibility = View.INVISIBLE; continue }
            val r = rs[at]
            val left = Math.round(r.x * cw); val top = Math.round(r.y * ch)
            val width = Math.round((r.x + r.w) * cw) - left
            val height = Math.round((r.y + r.h) * ch) - top
            val lp = t.frame.layoutParams as FrameLayout.LayoutParams
            if (lp.width != width || lp.height != height || lp.leftMargin != left || lp.topMargin != top) {
                lp.width = width; lp.height = height; lp.leftMargin = left; lp.topMargin = top
                t.frame.layoutParams = lp
            }
            t.border = border
            t.frame.setPadding(border, border, border, border)
            // Web: the badge is at most 80% of its tile.
            t.badge.maxWidth = minOf(vw(60f).toInt(), (width * 0.8f).toInt()).coerceAtLeast(1)
            t.frame.visibility = View.VISIBLE
            letterbox(t)
        }
        paintCode()
    }

    /** object-fit: contain inside the tile (less its frame), once the first frame says how big it is. */
    private fun letterbox(t: Tile) {
        if (t.frameW <= 0 || t.frameH <= 0) return
        val lp = t.frame.layoutParams ?: return
        val pw = lp.width - 2 * t.border; val ph = lp.height - 2 * t.border
        if (pw <= 0 || ph <= 0) return
        val (bw, bh) = ScreenShareProtocol.fit(pw, ph, t.frameW, t.frameH)
        val vlp = t.video.layoutParams as? FrameLayout.LayoutParams
        if (vlp == null || vlp.width != bw || vlp.height != bh) t.video.layoutParams = FrameLayout.LayoutParams(bw, bh, Gravity.CENTER)
        t.video.visibility = View.VISIBLE
        t.wait.visibility = View.GONE
    }

    // ------------------------------------------------------------------------------ the code
    override fun onCode(code: ScreenShareProtocol.Code?) {
        this.code = code
        paintCode()
    }

    private fun paintCode() {
        val c = code
        if (c == null) { codeView?.visibility = View.GONE; return }
        val view = codeView ?: buildCodeView().also { codeView = it }
        styleCode(view, compact = tiles.isNotEmpty())
        val img = view.getChildAt(0) as ImageView
        val bmp = c.qrPngBase64?.let {
            try { Base64.decode(it, Base64.DEFAULT).let { b -> BitmapFactory.decodeByteArray(b, 0, b.size) } } catch (_: Throwable) { null }
        }
        if (bmp != null) { img.setImageBitmap(bmp); img.visibility = View.VISIBLE } else { img.setImageDrawable(null); img.visibility = View.GONE }
        val texts = view.getChildAt(1) as LinearLayout
        (texts.getChildAt(0) as TextView).text = activity.getString(R.string.screen_share_code_title)
        (texts.getChildAt(1) as TextView).text = activity.getString(R.string.screen_share_code_hint).replace("{url}", c.shownUrl)
        (texts.getChildAt(2) as TextView).text = c.code
        view.visibility = View.VISIBLE
        view.bringToFront()
    }

    private fun buildCodeView(): LinearLayout {
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        box.addView(ImageView(activity).apply {
            setBackgroundColor(Color.WHITE)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }, LinearLayout.LayoutParams(1, 1))
        val texts = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(TextView(activity).apply { setTextColor(Color.WHITE); setTypeface(typeface, Typeface.BOLD) })
        texts.addView(TextView(activity).apply { setTextColor(Color.argb(217, 255, 255, 255)) })
        texts.addView(TextView(activity).apply {
            setTextColor(Color.WHITE)
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD); letterSpacing = 0.08f
        })
        box.addView(texts)
        parent.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return box
    }

    /*
     * The web badge's two sizes: full (bottom-right, under the shares' layer) with nobody sharing;
     * compact (top-right, ABOVE the tiles' container) while people share and a slot is free.
     */
    private fun styleCode(box: LinearLayout, compact: Boolean) {
        val density = activity.resources.displayMetrics.density
        val padV = vw(if (compact) 0.45f else 0.8f).toInt()
        val padH = vw(if (compact) 0.6f else 1f).toInt()
        box.setPadding(padH, padV, padH, padV)
        box.background = GradientDrawable().apply {
            setColor(if (compact) Color.argb(219, 15, 23, 42) else Color.argb(209, 15, 23, 42))
            cornerRadius = vw(if (compact) 0.6f else 0.8f)
        }
        box.translationZ = if (compact) 10_001f else 9_000f
        val qrSize = if (compact) maxOf((56 * density).toInt(), vw(4.2f).toInt())
                     else maxOf((84 * density).toInt(), vw(7f).toInt())
        val img = box.getChildAt(0)
        img.layoutParams = LinearLayout.LayoutParams(qrSize, qrSize).apply { marginEnd = vw(if (compact) 0.6f else 0.9f).toInt() }
        val base = if (compact) sp(10f, 0.75f) else sp(12f, 1f)
        val texts = box.getChildAt(1) as LinearLayout
        (texts.getChildAt(0) as TextView).setTextSize(TypedValue.COMPLEX_UNIT_PX, base * 1.1f)
        (texts.getChildAt(1) as TextView).setTextSize(TypedValue.COMPLEX_UNIT_PX, base)
        (texts.getChildAt(2) as TextView).setTextSize(TypedValue.COMPLEX_UNIT_PX, base * 1.9f)
        val margin = vw(if (compact) 0.8f else 1.2f).toInt()
        box.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            if (compact) Gravity.TOP or Gravity.END else Gravity.BOTTOM or Gravity.END).apply { setMargins(margin, margin, margin, margin) }
    }
}
