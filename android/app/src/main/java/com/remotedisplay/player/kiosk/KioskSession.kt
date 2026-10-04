package com.remotedisplay.player.kiosk

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebViewDatabase
import android.widget.FrameLayout
import android.widget.TextView
import com.remotedisplay.player.util.DebugLog

/**
 * Walk-up interactive web page (#473). One instance per player; [show] mounts a FRESH WebView for
 * every appearance of an interactive item and [hide] destroys it, so no state survives from one
 * visitor (or one loop) to the next. The pure rules live in KioskLogic.kt.
 *
 * Hooks back into the player:
 *  - [onHold]    first touch: hold the playlist on this item
 *  - [onRelease] session over (reset, failed load, crash): advance the playlist
 *  - [onSkip]    the page could not be shown at all and nobody was using it: advance now
 *
 * ⚠️ WEB STORAGE IS PROCESS-WIDE on Android (cookies, localStorage, cache, service workers), so the
 * wipe reaches every web item on the panel. Accepted for v1: interactive panels have one job.
 */
class KioskSession(
    private val activity: Activity,
    private val container: ViewGroup,
    private val onHold: () -> Unit,
    private val onRelease: () -> Unit,
    private val onSkip: () -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var overlay: TextView? = null
    private var card: TextView? = null
    private var config: KioskConfig? = null
    private var idle: KioskIdle? = null
    private var itemKey: String? = null
    private var touchedThisMount = false
    private var failing = false

    /** True while a visitor is using the page. Read by the capture path (blank frames). */
    val sessionActive: Boolean get() = idle?.inSession == true

    val isShowing: Boolean get() = webView != null || card != null
    fun isShowingItem(key: String): Boolean = isShowing && itemKey == key

    private val tickRunnable = object : Runnable {
        override fun run() {
            val k = idle ?: return
            apply(k.tick(System.currentTimeMillis()))
            handler.postDelayed(this, 500)
        }
    }

    fun show(key: String, cfg: KioskConfig) {
        if (isShowingItem(key)) return            // same item re-issued (playlist refresh): keep the visitor's page
        hide()                                     // wipes only if a visitor used the previous page
        itemKey = key
        config = cfg
        idle = KioskIdle(cfg.idleTimeoutSec * 1000L, cfg.warnSec * 1000L)
        touchedThisMount = false
        failing = false

        val ua = try { WebSettings.getDefaultUserAgent(activity) } catch (_: Throwable) { null }
        if (WebViewVersion.tooOld(ua, cfg.minWebView)) {
            DebugLog.w(TAG, "WebView too old for ${cfg.url} (ua=$ua, need ${cfg.minWebView}) — showing card")
            showCard(CARD_TOO_OLD)
            return
        }
        mountWebView(cfg)
    }

    /** Leave the item. Wipes when a visitor used it, so the next one never sees their session. */
    fun hide(wipe: Boolean = touchedThisMount) {
        handler.removeCallbacks(tickRunnable)
        val wv = webView
        webView = null
        removeView(overlay); overlay = null
        removeView(card); card = null
        if (wv != null) {
            try { wv.stopLoading(); wv.loadUrl("about:blank") } catch (_: Throwable) {}
            removeView(wv)
            if (wipe) wipeAll(activity, wv)
            try { wv.destroy() } catch (_: Throwable) {}
        } else if (wipe) wipeAll(activity, null)
        setSecure(false)
        idle?.end()
        idle = null
        itemKey = null
        config = null
        touchedThisMount = false                   // the next hide() must not wipe again for this visitor
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "ClickableViewAccessibility")
    private fun mountWebView(cfg: KioskConfig) {
        val wv = WebView(activity)
        wv.setBackgroundColor(Color.WHITE)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            setSupportMultipleWindows(false)          // window.open / target=_blank load in THIS view (allowlist applies)
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            saveFormData = false
        }
        // Embedded baskets and checkouts on another domain need third-party cookies (off by default).
        // They are wiped with everything else at the end of the session.
        try { CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true) } catch (_: Throwable) {}
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true
        wv.isLongClickable = false
        wv.isHapticFeedbackEnabled = false
        wv.setOnLongClickListener { true }        // no long-press menu, no text-selection handles
        wv.setDownloadListener { url, _, _, _, _ -> DebugLog.w(TAG, "download blocked: $url") }
        wv.setOnTouchListener { _, ev ->
            if (ev.actionMasked == MotionEvent.ACTION_DOWN) onActivity(touch = true)
            false                                  // never consume: the page gets every touch
        }
        wv.addJavascriptInterface(Bridge(), "STKiosk")
        wv.webViewClient = Client(cfg)
        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView?, cb: ValueCallback<Array<Uri>>?, p: FileChooserParams?): Boolean {
                cb?.onReceiveValue(null)           // no file chooser on a public panel
                return true
            }
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?): Boolean = false
        }
        container.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        DebugLog.i(TAG, "interactive page: ${cfg.url} (idle ${cfg.idleTimeoutSec}s, domains ${cfg.allowedDomains})")
        wv.loadUrl(cfg.url)
        handler.post(tickRunnable)
    }

    private fun onActivity(touch: Boolean) {
        val k = idle ?: return
        val now = System.currentTimeMillis()
        val a = if (touch) k.onTouch(now) else k.keepAlive(now)
        apply(a)
    }

    private fun apply(a: KioskIdle.Action) {
        when (a) {
            is KioskIdle.Action.Started -> {
                touchedThisMount = true
                markDirty(activity, true)
                setSecure(true)
                DebugLog.i(TAG, "session started — playlist held")
                onHold()
            }
            is KioskIdle.Action.Warn -> {
                if (overlay == null) DebugLog.i(TAG, "idle — \"Still there?\" countdown ${a.secondsLeft}s")
                showOverlay(a.secondsLeft)
            }
            is KioskIdle.Action.Resumed -> { removeView(overlay); overlay = null }
            is KioskIdle.Action.Reset -> {
                DebugLog.i(TAG, "session idle — wiping and moving on")
                hide(wipe = true)
                onRelease()
            }
            is KioskIdle.Action.None -> {}
        }
    }

    private fun showOverlay(secondsLeft: Int) {
        val text = "Still there?\nTap to keep browsing — resetting in ${secondsLeft}s"
        val o = overlay ?: TextView(activity).apply {
            setTextColor(Color.WHITE)
            textSize = 26f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(200, 0, 0, 0))
            isClickable = true
            setOnClickListener { onActivity(touch = true) }
            container.addView(this, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            this@KioskSession.overlay = this
        }
        o.text = text
    }

    private fun showCard(text: String) {
        val c = TextView(activity).apply {
            setTextColor(Color.WHITE)
            textSize = 28f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.rgb(17, 24, 39))
            this.text = text
        }
        container.addView(c, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        card = c
    }

    /** The page failed or crashed. Nobody using it: skip it. Someone using it: end their session. */
    private fun fail(why: String) {
        if (failing) return                        // one failure per page; errors arrive in bursts
        failing = true
        val mountKey = itemKey
        DebugLog.w(TAG, "interactive page unavailable ($why)")
        // Posted: tearing a WebView down from inside its own client callback can crash it.
        handler.post {
            if (itemKey != mountKey) return@post   // already replaced by another item
            val wasSession = sessionActive
            hide(wipe = touchedThisMount)
            if (wasSession) onRelease() else onSkip()
        }
    }

    private fun setSecure(on: Boolean) {
        // FLAG_SECURE blacks this window in MediaProjection, the live video and accessibility
        // screenshots, so an operator watching the panel cannot see what a visitor types. The
        // in-app view-draw tier is blanked separately via [sessionActive].
        try {
            if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } catch (_: Throwable) {}
    }

    private fun removeView(v: View?) {
        if (v == null) return
        try { (v.parent as? ViewGroup)?.removeView(v) } catch (_: Throwable) {}
    }

    private inner class Client(private val cfg: KioskConfig) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val url = request?.url?.toString()
            // Top-level only: subframes and subresources are not filtered, or most shops break.
            if (request != null && !request.isForMainFrame) return false
            if (KioskNav.isAllowed(url, cfg.allowedDomains)) return false
            DebugLog.w(TAG, "navigation blocked: $url")
            return true
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            DebugLog.i(TAG, "page loaded: $url")
            // Text selection off; and a light media probe: a video playing in the page is activity,
            // so the idle timer does not cut it off mid-clip.
            view?.evaluateJavascript(INJECT, null)
        }

        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            if (request?.isForMainFrame == true) fail("load error ${error?.errorCode} ${error?.description}")
        }

        override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
            if (request?.isForMainFrame == true && (errorResponse?.statusCode ?: 0) >= 400) fail("HTTP ${errorResponse?.statusCode}")
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            // The renderer died (WebView 83 does this on heavy sites). Returning true keeps the app
            // alive; the dead WebView must not be used again, so drop it and skip the item.
            if (view === webView) webView = null
            removeView(view)
            try { view?.destroy() } catch (_: Throwable) {}
            fail("renderer gone (crash=${detail?.didCrash()})")
            return true
        }
    }

    private inner class Bridge {
        @JavascriptInterface
        fun mediaPlaying() { handler.post { onActivity(touch = false) } }
    }

    companion object {
        private const val TAG = "Kiosk"
        private const val PREFS = "screentinker"
        private const val DIRTY = "kiosk_session_dirty"
        const val CARD_TOO_OLD = "This page needs a newer web browser than this screen has."

        private const val INJECT = """(function(){
  try {
    var s = document.createElement('style');
    s.textContent = '*{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
  if (window.__stKioskProbe) return;
  window.__stKioskProbe = setInterval(function(){
    try {
      var m = document.querySelectorAll('video,audio');
      for (var i = 0; i < m.length; i++) { if (!m[i].paused && !m[i].ended) { STKiosk.mediaPlaying(); return; } }
    } catch (e) {}
  }, 5000);
})();"""

        /**
         * Wipe everything a visitor could have left behind: cookies, localStorage/IndexedDB/service
         * workers (WebStorage.deleteAllData), HTTP cache, form data, history, HTTP auth.
         */
        fun wipeAll(ctx: Context, wv: WebView?) {
            try { CookieManager.getInstance().removeAllCookies(null); CookieManager.getInstance().flush() } catch (_: Throwable) {}
            try { WebStorage.getInstance().deleteAllData() } catch (_: Throwable) {}
            try {
                wv?.clearCache(true); wv?.clearFormData(); wv?.clearHistory()
                if (wv == null) WebView(ctx).apply { clearCache(true); destroy() }
            } catch (_: Throwable) {}
            try {
                @Suppress("DEPRECATION")
                WebViewDatabase.getInstance(ctx).apply { clearHttpAuthUsernamePassword(); clearFormData() }
            } catch (_: Throwable) {}
            markDirty(ctx, false)
            DebugLog.i(TAG, "web storage wiped")
        }

        private fun markDirty(ctx: Context, dirty: Boolean) {
            try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(DIRTY, dirty).apply() } catch (_: Throwable) {}
        }

        /** App start: a session cut off by a power loss or crash is wiped before anything loads. */
        fun wipeIfDirty(ctx: Context) {
            val dirty = try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(DIRTY, false) } catch (_: Throwable) { false }
            if (dirty) { DebugLog.i(TAG, "previous interactive session was not ended — wiping"); wipeAll(ctx, null) }
        }
    }
}
