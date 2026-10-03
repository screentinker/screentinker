package com.remotedisplay.player.player

/**
 * #333: what to do when a video FAILS, as opposed to finishing.
 *
 * ⚠️ A FAULT IS NOT A COMPLETION, AND THE FOLLOWER GATE ONLY KNEW ABOUT COMPLETIONS. Every signal
 * that a video had stopped — STATE_ENDED, a playback error, and since #297 a wedged decoder — was
 * routed into one callback, onVideoComplete(), and that callback returns early for a wall follower
 * or a group-sync member because those must not self-advance (the wall leader / the schedule tick
 * owns the index). Right for the natural end of a looping clip. Wrong for a fault: the #297
 * watchdog detected the wedge on the Xiaomi P1s, called onVideoComplete(), and the follower gate
 * swallowed it — so every self-heal in the player was switched off in exactly the mode where the
 * report came from. "Only restarting the app helps", again.
 *
 * The rule: a solo playlist ADVANCES past a broken item (unchanged — skipping it is the only way
 * on, and #297/Root-2 chose that). A follower or group member must keep the index the sync gave
 * it, so it REPLAYS the current item instead — a cold re-mount, which resets the decoder, after
 * which the sync tick snaps the position back to where the group is.
 *
 * Pure so the rule is on the JVM, next to FollowerExit and PlaybackStall.
 */
class PlaybackFault(
    /**
     * A follower re-mounts at most once per this window for the same item. A clip that errors the
     * instant it is prepared (corrupt file) would otherwise replay in a tight loop; held instead,
     * it is retried by the next fault after the window (the #297 watchdog needs 10s to report
     * anyway) or replaced by the next boundary.
     */
    private val replayCooldownMs: Long = 5_000L,
) {
    enum class Recovery {
        /** Solo playback: skip the broken item. */
        ADVANCE,
        /** Follower / group member: keep the index, re-mount the item, let the sync re-align. */
        REPLAY_CURRENT,
        /** Follower / group member, but the same item was just replayed: leave it, retry later. */
        HOLD,
    }

    private var lastReplayIndex = -1
    private var lastReplayAtMs: Long? = null   // nullable, not a 0 sentinel — see PlaybackStall

    fun recovery(follower: Boolean, index: Int, nowMs: Long): Recovery {
        if (!follower) return Recovery.ADVANCE
        val at = lastReplayAtMs
        if (at != null && lastReplayIndex == index && nowMs - at < replayCooldownMs) return Recovery.HOLD
        lastReplayIndex = index
        lastReplayAtMs = nowMs
        return Recovery.REPLAY_CURRENT
    }
}

/**
 * #333: the group-sync double buffer's parking slot — which clip the second ExoPlayer holds, and
 * whether that player is fit to be promoted at the boundary.
 *
 * ⚠️ THE 0:00 FREEZE. preloadVideo() parks the NEXT clip in a second player ~6s before the
 * boundary, and mountVideo() promotes that player with a warm swap — no prepare(), because a
 * healthy parked player is already prepared. But the shared listener ignored errors on the parked
 * player, and nothing forgot the file it had been given. So a preload that died (decoder
 * resources reclaimed — the second decoder is exactly what a single-instance SoC refuses) was
 * promoted anyway: playWhenReady = true on a player in STATE_IDLE, which does nothing, and the
 * screen sat on the freeze-frame at 0:00. No error fires for the promoted player (its error fired
 * while parked), and PlaybackStall deliberately ignores IDLE, so nothing recovered it.
 *
 * Pure: the player's state is passed in, so the rule is testable without an ExoPlayer.
 */
class PreloadSlot {
    enum class Claim {
        /** Nothing usable parked for this file: take the cold prepare on the active player. */
        COLD,
        /** A prepared player is parked with this file: promote it as-is. */
        WARM,
        /** The parked player has this file but sits in IDLE: promote it, but prepare() first. */
        WARM_NEEDS_PREPARE,
    }

    private var parkedPath: String? = null

    /** True when [path] is parked and healthy — preloadVideo() can skip re-preparing it. */
    fun isParked(path: String): Boolean = parkedPath == path

    /** A clip was handed to the second player. */
    fun park(path: String) { parkedPath = path }

    /**
     * The second player reported an error while parked. Forget the file so the boundary takes the
     * cold path and a later preload of the same clip is not short-circuited by [isParked].
     */
    fun fail() { parkedPath = null }

    /** The second player is gone (released, or promoted). */
    fun clear() { parkedPath = null }

    /**
     * Decide the mount path for [path]. A claim consumes the slot on WARM / WARM_NEEDS_PREPARE; a
     * COLD verdict leaves whatever is parked in place (it may be the clip after this one).
     */
    fun claim(path: String, playerIsIdle: Boolean): Claim {
        if (parkedPath != path) return Claim.COLD
        parkedPath = null
        return if (playerIsIdle) Claim.WARM_NEEDS_PREPARE else Claim.WARM
    }
}
