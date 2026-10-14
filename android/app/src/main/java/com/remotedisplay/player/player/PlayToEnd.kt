package com.remotedisplay.player.player

/**
 * #624 "Play to end": a YouTube item moves on when the video ends, not after its duration_sec.
 *
 * The YouTube wrapper page had no script at all, so the app could not know when a video ended: the
 * embed looped (loop=1&playlist=<id>) and the item's duration (10 s by default) cut it off. With the
 * flag set, the wrapper loads YouTube's IFrame API instead of looping and reports the video's length
 * and its end back through the `STYoutube` JavaScript bridge (MediaPlayerManager, ZoneManager).
 *
 * Same contract as the web player (server/player/index.html createYoutubeEmbed) and
 * server/lib/play-to-end.js:
 *  - duration_sec is NOT a cap. It is only the fallback while, or if, the length never arrives.
 *  - A sync group or wall ignores the flag: members compute the current item from a shared clock and
 *    each item's duration, and a video that runs "until it ends" would break that clock.
 *  - A one-item playlist keeps looping, as before.
 *  - ENDED is unreliable (#215: Shorts, some Android TV WebViews never fire it), so the reported
 *    length plus slack is the safety net, and an ENDED in the first seconds is ignored as spurious.
 *
 * Pure (no Android types), so the rules are pinned by PlayToEndTest on the JVM.
 */
object PlayToEnd {
    const val YOUTUBE_MIME = "video/youtube"

    /** How long to wait for the embed to report the video's length before the duration takes over. */
    const val LENGTH_WAIT_MS = 30_000L

    /** Added to the reported length, so a video that ends on time is never cut by its own safety net. */
    const val SLACK_MS = 3_000L

    /** An ENDED this soon after the item started is spurious (the web player's rule). */
    const val MIN_PLAY_MS = 3_000L

    /** The JavaScript bridge's name in the wrapper page. */
    const val BRIDGE = "STYoutube"

    fun applies(mime: String, flag: Boolean, synced: Boolean, playableCount: Int): Boolean =
        flag && mime == YOUTUBE_MIME && !synced && playableCount > 1

    /** Before the embed reports the length: the item's duration, but never less than [LENGTH_WAIT_MS]. */
    fun waitMs(slotMs: Long): Long = maxOf(slotMs, LENGTH_WAIT_MS)

    /**
     * Once the length is known: the rest of the video plus [SLACK_MS], counted from the item's start.
     * Null when the length is unusable (0 before metadata, NaN, infinite for a live stream), so the
     * wait from [waitMs] stands.
     */
    fun safetyMs(lengthSec: Double, elapsedMs: Long): Long? {
        if (lengthSec.isNaN() || lengthSec.isInfinite() || lengthSec <= 0.0) return null
        val restMs = (lengthSec * 1000.0).toLong() - maxOf(elapsedMs, 0L)
        return maxOf(restMs, 0L) + SLACK_MS
    }

    fun endedCounts(elapsedMs: Long): Boolean = elapsedMs >= MIN_PLAY_MS

    /** The embed's loop parameters: none when the video must be allowed to end. */
    fun loopParams(videoId: String, playToEnd: Boolean): String =
        if (playToEnd) "" else "&loop=1&playlist=$videoId"

    /**
     * The wrapper page's script for a play-to-end embed: attach the IFrame API to the existing iframe
     * (id `st-yt`) and report the length on ready and the end on ENDED. [token] identifies this page
     * load, so a late call from a page that has since been replaced is ignored on the app side. Empty
     * when the video should loop, so that page is unchanged from before.
     */
    fun bridgeScript(token: Long?): String {
        if (token == null) return ""
        return "<script src=\"https://www.youtube.com/iframe_api\"></script><script>" +
            "function onYouTubeIframeAPIReady(){try{new YT.Player('st-yt',{events:{" +
            "onReady:function(e){try{var d=e.target.getDuration();if(window.$BRIDGE)$BRIDGE.duration($token,d||0);}catch(x){}}," +
            "onStateChange:function(e){try{if(e.data===1){var d=e.target.getDuration();if(d>0&&window.$BRIDGE)$BRIDGE.duration($token,d);}" +
            "if(e.data===0&&window.$BRIDGE)$BRIDGE.ended($token);}catch(x){}}" +
            "}});}catch(x){}}</script>"
    }
}
