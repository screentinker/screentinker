package com.remotedisplay.player.data

import android.content.Context
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * Root-2 caching fixes vs the "stuck downloading / frozen" bug:
 *  - a hard OVERALL [callTimeout] so a slow-drip/stalled download on a HEALTHY socket can't hang
 *    forever (the old client only had a per-read timeout, which a trickle never trips),
 *  - download to a `.part` temp + integrity-check via [CacheValidation] + atomic rename, so a
 *    truncated/interrupted body is NEVER promoted to the cache and played as if whole,
 *  - exact-prefix cache lookup that also excludes in-flight `.part` files.
 *
 * RESUME. Those fixes made a bad download safe; they did not make it possible. Every attempt began
 * at byte 0 and the `.part` was deleted on failure, so on a link that cannot carry a whole asset in
 * one unbroken call — a one-bar 5G site, the case this was reported from — the file NEVER lands.
 * The player then has nothing cached, and a screen with nothing cached shows the waiting state:
 * reported as "the screens go black instead of playing from cache", when the real failure was that
 * the cache could never be filled in the first place. Five minutes of transfer, discarded; back
 * off; five more minutes, discarded; forever.
 *
 * So an interrupted download now KEEPS its `.part` and the next attempt asks for the rest with a
 * Range header. Progress accumulates across attempts and across reboots instead of being thrown
 * away, which is the whole difference between "eventually plays" and "never plays".
 *
 * Two ways a resume could corrupt the cache, both closed:
 *  - the asset changed under us — `If-Range` with the stored validator makes the server answer 200
 *    with the whole body instead of a tail, and we restart from zero.
 *  - the `.part` is longer than the asset — the server answers 416 and we discard it.
 * The completeness check is unchanged in spirit but now counts TOTAL bytes on disk against the
 * total the server declared in Content-Range, not bytes received this attempt.
 *
 * The primary constructor takes the cache dir + client directly so the real download logic is
 * unit-testable (see ContentDownloadTest) against a local server without an Android Context; the
 * [Context] convenience constructor is what the app uses.
 */
