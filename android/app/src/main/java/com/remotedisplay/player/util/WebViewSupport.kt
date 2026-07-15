package com.remotedisplay.player.util

import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Shared setup + helpers for the player's WebViews (zone widgets, fullscreen
 * widgets, YouTube). Centralizes:
 *  - JS / DOM storage / autoplay-without-gesture,
 *  - mixed-content ALLOW (self-hosted servers are often http on the LAN; without
 *    this an https page embedding http - or vice versa - is silently blocked into
 *    a black broken-frame),
 *  - error/console logging piped to DebugLog so a failing web frame shows the
 *    real reason in the live debug panel instead of just a black broken-page view,
 *  - a YouTube embed that loads with a valid youtube.com origin (fixes Error 153).
 */
object WebViewSupport {

    const val YT_BASE = "https://www.youtube.com"
    // Base URL the embed page is loaded under (its referrer to YouTube). It must be
    // a normal embedding site, NOT youtube.com itself — a page claiming to be
    // youtube.com embedding a youtube.com iframe is rejected as an invalid embed
    // context ("This video is unavailable / Error 152"). A real third-party domain
    // is what legitimate embeds use.
    const val EMBED_BASE = "https://screentinker.com"

    fun configure(webView: WebView, tag: String) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        // Interactive widgets (e.g. directory-search) need the WebView to take
        // touch focus so the search field accepts a tap/cursor inside the kiosk
        // lock-task WebView. Harmless for passive widgets (board/YouTube): they
        // have no focusable inputs, so nothing steals focus or pops the IME. The
        // widget's own on-screen keyboard drives the filter even when the system
        // IME is suppressed (it mutates the input value directly, no focus needed).
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) {
                    DebugLog.e(tag, "WebView load error ${error?.errorCode} ${error?.description} url=${request.url}")
                }
            }
            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                if (request?.isForMainFrame == true) {
                    DebugLog.e(tag, "WebView HTTP ${errorResponse?.statusCode} url=${request.url}")
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                if (msg?.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    DebugLog.w(tag, "JS error: ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}")
                }
                return super.onConsoleMessage(msg)
            }
        }
    }

    fun extractYoutubeId(url: String): String? {
        val patterns = listOf(
            Regex("""embed/([A-Za-z0-9_-]{6,})"""),
            Regex("""[?&]v=([A-Za-z0-9_-]{6,})"""),
            Regex("""youtu\.be/([A-Za-z0-9_-]{6,})""")
        )
        for (p in patterns) p.find(url)?.let { return it.groupValues[1] }
        return null
    }

    /**
     * HTML wrapper for a YouTube embed. Loaded via loadDataWithBaseURL(YT_BASE, ...)
     * so the iframe has a valid youtube.com origin/referer (a bare loadUrl of the
     * embed gives Error 153 "player misconfigured"). Returns null if no video id.
     *
     * #129: the initial mute now comes from the per-item [muted] flag (was hardcoded
     * mute=1, which made YouTube un-unmuteable). The WebView sets
     * mediaPlaybackRequiresUserGesture=false, so mute=0 still autoplays WITH audio.
     * enablejsapi=1 lets the live device:mute-changed toggle drive the player via the
     * IFrame API postMessage bridge (MediaPlayerManager.setYoutubeMuted) without a
     * flicker-y reload.
     */
    fun youtubeEmbedHtml(url: String, muted: Boolean = true): String? {
        val id = extractYoutubeId(url) ?: return null
        val mute = if (muted) 1 else 0
        val src = "$YT_BASE/embed/$id?autoplay=1&mute=$mute&controls=0&rel=0&modestbranding=1&loop=1&playlist=$id&playsinline=1&enablejsapi=1"
        return "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>" +
            "</head><body><iframe src=\"$src\" allow=\"autoplay; encrypted-media\" allowfullscreen></iframe></body></html>"
    }
}
