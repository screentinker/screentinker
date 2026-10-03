package com.remotedisplay.player.player

/**
 * Pure, unit-testable playlist SELECTION + screen-resilience decisions (no Android deps, same
 * pattern as ConnectionGuard / OtaThrottle). PlaylistController is the imperative shell (Handler /
 * playback); this owns "which item can play right now" and "what to do when none can", so the
 * viewer-visible invariant has real coverage:
 *
 *   a pending/failed/stalled content download must NEVER blank or freeze a screen that is showing
 *   content — the player keeps showing what it already has and only swaps to new content once it's
 *   fully + validly downloaded.
 */
object PlaylistSelection {
    /** First index for which [isPlayable] holds, or -1 if none. */
    fun firstPlayableIndex(size: Int, isPlayable: (Int) -> Boolean): Int {
        for (i in 0 until size) if (isPlayable(i)) return i
        return -1
    }

    /**
     * Next index after [from] (wrapping) for which [isPlayable] holds, or -1 if none. With a single
     * playable item it returns that item (loop), so a device keeps looping the content it HAS while
     * other items are still downloading.
     */
    fun nextPlayableIndex(size: Int, from: Int, isPlayable: (Int) -> Boolean): Int {
        if (size <= 0) return -1
        for (i in 1..size) {
            val idx = (((from + i) % size) + size) % size
            if (isPlayable(idx)) return idx
        }
        return -1
    }

    /**
     * First playable index AT OR AFTER [from] (wrapping), or -1 if none. A negative [from] means
     * "no position yet" and starts at 0 rather than wrapping onto the last item.
     */
    fun playableFromIndex(size: Int, from: Int, isPlayable: (Int) -> Boolean): Int {
        if (size <= 0) return -1
        val start = if (from < 0) 0 else from % size
        for (i in 0 until size) {
            val idx = (start + i) % size
            if (isPlayable(idx)) return idx
        }
        return -1
    }

    /**
     * Which item a content re-check should play once something finally becomes ready.
     *
     * [hasContentOnScreen] is the entire distinction, and getting it wrong costs the operator the
     * first item of their playlist. When content IS up, currentIndex is a real position that has
     * already had its turn, so the scan must move PAST it. When nothing is up, currentIndex is only
     * where playback INTENDED to begin — updatePlaylist() seeds it to 0 for a playlist that has not
     * started yet — so it has never been shown, and advancing past it silently drops item 1 from the
     * first pass through the playlist.
     *
     * That is the cold-start case on every fresh panel: the playlist arrives before its media has
     * downloaded, start() finds nothing playable, and the re-check three seconds later is what
     * actually begins playback. On a two-item playlist it looks exactly like "only one of the two
     * ever plays" until the list wraps.
     */
    fun recheckIndex(size: Int, from: Int, hasContentOnScreen: Boolean, isPlayable: (Int) -> Boolean): Int =
        if (hasContentOnScreen) nextPlayableIndex(size, from, isPlayable)
        else playableFromIndex(size, from, isPlayable)

    enum class NonePlayable { KEEP_CURRENT, SHOW_WAITING }

    /**
     * When nothing is playable (e.g. the scheduled item's content isn't downloaded yet): NEVER
     * blank a screen that is showing content. Keep the current content if we have some on screen;
     * only fall to the defined waiting/setup state when there is genuinely nothing displayed yet
     * (a fresh device that has never successfully played anything). This is the one decision that
     * separates "nothing to show yet" (acceptable) from "had content but blanked while updating"
     * (the bug this fix forbids).
     */
    fun whenNonePlayable(hasContentOnScreen: Boolean): NonePlayable =
        if (hasContentOnScreen) NonePlayable.KEEP_CURRENT else NonePlayable.SHOW_WAITING

    /*
     * ⚠️ TWO PASSES, AND THE ORDER IS THE DESIGN.
     *
     * `strict` is the real question — is this item scheduled AND is the copy we hold the revision the
     * playlist asked for? That second half is what keeps "cached for offline" compatible with "and it
     * still updates", so anything passing it must always win.
     *
     * `stale` is the last-resort question, asked ONLY when the strict pass finds nothing anywhere:
     * do we have bytes for this at all? An asset cached by a build from before content revisions
     * existed carries no revision to compare, so it can never satisfy `strict` — and a panel whose
     * disk was full of playable media sat on "Waiting for content" after an OTA rather than showing
     * any of it. A blank screen is worse than slightly stale content; it is not better than fresh
     * content, which is why this runs second and never first.
     */
    fun firstPlayableOrStale(size: Int, strict: (Int) -> Boolean, stale: (Int) -> Boolean): Int {
        val hit = firstPlayableIndex(size, strict)
        return if (hit >= 0) hit else firstPlayableIndex(size, stale)
    }