class ContentCache internal constructor(
    private val cacheDir: File,
    private val client: OkHttpClient
) {
    constructor(context: Context) : this(
        File(context.filesDir, "content_cache").also { it.mkdirs() },
        defaultClient()
    )

    /**
     * What one download attempt achieved. The distinction that matters is [Partial] vs [Failed]:
     * an attempt that moved bytes onto disk is PROGRESS, and backing that off exponentially the way
     * a hard failure is backed off is what turns a slow site into a dead one.
     */
    sealed class Result {
        data class Done(val file: File) : Result()
        /** Bytes are on disk and the next attempt resumes from there. */
        data class Partial(val bytesOnDisk: Long, val totalBytes: Long, val progressed: Boolean) : Result()
        /** Nothing usable happened: refused, unreachable, or a stale partial we had to discard. */
        object Failed : Result()
    }

    fun getCachedFile(contentId: String): File? {
        // Match "<id>.<ext>" exactly: the trailing dot stops an id that PREFIXES another id from
        // cross-matching. `contains` rather than `endsWith` for the temp check because the resume
        // validator sidecar is "<id>.<ext>.part.tag" — it does not END with ".part", and returning
        // THAT as the cached asset would hand the player a short ETag file to play.
        val files = cacheDir.listFiles { _, name ->
            name.startsWith("$contentId.") &&
                !name.startsWith("$contentId$IMAGE_AS_VIDEO_VARIANT_SUFFIX") &&
                !name.contains(PART_SUFFIX) &&
                !name.endsWith(REV_SUFFIX)
        }
        val hit = files?.firstOrNull()?.takeIf { it.exists() && it.length() > 0 }
        com.remotedisplay.player.util.DebugLog.v("ContentCache", "getCachedFile($contentId): dir=${cacheDir.absolutePath} listFiles=${files?.size ?: -1} hit=${hit?.name}")
        return hit
    }

    /** Keep this optional clip separate from the still and accept it only for the server's revision. */
    fun getCachedImageAsVideoVariant(contentId: String, revision: Long): File? {
        if (revision <= 0L) return null
        val file = File(cacheDir, imageAsVideoVariantFilename(contentId, revision))
        return file.takeIf { it.isFile && it.length() > 0 && readRev(it) == revision }
    }

    fun isContentCached(contentId: String): Boolean {
        return getCachedFile(contentId) != null
    }

    /**
     * Cached AND holding the revision the playlist is asking for.
     *
     * The dashboard can replace an asset's bytes under a stable content id, which is the one way a
     * cached copy can be permanently wrong: the id does not change, the filename does not change,
     * and nothing about a plain existence check can tell. A panel would keep playing last month's
     * video until somebody deleted and re-added the item. Comparing the revision is what makes
     * "cached for offline" compatible with "and it still updates".
     *
     * A revision of 0 means the server never sent one (an older build): fall back to existence, so
     * an upgrade does not re-download the entire playlist over the link least able to afford it.
     */
    fun isContentCached(contentId: String, rev: Long): Boolean {
        val file = getCachedFile(contentId) ?: return false
        if (rev <= 0L) return true
        return readRev(file) == rev
    }

    private fun revFile(file: File) = File(file.absolutePath + REV_SUFFIX)

    private fun readRev(file: File): Long =
        try { revFile(file).takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull() ?: 0L }
        catch (e: Exception) { 0L }

    /**
     * Fetch (or continue fetching) [contentId]. Safe to call repeatedly: each call transfers what
     * the link allows and leaves the rest for the next one.
     */
    fun fetch(serverUrl: String, contentId: String, filename: String, rev: Long = 0L): Result {
        val ext = filename.substringAfterLast('.', "mp4")
        val cacheFilename = "$contentId.$ext"
        val url = "${serverUrl.trimEnd('/')}/api/content/$contentId/file" + (if (rev > 0L) "?rev=$rev" else "")
        return fetchUrl(url, filename, cacheFilename, rev)
    }

    fun fetchImageAsVideoVariant(url: String, contentId: String, revision: Long): Result {
        if (revision <= 0L) return Result.Failed
        val filename = imageAsVideoVariantFilename(contentId, revision)
        val result = fetchUrl(url, filename, filename, revision)
        if (result is Result.Done) deleteStaleImageAsVideoVariants(contentId, revision)
        return result
    }

    private fun fetchUrl(url: String, filename: String, cacheFilename: String, rev: Long): Result {
        val finalFile = File(cacheDir, cacheFilename)
        val partFile = File(cacheDir, "$cacheFilename$PART_SUFFIX")
        val tagFile = File(cacheDir, "$cacheFilename$PART_SUFFIX$TAG_SUFFIX")

        // Only resume when we also hold the validator that was current when those bytes were
        // fetched. Without it there is no way to know the asset is still the same one, and a silent
        // splice of two files is worse than re-downloading.
        val validator = readValidator(tagFile)
        val resumeFrom = if (validator != null && partFile.exists()) partFile.length() else 0L
        if (resumeFrom == 0L) { partFile.delete(); tagFile.delete() }

        try {
            // The revision rides in the URL as well as in the sidecar, preventing intermediary
            // caches from serving bytes from an earlier variant revision.
            val builder = Request.Builder().url(url)
            if (resumeFrom > 0) {
                builder.header("Range", "bytes=$resumeFrom-")
                builder.header("If-Range", validator!!)
            }

            // .use closes the Response (and its body) on every path — also fixes the prior
            // error-path body/connection leak.
            client.newCall(builder.build()).execute().use { response ->
                // Our partial is at or past the end of the asset: it belongs to something else, or
                // to a truncated earlier life of this file. Discard and start clean next time.
                if (response.code == 416) {
                    Log.w("ContentCache", "Server refused resume at $resumeFrom for $filename (416) — discarding stale partial")
                    partFile.delete(); tagFile.delete()
                    return Result.Failed
                }
                if (!response.isSuccessful) {
                    Log.e("ContentCache", "Download failed: ${response.code}")
                    // The partial is kept: a 5xx or a captive-portal interception says nothing about
                    // the bytes we already hold.
                    return if (resumeFrom > 0) Result.Partial(resumeFrom, -1L, false) else Result.Failed
                }
                val body = response.body ?: return Result.Failed

                val appendAt: Long
                val total: Long
                if (response.code == 206) {
                    // Content-Length on a 206 is the length of the CHUNK, so the only trustworthy
                    // source for the full size is the total in Content-Range.
                    val range = parseContentRange(response.header("Content-Range"))
                    if (range == null || range.first != resumeFrom || range.second <= 0L) {
                        // A 206 we cannot verify, or one starting somewhere we did not ask for.
                        // Appending it blind would corrupt the file at exactly the byte count that
                        // makes it look complete.
                        Log.e("ContentCache", "Unusable 206 for $filename (Content-Range=${response.header("Content-Range")}, wanted $resumeFrom) — restarting")
                        partFile.delete(); tagFile.delete()
                        return Result.Failed
                    }
                    appendAt = resumeFrom
                    total = range.second
                    if (!tagFile.exists()) writeValidator(tagFile, response.header("ETag") ?: response.header("Last-Modified"))
                } else {
                    // 200. Either we sent no Range, or If-Range told the server the asset changed
                    // and it sent the whole thing instead of a tail. Both mean: start from zero.
                    if (resumeFrom > 0) Log.i("ContentCache", "Asset changed under a resume for $filename — restarting from 0")
                    appendAt = 0L
                    partFile.delete()
                    total = body.contentLength()   // -1 when unknown (chunked)
                    writeValidator(tagFile, response.header("ETag") ?: response.header("Last-Modified"))
                }

                var onDisk = appendAt
                try {
                    body.byteStream().use { input ->
                        FileOutputStream(partFile, appendAt > 0).use { output ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                output.write(buf, 0, n)
                                onDisk += n
                            }
                            output.flush()
                            // Durable, so a power cut on a signage panel costs the last buffer
                            // rather than the whole partial. These are big files on bad links; the
                            // sync is cheap next to re-fetching 200MB.
                            try { output.fd.sync() } catch (_: Exception) {}
                        }
                    }

                } catch (e: Exception) {
                    // The break we now RECOVER from instead of restarting after. Includes the read
                    // timeout (a stalled stream) and the call timeout (a slow drip that ran out of
                    // its attempt budget) — on a bad link these are the normal case, not the
                    // exception, and everything written so far stays.
                    Log.i("ContentCache", "Download interrupted for $filename at ${partFile.length()} bytes (${e.message})")
                    return partialOrDiscard(partFile, tagFile, partFile.length(), total, resumeFrom)
                }

                // Total bytes on disk against the declared total — NOT bytes received this attempt,
                // which on a resume is only the tail.
                if (!CacheValidation.isComplete(onDisk, total)) {
                    Log.i("ContentCache", "Incomplete after this attempt ($onDisk/$total) for $filename")
                    return partialOrDiscard(partFile, tagFile, onDisk, total, resumeFrom)
                }

                finalFile.delete()
                if (!partFile.renameTo(finalFile)) {
                    Log.e("ContentCache", "Rename failed for $filename")
                    partFile.delete(); tagFile.delete()
                    return Result.Failed
                }
                tagFile.delete()
                // Record WHICH revision these bytes are, so a later replace is detectable. Written
                // after the rename: a revision marker next to a file that is not there yet would
                // claim a cached asset that does not exist.
                try {
                    if (rev > 0L) revFile(finalFile).writeText(rev.toString()) else revFile(finalFile).delete()
                } catch (e: Exception) { /* the file is still usable; worst case it re-downloads */ }
                Log.i("ContentCache", "Downloaded: $filename -> ${finalFile.absolutePath} ($onDisk bytes)")
                return Result.Done(finalFile)
            }
        } catch (e: Exception) {
            // Connect-time failures (no route, DNS, TLS) — nothing was transferred, so whatever is
            // already on disk is still valid to resume from. This also catches a throw from closing
            // the response after a partial body, which is why `progressed` is measured against the
            // bytes on disk rather than assumed false: an attempt that advanced must not be
            // reported as a stall just because the connection objected on the way out.
            Log.e("ContentCache", "Download error: ${e.message}")
            val kept = partFile.length()
            return if (kept > 0) partialOrDiscard(partFile, tagFile, kept, -1L, resumeFrom) else Result.Failed
        }
    }

    private fun imageAsVideoVariantFilename(contentId: String, revision: Long) =
        "$contentId$IMAGE_AS_VIDEO_VARIANT_SUFFIX$revision.mp4"

    private fun deleteStaleImageAsVideoVariants(contentId: String, keepRevision: Long) {
        val prefix = "$contentId$IMAGE_AS_VIDEO_VARIANT_SUFFIX"
        cacheDir.listFiles { _, name ->
            name.startsWith(prefix) &&
                name.removePrefix(prefix).substringBefore(".mp4").toLongOrNull()?.let { it < keepRevision } == true
        }?.forEach { it.delete() }
    }

    /**
     * 3.0 site cache: fetch [contentId] from the LAN cache box by its sha256 and keep it ONLY if the
     * bytes hash to the digest the ORIGIN gave us (never one the box claims). One short attempt, no
     * resume — a LAN either moves the file or the box is not worth waiting for — and every failure
     * is [Result.Failed] so the caller goes to the origin exactly as before.
     *
     * Uses its own `.site.part`, never the origin download's `.part`: a half-finished origin resume
     * must survive a failed LAN attempt untouched.
     */
    fun fetchFromSiteCache(site: SiteCacheConfig, entry: SiteCacheConfig.Entry, contentId: String, filename: String, rev: Long = 0L): Result {
        val ext = filename.substringAfterLast('.', "mp4")
        val finalFile = File(cacheDir, "$contentId.$ext")
        val sitePart = File(cacheDir, "$contentId.$ext$PART_SUFFIX$SITE_SUFFIX")
        sitePart.delete()
        try {
            val req = Request.Builder()
                .url("${site.baseUrl}/cache/${entry.sha256}")
                .header("Authorization", "Bearer ${site.token}")
                .build()
            siteClient.newCall(req).execute().use { response ->
                if (response.code != 200) {
                    Log.i("ContentCache", "Site cache answered ${response.code} for $filename — using the origin")
                    return Result.Failed
                }
                val body = response.body ?: return Result.Failed
                val digest = java.security.MessageDigest.getInstance("SHA-256")
                var n = 0L
                body.byteStream().use { input ->
                    FileOutputStream(sitePart).use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val r = input.read(buf)
                            if (r < 0) break
                            n += r
                            // More than promised is not this asset; stop rather than fill the disk.
                            if (n > entry.size) throw java.io.IOException("longer than the manifest says")
                            digest.update(buf, 0, r)
                            output.write(buf, 0, r)
                        }
                        output.flush()
                        try { output.fd.sync() } catch (_: Exception) {}
                    }
                }
                val hex = digest.digest().joinToString("") { "%02x".format(it) }
                if (n != entry.size || hex != entry.sha256) {
                    Log.w("ContentCache", "Site cache bytes for $filename did not match their sha256 — discarded, using the origin")
                    sitePart.delete()
                    return Result.Failed
                }
                finalFile.delete()
                if (!sitePart.renameTo(finalFile)) { sitePart.delete(); return Result.Failed }
                try {
                    if (rev > 0L) revFile(finalFile).writeText(rev.toString()) else revFile(finalFile).delete()
                } catch (_: Exception) { /* still usable */ }
                Log.i("ContentCache", "From site cache: $filename ($n bytes, sha256 verified)")
                return Result.Done(finalFile)
            }
        } catch (e: Exception) {
            Log.i("ContentCache", "Site cache unavailable for $filename (${e.message}) — using the origin")
            sitePart.delete()
            return Result.Failed
        }
    }

    /** Complete-or-nothing wrapper: returns the cached file only when the asset is whole. */
    fun downloadContent(serverUrl: String, contentId: String, filename: String, rev: Long = 0L): File? =
        (fetch(serverUrl, contentId, filename, rev) as? Result.Done)?.file

    fun deleteContent(contentId: String) {
        // Exact-prefix (with the dot) so we don't delete a different id's file — and this also
        // sweeps the "<id>.<ext>.part" temp and its ".part.tag" validator.
        cacheDir.listFiles { _, name -> name.startsWith("$contentId.") }?.forEach { it.delete() }
        Log.i("ContentCache", "Deleted cached content: $contentId")
    }

    fun clearAll() {
        cacheDir.listFiles()?.forEach { it.delete() }
    }

    fun getCacheSize(): Long {
        return cacheDir.listFiles()?.sumOf { it.length() } ?: 0L
    }

    /**
     * Report an unfinished attempt — keeping the bytes only if the NEXT attempt can build on them.
     *
     * Without a validator there is no safe resume, so the partial is dead weight: the next attempt
     * would restart from zero, re-fetch the same prefix, and land in exactly the same place. Worse,
     * counting that as progress would make the coordinator chain attempts against a link that is
     * getting nowhere. Discard it and report no progress, so it backs off like the failure it is.
     */
    private fun partialOrDiscard(partFile: File, tagFile: File, onDisk: Long, total: Long, resumeFrom: Long): Result {
        if (!tagFile.exists()) {
            partFile.delete()
            return Result.Partial(0L, total, false)
        }
        return Result.Partial(onDisk, total, onDisk > resumeFrom)
    }

    private fun readValidator(tagFile: File): String? =
        try { if (tagFile.exists()) tagFile.readText().trim().ifEmpty { null } else null } catch (_: Exception) { null }

    private fun writeValidator(tagFile: File, value: String?) {
        // No validator (a server that sends neither ETag nor Last-Modified) means no safe resume:
        // leave the sidecar absent and the next attempt starts over rather than splicing blind.
        try { if (value.isNullOrBlank()) tagFile.delete() else tagFile.writeText(value) } catch (_: Exception) {}
    }

    /*
     * The LAN fetch gets SHORT timeouts of its own: a box that does not answer within seconds is
     * down, and every second spent on it is a second the origin download has not started.
     */
    private val siteClient: OkHttpClient by lazy {
        client.newBuilder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(10, TimeUnit.MINUTES)
            .followRedirects(false)
            .build()
    }

    companion object {
        private const val PART_SUFFIX = ".part"
        private const val TAG_SUFFIX = ".tag"
        private const val REV_SUFFIX = ".rev"
        private const val IMAGE_AS_VIDEO_VARIANT_SUFFIX = ".image-as-video-variant-"
        private const val SITE_SUFFIX = ".site"

        /**
         * "bytes <start>-<end>/<total>" -> (start, total). Null for anything else, including the
         * "*" total a server may send, which gives us nothing to validate completeness against.
         */
        internal fun parseContentRange(header: String?): Pair<Long, Long>? {
            val m = Regex("""^\s*bytes\s+(\d+)-(\d+)/(\d+)\s*$""").find(header ?: return null) ?: return null
            val start = m.groupValues[1].toLongOrNull() ?: return null
            val total = m.groupValues[3].toLongOrNull() ?: return null
            return start to total
        }

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)   // Root-2: a stalled stream (no bytes 30s) aborts (was 5min)
            .writeTimeout(30, TimeUnit.SECONDS)
            // Root-2 gave this a hard OVERALL cap so a slow drip could not hang forever. With resume
            // it caps ONE ATTEMPT rather than the whole asset: a link that only manages 20MB per
            // call now keeps those 20MB and continues, where before the cap was the reason a large
            // file could never finish.
            .callTimeout(5, TimeUnit.MINUTES)
            .build()
    }
}
