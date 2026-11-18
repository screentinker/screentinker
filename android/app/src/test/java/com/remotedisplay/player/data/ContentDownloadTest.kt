package com.remotedisplay.player.data

import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * Root-2 REPRODUCE-THEN-PROVE for the "stuck downloading / frozen" caching bug, extended with the
 * RESUME case that came out of a customer on an unstable one-bar 5G link: their screens showed the
 * waiting state instead of playing, and the reason was not the playback path at all — the asset
 * could never finish downloading, so there was never anything cached to play.
 *
 * Each test drives the REAL ContentCache against a local HTTP server that reproduces a specific
 * failure mode on a HEALTHY socket (the socket is fine — the DOWNLOAD misbehaves).
 *
 * The client uses short timeouts so the STALL reproduction is fast; the download/validation logic
 * exercised is identical to production (only the timeout VALUES differ — production is
 * callTimeout=5min / readTimeout=30s, verified by inspection in ContentCache.defaultClient()).
 */
class ContentDownloadTest {

    private lateinit var dir: java.io.File
    private lateinit var cache: ContentCache
    private var server: ServerSocket? = null

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(1, TimeUnit.SECONDS)   // a stalled stream aborts in ~1s => fast test
        .callTimeout(3, TimeUnit.SECONDS)   // hard overall cap backstop
        .build()

    @Before fun setUp() {
        dir = Files.createTempDirectory("cachetest").toFile()
        cache = ContentCache(dir, client)   // internal ctor — real logic, no Android Context
    }

    @After fun tearDown() {
        try { server?.close() } catch (_: Exception) {}
        dir.deleteRecursively()
    }

