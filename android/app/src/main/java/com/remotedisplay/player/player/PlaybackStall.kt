package com.remotedisplay.player.player

/**
 * Has playback stopped moving while it believes it is playing?
 *
 * ⚠️ THE GAP THIS FILLS (#297). A video advances the playlist in exactly two ways: ExoPlayer reports
 * STATE_ENDED, or it reports an error — and MediaPlayerManager treats both as "move on". A decoder
 * that simply WEDGES reports neither. It stays READY, playWhenReady stays true, and the position
 * stops moving; nothing in the app ever notices, so the playlist stops for good and only a restart
 * recovers it. That is precisely what was reported: "after some time, playback freezes. A complete
 * restart of the application helps."
 *
 * ⚠️ AND A STALL IS NOT AN ERROR, WHICH IS WHY NOTHING CAUGHT IT. The existing self-heal hangs off
 * onPlayerError, and a wedged hardware decoder on a TV SoC does not raise one.
 *
 * Pure and time-injected so the rule can be tested on the JVM without a device, an ExoPlayer or a
 * clock — the same reason ItemTiming next door is a plain object.
 */
class PlaybackStall(
    /** How long a READY, playing video may sit at the same position before we call it wedged. */
    private val readyStallMs: Long = 10_000L,
    /**
     * Buffering is allowed longer: a remote stream on a poor link legitimately buffers, and cutting
     * a slow download short would turn a bad network into a skipped item.
     */
    private val bufferingStallMs: Long = 30_000L,
) {
    /** Playback states, mirrored so the JVM tests need no androidx dependency. */
    companion object {
        const val STATE_IDLE = 1
        const val STATE_BUFFERING = 2
        const val STATE_READY = 3
        const val STATE_ENDED = 4
    }

    private var lastPositionMs: Long = -1L
    /*
     * ⚠️ NULLABLE, NOT A 0 SENTINEL. The first version used 0 for "no observation yet", and the
     * clock is injected — so a caller whose first tick is at t=0 (every test, and SystemClock right
     * after boot) collided with the sentinel and had its timer silently restarted every tick, which
     * meant a genuinely wedged decoder was never reported. Caught by the tests, not by reading.
     */
    private var stuckSinceMs: Long? = null

    /** Forget everything. Call whenever a new item is mounted, or playback is deliberately stopped. */
    fun reset() {
        lastPositionMs = -1L
        stuckSinceMs = null
    }

    /**
     * Feed one observation. Returns true exactly once when the current item first looks wedged;
     * the caller is expected to advance, which resets this.
     *
     * @param nowMs        a monotonic-ish clock (SystemClock.elapsedRealtime in production)
     * @param state        one of the STATE_ constants above
     * @param playWhenReady whether the player has been told to play
     * @param positionMs   the player's current position
     */
    fun tick(nowMs: Long, state: Int, playWhenReady: Boolean, positionMs: Long): Boolean {
        /*
         * ⚠️ ONLY WHEN THE PLAYER CLAIMS TO BE PLAYING. A paused item (a held wall follower, a
         * group-sync member waiting for its slot, a deliberately stopped player) sits at one
         * position for as long as it likes and is not stalled — treating that as a fault would
         * advance a playlist that was doing exactly what it was told.
         */
        if (!playWhenReady || (state != STATE_READY && state != STATE_BUFFERING)) {
            reset()
            return false
        }

        if (positionMs != lastPositionMs) {
            // Progress. Note that a looping single video resets to ~0, which is still a change.
            lastPositionMs = positionMs
            stuckSinceMs = nowMs
            return false
        }

        val since = stuckSinceMs
        if (since == null) {                 // first observation at this position
            stuckSinceMs = nowMs
            return false
        }

        val limit = if (state == STATE_BUFFERING) bufferingStallMs else readyStallMs
        if (nowMs - since < limit) return false

        // Report once, then forget — the caller advances, and a second report on the same item
        // would advance twice.
        reset()
        return true
    }
}
