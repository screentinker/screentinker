package com.remotedisplay.player.player

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

data class PlaylistItem(
    val assignmentId: Int,
    val contentId: String,
    val filename: String,
    val mimeType: String,
    val filepath: String,
    val durationSec: Int,
    val fileSize: Long,
    val sortOrder: Int,
    val enabled: Boolean = true,
    val remoteUrl: String? = null,
    val muted: Boolean = false,
    val widgetId: String? = null,
    // Changes whenever the widget is edited. Carried into the render URL so an edited widget gets
    // a URL the player has not seen, which is what defeats the deliberate same-URL WebView reuse.
    val widgetRev: Long = 0L,
    // Bumped by the server when an asset's BYTES change under a stable content id (the dashboard's
    // "replace file"). The cache is keyed on it: without one, a replaced asset would keep playing
    // the copy already on disk forever, because nothing about the id or the URL would differ.
    val contentRev: Long = 0L,
    val widgetType: String? = null,
    val schedules: List<ScheduleEval.Block> = emptyList(),
    /* Slide voiceover + deck music bed. Metadata on the ITEM, not inside the slide document — a
     * player that only renders the widget iframe makes no sound, which is why this exists. */
    val slideAudio: SlideAudio? = null,
    // feat/transition-engine: the resolved GL transition this item plays INTO (null = hard cut).
    val transition: TransitionSpec? = null
) {
    /*
     * ⚠️  WHICH ITEM THIS IS, FOR CONTINUITY — AND IT IS NOT contentId.
     *
     * Widget items carry contentId = "" (there is no content row behind them), so keying continuity
     * on contentId alone made every widget in a playlist the same item. On an all-widget playlist
     * `indexOfFirst { it.contentId == currentlyPlayingId }` matched INDEX 0 whatever was actually on
     * screen, so any edit snapped playback back to the first slide — and then returned without
     * re-rendering, so the screen kept showing the old one while the index said otherwise. That is
     * ⚠️ #234 in a new place: the fix there was to stop treating a changed field as a changed item,
     * and this is the same mistake from the other direction.
     *
     * Shaped like sig() above deliberately: a content item is "abc|", a widget item is "|w-123".
     * Both stable across an edit, and never equal to each other.
     */
    val itemKey: String get() = contentId + "|" + (widgetId ?: "")

    val isRemote: Boolean get() = !remoteUrl.isNullOrEmpty()
    // Widget assignments have a widget_id and no downloadable content file.
    val isWidget: Boolean get() = !widgetId.isNullOrEmpty()
}