    fun nextPlayableOrStale(size: Int, from: Int, strict: (Int) -> Boolean, stale: (Int) -> Boolean): Int {
        val hit = nextPlayableIndex(size, from, strict)
        return if (hit >= 0) hit else nextPlayableIndex(size, from, stale)
    }
}

/**
 * #234 — where playback should RESUME when a playlist is (re)loaded.
 *
 * PlaylistController is created fresh with every MainActivity instance, so a recreate always handed
 * it an empty list and then a full one, which reads as "0 -> N items" and starts from the top. On a
 * panel that re-registers and relaunches itself at each item boundary, item 2 therefore never
 * survived more than a fraction of a second: the reporter of #234 had "never seen the photo, just
 * the video", and prod play_logs showed the second item logging 0-1s durations while the first
 * accumulated all the playtime.
 *
 * Starting from the top is only correct for a genuinely COLD start. If we were playing moments ago,
 * the right thing is to carry on. Kept pure so the window arithmetic is testable without a device.
 */
object PlaybackResume {
    /** How recently we must have been playing for a reload to count as a continuation. */
    const val RESUME_WINDOW_MS = 90_000L

    /**
     * Index to begin scanning from. [savedIndex] < 0, an empty/short playlist, a stale save, or a
     * clock that jumped backwards all fall back to 0 — i.e. to today's behaviour, so a real cold
     * start is unaffected.
     */
    fun resumeIndex(savedIndex: Int, savedAtMs: Long, nowMs: Long, itemCount: Int): Int {
        if (itemCount <= 0) return 0
        if (savedIndex < 0 || savedIndex >= itemCount) return 0
        if (savedAtMs <= 0L) return 0
        val age = nowMs - savedAtMs
        if (age < 0L || age > RESUME_WINDOW_MS) return 0
        return savedIndex
    }
}

/**
 * #157's deferral: when a playlist update drops the item that is CURRENTLY on screen, we let that
 * item finish its turn instead of yanking it, and apply the new list at the next natural advance.
 *
 * The rule needs two guards it did not have, both found from a customer report where a playlist
 * change appeared to be ignored entirely:
 *
 *  1. An EMPTY new list is not a rotation. Clearing a screen's playlist is an operator saying "stop
 *     showing that", so it must take effect now. Deferring it left the old content up forever.
 *  2. Deferring assumes an advance is coming. A YouTube item never advanced (see endsOnTimer), so
 *     the pending swap was stranded permanently — the caller must pair this with a deadline.
 *
 * Pure so the rule can be checked without a device or a WebView.
 */
object PendingSwap {
    /**
     * How long a deferred swap may wait for "the next natural advance" before it is applied anyway.
     * The deferral assumes an advance is coming; YouTube proved it might not be, and any future item
     * type that ends on a callback could do the same. Must comfortably clear an ordinary dwell so it
     * never pre-empts a normal rotation, while still being short enough that an operator watching
     * the screen sees their change land.
     */
    const val DEADLINE_MS = 60_000L

    /**
     * Whether a playlist update should wait for the current item to finish.
     * False means apply it immediately.
     */
    fun shouldDefer(
        isRunning: Boolean,
        wallFollower: Boolean,
        hasContentOnScreen: Boolean,
        currentlyPlayingId: String?,
        newContentIds: List<String>,
    ): Boolean {
        if (!isRunning || wallFollower || !hasContentOnScreen) return false
        if (currentlyPlayingId == null) return false
        if (newContentIds.isEmpty()) return false            // guard 1: an explicit stop
        return !newContentIds.contains(currentlyPlayingId)
    }
}

/**
 * Which items end on a TIMER versus a completion callback.
 *
 * video/youtube was in neither camp and so ended on nothing at all: it is played by loading an embed
 * into a WebView, which reports no completion, and no advance was ever armed for it. The item's
 * configured duration was passed to the player and dropped on the floor. A playlist containing a
 * YouTube item simply stopped there for good, and any pending playlist change stopped with it.
 *
 * Local and remote video deliberately stay OFF the timer path — the player reports STATE_ENDED for
 * those and a timer would cut a clip short at its configured duration.
 *
 * An HTML bundle is a WebView page like a widget: it reports no completion either, so it belongs on
 * the timer for exactly the reason YouTube does. Leaving it off is not a slow rotation, it is a
 * stopped one.
 */
object ItemTiming {
    /** The mime the server stamps on an uploaded HTML bundle (lib/html-bundle.js). */
    const val BUNDLE_MIME = "application/vnd.screentinker.bundle+zip"

    fun endsOnTimer(mimeType: String, isWidget: Boolean): Boolean =
        mimeType.startsWith("image/") || isWidget || mimeType == "video/youtube" ||
            mimeType == BUNDLE_MIME
}

