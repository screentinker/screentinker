package com.remotedisplay.player.data

import android.os.SystemClock
import android.util.Log
import com.remotedisplay.player.util.DebugLog
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Resolves the background-download × reconnect A-bucket bug. Previously every playlist sweep spawned
 * a detached, un-deduped download `thread{}` writing a deterministic `${id}.ext.part` path. On a
 * watchdog / ConnectionGuard reconnect the re-register drove a NEW sweep that started a DUPLICATE
 * download of the same content mid-fetch — two writers racing the shared `.part` (a corrupt file
 * whose byte-count still matched Content-Length, so it passed the integrity check and was promoted),
 * plus orphaned threads piling up across reconnects, resurrecting "stuck downloading" through the
 * reconnect path — the exact failure the caching fix was meant to eliminate.
 *
 * This coordinator makes background downloads reconnect-resilient:
 *  - SINGLE-FLIGHT per contentId: a reconnect's re-sweep never starts a second download for content
 *    already in flight. The in-flight fetch runs on its OWN OkHttp connection (independent of the
 *    socket), so a reconnect underneath it does not interrupt it — it CONTINUES and completes; if
 *    the network drop truncated it, ContentCache's partial detection discards the `.part` and it
 *    cleanly RESTARTS on a later sweep. Never orphaned, never a duplicate racing the `.part`.
 *  - BOUNDED executor: caps concurrent downloads (no thread pileup across reconnects); shutdown()
 *    cancels in-flight work so nothing orphans or pins the Activity.
 *  - BACKOFF with failure memory: a permanently-failing URL backs off exponentially instead of
 *    re-fetching every 60s forever (no retry storm). The screen keeps serving cached content
 *    (screen-resilience is untouched) and the CMS gets one "failed" ack, not a stuck "downloading".
 *
 * Atomic-swap + partial detection are ContentCache's job and are unchanged; this only guarantees a
 * SINGLE writer per `.part` so that guarantee can't be defeated by a concurrent duplicate.
 */
class DownloadCoordinator(
    private val cache: ContentCache,
    private val serverUrl: () -> String,
    private val socketAlive: () -> Boolean,
    private val onAck: (contentId: String, status: String) -> Unit,
    private val executor: ExecutorService = Executors.newFixedThreadPool(MAX_CONCURRENT),
    private val now: () -> Long = { SystemClock.elapsedRealtime() }
) {
    private val inFlight = Collections.synchronizedSet(HashSet<String>())
    private val attempts = ConcurrentHashMap<String, Int>()
    private val nextAttemptAt = ConcurrentHashMap<String, Long>()

    /**
     * Ensure [contentId] is (being) downloaded. Called for each local assignment on EVERY playlist
     * sweep — the 60s refresh and every post-reconnect re-register included. Idempotent and
     * non-blocking: it enqueues at most ONE download per contentId and returns immediately.
     */
    fun ensure(contentId: String, filename: String) {
        if (contentId.isEmpty()) return
        if (cache.isContentCached(contentId)) { DebugLog.v("DownloadCoordinator", "ensure($contentId): SEED-A cached -> ack ready"); onAck(contentId, "ready"); return } // already have it — re-ack (SEED-A)
        // Socket down => the WATCHDOG owns recovery; don't hammer downloads over a dead connection.
        if (!socketAlive()) { DebugLog.v("DownloadCoordinator", "ensure($contentId): socket not alive -> skip"); return }
        if (now() < (nextAttemptAt[contentId] ?: 0L)) { DebugLog.v("DownloadCoordinator", "ensure($contentId): in backoff until ${nextAttemptAt[contentId]} -> skip"); return }       // in failure backoff — don't storm
        if (!inFlight.add(contentId)) { DebugLog.v("DownloadCoordinator", "ensure($contentId): already inFlight -> skip"); return }                        // single-flight: already downloading
        DebugLog.v("DownloadCoordinator", "ensure($contentId): dispatching download '$filename'")
        try {
            executor.execute { runDownload(contentId, filename) }
        } catch (e: Throwable) {
            inFlight.remove(contentId)                              // executor rejected (shut down) — don't leak the guard
        }
    }

    private fun runDownload(contentId: String, filename: String) {
        try {
            val file = cache.downloadContent(serverUrl(), contentId, filename)
            if (file != null) {
                attempts.remove(contentId); nextAttemptAt.remove(contentId)
                // Ack only reaches a live socket; if it dropped, the reconnect's re-register clears
                // the ack set and the next sweep re-acks the now-cached file.
                if (socketAlive()) onAck(contentId, "ready")
            } else {
                onFailure(contentId) // includes a reconnect-truncated .part (ContentCache returned null)
            }
        } catch (e: Throwable) {
            Log.w("DownloadCoordinator", "download $contentId failed: ${e.message}")
            onFailure(contentId)
        } finally {
            inFlight.remove(contentId)
        }
    }

    private fun onFailure(contentId: String) {
        val n = (attempts[contentId] ?: 0) + 1
        attempts[contentId] = n
        val delay = minOf(BACKOFF_BASE_MS shl (n - 1).coerceIn(0, 20), BACKOFF_MAX_MS)
        nextAttemptAt[contentId] = now() + delay
        if (socketAlive()) onAck(contentId, "failed")
    }

    /** Content deleted server-side — drop download/backoff state so a re-add downloads fresh. */
    fun forget(contentId: String) {
        inFlight.remove(contentId); attempts.remove(contentId); nextAttemptAt.remove(contentId)
    }

    /**
     * Clear failure backoff for [contentId] WITHOUT touching single-flight (unlike forget()).
     * A genuine (re)assignment or a fresh network transition should retry a stuck item NOW instead
     * of waiting out a backoff that ballooned to the 5-min cap during the unstable first-boot window
     * (#170). Keeping inFlight means an in-progress download is never duplicated. No-op if not failing.
     */
    fun resetBackoff(contentId: String) {
        attempts.remove(contentId); nextAttemptAt.remove(contentId)
    }

    /** Clear ALL failure backoff (keep single-flight) — e.g. the network just (re)connected, so any
     *  item that backed off while the link was settling should re-attempt on the next sweep. */
    fun resetAllBackoff() {
        attempts.clear(); nextAttemptAt.clear()
    }

    /** Teardown (onDestroy): cancel in-flight downloads so none orphan or pin the Activity. */
    fun shutdown() {
        try { executor.shutdownNow() } catch (_: Throwable) {}
        inFlight.clear()
    }

    // test visibility
    internal fun isInFlight(contentId: String) = inFlight.contains(contentId)

    companion object {
        const val MAX_CONCURRENT = 3
        const val BACKOFF_BASE_MS = 15_000L
        const val BACKOFF_MAX_MS = 5 * 60_000L
    }
}
