package com.remotedisplay.player.data

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * On-disk store for the server's flattened HTML-bundle renders.
 *
 * ⚠️ WHY THE RENDER AND NOT THE ARCHIVE. [ContentCache] already downloads a bundle's `.zip` like
 * any other asset — and nothing on this player can open one. What actually goes on screen is the
 * server's single self-contained document at `/api/content/:id/bundle`, a different URL that the
 * media cache has never heard of. Without this, a bundle plays only while the server is reachable,
 * on a product whose entire promise is that a screen keeps working when it is not.
 *
 * ⚠️ AND IT LIVES IN ITS OWN DIRECTORY, NOT IN content_cache. `ContentCache.getCachedFile` globs
 * `"<id>."` and returns the first hit that exists and is non-empty; a render file sitting next to
 * the media would satisfy that glob and be handed to ExoPlayer as if it were a video. Its
 * `deleteContent` is also a plain `File.delete()`, which fails silently on a directory. Separate
 * directory, separate lifecycle, no chance of the two being confused.
 *
 * Keyed by content id AND revision: a replaced archive gets a new `content_rev`, so a stale render
 * can never be served for new bytes. Superseded revisions are deleted as soon as a newer one lands.
 */
class BundleCache internal constructor(
    private val dir: File,
    private val client: OkHttpClient,
) {
    constructor(context: Context) : this(
        File(context.filesDir, "bundle_render").also { it.mkdirs() },
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build(),
    )

    companion object {
        /** Refuse anything implausible for a single document — the server caps its own inlining
         *  well below this, so hitting it means something is wrong rather than merely large. */
        const val MAX_RENDER_BYTES = 24L * 1024 * 1024

        /** The one place the on-disk name is decided, so the reader and the pruner cannot disagree. */
        fun fileName(contentId: String, rev: Long): String = "$contentId.$rev.html"

        /** True when [name] belongs to [contentId] but a DIFFERENT revision — i.e. reclaimable. */
        fun isSupersededName(name: String, contentId: String, keepRev: Long): Boolean =
            name.startsWith("$contentId.") && name.endsWith(".html") && name != fileName(contentId, keepRev)
    }

    private fun fileFor(contentId: String, rev: Long) = File(dir, fileName(contentId, rev))

    /** The cached document for this exact revision, or null. */
    fun cachedHtml(contentId: String, rev: Long): String? {
        val f = fileFor(contentId, rev)
        return try {
            if (f.exists() && f.length() > 0) f.readText() else null
        } catch (e: Exception) {
            Log.w("BundleCache", "unreadable render for $contentId@$rev: ${e.message}")
            null
        }
    }

    fun isCached(contentId: String, rev: Long): Boolean = fileFor(contentId, rev).let { it.exists() && it.length() > 0 }

    /**
     * Fetch and store the render. Blocking — call it off the main thread.
     *
     * Writes to a temp file and renames, so a half-written document is never readable as a whole
     * one: the same complete-or-nothing rule ContentCache follows, and for the same reason — a
     * truncated page renders as a blank screen that looks exactly like a working cache.
     */
    fun fetch(serverUrl: String, contentId: String, rev: Long): String? {
        val url = "$serverUrl/api/content/$contentId/bundle?rev=$rev"
        return try {
            client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                if (!res.isSuccessful) {
                    Log.w("BundleCache", "fetch $contentId@$rev -> HTTP ${res.code}")
                    return null
                }
                val body = res.body ?: return null
                val len = body.contentLength()
                if (len > MAX_RENDER_BYTES) {
                    Log.w("BundleCache", "render for $contentId is ${len}B, over the cap")
                    return null
                }
                val html = body.string()
                if (html.isEmpty()) return null
                val tmp = File(dir, "${fileName(contentId, rev)}.part")
                tmp.writeText(html)
                if (!tmp.renameTo(fileFor(contentId, rev))) {
                    tmp.delete()
                    Log.w("BundleCache", "could not promote render for $contentId@$rev")
                    return html            // usable now even though it did not persist
                }
                pruneOldRevisions(contentId, rev)
                html
            }
        } catch (e: Exception) {
            Log.w("BundleCache", "fetch failed for $contentId@$rev: ${e.message}")
            null
        }
    }

    /** Drop every other revision of this bundle. */
    fun pruneOldRevisions(contentId: String, keepRev: Long) {
        try {
            dir.listFiles { _, name -> isSupersededName(name, contentId, keepRev) }
                ?.forEach { it.delete() }
        } catch (e: Exception) { /* reclaim is best-effort */ }
    }

    /** Everything for this content id — called when the server says the content was deleted. */
    fun delete(contentId: String) {
        try {
            dir.listFiles { _, name -> name.startsWith("$contentId.") }?.forEach { it.delete() }
        } catch (e: Exception) { /* best effort */ }
    }

    /** Drop renders for content ids that are no longer in the playlist. */
    fun pruneToPlaylist(keepContentIds: Set<String>) {
        try {
            dir.listFiles()?.forEach { f ->
                val id = f.name.substringBefore('.')
                if (id.isNotEmpty() && !keepContentIds.contains(id)) f.delete()
            }
        } catch (e: Exception) { /* best effort */ }
    }
}
