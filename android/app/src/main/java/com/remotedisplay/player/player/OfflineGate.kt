package com.remotedisplay.player.player

/**
 * What a screen plays when the network is gone.
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR. Cached media survives a WAN outage; web items do not. A widget,
 * a YouTube embed or a remote stream that came round while the modem was unplugged painted
 * Chrome's "webpage not available" on the panel, and default content could not help: it only shows
 * when the playlist is empty or dayparted off, never "this item cannot load". Reported with a fix
 * already running in a fork on Fire TV and Fire tablets; this is the same three ideas:
 *
 *  1. OFFLINE, SKIP WHAT NEEDS THE NETWORK — but only while something cached can play instead. A
 *     playlist that is ALL web items is not emptied by this: skipping everything would trade an
 *     error page for "waiting for content", which is no better. When the network returns, nothing
 *     needs to happen: the next advance asks again and the full list is back.
 *  2. A FAILED PAGE IS HIDDEN, never shown (WebViewSupport), and when nothing cached can take its
 *     turn it is covered by the standby image after [COVER_AFTER_MS] of continuous failure. A page
 *     that ALREADY LOADED keeps showing — Google Slides, a dashboard — because its main frame never
 *     fails; only a navigation does.
 *  3. "OFFLINE" IS DECIDED BY US, quickly, and PER ITEM. Android's NET_CAPABILITY_VALIDATED took
 *     2–5 minutes to notice a modem being unplugged in the fork's testing, so it is not consulted.
 *     An item cannot load right now when the socket to the server is down (then nothing that needs
 *     the network can), or when THAT item failed to load within [FAILURE_MEMORY_MS] with no success
 *     since. Per item, because the second case is a self-hosted LAN server that is still up while
 *     the internet behind it is not: YouTube fails, but the server's own widgets still render, and a
 *     screen-wide "offline" would have skipped those too (found on the emulator). Learned from loads
 *     that were happening anyway — no extra probe traffic from every screen in a fleet.
 *
 * Pure: no Android, so the decisions are tested on a developer machine (OfflineGateTest).
 */
object OfflineGate {

    /** How long one failed web load keeps the screen in "offline" (absent a success since). */
    const val FAILURE_MEMORY_MS = 60_000L

    /** Continuous failure, with nothing cached to play instead, before the standby image covers. */
    const val COVER_AFTER_MS = 30_000L

    /**
     * Needs the network to render. Widgets render from the server's page; remote items stream from
     * wherever their URL points (YouTube, HLS, a remote image). A bundle does NOT: its flattened
     * document is cached on disk (BundleCache) like any other media.
     */
    fun needsNetwork(item: PlaylistItem): Boolean =
        // hdmi:// is a socket on the box, not a host; hold:// is not fetched from anywhere at all.
        item.isWidget || (item.isRemote && !LiveInput.isLiveInput(item.mimeType) && !Hold.isHold(item.mimeType))

    /**
     * Should [index] be passed over right now? Only when it cannot load, and only when some OTHER
     * scheduled item could play from local bytes in its place.
     */
    fun shouldSkip(
        cannotLoad: (PlaylistItem) -> Boolean,
        items: List<PlaylistItem>,
        index: Int,
        scheduled: (PlaylistItem) -> Boolean,
        hasLocalBytes: (PlaylistItem) -> Boolean
    ): Boolean {
        val item = items.getOrNull(index) ?: return false
        if (!needsNetwork(item) || !cannotLoad(item)) return false
        return hasOfflineAlternative(items, scheduled, hasLocalBytes)
    }

    /** Is there anything scheduled now that plays without the network? */
    fun hasOfflineAlternative(
        items: List<PlaylistItem>,
        scheduled: (PlaylistItem) -> Boolean,
        hasLocalBytes: (PlaylistItem) -> Boolean
    ): Boolean = items.any { !needsNetwork(it) && scheduled(it) && hasLocalBytes(it) }

    /**
     * Web-load outcomes per item (PlaylistItem.itemKey), remembered just long enough to pass over an
     * item that is not loading. Main thread only (WebViewClient callbacks and the playlist controller
     * both run there).
     */
    class WebHealth {
        private val lastFailureAt = HashMap<String, Long>()

        fun reportFailure(key: String, nowMs: Long) { lastFailureAt[key] = nowMs }
        fun reportSuccess(key: String) { lastFailureAt.remove(key) }

        fun recentlyFailed(key: String, nowMs: Long): Boolean {
            val at = lastFailureAt[key] ?: return false
            if (nowMs - at < FAILURE_MEMORY_MS) return true
            lastFailureAt.remove(key)
            return false
        }
    }

    /** [item] cannot load right now: the server is unreachable, or it just failed by itself. */
    fun cannotLoad(item: PlaylistItem, serverConnected: Boolean, health: WebHealth, nowMs: Long): Boolean =
        needsNetwork(item) && (!serverConnected || health.recentlyFailed(item.itemKey, nowMs))

    /**
     * Should the standby cover go up now? [failingSinceMs] is the start of the CURRENT run of
     * failures (0 = not failing); it is not reset by the playlist re-showing the same failing item,
     * which is what lets a 10-second web item still reach the 30-second cover.
     */
    fun shouldCover(failingSinceMs: Long, nowMs: Long): Boolean =
        failingSinceMs > 0L && nowMs - failingSinceMs >= COVER_AFTER_MS
}
