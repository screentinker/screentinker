package com.remotedisplay.player.kiosk

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
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
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Walk-up interactive web page (#473). One instance per player; [show] mounts a FRESH WebView for
 * every appearance of an interactive item and [hide] destroys it, so no state survives from one
 * visitor (or one loop) to the next. The pure rules live in KioskLogic.kt.
 *
 * Hooks back into the player:
 *  - [onHold]    first touch: hold the playlist on this item
 *  - [onRelease] session over (reset, failed load, crash): advance the playlist
 *  - [onSkip]    the page could not be shown at all and nobody was using it: advance now
 *  - [onError]   v2: a load failure worth an incident on the dashboard (already rate-limited)
 *  - [onSessionEnd] v2: one record per visitor session, for the usage counts
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
    private val onError: (reason: String, detail: String) -> Unit = { _, _ -> },
    private val onSessionEnd: (KioskSessionRecord) -> Unit = {},
) {
    private val handler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var frame: ZoomFrame? = null
    private var home: TextView? = null
    private var overlay: TextView? = null
    private var card: TextView? = null
    private var config: KioskConfig? = null
    private var idle: KioskIdle? = null
    private var itemKey: String? = null
    private var touchedThisMount = false
    private var failing = false
    private var widgetId: String? = null
    private var sessionId: String? = null
    private var sessionStartMs = 0L
    private var pages = 0
    private var lastPersistMs = 0L
    private val visitedHosts = LinkedHashSet<String>()
    private val errors = ErrorThrottle()

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

    fun show(key: String, cfg: KioskConfig, widgetId: String? = null) {
        if (isShowingItem(key)) return            // same item re-issued (playlist refresh): keep the visitor's page
        hide()                                     // wipes only if a visitor used the previous page
        itemKey = key
        config = cfg
        this.widgetId = widgetId
        visitedHosts.clear()
        saveKeepSpec(activity, keepSpecFor(cfg))   // what a wipe on the NEXT app start may keep
        idle = KioskIdle(cfg.idleTimeoutSec * 1000L, cfg.warnSec * 1000L)
        touchedThisMount = false
        failing = false

        val ua = try { WebSettings.getDefaultUserAgent(activity) } catch (_: Throwable) { null }
        if (WebViewVersion.tooOld(ua, cfg.minWebView)) {
            DebugLog.w(TAG, "WebView too old for ${cfg.url} (ua=$ua, need ${cfg.minWebView}) — showing card")
            report("webview_too_old", cfg.url, "Chrome ${WebViewVersion.chromeMajor(ua) ?: "?"}, page needs ${cfg.minWebView}")
            showCard(CARD_TOO_OLD)
            return
        }
        mountWebView(cfg)
    }

    /** Leave the item. Wipes when a visitor used it, so the next one never sees their session. */
    fun hide(wipe: Boolean = touchedThisMount, reason: String = "interrupted") {
        handler.removeCallbacks(tickRunnable)
        finishSession(reason)
        val keep = keepSpecFor(config)
        val wv = webView
        webView = null
        removeView(overlay); overlay = null
        removeView(card); card = null
        removeView(home); home = null
        removeView(frame); frame = null
        if (wv != null) {
            try { wv.stopLoading(); wv.loadUrl("about:blank") } catch (_: Throwable) {}
            removeView(wv)
            if (wipe) wipeAll(activity, wv, keep)
            try { wv.destroy() } catch (_: Throwable) {}
        } else if (wipe) wipeAll(activity, null, keep)
        setSecure(false)
        idle?.end()
        idle = null
        itemKey = null
        config = null
        widgetId = null
        touchedThisMount = false                   // the next hide() must not wipe again for this visitor
    }

    /** Close the visitor's session record, if one is open. Engaged time: first touch to last activity. */
    private fun finishSession(reason: String) {
        val id = sessionId ?: return
        val start = sessionStartMs
        val last = maxOf(idle?.lastActivityAt ?: start, start)
        sessionId = null
        sessionStartMs = 0L
        val r = KioskSessionRecord(id, widgetId, start / 1000, ((last - start) / 1000).toInt().coerceAtLeast(1), reason, pages.coerceAtLeast(1))
        clearOpenSession(activity)
        DebugLog.i(TAG, "session ended ($reason) after ${r.durationSec}s, ${r.pages} page(s)")
        try { onSessionEnd(r) } catch (_: Throwable) {}
    }

    /**
     * What a wipe may keep for [cfg]: the consent cookies of the allowed sites, by name only — or,
     * with wipe_site_data off, all cookies and site storage (the wipe then skips both).
     */
    private fun keepSpecFor(cfg: KioskConfig?): KeepSpec? {
        if (cfg == null || (!cfg.keepConsent && cfg.wipeSiteData)) return null
        if (!cfg.wipeSiteData) return KeepSpec(emptyList(), emptyList(), wipeSiteData = false)
        val hosts = (cfg.allowedDomains + visitedHosts.filter { KioskNav.isAllowed("https://$it/", cfg.allowedDomains) }).distinct()
        return KeepSpec(hosts, (CookieKeep.BUILT_IN + cfg.keepCookieNames).distinct())
    }

    private fun noteUrl(url: String?, isReload: Boolean) {
        val cfg = config ?: return
        val host = KioskNav.hostOf(url)
        if (host != null && host !in visitedHosts && KioskNav.isAllowed(url, cfg.allowedDomains)) {
            visitedHosts.add(host)
            if (cfg.keepConsent) saveKeepSpec(activity, keepSpecFor(cfg))
        }
        if (sessionActive && !isReload && url != null && url != "about:blank") pages++
        updateHome(url)
    }

    private fun updateHome(url: String?) {
        val cfg = config ?: return
        if (!cfg.homeButton) return
        val show = webView != null && !isStartPage(url, cfg.url)
        if (!show) { home?.visibility = View.GONE; return }
        val h = home ?: TextView(activity).apply {
            text = HOME_LABEL
            setTextColor(Color.WHITE)
            textSize = 18f
            val dp = resources.displayMetrics.density
            setPadding((18 * dp).toInt(), (10 * dp).toInt(), (18 * dp).toInt(), (10 * dp).toInt())
            background = GradientDrawable().apply { cornerRadius = 28 * dp; setColor(Color.argb(190, 17, 24, 39)) }
            elevation = 6 * dp
            isClickable = true
            setOnClickListener {
                onActivity(touch = true)
                DebugLog.i(TAG, "home button — back to ${cfg.url}")
                webView?.loadUrl(cfg.url)
            }
            container.addView(this, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.START).apply { val m = (16 * dp).toInt(); setMargins(m, m, m, m) })
            this@KioskSession.home = this
        }
        h.visibility = View.VISIBLE
        overlay?.bringToFront()                    // the countdown stays on top of everything
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
        // Zoom is a LAYOUT zoom, like the server's passive render: the page lays out for a viewport
        // of size/zoom and the view is scaled back up, so a desktop site reflows bigger rather than
        // being magnified past the screen edge. Touch coordinates follow the view transform.
        val f = ZoomFrame(activity, cfg.zoomPct / 100f)
        f.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        container.addView(f, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        frame = f
        webView = wv
        DebugLog.i(TAG, "interactive page: ${cfg.url} (idle ${cfg.idleTimeoutSec}s, domains ${cfg.allowedDomains}, zoom ${cfg.zoomPct}%" +
            (if (cfg.keepConsent) ", keeps consent cookies" else "") + (if (!cfg.wipeSiteData) ", keeps site data" else "") + ")")
        wv.loadUrl(cfg.url)
        handler.post(tickRunnable)
    }

    private fun onActivity(touch: Boolean) {
        val k = idle ?: return
        val now = System.currentTimeMillis()
        val a = if (touch) k.onTouch(now) else k.keepAlive(now)
        apply(a)
        // Keep the crash-recovery copy of the open session roughly current (cheap, async prefs).
        if (sessionId != null && now - lastPersistMs >= 10_000) { lastPersistMs = now; saveOpenSession() }
    }

    private fun saveOpenSession() {
        val id = sessionId ?: return
        val r = KioskSessionRecord(id, widgetId, sessionStartMs / 1000,
            (((idle?.lastActivityAt ?: sessionStartMs) - sessionStartMs) / 1000).toInt().coerceAtLeast(1), "interrupted", pages.coerceAtLeast(1))
        try { activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(OPEN_SESSION, r.toJson().toString()).apply() } catch (_: Throwable) {}
    }

    private fun apply(a: KioskIdle.Action) {
        when (a) {
            is KioskIdle.Action.Started -> {
                touchedThisMount = true
                markDirty(activity, true)
                sessionId = java.util.UUID.randomUUID().toString()
                sessionStartMs = System.currentTimeMillis()
                pages = 1
                lastPersistMs = sessionStartMs
                saveOpenSession()
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
                hide(wipe = true, reason = "idle")
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

    /** Dashboard incident, at most one per (reason, host) per window. */
    private fun report(reason: String, url: String?, detail: String) {
        if (!errors.shouldReport(reason, url, System.currentTimeMillis())) return
        val where = KioskNav.hostOf(url) ?: url ?: ""
        try { onError(reason, (if (where.isNotEmpty()) "$where: " else "") + detail) } catch (_: Throwable) {}
    }

    /** The page failed or crashed. Nobody using it: skip it. Someone using it: end their session. */
    private fun fail(reason: String, url: String?, why: String) {
        if (failing) return                        // one failure per page; errors arrive in bursts
        failing = true
        val mountKey = itemKey
        DebugLog.w(TAG, "interactive page unavailable ($why)")
        report(reason, url, why)
        // Posted: tearing a WebView down from inside its own client callback can crash it.
        handler.post {
            if (itemKey != mountKey) return@post   // already replaced by another item
            val wasSession = sessionActive
            hide(wipe = touchedThisMount, reason = "error")
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

        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) { updateHome(url) }

        override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
            // Fires for real loads AND single-page-app history changes (pushState), so it counts pages.
            noteUrl(url, isReload)
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            DebugLog.i(TAG, "page loaded: $url")
            // Text selection off; and a light media probe: a video playing in the page is activity,
            // so the idle timer does not cut it off mid-clip.
            view?.evaluateJavascript(INJECT, null)
        }

        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            if (request?.isForMainFrame == true) fail("load_error", request.url?.toString(), "load error ${error?.errorCode} ${error?.description}")
        }

        override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
            if (request?.isForMainFrame == true && (errorResponse?.statusCode ?: 0) >= 400) fail("http_error", request.url?.toString(), "HTTP ${errorResponse?.statusCode}")
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            // The renderer died (WebView 83 does this on heavy sites). Returning true keeps the app
            // alive; the dead WebView must not be used again, so drop it and skip the item.
            val url = config?.url
            if (view === webView) webView = null
            removeView(view)
            try { view?.destroy() } catch (_: Throwable) {}
            fail("renderer_gone", url, "renderer gone (crash=${detail?.didCrash()})")
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
        private const val KEEP = "kiosk_keep_spec"
        private const val OPEN_SESSION = "kiosk_open_session"
        private const val HOME_LABEL = "\u2302  Home"
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
         *
         * v2: with [keep], the consent cookies it names are read first and written back once the
         * cookie store is empty (removeAllCookies is asynchronous, so the restore runs in its
         * callback — writing before it completes would let the removal delete them again).
         */
        fun wipeAll(ctx: Context, wv: WebView?, keep: KeepSpec? = null) {
            // wipe_site_data off (info pages): cookies and WebStorage stay — the consent banner and the
            // chosen language survive. Everything below them (cache, form data, history, HTTP auth) goes.
            val siteData = keep?.wipeSiteData != false
            if (siteData) try {
                val cm = CookieManager.getInstance()
                val saved = keep?.hosts?.flatMap { h ->
                    CookieKeep.select(cm.getCookie("https://$h/"), keep.patterns).map { Triple(h, it.first, it.second) }
                }.orEmpty()
                cm.removeAllCookies {
                    for ((h, n, v) in saved) try { cm.setCookie("https://$h/", CookieKeep.restoreHeader(n, v, h)) } catch (_: Throwable) {}
                    cm.flush()
                    if (saved.isNotEmpty()) DebugLog.i(TAG, "kept ${saved.size} consent cookie(s): ${saved.map { it.second }.distinct()}")
                }
            } catch (_: Throwable) {}
            if (siteData) try { WebStorage.getInstance().deleteAllData() } catch (_: Throwable) {}
            try {
                wv?.clearCache(true); wv?.clearFormData(); wv?.clearHistory()
                if (wv == null) WebView(ctx).apply { clearCache(true); destroy() }
            } catch (_: Throwable) {}
            try {
                @Suppress("DEPRECATION")
                WebViewDatabase.getInstance(ctx).apply { clearHttpAuthUsernamePassword(); clearFormData() }
            } catch (_: Throwable) {}
            markDirty(ctx, false)
            DebugLog.i(TAG, if (siteData) "web storage wiped" else "session reset (cookies + site storage kept: wipe_site_data off)")
        }

        private fun markDirty(ctx: Context, dirty: Boolean) {
            try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(DIRTY, dirty).apply() } catch (_: Throwable) {}
        }

        /** App start: a session cut off by a power loss or crash is wiped before anything loads. */
        fun wipeIfDirty(ctx: Context) {
            val prefs = try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE) } catch (_: Throwable) { return }
            // The cut-off session still counts: queue it as interrupted, with the time we last saw.
            try {
                prefs.getString(OPEN_SESSION, null)?.let { KioskSessionRecord.fromJson(JSONObject(it)) }?.let { KioskSessionLog.add(ctx, it) }
            } catch (_: Throwable) {}
            clearOpenSession(ctx)
            val dirty = try { prefs.getBoolean(DIRTY, false) } catch (_: Throwable) { false }
            if (dirty) { DebugLog.i(TAG, "previous interactive session was not ended — wiping"); wipeAll(ctx, null, loadKeepSpec(ctx)) }
        }

        private fun clearOpenSession(ctx: Context) {
            try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(OPEN_SESSION).apply() } catch (_: Throwable) {}
        }

        private fun saveKeepSpec(ctx: Context, k: KeepSpec?) {
            try {
                val e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                if (k == null) e.remove(KEEP) else e.putString(KEEP, JSONObject().put("hosts", JSONArray(k.hosts)).put("patterns", JSONArray(k.patterns)).put("wipe_site_data", k.wipeSiteData).toString())
                e.apply()
            } catch (_: Throwable) {}
        }

        private fun loadKeepSpec(ctx: Context): KeepSpec? = try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEEP, null)?.let { raw ->
                val o = JSONObject(raw)
                fun list(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it, "") }.filter { it.isNotEmpty() }
                KeepSpec(list(o.optJSONArray("hosts")), list(o.optJSONArray("patterns")), o.optBoolean("wipe_site_data", true))
            }
        } catch (_: Throwable) { null }
    }
}

