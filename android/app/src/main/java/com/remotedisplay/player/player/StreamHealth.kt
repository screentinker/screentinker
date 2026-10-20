package com.remotedisplay.player.player

/**
 * Keeps ONE video in a zone (ZoneManager, WallZoneRenderer) alive: decides when it has failed and
 * how long to wait before reconnecting it.
 *
 * ⚠️ WHY ZONES NEED THIS. Full-screen video has had a stall watchdog and a fault backoff for a
 * long time (MediaPlayerManager, PlaybackStall, FaultBackoff). Zone video had neither: a lone item
 * in a zone had NO listener at all, so an RTSP camera whose connection dropped (the NVR restarted,
 * the Wi-Fi roamed, the camera rebooted) sat on its last frame until the app was restarted, and in
 * a wall zone a live item showed the zone background until a boundary that a camera never reaches.
 * Seen on a two-camera layout: both zones frozen, both fine again after a restart.
 *
 * Two triggers, one answer:
 *   - error()      the player reported a PlaybackException;
 *   - observe()    called every couple of seconds with the player's state: a player that claims
 *                  to be playing but draws no new frame (or, with no video, makes no progress)
 *                  for PlaybackStall's limits (10 s ready, 30 s buffering) has stalled. A stall
 *                  raises NO event, which is why this is observed, not listened for.
 * Either schedules onRecover(delayMs) with FaultBackoff's 2/4/8/15/30 s, so a camera that is
 * really down is retried patiently instead of hammered, and a fault long after the last one starts
 * again from 2 s.
 *
 * Progress is the decoder's RENDERED-FRAME count when there is one: for a live stream that is the
 * picture actually changing on screen, which is the thing that froze. The playback position is the
 * fallback (audio-only). Pure: no Android types, so the rules are unit-tested (StreamHealthTest).
 */
class StreamHealth(
    private val onRecover: (delayMs: Long, reason: String) -> Unit,
    readyStallMs: Long = 10_000L,
    bufferingStallMs: Long = 30_000L,
) {
    private val stall = PlaybackStall(readyStallMs, bufferingStallMs)
    private val backoff = FaultBackoff()
    /** A reconnect is already scheduled: a second fault before it runs must not stack another. */
    private var pending = false

    /** The player reported an error. */
    fun error(nowMs: Long) = recover(nowMs, "error")

    /**
     * One observation. [renderedFrames] is the video decoder's rendered-frame count, or null when
     * the player has no video decoder (then [positionMs] is the progress).
     * @return true when this observation found a stall (and scheduled a reconnect).
     */
    fun observe(nowMs: Long, state: Int, playWhenReady: Boolean, renderedFrames: Long?, positionMs: Long): Boolean {
        if (pending) return false
        val progress = renderedFrames ?: positionMs
        if (!stall.tick(nowMs, state, playWhenReady, progress)) return false
        recover(nowMs, "stall")
        return true
    }

    /** The reconnect ran: watch the fresh connection from scratch. */
    fun reconnected() {
        pending = false
        stall.reset()
    }

    /** Forget any scheduled reconnect (the item was replaced or the zone torn down). */
    fun reset() {
        pending = false
        stall.reset()
    }

    private fun recover(nowMs: Long, reason: String) {
        if (pending) return
        pending = true
        stall.reset()
        onRecover(backoff.next(nowMs), reason)
    }
}
