package com.remotedisplay.player.player

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
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
    private val log: (level: String, message: String) -> Unit = { _, _ -> }
) {
    private val handler = Handler(Looper.getMainLooper())
    private var timer: Runnable? = null
    private var current: String? = null
    private var webView: WebView? = null

    fun show(p: JSONObject) {
        try {
            teardown() // single slot, last-show-wins
            val type = p.optString("type", "image")
            val uri = p.optString("uri", "")
            if (uri.isEmpty()) { log("warn", "pip show ignored: empty uri"); return }

            val dm = context.resources.displayMetrics
            val w = p.optInt("width", 480).coerceIn(1, dm.widthPixels * 4)
            val h = p.optInt("height", 360).coerceIn(1, dm.heightPixels * 4)

            val box = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                clipToOutline = true
                val radius = p.optInt("border_radius", 0).toFloat()
                background = GradientDrawable().apply {
                    setColor(parseColor(p.optString("background_color", ""), Color.BLACK))
                    cornerRadius = radius
                }
                alpha = p.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f)
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
                val wv = WebView(context)
                WebViewSupport.configure(wv, "PiP")
                // Mute web audio by default: deny autoplay-with-gesture so audio can't start.
                try { wv.settings.mediaPlaybackRequiresUserGesture = true } catch (_: Throwable) {}
                wv.setBackgroundColor(Color.TRANSPARENT)
                wv.loadUrl(uri)
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

            pipLayout.addView(box, lp)
            pipLayout.visibility = View.VISIBLE
            current = p.optString("pip_id", "(anon)")

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
                if (bmp != null) img.setImageBitmap(bmp)
                else { log("warn", "pip image failed to load"); clear(token) }
            }
        }.start()
    }

    private fun parseColor(hex: String, fallback: Int): Int =
        if (hex.matches(Regex("^#[0-9A-Fa-f]{6}$"))) try { Color.parseColor(hex) } catch (e: Throwable) { fallback } else fallback
}