/**
 * Hosts whose cookies are read before a wipe, and the names that survive it. [wipeSiteData] false
 * (the item's wipe_site_data off) skips the cookie and WebStorage wipe altogether.
 */
data class KeepSpec(val hosts: List<String>, val patterns: List<String>, val wipeSiteData: Boolean = true)

/**
 * Lays its child out at (size / zoom) and scales it back up to fill. The page therefore sees a
 * smaller (zoom > 1) or larger (zoom < 1) viewport — the same model as the server's passive render
 * (iframe at 100/zoom % with transform: scale). ViewGroup maps touches through the child's scale.
 */
class ZoomFrame(ctx: Context, private val zoom: Float) : FrameLayout(ctx) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(w, h)
        val cw = (w / zoom).roundToInt().coerceAtLeast(1)
        val ch = (h / zoom).roundToInt().coerceAtLeast(1)
        for (i in 0 until childCount) {
            getChildAt(i).measure(MeasureSpec.makeMeasureSpec(cw, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(ch, MeasureSpec.EXACTLY))
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for (i in 0 until childCount) {
            val c = getChildAt(i)
            c.layout(0, 0, c.measuredWidth, c.measuredHeight)
            c.pivotX = 0f; c.pivotY = 0f
            c.scaleX = zoom; c.scaleY = zoom
        }
    }
}
