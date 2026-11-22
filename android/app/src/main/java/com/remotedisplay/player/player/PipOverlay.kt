package com.remotedisplay.player.player

import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.remotedisplay.player.util.ImageLoader
import com.remotedisplay.player.util.WebViewSupport
import org.json.JSONObject

/**
 * PiP overlay layer (#109). Renders an image or web (WebView) overlay into [pipLayout],
 * which is the top child of rootLayout — so it draws above the playlist AND inherits the
 * orientation rotation/translation applied to rootView (corner positions track the visible
 * content). The playlist renderers never touch pipLayout.
 *
 * MVP semantics (mirrors the web/Tizen players): single overlay slot, last-show-wins;
 * duration timer (0 = until cleared); device:pip-clear (id-aware) or the timer tears it
 * down; teardown is wrapped so a malformed payload can't wedge the layer. Reports show/clear
 * via [log] (device:log tag "pip").
 *
 * All methods must run on the main thread (WebSocketService posts the socket events there).
 */
class PipOverlay(
    private val context: Context,
    private val pipLayout: FrameLayout,
    // #109 debug: refs used ONLY by pipDebug logging (the orientation transform that keeps
    // pipLayout aligned with the content is applied in MainActivity). Both are nullable so
    // the overlay stays constructable without them.
    private val rootView: View? = null,
    private val youtubeWebView: WebView? = null,
    private val log: (level: String, message: String) -> Unit = { _, _ -> }
) {
    private val handler = Handler(Looper.getMainLooper())
    private var timer: Runnable? = null
    private var current: String? = null
    private var webView: WebView? = null

    /**
     * #109 debug flag (default OFF — no behavior change in prod). When on, [show] paints the
     * box solid magenta with a magenta border and renders the media ON TOP, so the BOX itself
     * is visible even if media never loads; it then posts a one-shot Runnable that logs the
     * geometry/visibility of the box, pipLayout, rootView and the YouTube WebView over
     * device:log tag "pip" — enough to tell surface-occlusion (1) from orientation (2) from
     * a measure/visibility (3) failure. Toggled via device:command {type:"pip_debug"}.
     */
    @Volatile var pipDebug: Boolean = false

    fun show(p: JSONObject) {
        try {
            teardown() // single slot, last-show-wins
            val type = p.optString("type", "image")
            val uri = p.optString("uri", "")
            if (uri.isEmpty()) { log("warn", "pip show ignored: empty uri"); return }

            val dm = context.resources.displayMetrics
            val w = p.optInt("width", 480).coerceIn(1, dm.widthPixels * 4)
            val h = p.optInt("height", 360).coerceIn(1, dm.heightPixels * 4)

            // Set the slot token BEFORE building media: loadImageInto captures `current` as
            // its drop-if-replaced token, and its decode finishes on a background thread that
            // posts back AFTER show() returns. If current were still null here (teardown
            // clears it), that guard would always fail and the decoded bitmap would be
            // dropped — i.e. image PiPs never painted. (#109 follow-up.)
            current = p.optString("pip_id", "(anon)")

            val box = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                clipToOutline = true
                val radius = p.optInt("border_radius", 0).toFloat()
                background = GradientDrawable().apply {
                    if (pipDebug) {
                        // Solid magenta fill + 8px magenta border so the BOX paints even if
                        // media never loads (#CCFF00FF = 80%-opaque magenta).
                        setColor(0xCCFF00FF.toInt())
                        setStroke(8, Color.MAGENTA)
                    } else {
                        setColor(parseColor(p.optString("background_color", ""), Color.BLACK))
                    }
                    cornerRadius = radius
                }
                alpha = if (pipDebug) 1f else p.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f)
            }

            val title = p.optString("title", "")
            if (title.isNotEmpty()) {
                box.addView(TextView(context).apply {
                    text = title
                    setTextColor(parseColor(p.optString("title_color", ""), Color.WHITE))
                    setBackgroundColor(Color.argb(115, 0, 0, 0))
                    textSize = 14f
                    maxLines = 1
                    setPadding(20, 12, 20, 12)
                }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            }

            // Media fills the remaining box height (weight 1).
            val mediaLp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            if (type == "web") {
                val wv = buildWebView(uri, current)
                webView = wv
                box.addView(wv, mediaLp)
            } else {
                val img = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
                box.addView(img, mediaLp)
                loadImageInto(img, uri, w, h)
            }

            // Corner/center placement; 4% inset off the edges (matches web/Tizen).
            val lp = FrameLayout.LayoutParams(w, h)
            val mx = (dm.widthPixels * 0.04f).toInt()
            val my = (dm.heightPixels * 0.04f).toInt()
            lp.gravity = when (p.optString("position", "top-right")) {
                "top-left" -> { lp.leftMargin = mx; lp.topMargin = my; Gravity.TOP or Gravity.START }
                "bottom-right" -> { lp.rightMargin = mx; lp.bottomMargin = my; Gravity.BOTTOM or Gravity.END }
                "bottom-left" -> { lp.leftMargin = mx; lp.bottomMargin = my; Gravity.BOTTOM or Gravity.START }
                "center" -> Gravity.CENTER
                else -> { lp.rightMargin = mx; lp.topMargin = my; Gravity.TOP or Gravity.END } // top-right
            }

            // Optional close button (close_button:true). Render a tappable ✕ floating at the
            // box's top-right corner; tapping clears THIS overlay (id-matched). It lives in a
            // FrameLayout wrapper that is a SIBLING of the box — so it isn't clipped by the
            // box outline and isn't dimmed by the box's opacity. Only the button is clickable;
            // the rest of pipLayout stays touch-transparent so taps fall through to content.
            val attach: View = if (p.optBoolean("close_button", false)) {
                val token = current
                FrameLayout(context).apply {
                    addView(box, FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
                    val d = dm.density
                    addView(TextView(context).apply {
                        text = "✕" // ✕
                        setTextColor(Color.WHITE)
                        textSize = 16f
                        gravity = Gravity.CENTER
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL; setColor(Color.argb(150, 0, 0, 0))
                        }
                        isClickable = true
                        contentDescription = "Close"
                        setOnClickListener { clear(token) }
                    }, FrameLayout.LayoutParams((28 * d).toInt(), (28 * d).toInt()).apply {
                        gravity = Gravity.TOP or Gravity.END
                        val m = (6 * d).toInt(); topMargin = m; rightMargin = m
                    })
                }
            } else box

            pipLayout.addView(attach, lp)
            pipLayout.visibility = View.VISIBLE
            // current was set above (before media build) so loadImageInto's token matches.

            // #109 fix (1)/(3): the pip layer is a top-level view above the WebView (reparented
            // to the window content in MainActivity), but make sure it composites last and is
            // laid out before the next frame — raise it to the front and force a layout/redraw
            // so the box is never left attached-but-unpainted behind the playing content.
            pipLayout.bringToFront()
            pipLayout.requestLayout()
            pipLayout.invalidate()
            (pipLayout.parent as? View)?.invalidate()

            if (pipDebug) logGeometry(box)

            val dur = p.optInt("duration", 0)
            if (dur > 0) {
                val id = current
                timer = Runnable { clear(id) }.also { handler.postDelayed(it, dur * 1000L) }
            }
            log("info", "pip show $type ${p.optString("pip_id", "")} pos=${p.optString("position", "top-right")} dur=$dur")
        } catch (e: Throwable) {
            // A malformed payload must never wedge the layer.
            teardown()
            log("warn", "pip show failed: ${e.message}")
        }
    }

    private fun buildWebView(uri: String, token: String?): WebView {
        val wv = WebView(context)
        WebViewSupport.configure(wv, "PiP", onRendererGone = { dead -> onRendererGone(dead, uri, token) })
        // Mute web audio by default: deny autoplay-with-gesture so audio can't start.
        try { wv.settings.mediaPlaybackRequiresUserGesture = true } catch (_: Throwable) {}
        wv.setBackgroundColor(Color.TRANSPARENT)
        wv.loadUrl(uri)
        return wv
    }

    /*
     * #883: the renderer died (it is shared with every other WebView, so zones and the fullscreen
     * widget went with it). Put a fresh WebView in the same place in the box and load the page again,
     * within RendererRecovery's budget, so the PiP does not stay an empty box until it is cleared.
     */
    private val rendererRecovery = com.remotedisplay.player.util.RendererRecovery()

    private fun onRendererGone(dead: WebView, uri: String, token: String?) {
        val parent = dead.parent as? ViewGroup
        val index = parent?.indexOfChild(dead) ?: -1
        val lp = dead.layoutParams
        val mine = dead === webView && current == token
        WebViewSupport.discardDead(dead)
        if (dead === webView) webView = null
        if (!mine || parent == null || index < 0) return
        if (!rendererRecovery.allow("pip")) { log("warn", "pip renderer keeps dying, leaving it empty"); return }
        try {
            val fresh = buildWebView(uri, token)
            parent.addView(fresh, index, lp)
            webView = fresh
            log("warn", "pip renderer gone, page reloaded")
        } catch (t: Throwable) {
            log("warn", "pip renderer recovery failed: ${t.message}")
        }
    }

    /** Clear a showing overlay. A pip_id only clears if it matches; an empty id clears any. */
    fun clear(pipId: String?) {
        if (!pipId.isNullOrEmpty() && current != null && pipId != current) return
        val had = current != null
        teardown()
        if (had) log("info", "pip cleared" + (if (!pipId.isNullOrEmpty()) " $pipId" else ""))
    }

    /** Convenience for the device:pip-clear payload ({ pip_id? }). */
    fun clearFrom(data: JSONObject) = clear(if (data.has("pip_id")) data.optString("pip_id") else null)

    private fun teardown() {
        try { timer?.let { handler.removeCallbacks(it) } } catch (_: Throwable) {}
        timer = null
        current = null
        try { webView?.apply { stopLoading(); loadUrl("about:blank"); destroy() } } catch (_: Throwable) {}
        webView = null
        try { pipLayout.removeAllViews(); pipLayout.visibility = View.GONE } catch (_: Throwable) {}
    }

    private fun loadImageInto(img: ImageView, url: String, w: Int, h: Int) {
        val token = current
        Thread {
            val bmp = try { ImageLoader.decodeUrl(url, w, h) } catch (e: Throwable) { null }
            img.post {
                // Drop the result if this overlay was torn down / replaced while decoding.
                if (img.parent == null || token != current) return@post
                if (bmp != null) {
                    img.setImageBitmap(bmp)
                    if (pipDebug) log("info", "pip image loaded ${bmp.width}x${bmp.height}")
                } else { log("warn", "pip image failed to load"); clear(token) }
            }
        }.start()
    }

    /**
     * #109 debug: dump the geometry/visibility that tells the three candidate causes apart.
     * Posted onto the box so it runs after the first layout pass. Reads device:log tag "pip":
     *  - magenta box visible over an image but NOT over YouTube -> (1) surface occlusion
     *  - box visible rect empty / off the panel                 -> (2) orientation transform
     *  - box not shown / 0-size / pipLayout GONE or 0 children   -> (3) measure/visibility
     */
    private fun logGeometry(box: View) {
        box.post {
            try {
                val r = Rect()
                val boxVisible = box.getGlobalVisibleRect(r)
                val parent = pipLayout.parent as? ViewGroup
                val idx = parent?.indexOfChild(pipLayout) ?: -1
                log("info", "pip dbg box ${box.width}x${box.height} shown=${box.isShown} " +
                    "globalRect=$r($boxVisible)")
                log("info", "pip dbg pipLayout ${pipLayout.width}x${pipLayout.height} " +
                    "vis=${pipLayout.visibility} children=${pipLayout.childCount} " +
                    "idxInParent=$idx parent=${parent?.javaClass?.simpleName}")
                rootView?.let {
                    log("info", "pip dbg root rot=${it.rotation} tx=${it.translationX} " +
                        "ty=${it.translationY} sx=${it.scaleX} hwAccel=${it.isHardwareAccelerated}")
                }
                youtubeWebView?.let {
                    val yr = Rect()
                    val yv = it.getGlobalVisibleRect(yr)
                    log("info", "pip dbg youtube vis=${it.visibility} globalRect=$yr($yv)")
                }
            } catch (e: Throwable) {
                log("warn", "pip dbg failed: ${e.message}")
            }
        }
    }

    private fun parseColor(hex: String, fallback: Int): Int =
        if (hex.matches(Regex("^#[0-9A-Fa-f]{6}$"))) try { Color.parseColor(hex) } catch (e: Throwable) { fallback } else fallback
}