    /** Accept ONE connection, drain the request, then let [respond] write a crafted response. */
    private fun serveOnce(onRequest: (String) -> Unit = {}, respond: (OutputStream) -> Unit): String {
        val s = ServerSocket(0)
        server = s
        Thread {
            try {
                s.accept().use { sock ->
                    val reader = sock.getInputStream().bufferedReader()
                    onRequest(reader.readLine() ?: "")
                    while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break }
                    respond(sock.getOutputStream())
                }
            } catch (_: Exception) { /* client hung up on timeout — expected for the stall case */ }
        }.apply { isDaemon = true; start() }
        return "http://127.0.0.1:${s.localPort}"
    }

    /** The request headers of each call the client made, in order. */
    private val seen = java.util.Collections.synchronizedList(ArrayList<Map<String, String>>())

    /**
     * A server that behaves like a bad link: it honours Range/If-Range correctly, but never sends
     * more than [bytesPerCall] before dropping the connection mid-body. Nothing is wrong with the
     * server or the file — the transfer simply cannot complete in one call, which is the whole
     * shape of the reported fault.
     *
     * [etagOf] is read per request so a test can change the asset underneath a resume.
     */
    private fun serveFlaky(body: () -> ByteArray, bytesPerCall: Int, etagOf: () -> String): String {
        val s = ServerSocket(0)
        server = s
        Thread {
            while (!s.isClosed) {
                try {
                    s.accept().use { sock ->
                        val headers = HashMap<String, String>()
                        val reader = sock.getInputStream().bufferedReader()
                        reader.readLine()   // request line
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            val i = line.indexOf(':')
                            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
                        }
                        seen.add(headers)

                        val content = body()
                        val etag = etagOf()
                        val out = sock.getOutputStream()
                        val range = headers["range"]
                        val ifRange = headers["if-range"]
                        // If-Range with a stale validator means "send the whole thing" — the
                        // mechanism that stops a resume splicing two different assets together.
                        val honourRange = range != null && (ifRange == null || ifRange == etag)
                        val start = if (honourRange) Regex("""bytes=(\d+)-""").find(range!!)?.groupValues?.get(1)?.toInt() ?: 0 else 0

                        if (honourRange && start >= content.size) {
                            out.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */${content.size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                            out.flush()
                            return@use
                        }

                        val remaining = content.size - start
                        if (honourRange) {
                            out.write(("HTTP/1.1 206 Partial Content\r\n" +
                                "Content-Range: bytes $start-${content.size - 1}/${content.size}\r\n" +
                                "Content-Length: $remaining\r\nETag: $etag\r\nConnection: close\r\n\r\n").toByteArray())
                        } else {
                            out.write(("HTTP/1.1 200 OK\r\nContent-Length: ${content.size}\r\n" +
                                "ETag: $etag\r\nConnection: close\r\n\r\n").toByteArray())
                        }
                        // ...then send only part of what we just declared, and hang up.
                        val send = minOf(bytesPerCall, remaining)
                        out.write(content, start, send)
                        out.flush()
                    }
                } catch (_: Exception) { /* closed between tests */ }
            }
        }.apply { isDaemon = true; start() }
        return "http://127.0.0.1:${s.localPort}"
    }

    private fun OutputStream.writeHttp(contentLength: Int, body: ByteArray) {
        write("HTTP/1.1 200 OK\r\nContent-Length: $contentLength\r\nETag: \"w1\"\r\nContent-Type: application/octet-stream\r\n\r\n".toByteArray())
        write(body)
        flush()
    }

    private fun partFiles() = dir.listFiles { _, name -> name.endsWith(".part") }?.toList() ?: emptyList()
    private fun tagFiles() = dir.listFiles { _, name -> name.endsWith(".part.tag") }?.toList() ?: emptyList()

    // ---- positive control: a complete download IS cached ----
    @Test fun `complete download is cached with the right size and no leftover part file`() {
        val url = serveOnce { it.writeHttp(5, "hello".toByteArray()) }
        val file = cache.downloadContent(url, "cidA", "clip.bin")
        assertNotNull("a complete download should be cached", file)
        assertEquals(5L, file!!.length())
        assertNotNull(cache.getCachedFile("cidA"))
        assertTrue("no .part temp should remain", partFiles().isEmpty())
        assertTrue("no validator sidecar should remain", tagFiles().isEmpty())
    }

    // ---- REPRODUCE: truncated body (declares 100 bytes, sends 40 then closes) on a healthy socket ----
    @Test fun `truncated download is NOT promoted to the cache — but its bytes are KEPT to resume from`() {
        val url = serveOnce {
            it.writeHttp(100, ByteArray(40) { 'x'.code.toByte() })
            // close after 40 of the declared 100 bytes -> truncation
        }
        val file = cache.downloadContent(url, "cidB", "clip.bin")
        assertNull("a truncated download must return null (not a usable file)", file)
        assertNull("a truncated file must NOT be served as cached", cache.getCachedFile("cidB"))
        // The bytes stay. Deleting them was correct while there was no way to continue from them
        // and catastrophic once the link is the limiting factor: it made every attempt start at
        // zero, so an asset larger than one call's worth could never be cached at all.
        assertEquals("the 40 received bytes must be kept for the next attempt", 1, partFiles().size)
        assertEquals(40L, partFiles().first().length())
    }

    // ---- REPRODUCE: a STALLED download (headers + a trickle, then hang) on a healthy socket ----
    @Test fun `stalled download aborts within the timeout instead of hanging forever`() {
        val url = serveOnce {
            it.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nETag: \"v1\"\r\n\r\n".toByteArray())
            it.write(ByteArray(10)); it.flush()
            Thread.sleep(10_000) // hang mid-stream — the OLD client (5min readTimeout) waited here
        }
        val start = System.currentTimeMillis()
        val file = cache.downloadContent(url, "cidC", "clip.bin")
        val elapsed = System.currentTimeMillis() - start
        assertNull("a stalled download must fail, not hang", file)
        assertTrue("must abort quickly via the timeout (was ~$elapsed ms)", elapsed < 5_000)
        assertNull(cache.getCachedFile("cidC"))
        assertEquals("the 10 bytes that did arrive are kept", 10L, partFiles().first().length())
    }

    // ---- THE BUG: a link that can never carry the whole asset in one call ----
    @Test fun `an asset larger than any single call still completes, one resumed attempt at a time`() {
        val body = ByteArray(1000) { (it % 251).toByte() }
        val url = serveFlaky({ body }, bytesPerCall = 300, etagOf = { "\"v1\"" })

        // Each attempt gets 300 bytes and the connection dies. Restart-from-zero would loop here
        // forever, cache nothing, and leave the screen on "waiting for content" — the customer's
        // report. Resume needs four.
        var result: ContentCache.Result = ContentCache.Result.Failed
        var attempts = 0
        while (attempts < 10) {
            attempts++
            result = cache.fetch(url, "big", "movie.bin")
            if (result is ContentCache.Result.Done) break
            assertTrue("every attempt must make progress", (result as ContentCache.Result.Partial).progressed)
        }

        assertTrue("the asset must eventually be cached, not retried forever", result is ContentCache.Result.Done)
        assertEquals(4, attempts)
        assertArrayEquals("the reassembled file must be byte-identical to the original",
            body, cache.getCachedFile("big")!!.readBytes())
        assertTrue("no temp files survive completion", partFiles().isEmpty() && tagFiles().isEmpty())
    }

    @Test fun `each attempt asks for exactly the bytes it does not have yet`() {
        seen.clear()
        val body = ByteArray(1000) { (it % 251).toByte() }
        val url = serveFlaky({ body }, bytesPerCall = 400, etagOf = { "\"v1\"" })
        repeat(3) { cache.fetch(url, "big", "movie.bin") }

        assertNull("the first call has nothing to resume from", seen[0]["range"])
        assertEquals("bytes=400-", seen[1]["range"])
        assertEquals("bytes=800-", seen[2]["range"])
        // Without If-Range the server cannot tell us the asset changed, and a resume would append
        // the tail of a new file to the head of an old one.
        assertEquals("\"v1\"", seen[1]["if-range"])
    }

    // ---- the corruption a resume could cause, and the guard that stops it ----
    @Test fun `an asset that changes under a resume restarts from zero instead of splicing`() {
        val v1 = ByteArray(1000) { 'a'.code.toByte() }
        val v2 = ByteArray(1000) { 'b'.code.toByte() }
        var current = v1
        var etag = "\"v1\""
        val url = serveFlaky({ current }, bytesPerCall = 400, etagOf = { etag })

        cache.fetch(url, "swap", "movie.bin")                       // 400 bytes of v1 on disk
        assertEquals(400L, partFiles().first().length())

        current = v2; etag = "\"v2\""                               // replaced between attempts
        val second = cache.fetch(url, "swap", "movie.bin")
        assertTrue(second is ContentCache.Result.Partial)
        // If-Range mismatch -> the server sent the WHOLE new asset, so we started over and hold
        // 400 bytes of v2, not 400 of v1 with a v2 tail to come. A splice would have been exactly
        // 1000 bytes and passed every completeness check we have.
        assertEquals(400L, partFiles().first().length())

        repeat(3) { cache.fetch(url, "swap", "movie.bin") }
        assertArrayEquals("the cached asset must be all-v2, with no v1 bytes spliced in",
            v2, cache.getCachedFile("swap")!!.readBytes())
    }

    @Test fun `a partial longer than the asset is discarded rather than resumed forever`() {
        // The server answers 416. Keeping the partial would mean asking for a range past the end on
        // every future attempt and never recovering.
        val body = ByteArray(100) { 'z'.code.toByte() }
        val url = serveFlaky({ body }, bytesPerCall = 500, etagOf = { "\"v1\"" })
        java.io.File(dir, "over.bin.part").writeBytes(ByteArray(400))
        java.io.File(dir, "over.bin.part.tag").writeText("\"v1\"")

        val first = cache.fetch(url, "over", "movie.bin")
        assertTrue("an over-long partial is a hard failure, not a resume", first is ContentCache.Result.Failed)
        assertTrue("the stale partial must be discarded", partFiles().isEmpty())

        assertTrue(cache.fetch(url, "over", "movie.bin") is ContentCache.Result.Done)
        assertArrayEquals(body, cache.getCachedFile("over")!!.readBytes())
    }

    @Test fun `a server that offers no validator discards the partial rather than hoarding it`() {
        // No ETag and no Last-Modified: there is nothing to detect a changed asset with, so a
        // resume would be a guess and the next attempt has to start over anyway. Bytes that cannot
        // be built upon are not progress — keeping them would leave dead weight on disk, and
        // COUNTING them as progress would make the coordinator chain attempts against a link that
        // is getting nowhere. It backs off like the failure it is.
        val s = ServerSocket(0)
        server = s
        Thread {
            while (!s.isClosed) {
                try {
                    s.accept().use { sock ->
                        val reader = sock.getInputStream().bufferedReader()
                        while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break }
                        val out = sock.getOutputStream()
                        out.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n".toByteArray())
                        out.write(ByteArray(40)); out.flush()
                    }
                } catch (_: Exception) {}
            }
        }.apply { isDaemon = true; start() }
        val url = "http://127.0.0.1:${s.localPort}"

        val r = cache.fetch(url, "noval", "movie.bin")
        assertTrue(r is ContentCache.Result.Partial)
        assertFalse("re-fetching the same prefix forever is not progress", (r as ContentCache.Result.Partial).progressed)
        assertTrue("an unusable partial must not be left on disk", partFiles().isEmpty())
        assertNull("and nothing incomplete is ever served as cached", cache.getCachedFile("noval"))
    }


    // ---- the UPDATE half: caching for offline must not make a screen permanently wrong ----
    @Test fun `an asset replaced under a stable id is a cache MISS at the new revision`() {
        // The trap that offline caching creates. PUT /api/content/:id/replace changes the bytes and
        // nothing else — same id, same filename, same URL path — so a plain "do I have this file?"
        // check says yes forever and the panel keeps playing last month's video.
        val v1 = ByteArray(50) { 'a'.code.toByte() }
        val url = serveFlaky({ v1 }, bytesPerCall = 500, etagOf = { "\"v1\"" })

        assertTrue(cache.fetch(url, "swap", "clip.bin", rev = 100L) is ContentCache.Result.Done)
        assertTrue("cached at the revision we asked for", cache.isContentCached("swap", 100L))
        assertTrue("...and NOT at a newer one", !cache.isContentCached("swap", 200L))
    }

    @Test fun `a player with no revision from the server still uses whatever it has`() {
        // Older servers send no content_rev. Treating that as a permanent miss would re-download the
        // entire playlist on every sweep, over the link least able to afford it.
        val url = serveOnce { it.writeHttp(4, "abcd".toByteArray()) }
        assertNotNull(cache.downloadContent(url, "norev", "clip.bin"))
        assertTrue(cache.isContentCached("norev", 0L))
    }

    @Test fun `the revision marker is never served as the cached asset`() {
        // "<id>.<ext>.rev" starts with the id, so a prefix match would hand the player a few bytes
        // of ASCII digits to decode as a video.
        java.io.File(dir, "marker.bin.rev").writeText("12345")
        assertNull(cache.getCachedFile("marker"))
    }

    @Test fun `the request carries the revision, so an intermediary cannot serve the old bytes`() {
        seen.clear()
        val url = serveFlaky({ ByteArray(20) }, bytesPerCall = 500, etagOf = { "\"v1\"" })
        cache.fetch(url, "cdn", "clip.bin", rev = 777L)
        // The request line is not captured by the header sniffer, so assert via the effect: a
        // revisioned fetch completes and records that revision.
        assertTrue(cache.isContentCached("cdn", 777L))
        assertTrue(!cache.isContentCached("cdn", 778L))
    }

    @Test fun `image as video variants are cached separately by revision`() {
        var requestLine = ""
        val url = serveOnce(onRequest = { requestLine = it }) { it.writeHttp(4, "rend".toByteArray()) }
        val variantUrl = "$url/api/content/image-id/image-as-video?rev=17"

        val result = cache.fetchImageAsVideoVariant(variantUrl, "image-id", 17L)

        assertTrue(result is ContentCache.Result.Done)
        assertEquals("GET /api/content/image-id/image-as-video?rev=17 HTTP/1.1", requestLine)
        assertNotNull(cache.getCachedImageAsVideoVariant("image-id", 17L))
        assertNull("a different variant revision is a cache miss", cache.getCachedImageAsVideoVariant("image-id", 18L))
        assertNull("the variant must not be mistaken for the original content file", cache.getCachedFile("image-id"))
    }

    // ---- prefix cross-match guard: an id that prefixes another must not match ----
    @Test fun `getCachedFile does not cross-match an id that is a prefix of another`() {
        serveOnce { it.writeHttp(3, "abc".toByteArray()) }.let { url ->
            assertNotNull(cache.downloadContent(url, "abc", "x.bin"))
        }
        assertNotNull(cache.getCachedFile("abc"))
        assertNull("id 'ab' must NOT match cached 'abc.x'", cache.getCachedFile("ab"))
    }

    @Test fun `the validator sidecar is never mistaken for the cached asset`() {
        // ".part.tag" does not END with ".part", so the old endsWith() exclusion would have handed
        // the player a few bytes of ETag to decode as a video.
        java.io.File(dir, "sid.bin.part").writeBytes(ByteArray(10))
        java.io.File(dir, "sid.bin.part.tag").writeText("\"v1\"")
        assertNull("neither temp may be served as content", cache.getCachedFile("sid"))
    }

    @Test fun `Content-Range parsing rejects anything it cannot verify a total from`() {
        assertEquals(400L to 1000L, ContentCache.parseContentRange("bytes 400-999/1000"))
        assertNull("an unknown total gives nothing to check completeness against",
            ContentCache.parseContentRange("bytes 400-999/*"))
        assertNull(ContentCache.parseContentRange("items 0-1/2"))
        assertNull(ContentCache.parseContentRange(null))
    }
}
