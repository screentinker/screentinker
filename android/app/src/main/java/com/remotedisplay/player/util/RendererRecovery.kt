package com.remotedisplay.player.util

/**
 * How often a screen area (a zone, the PiP box, a video-wall zone) may re-mount its web content after
 * the WebView renderer died (WebViewSupport.onRenderProcessGone).
 *
 * Every WebView in the app shares one renderer process, so one crash takes down every web area on
 * the screen at once. Each area brings its own content back in a fresh WebView. A page that kills
 * the renderer every time it loads would turn that into a crash loop, so each area gets at most
 * [maxPerWindow] re-mounts in any [windowMs]; after that it stays empty until its next item, the
 * next playlist push, or the window passing.
 *
 * Pure Kotlin (no android.*) so it is unit-tested on the JVM.
 */
class RendererRecovery(
    private val maxPerWindow: Int = 3,
    private val windowMs: Long = 60_000L,
    private val now: () -> Long = { System.nanoTime() / 1_000_000L },
) {
    private val hits = HashMap<String, ArrayDeque<Long>>()

    /** True if [key] may re-mount now; the attempt is counted when it is allowed. */
    @Synchronized
    fun allow(key: String): Boolean {
        val t = now()
        val q = hits.getOrPut(key) { ArrayDeque() }
        while (q.isNotEmpty() && t - q.first() >= windowMs) q.removeFirst()
        if (q.size >= maxPerWindow) return false
        q.addLast(t)
        return true
    }
}
