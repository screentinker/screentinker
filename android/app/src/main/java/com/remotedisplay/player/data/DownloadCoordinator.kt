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
    private val now: () -> Long = { SystemClock.elapsedRealtime() },
    /** 3.0 site cache: the LAN box from the latest payload, or null (docs/site-cache.md). */
    private val siteCache: () -> SiteCacheConfig? = { null }
) {
    /* A content id the box failed for is not tried there again for a while: the origin has it. */
    private val siteSkipUntil = ConcurrentHashMap<String, Long>()

    private val inFlight = Collections.synchronizedSet(HashSet<String>())
    private val attempts = ConcurrentHashMap<String, Int>()
    private val nextAttemptAt = ConcurrentHashMap<String, Long>()
    private val imageAsVideoVariantInFlight = Collections.synchronizedSet(HashSet<String>())
    private val imageAsVideoVariantAttempts = ConcurrentHashMap<String, Int>()
    private val imageAsVideoVariantNextAttemptAt = ConcurrentHashMap<String, Long>()

    /**
     * Ensure [contentId] is (being) downloaded. Called for each local assignment on EVERY playlist
     * sweep — the 60s refresh and every post-reconnect re-register included. Idempotent and
     * non-blocking: it enqueues at most ONE download per contentId and returns immediately.
     */
    fun ensure(contentId: String, filename: String, rev: Long = 0L) {
        if (contentId.isEmpty()) return
        if (cache.isContentCached(contentId, rev)) { DebugLog.v("DownloadCoordinator", "ensure($contentId): SEED-A cached -> ack ready"); onAck(contentId, "ready"); return } // already have it — re-ack (SEED-A)
        // Socket down => the WATCHDOG owns recovery; don't hammer downloads over a dead connection.
        if (!socketAlive()) { DebugLog.v("DownloadCoordinator", "ensure($contentId): socket not alive -> skip"); return }
        if (now() < (nextAttemptAt[contentId] ?: 0L)) { DebugLog.v("DownloadCoordinator", "ensure($contentId): in backoff until ${nextAttemptAt[contentId]} -> skip"); return }       // in failure backoff — don't storm
        if (!inFlight.add(contentId)) { DebugLog.v("DownloadCoordinator", "ensure($contentId): already inFlight -> skip"); return }                        // single-flight: already downloading
        DebugLog.v("DownloadCoordinator", "ensure($contentId): dispatching download '$filename'")
        try {
            executor.execute { runDownload(contentId, filename, rev) }
        } catch (e: Throwable) {
            inFlight.remove(contentId)                              // executor rejected (shut down) — don't leak the guard
        }
    }

    /**
     * Cache an optional server-generated image-as-video variant. It has its own cache identity and
     * failure state: it must neither replace the original image nor affect its content ack.
     */
    fun ensureImageAsVideoVariant(contentId: String, revision: Long, url: String, onReady: (java.io.File) -> Unit) {
        if (contentId.isEmpty() || revision <= 0L) return
        cache.getCachedImageAsVideoVariant(contentId, revision)?.let { onReady(it); return }
        val key = "$contentId:$revision"
        if (!socketAlive()) return
        if (now() < (imageAsVideoVariantNextAttemptAt[key] ?: 0L)) return
        if (!imageAsVideoVariantInFlight.add(key)) return
        try {
            executor.execute {
                try {
                    var link = 0
                    while (link < MAX_RESUME_CHAIN) {
                        link++
                        when (val result = cache.fetchImageAsVideoVariant(url, contentId, revision)) {
                            is ContentCache.Result.Done -> {
                                imageAsVideoVariantAttempts.remove(key)
                                imageAsVideoVariantNextAttemptAt.remove(key)
                                onReady(result.file)
                                return@execute
                            }
                            is ContentCache.Result.Partial -> {
                                if (!result.progressed) {
                                    backoffImageAsVideoVariant(key)
                                    return@execute
                                }
                            }
                            is ContentCache.Result.Failed -> {
                                backoffImageAsVideoVariant(key)
                                return@execute
                            }
                        }
                    }
                    imageAsVideoVariantNextAttemptAt[key] = now() + RESUME_HANDBACK_MS
                } catch (e: Exception) {
                    Log.w("DownloadCoordinator", "image-as-video variant download $contentId@$revision failed: ${e.message}")
                    backoffImageAsVideoVariant(key)
                } finally {
                    imageAsVideoVariantInFlight.remove(key)
                }
            }
        } catch (e: Exception) {
            imageAsVideoVariantInFlight.remove(key)
            Log.w("DownloadCoordinator", "could not schedule image-as-video variant download $contentId@$revision: ${e.message}")
        }
    }

    private fun backoffImageAsVideoVariant(key: String) {
        val n = (imageAsVideoVariantAttempts[key] ?: 0) + 1
        imageAsVideoVariantAttempts[key] = n
        val delay = minOf(BACKOFF_BASE_MS shl (n - 1).coerceIn(0, 20), BACKOFF_MAX_MS)
        imageAsVideoVariantNextAttemptAt[key] = now() + delay
    }

    /**
     * Run attempts back-to-back for as long as each one is putting bytes on disk.
     *
     * A site whose link only carries part of an asset per call needs many attempts to finish one
     * file. Handing each attempt back to the 60s playlist sweep would stretch a 200MB video over
     * hours of mostly-idle waiting, and running to the exponential backoff would stretch it to
     * never — which is the failure this whole change is about. Progress is the signal: keep going
     * while bytes are landing, stop the moment one attempt achieves nothing.
     *
     * inFlight is held across the whole chain, so this is still exactly one writer per `.part` and
     * a concurrent sweep still finds the item busy rather than starting a duplicate.
     */
    private fun runDownload(contentId: String, filename: String, rev: Long) {
        try {
            // 3.0 site cache first: verified against the origin's sha256, and any failure simply
            // falls through to the origin path below, unchanged.
            val site = try { siteCache() } catch (_: Throwable) { null }
            val entry = site?.entryFor(contentId)
            if (site != null && entry != null && now() >= (siteSkipUntil[contentId] ?: 0L)) {
                if (cache.fetchFromSiteCache(site, entry, contentId, filename, rev) is ContentCache.Result.Done) {
                    attempts.remove(contentId); nextAttemptAt.remove(contentId); siteSkipUntil.remove(contentId)
                    if (socketAlive()) onAck(contentId, "ready")
                    return
                }
                siteSkipUntil[contentId] = now() + SITE_SKIP_MS
            }
            var link = 0
            while (link < MAX_RESUME_CHAIN) {
                link++
                val result = cache.fetch(serverUrl(), contentId, filename, rev)
                when (result) {
                    is ContentCache.Result.Done -> {
                        attempts.remove(contentId); nextAttemptAt.remove(contentId)
                        // Ack only reaches a live socket; if it dropped, the reconnect's re-register
                        // clears the ack set and the next sweep re-acks the now-cached file.
                        if (socketAlive()) onAck(contentId, "ready")
                        return
                    }
                    is ContentCache.Result.Partial -> {
                        if (!result.progressed) {
                            // Bytes are held but this attempt added none: the link is down rather
                            // than slow, so back off properly instead of spinning on it.
                            onFailure(contentId)
                            return
                        }
                        DebugLog.v("DownloadCoordinator", "resume $contentId: ${result.bytesOnDisk}/${result.totalBytes} after attempt $link")
                        // Deliberately NOT acked as failed. A download that is advancing is not a
                        // failure, and telling the CMS otherwise is what put items in the dashboard
                        // showing "failed" while they were in fact still arriving.
                    }
                    is ContentCache.Result.Failed -> { onFailure(contentId); return }
                }
            }
            // Still going when the chain ran out. Not a failure — hand it back to the next sweep
            // with a short, FIXED delay rather than the exponential one, so a large asset over a
            // slow link keeps advancing instead of decaying into the 5-minute cap.
            nextAttemptAt[contentId] = now() + RESUME_HANDBACK_MS
            DebugLog.v("DownloadCoordinator", "resume chain exhausted for $contentId — continuing on the next sweep")
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
        val prefix = "$contentId:"
        imageAsVideoVariantAttempts.keys.removeAll { it.startsWith(prefix) }
        imageAsVideoVariantNextAttemptAt.keys.removeAll { it.startsWith(prefix) }
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
        imageAsVideoVariantAttempts.clear(); imageAsVideoVariantNextAttemptAt.clear()
    }

    /** Teardown (onDestroy): cancel in-flight downloads so none orphan or pin the Activity. */
    fun shutdown() {
        try { executor.shutdownNow() } catch (_: Throwable) {}
        inFlight.clear()
        imageAsVideoVariantInFlight.clear()
    }

    // test visibility
    internal fun isInFlight(contentId: String) = inFlight.contains(contentId)

    companion object {
        const val MAX_CONCURRENT = 3
        const val BACKOFF_BASE_MS = 15_000L
        const val BACKOFF_MAX_MS = 5 * 60_000L
        /**
         * Consecutive resuming attempts before the item goes back on the sweep. Bounded so one
         * enormous asset on a slow link cannot hold an executor slot indefinitely and starve the
         * other two items in a playlist — with a 5-minute attempt cap this is still up to an hour
         * of continuous transfer per dispatch.
         */
        const val MAX_RESUME_CHAIN = 12
        const val RESUME_HANDBACK_MS = 5_000L
        /** After the site cache failed for an item, the origin serves it for this long. */
        const val SITE_SKIP_MS = 10 * 60_000L
    }
}