class PlaylistController(
    private val onItemChanged: (PlaylistItem?) -> Unit,
    private val onPlaylistEmpty: () -> Unit,
    private val onRequestRefresh: (() -> Unit)? = null,
    private val onNothingScheduled: (() -> Unit)? = null,
    // Screen-resilience: the defined "content isn't downloaded yet" waiting state, shown ONLY when
    // nothing has ever played (fresh device). Never used while content is on screen.
    private val onWaitingForContent: (() -> Unit)? = null,
    // Proof-of-play: emitted on each item show ("play_start") and when it's left ("play_end"),
    // so the caller can forward device:play-event to the server (populates play_logs / Reports).
    private val onPlayLog: ((event: String, item: PlaylistItem, completed: Boolean) -> Unit)? = null,
    // #234: playback position, persisted OUTSIDE this object so it survives the controller being
    // rebuilt with a new Activity. Null on both = today's behaviour (always start from the top).
    private val loadResume: (() -> Pair<Int, Long>?)? = null,
    private val saveResume: ((index: Int, atMs: Long) -> Unit)? = null
) {
    private companion object {
        const val CONTENT_RECHECK_MS = 3000L
        // Backstop against a busy-loop: an auto-advance is never scheduled faster than
        // this, so a bad/zero duration on any path can't peg the main thread (see #widget
        // zero-duration self-loop — a solo fullscreen widget with duration_sec=0).
        const val MIN_ADVANCE_MS = 500L
    }

    private val items = mutableListOf<PlaylistItem>()
    private var currentIndex = -1
    // Proof-of-play: the item we last emitted a play_start for (so we can close it with play_end
    // on the next show). Only set for loggable items (never wall followers).
    private var loggedItem: PlaylistItem? = null
    private val handler = Handler(Looper.getMainLooper())
    private var advanceRunnable: Runnable? = null
    private var isRunning = false
    // #74/#75: per-item scheduling state
    @Volatile private var effectiveTimezone: String? = null
    private var retryRunnable: Runnable? = null

    // #157: when a playlist update REMOVES the item currently on screen (e.g. it just expired),
    // we don't yank it off / restart — the current item plays out and we rotate into this stashed
    // list on the next advance. pendingSuccessorId is the item that followed the removed one (old
    // order) and still exists, so rotation continues where it left off instead of jumping to the top.
    // Solo playback only (never wallFollower/group-sync, whose advance isn't driven by next()).
    private var pendingItems: List<PlaylistItem>? = null
    private var pendingSuccessorId: String? = null

    // Screen-resilience: an item is playable only when its content is actually AVAILABLE
    // (widget / remote-stream / fully-downloaded local file). Injected by MainActivity (which owns
    // the cache); the default keeps every item playable so behavior is unchanged until it's set.
    private var contentReady: (PlaylistItem) -> Boolean = { true }
    fun setContentReadyCheck(f: (PlaylistItem) -> Boolean) { contentReady = f }

    /*
     * ⚠️ THE LAST-RESORT GATE: bytes we HAVE but cannot vouch for.
     *
     * contentReady above is strict, and has to be — it is what makes "cached for offline" compatible
     * with "and it still updates", by refusing a copy whose revision does not match what the
     * playlist is asking for. The failure was making that the ONLY question. An asset cached by a
     * build from before content revisions existed carries no revision sidecar, so it can never match,
     * and a panel whose disk is full of perfectly playable media sat on "Waiting for content" after
     * an OTA — reported from a fleet, with the operator's own log showing every file present.
     *
     * So there are two passes, in this order, and the order is the whole design: anything with a
     * CONFIRMED revision plays first, always, so a replaced asset still reaches the screen the moment
     * it lands. Only when nothing at all passes that bar do we ask the weaker question — is there
     * something here we could show? — instead of showing nothing. That is the same principle
     * ScheduleEval states two files away: a blank screen is worse than slightly stale content.
     *
     * Defaults to false, so a caller that never injects it keeps exactly the old behaviour.
     */
    private var contentUsable: (PlaylistItem) -> Boolean = { false }
    fun setContentUsableCheck(f: (PlaylistItem) -> Boolean) { contentUsable = f }

    // Slide audio. Injected like contentReady above, for the same reason: this class should not
    // know where the server URL is stored, and a controller with neither set still behaves exactly
    // as it did before the feature existed.
    private var serverBase: (() -> String)? = null
    fun setServerBase(f: () -> String) { serverBase = f }
    private var slideAudioPlayer: SlideAudioPlayer? = null
    fun setSlideAudioPlayer(p: SlideAudioPlayer?) { slideAudioPlayer = p }
    // True while a valid item is rendered on screen — so we NEVER blank it for a pending download.
    private var hasContentOnScreen = false

    // Video wall: followers don't self-advance — the leader's wall:sync drives the index.
    private var wallFollower = false
    // Wall-clock at which the current item started playing, for non-video sync position.
    private var itemStartedAt = 0L

    val isPlaying: Boolean get() = isRunning && currentIndex >= 0

    /**
     * Enter/leave follower mode (video wall follower, or group sync). While it is ON no advance
     * timer is ever armed — playCurrentItem() skips scheduleAdvance() and the wall/group tick owns
     * the index instead.
     *
     * That makes BOTH edges stateful, and both were being ignored:
     *  - leaving, the flag was cleared but nothing re-armed the timer for the item already on
     *    screen, so the playlist sat on one frame forever (until the app restarted). Unchecking
     *    "sync" on a group froze every member showing an image.
     *  - entering, a timer armed by the previous playCurrentItem() stayed live and would fire a
     *    next() that fights the tick for the index.
     *
     * Video is exempt on the way out: it advances from its completion callback, which onVideoComplete
     * already gates on this same flag.
     */
    fun setWallFollower(b: Boolean) {
        val was = wallFollower
        wallFollower = b
        if (was == b) return
        if (b) { cancelAdvance(); return }
        val item = currentItem ?: return
        val delay = FollowerExit.resumeDelayMs(
            isRunning = isRunning,
            isImageOrWidget = endsOnTimer(item),
            slotMs = slotMs(item),
            elapsedMs = System.currentTimeMillis() - itemStartedAt
        ) ?: return
        Log.i("PlaylistController", "follower mode off — resuming self-advance in ${delay}ms")
        scheduleAdvance(delay)
    }

    /** Current playlist index (-1 if nothing is playing). */
    fun getIndex(): Int = currentIndex

    /** Wall-clock ms when the current item started; used for non-video sync position. */
    fun itemStartedAtMs(): Long = itemStartedAt

    /** Jump to an absolute index (wraps); used by wall followers tracking the leader. */
    fun gotoIndex(idx: Int) {
        if (items.isEmpty()) return
        val n = items.size
        val target = ((idx % n) + n) % n
        if (target == currentIndex) return
        currentIndex = target
        playCurrentItem()
    }

    /** #74/#75: device-effective IANA timezone for per-item schedule evaluation. */
    fun setTimezone(tz: String?) { effectiveTimezone = tz }

    val currentItem: PlaylistItem?
        get() = if (currentIndex in items.indices) items[currentIndex] else null

    // #group-sync double buffer: resolve an item by index (for preloading the next clip).
    fun itemAt(index: Int): PlaylistItem? = if (index in items.indices) items[index] else null

    val currentContentId: String?
        get() = currentItem?.contentId

    fun updatePlaylist(assignmentsJson: JSONArray) {
        Log.i("PlaylistController", "Received JSONArray with ${assignmentsJson.length()} items")

        // Build new list
        val newItems = mutableListOf<PlaylistItem>()
        for (i in 0 until assignmentsJson.length()) {
            val obj = assignmentsJson.getJSONObject(i)
            newItems.add(
                PlaylistItem(
                    assignmentId = obj.optInt("id", 0),
                    // Tolerant: widget assignments have no content_id (getString threw).
                    contentId = if (obj.isNull("content_id")) "" else obj.optString("content_id", ""),
                    filename = obj.optString("filename", "unknown"),
                    mimeType = obj.optString("mime_type", "video/mp4"),
                    filepath = obj.optString("filepath", ""),
                    durationSec = obj.optInt("duration_sec", 10),
                    fileSize = obj.optLong("file_size", 0),
                    sortOrder = obj.optInt("sort_order", 0),
                    enabled = obj.optInt("enabled", 1) == 1,
                    remoteUrl = if (obj.isNull("remote_url")) null else obj.optString("remote_url", "").ifEmpty { null },
                    muted = obj.optInt("muted", 0) == 1,
                    widgetId = if (obj.isNull("widget_id")) null else obj.optString("widget_id", "").ifEmpty { null },
                    widgetRev = obj.optLong("widget_rev", 0L),
                    contentRev = obj.optLong("content_rev", 0L),
                    widgetType = if (obj.isNull("widget_type")) null else obj.optString("widget_type", "").ifEmpty { null },
                    schedules = parseSchedules(obj.optJSONArray("schedules")),
                    transition = Transitions.parse(obj.optJSONObject("transition")),
                    slideAudio = parseSlideAudio(obj.optJSONObject("audio"))
                )
            )
        }

        // Check if playlist actually changed (key on content OR widget id, since
        // widget items share an empty contentId).
        // #74/#75: a schedule edit changes playback even when content is identical, so
        // the change signature must include schedules (else updated blocks are dropped).
        // #129: include muted too, so a mute-only change (same content) re-renders with the
        // new flag instead of being de-duped (the real-time event handles the live toggle;
        // this makes a published mute persist across reloads).
        // Signature is STRUCTURAL only — content/widget identity, order, mute, schedules. durationSec is
        // deliberately EXCLUDED so a duration-only edit does NOT force a restart; instead it's applied
        // IN PLACE below (the #group-sync schedule tick + the solo advance timer read durationSec live),
        // so timing edits take effect without interrupting playback or resetting the index.
        // transition included so a transition-only edit re-renders instead of being de-duped (a
        // cached-playlist device otherwise silently ignores it — the web/Tizen fingerprint bug).
        // widgetRev for the same reason as muted and transition above: a widget's identity does not
        // change when it is EDITED, so a content edit produced a byte-identical signature, the
        // update was de-duped, and the player kept its old items — including the old rev, so the
        // render URL never changed and the WebView reuse held. The screen only caught up on an app
        // restart. Found on the emulator; the code read looked correct without it.
        fun sig(it: PlaylistItem) = it.contentId + "|" + (it.widgetId ?: "") + "|" + it.widgetRev + "|" + (if (it.muted) "m" else "") + "|" +
            it.schedules.joinToString(";") { b ->
                b.days.sorted().joinToString(",") + "@" + b.start + "-" + b.end + ":" + (b.startDate ?: "") + "~" + (b.endDate ?: "")
            } + "|" + (it.transition?.sig() ?: "")
        val oldContentIds = items.map(::sig)
        val newContentIds = newItems.map(::sig)
        val playlistChanged = oldContentIds != newContentIds

        if (!playlistChanged && items.isNotEmpty()) {
            // In-place duration refresh: patch durationSec on the existing items so a duration edit
            // takes effect immediately without a restart. For a sync group this re-anchors the shared
            // schedule (all members recompute the new period together); for solo it's picked up on the
            // next advance. No index reset, no video reload.
            var durChanged = false
            for (i in items.indices) {
                val ni = newItems.getOrNull(i) ?: continue
                if (items[i].durationSec != ni.durationSec) { items[i] = items[i].copy(durationSec = ni.durationSec); durChanged = true }
            }
            Log.i("PlaylistController", if (durChanged) "Durations updated in place (${items.size} items), not interrupting" else "Playlist unchanged (${items.size} items), not interrupting playback")
            return
        }

        Log.i("PlaylistController", "Playlist changed: ${items.size} -> ${newItems.size} items")

        // Remember what's currently playing.
        // ⚠️ Captured BEFORE items is replaced below, and captured as a KEY rather than a contentId
        // so a widget item identifies itself. The rev rides along because it is the one field that
        // changes without changing which item this is — see the re-render below.
        val currentlyPlayingId = currentItem?.itemKey
        val currentlyPlayingRev = currentItem?.widgetRev ?: 0L

        // #157: the item on screen was REMOVED (its only change is removal — e.g. it just expired).
        // In solo playback, don't interrupt it: keep it up, stash the new list, and rotate out on the
        // next natural advance (video end / image duration). Excludes wallFollower + group-sync, whose
        // advance is driven by their tick, not next() — deferring there would strand the swap.
        // An EMPTY new list is never a deferral candidate. Clearing a screen's playlist is an
        // explicit "stop showing that" from an operator, not an item rotating out — deferring it
        // meant selecting "no playlist" left the old content up indefinitely, which is the opposite
        // of what was asked for and looked like the setting had done nothing.
        if (PendingSwap.shouldDefer(
                isRunning = isRunning,
                wallFollower = wallFollower,
                hasContentOnScreen = hasContentOnScreen,
                currentlyPlayingId = currentlyPlayingId,
                newContentIds = newItems.map { it.itemKey },
            )) {
            var succ: String? = null
            if (items.isNotEmpty()) {
                for (k in 1..items.size) {
                    val cid = items[(currentIndex + k) % items.size].itemKey
                    if (cid != currentlyPlayingId && newItems.any { it.itemKey == cid }) { succ = cid; break }
                }
            }
            pendingItems = newItems
            pendingSuccessorId = succ
            Log.i("PlaylistController", "Current item removed but still live — deferring rotation-out (successor=$succ)")
            armPendingSwapDeadline()
            return
        }
        // A non-deferred structural update supersedes any pending swap.
        pendingItems = null
        pendingSuccessorId = null
        cancelPendingSwapDeadline()

        items.clear()
        items.addAll(newItems)

        if (items.isEmpty()) {
            currentIndex = -1
            cancelAdvance()
            onPlaylistEmpty()
        } else if (isRunning) {
            // Try to keep playing the current item if it's still in the list
            if (currentlyPlayingId != null) {
                val newIndex = items.indexOfFirst { it.itemKey == currentlyPlayingId }
                if (newIndex >= 0 && hasContentOnScreen) {
                    // Current item still exists AND is genuinely on screen - don't interrupt, just update index.
                    currentIndex = newIndex
                    /*
                     * ⚠️ UNLESS THE ITEM IS THE SAME BUT ITS CONTENTS ARE NOT.
                     *
                     * A widget's identity does not change when it is edited — that is deliberate, and
                     * it is what lets an edit avoid restarting the playlist. But it means "same item"
                     * and "same thing on screen" stopped being the same question. widgetRev is the
                     * only field that separates them, so a rev that moved under a matching key is
                     * exactly the case where holding the WebView is wrong: the render URL changed,
                     * and returning here would leave the old slide up until the next natural advance.
                     *
                     * Re-rendering only this item is the narrow fix. The index is already correct, so
                     * playback continues from the same place — the operator sees their edit appear
                     * where it was, not the playlist jump back to the start.
                     */
                    if (items[newIndex].widgetRev != currentlyPlayingRev) {
                        Log.i("PlaylistController",
                            "Same item at $newIndex but widgetRev ${currentlyPlayingRev} -> ${items[newIndex].widgetRev} — re-rendering in place")
                        playCurrentItem()
                        return
                    }
                    Log.i("PlaylistController", "Current item still in playlist at index $newIndex, not interrupting")
                    return
                }
                // #162: if the item is still present but nothing is actually rendered (hasContentOnScreen
                // = false, e.g. content wasn't downloaded when we first tried), do NOT trust the stale
                // "playing" state — fall through to (re)pick a playable item and start below.
            }
            // Current item was removed or nothing was playing - start from the first
            // schedule-active AND downloaded item. Distinguish the two idle reasons: daypart
            // closed (nothing scheduled) => defined idle; scheduled-but-not-yet-downloaded =>
            // keep current content / waiting, never blank.
            val fp = firstPlayable()
            if (fp >= 0) { currentIndex = fp; playCurrentItem() }
            else if (firstActiveIndex() < 0) showNothingScheduled()
            else onContentNotReady()
        } else {
            currentIndex = 0
        }
    }

    fun removeContent(contentId: String) {
        val wasCurrentId = currentItem?.contentId
        items.removeAll { it.contentId == contentId }

        if (items.isEmpty()) {
            currentIndex = -1
            cancelAdvance()
            onPlaylistEmpty()
        } else if (wasCurrentId == contentId) {
            if (currentIndex >= items.size) currentIndex = 0
            playCurrentItem()
        }
    }

    fun start() {
        isRunning = true
        if (items.isEmpty()) { onPlaylistEmpty(); return }
        // #74/#75: begin on the first schedule-active item; daypart-closed => defined idle.
        if (firstActiveIndex() < 0) { showNothingScheduled(); return }
        // Screen-resilience: only start on an item whose content is downloaded; if the scheduled
        // content isn't ready yet, keep current/wait (never blank on a loading state).
        // #234: continue where we left off when this is a reload moments after playing (a new
        // Activity => a brand-new controller), not a genuine cold start. Scanning from 0 every time
        // is what pinned these playlists on their first item forever.
        val saved = try { loadResume?.invoke() } catch (_: Throwable) { null }
        val from = PlaybackResume.resumeIndex(
            saved?.first ?: -1, saved?.second ?: 0L, System.currentTimeMillis(), items.size)
        val idx = if (from > 0 && playableNow(from)) from
                  else if (from > 0) nextPlayable(from - 1)
                  else firstPlayable()
        if (from > 0) Log.i("PlaylistController", "Resuming at index $from (reload within resume window)")
        if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
    }

    fun startIfNeeded() {
        if (items.isEmpty()) {
            Log.i("PlaylistController", "No items, nothing to start")
            onPlaylistEmpty()
            return
        }
        // #162: isRunning + a valid index are NOT proof the player is actually rendering. After a
        // restore, or an onContentNotReady (content still downloading when start() first ran),
        // isRunning stays true with a seeded currentIndex but NOTHING on screen — and the old guard
        // then blocked every retry, stranding the panel on "waiting for content" even after the
        // content finished downloading. Only short-circuit when an item is genuinely on screen;
        // otherwise fall through and (re)start so playback reliably begins/recovers.
        if (isRunning && currentIndex >= 0 && currentIndex < items.size && hasContentOnScreen) {
            Log.i("PlaylistController", "Already playing ${items[currentIndex].filename}, not restarting")
            return
        }
        Log.i("PlaylistController", "Starting playback")
        start()
    }

    fun stop() {
        isRunning = false
        cancelAdvance()
        cancelRetry()
        cancelPendingSwapDeadline()   // else a stopped controller can still fire next()
        hasContentOnScreen = false
        pendingItems = null
        pendingSuccessorId = null
        // Here and not in the per-item path: the bed has to survive an advance, and only a real
        // stop ends it.
        try { slideAudioPlayer?.stop() } catch (_: Throwable) {}
        // Proof-of-play: close the open row so its duration is recorded on shutdown/screen-off.
        loggedItem?.let { onPlayLog?.invoke("play_end", it, true) }
        loggedItem = null
    }

    fun next() {
        // #157: a deferred rotation-out — the just-finished item was removed (expired) while live.
        // Swap in the stashed list now and continue at the preserved successor (or first playable).
        pendingItems?.let { p ->
            pendingItems = null
            cancelPendingSwapDeadline()
            val succ = pendingSuccessorId; pendingSuccessorId = null
            items.clear(); items.addAll(p)
            if (items.isEmpty()) { currentIndex = -1; cancelAdvance(); onPlaylistEmpty(); return }
            onRequestRefresh?.invoke()
            if (firstActiveIndex() < 0) { showNothingScheduled(); return }
            var idx = if (succ != null) items.indexOfFirst { it.contentId == succ } else -1
            if (idx < 0 || !playableNow(idx)) idx = firstPlayable()
            if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
            return
        }
        if (items.isEmpty()) return
        // Request a playlist refresh between plays so new content gets picked up
        onRequestRefresh?.invoke()
        // #74/#75: daypart closed (nothing scheduled now) => defined idle.
        if (firstActiveIndex() < 0) { showNothingScheduled(); return }
        // Screen-resilience: advance to the next schedule-active AND downloaded item. Unready items
        // are SKIPPED (their background download continues), so a stalled/failed download of the
        // next content never blanks the screen — we keep looping the content we already have. If
        // NOTHING is downloaded yet, keep current content / show the waiting state, never blank.
        val idx = nextPlayable(currentIndex)
        if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
    }

    fun onVideoComplete() {
        // Called when a video finishes naturally. Wall followers don't self-advance —
        // they hold (and loop) the leader's item until a wall:sync changes the index.
        // ⚠️ Completions ONLY. A fault goes through onVideoFault(): routing it here is what
        // switched every self-heal off in follower/group mode (#333).
        if (wallFollower) return
        next()
    }

    /**
     * #333: the video FAILED — a playback error, or the #297 watchdog saw the decoder wedge. See
     * PlaybackFault for the rule. Solo: skip it (unchanged). Follower / group member: the sync owns
     * the index, so keep it and re-mount the same item; the sync tick then snaps the position back
     * to the group. Re-mounting is the cold path (MediaPlayerManager has already dropped the
     * players a wedge left behind), which is the part of "restart the app" that actually fixed it.
     */
    private val fault = PlaybackFault()

    fun onVideoFault() {
        when (fault.recovery(wallFollower, currentIndex, System.currentTimeMillis())) {
            PlaybackFault.Recovery.ADVANCE -> next()
            PlaybackFault.Recovery.REPLAY_CURRENT -> {
                val item = currentItem ?: return
                Log.w("PlaylistController", "video fault in follower/group mode — replaying ${item.filename} (index $currentIndex)")
                playCurrentItem()
            }
            PlaybackFault.Recovery.HOLD ->
                Log.w("PlaylistController", "video fault in follower/group mode — just replayed index $currentIndex, holding")
        }
    }

    /**
     * Items whose turn ends on a TIMER rather than a completion callback.
     *
     * video/youtube belongs here and did not: it is played by loading an embed into a WebView, which
     * fires no completion event, so nothing ever advanced past it. playYoutube() even takes a
     * durationSec and never reads it. A playlist containing a YouTube item simply stopped there.
     *
     * That also stranded #157's deferred swap, which waits for "the next natural advance": assigning
     * a different playlist while a YouTube item was on screen deferred forever, so the change looked
     * like it had been ignored. Reported as "I assigned Playlist 2 and it kept showing the video".
     *
     * Local and remote non-YouTube video stay off this list — ExoPlayer reports STATE_ENDED and
     * onVideoComplete drives those, and a timer would cut a clip short.
     */
    private var pendingSwapRunnable: Runnable? = null

    /** Apply a deferred swap even if no advance arrives — see PENDING_SWAP_DEADLINE_MS. */
    private fun armPendingSwapDeadline() {
        cancelPendingSwapDeadline()
        pendingSwapRunnable = Runnable {
            if (pendingItems != null) {
                Log.w("PlaylistController", "Deferred playlist swap never got an advance — applying it now")
                next()
            }
        }
        handler.postDelayed(pendingSwapRunnable!!, PendingSwap.DEADLINE_MS)
    }

    private fun cancelPendingSwapDeadline() {
        pendingSwapRunnable?.let { handler.removeCallbacks(it) }
        pendingSwapRunnable = null
    }

    private fun endsOnTimer(item: PlaylistItem): Boolean =
        ItemTiming.endsOnTimer(item.mimeType, item.isWidget)

    private fun playCurrentItem() {
        cancelAdvance()
        cancelRetry()
        val item = currentItem ?: return
        itemStartedAt = System.currentTimeMillis()
        // #234: remember where we are so a controller rebuilt seconds from now can carry on.
        try { saveResume?.invoke(currentIndex, itemStartedAt) } catch (_: Throwable) {}
        Log.i("PlaylistController", "Playing: ${item.filename} (index $currentIndex)")
        // Slide audio: replaces the voiceover, leaves a bed playing when the id has not changed.
        try { slideAudioPlayer?.apply(item.slideAudio, item.muted || wallFollower) } catch (t: Throwable) {
            Log.w("PlaylistController", "slide audio failed: ${t.message}")
        }
        onItemChanged(item)
        hasContentOnScreen = true // a valid item is now rendered — protect it from being blanked

        // Proof-of-play (parity with the web player): close the outgoing item and open this one.
        // Wall followers don't log — the leader's single row represents the whole wall.
        if (!wallFollower) {
            loggedItem?.let { prev -> if (prev !== item) onPlayLog?.invoke("play_end", prev, true) }
            onPlayLog?.invoke("play_start", item, false)
            loggedItem = item
        }

        // For images and widgets, auto-advance after duration. For videos, wait
        // for the completion callback. Wall followers never auto-advance — the
        // leader's wall:sync index drives every switch.
        if (!wallFollower && endsOnTimer(item)) {
            // slotMs() floors a zero/negative duration to 10s (the max(1, duration||10)
            // contract shared with the web/Tizen players). A raw durationSec*1000 here let a
            // solo fullscreen widget with duration_sec=0 schedule a 0ms advance -> self-loop.
            scheduleAdvance(slotMs(item))
        }
    }

    private fun scheduleAdvance(delayMs: Long) {
        cancelAdvance()
        // Backstop: never busy-loop, even if a future caller passes a tiny/zero delay.
        val safeDelayMs = maxOf(delayMs, MIN_ADVANCE_MS)
        advanceRunnable = Runnable { next() }
        handler.postDelayed(advanceRunnable!!, safeDelayMs)
    }

    private fun cancelAdvance() {
        advanceRunnable?.let { handler.removeCallbacks(it) }
        advanceRunnable = null
    }

    private fun cancelRetry() {
        retryRunnable?.let { handler.removeCallbacks(it) }
        retryRunnable = null
    }

    // #74/#75 schedule helpers ---------------------------------------------------
    private fun scheduleAllows(item: PlaylistItem): Boolean =
        item.schedules.isEmpty() ||
            ScheduleEval.isItemActiveNow(item.schedules, System.currentTimeMillis(), effectiveTimezone)

    // #group-sync schedule engine. Lay the deterministic playlist (each active item occupies a
    // CANONICAL slot, dayparted items skipped) on the server-disciplined clock and derive the target
    // (index, position). The slot formula MUST be byte-identical to the web and Tizen players
    // (max(1, duration_sec||10)*1000) or a mixed-platform group would diverge — so it deliberately
    // does NOT use this player's solo-playback duration clamp.
    // nextIndex + secToBoundary let the double buffer preload the upcoming clip a few seconds early.
    // For a single active slot, nextIndex == index (the caller skips preloading a self-loop).
    data class GroupTarget(val index: Int, val posSec: Float, val nextIndex: Int, val secToBoundary: Float)
    private fun slotMs(it: PlaylistItem): Long = (if (it.durationSec > 0) it.durationSec else 10).toLong() * 1000L
    fun groupScheduleTarget(syncedNowMs: Long): GroupTarget? {
        if (items.isEmpty()) return null
        var acc = 0L
        val slots = ArrayList<Triple<Int, Long, Long>>()   // index, startMs, durMs
        for (i in items.indices) {
            if (!scheduleAllows(items[i])) continue
            val d = slotMs(items[i]); slots.add(Triple(i, acc, d)); acc += d
        }
        if (slots.isEmpty() || acc <= 0L) return null
        val period = acc
        val phase = ((syncedNowMs % period) + period) % period
        var chosenIdx = slots.size - 1
        for (k in slots.indices) { val s = slots[k]; if (phase >= s.second && phase < s.second + s.third) { chosenIdx = k; break } }
        val chosen = slots[chosenIdx]
        val next = slots[(chosenIdx + 1) % slots.size]
        val secToBoundary = (chosen.second + chosen.third - phase) / 1000f
        return GroupTarget(chosen.first, (phase - chosen.second) / 1000f, next.first, secToBoundary)
    }

    // Playable NOW = schedule-active AND its content is downloaded/available.
    private fun playableNow(i: Int): Boolean =
        i in items.indices && scheduleAllows(items[i]) && contentReady(items[i])

    /** Scheduled, and we hold bytes for it — but their revision could not be confirmed. */
    private fun playableStale(i: Int): Boolean =
        i in items.indices && scheduleAllows(items[i]) && contentUsable(items[i])

    /*
     * Strict first, stale only if strict finds nothing. Every selection goes through these two so a
     * future call site cannot accidentally get one pass and not the other — which is precisely how
     * the single-pass version came to be the only behaviour.
     */
    private fun firstPlayable(): Int =
        PlaylistSelection.firstPlayableOrStale(items.size, { playableNow(it) }, { playableStale(it) })

    private fun nextPlayable(from: Int): Int =
        PlaylistSelection.nextPlayableOrStale(items.size, from, { playableNow(it) }, { playableStale(it) })

    // Screen-resilience: the scheduled item(s) exist but their content isn't downloaded yet.
    // NEVER blank a screen that is already showing content — keep it and re-check soon (the
    // background download finishes, or the watchdog restores connectivity). Only show the defined
    // waiting/setup state on a fresh device that has never played anything.
    private fun onContentNotReady() {
        cancelAdvance()
        when (PlaylistSelection.whenNonePlayable(hasContentOnScreen)) {
            PlaylistSelection.NonePlayable.KEEP_CURRENT -> { /* leave current content on screen */ }
            PlaylistSelection.NonePlayable.SHOW_WAITING -> {
                hasContentOnScreen = false
                (onWaitingForContent ?: onNothingScheduled ?: onPlaylistEmpty)()
            }
        }
        scheduleContentRecheck()
    }

    // Re-evaluate playability shortly (a pending download may have finished / a daypart opened).
    // Faster than the schedule re-check because a finished download should play promptly.
    private fun scheduleContentRecheck() {
        cancelRetry()
        retryRunnable = Runnable {
            if (isRunning && items.isNotEmpty()) {
                if (firstActiveIndex() < 0) { showNothingScheduled(); return@Runnable }
                // Include currentIndex when nothing is on screen: there it is the intended START,
                // not a position that has had its turn. Skipping it dropped item 1 on every cold
                // start, because a fresh panel always gets the playlist before the media.
                val idx = PlaylistSelection.recheckIndex(items.size, currentIndex, hasContentOnScreen) { playableNow(it) }
                if (idx >= 0) { currentIndex = idx; playCurrentItem() } else onContentNotReady()
            }
        }
        handler.postDelayed(retryRunnable!!, CONTENT_RECHECK_MS)
    }

    private fun firstActiveIndex(): Int {
        for (i in items.indices) if (scheduleAllows(items[i])) return i
        return -1
    }

    private fun nextActiveIndex(from: Int): Int {
        if (items.isEmpty()) return -1
        for (i in 1..items.size) {
            val idx = (from + i) % items.size
            if (scheduleAllows(items[idx])) return idx
        }
        return -1
    }

    // Every item filtered out: show the idle screen and re-check shortly, since a
    // daypart may open. (Boundary re-evaluation otherwise happens on advance.)
    private fun showNothingScheduled() {
        cancelAdvance()
        hasContentOnScreen = false // the daypart genuinely closed — a defined idle, not a blank-bug
        (onNothingScheduled ?: onPlaylistEmpty)()
        cancelRetry()
        retryRunnable = Runnable {
            if (isRunning && items.isNotEmpty()) {
                val idx = firstActiveIndex()
                if (idx >= 0) { currentIndex = idx; playCurrentItem() } else showNothingScheduled()
            }
        }
        handler.postDelayed(retryRunnable!!, 30_000L)
    }

    /**
     * The audio block, with URLs made absolute.
     *
     * ⚠️ ABSOLUTE, ALWAYS. The server sends `/uploads/content/...`; ExoPlayer has no document to
     * resolve a relative path against and simply fails. serverBase is the same value every other
     * media path here is built on.
     */
    private fun parseSlideAudio(o: JSONObject?): SlideAudio? {
        if (o == null) return null
        fun abs(u: String?): String? {
            if (u.isNullOrEmpty()) return null
            if (u.startsWith("http://") || u.startsWith("https://")) return u
            val base = (serverBase?.invoke() ?: "").trimEnd('/')
            return if (base.isEmpty()) null else base + u
        }
        val a = SlideAudio(
            voUrl = abs(if (o.isNull("vo_url")) null else o.optString("vo_url", "")),
            voVolume = o.optDouble("vo_volume", 1.0).toFloat(),
            musicId = if (o.isNull("music_id")) null else o.optString("music_id", "").ifEmpty { null },
            musicUrl = abs(if (o.isNull("music_url")) null else o.optString("music_url", "")),
            musicVolume = o.optDouble("music_volume", 0.4).toFloat(),
        )
        return if (a.isEmpty) null else a
    }

    private fun parseSchedules(arr: JSONArray?): List<ScheduleEval.Block> {
        if (arr == null) return emptyList()
        val out = ArrayList<ScheduleEval.Block>(arr.length())
        for (j in 0 until arr.length()) {
            val s = arr.getJSONObject(j)
            val d = s.getJSONArray("days")
            val days = HashSet<Int>(d.length())
            for (k in 0 until d.length()) days.add(d.getInt(k))
            out.add(
                ScheduleEval.Block(
                    days = days,
                    start = s.getString("start"),
                    end = s.getString("end"),
                    startDate = if (s.isNull("start_date")) null else s.optString("start_date").ifEmpty { null },
                    endDate = if (s.isNull("end_date")) null else s.optString("end_date").ifEmpty { null }
                )
            )
        }
        return out
    }
}

/**
 * Pure decision for re-arming self-advance when follower mode (video wall / group sync) is turned
 * off, extracted so it's unit-testable without a Handler or Android runtime — same seam pattern as
 * TierLogic / ManagedLogic.
 *
 * Returns the delay to schedule, or null when nothing should be armed. The remaining slot is
 * measured from when the item actually started, so leaving sync 8s into a 10s image advances in
 * ~2s rather than restarting the full duration. A slot that already elapsed yields 0 and the
 * caller's MIN_ADVANCE_MS backstop keeps it off a busy loop.
 */
object FollowerExit {
    fun resumeDelayMs(
        isRunning: Boolean,
        isImageOrWidget: Boolean,
        slotMs: Long,
        elapsedMs: Long
    ): Long? {
        if (!isRunning) return null          // nothing is playing; playCurrentItem() will arm it
        if (!isImageOrWidget) return null    // video advances from its completion callback
        return (slotMs - elapsedMs).coerceAtLeast(0L)
    }
}
