package com.remotedisplay.player.data

import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * The offline store for flattened HTML bundles, driven against a REAL local HTTP server — same
 * approach as ContentDownloadTest next door, and for the same reason: a cache tested against a mock
 * proves the mock behaves.
 *
 * ⚠️ THE CLAIM UNDER TEST IS "IT STILL PLAYS WITH THE SERVER GONE". That is not something you can
 * assert by reading the code, so every test here either serves bytes and then kills the server, or
 * checks the revision rule that decides whether a cached copy may be used at all.
 */
class BundleCacheTest {

    private lateinit var dir: java.io.File
    private lateinit var cache: BundleCache
    private var server: ServerSocket? = null

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build()

    private val HTML = "<!doctype html><h1>bundle</h1><script src=\"data:text/javascript;base64,AA==\"></script>"

    @Before fun setUp() {
        dir = Files.createTempDirectory("bundle-cache").toFile()
        cache = BundleCache(dir, client)
    }

    @After fun tearDown() {
        try { server?.close() } catch (e: Exception) { }
        dir.deleteRecursively()
    }

    /** Serve [body] to the next N requests, then stop answering. Returns the base URL. */
    private fun serve(body: String, times: Int = 99): String {
        val s = ServerSocket(0)
        server = s
        Thread {
            var served = 0
            try {
                while (served < times) {
                    val sock = s.accept()
                    served++
                    sock.getInputStream().read(ByteArray(4096))
                    val out = sock.getOutputStream()
                    val bytes = body.toByteArray()
                    out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${bytes.size}\r\n\r\n").toByteArray())
                    out.write(bytes)
                    out.flush()
                    sock.close()
                }
            } catch (e: Exception) { /* closed */ }
        }.also { it.isDaemon = true }.start()
        return "http://127.0.0.1:${s.localPort}"
    }

    @Test fun `fetch stores the render and it reads back`() {
        val base = serve(HTML)
        val got = cache.fetch(base, "c1", 7L)
        assertEquals(HTML, got)
        assertTrue(cache.isCached("c1", 7L))
        assertEquals(HTML, cache.cachedHtml("c1", 7L))
    }

    @Test fun `THE POINT - a cached bundle still reads back after the server is gone`() {
        val base = serve(HTML)
        cache.fetch(base, "c1", 7L)
        server?.close()          // the WAN is now down, which is the whole scenario
        assertEquals(HTML, cache.cachedHtml("c1", 7L))

        /*
         * ...and a fetch attempt fails cleanly rather than throwing into the player.
         *
         * ⚠️ AIMED AT A PORT NOTHING CAN RECLAIM, not at the one we just closed. serve() takes an
         * ephemeral port, and once it is released anything else on the machine may bind it: on a
         * busy CI runner this assert saw a live socket on the recycled port, the fetch succeeded,
         * and the job went red with no code change (observed once on 5f13c40, green on re-run).
         * Port 9 is discard/unassigned and privileged, so nothing can be listening on it, which is
         * the condition the test actually means by "the server is gone".
         */
        assertNull(cache.fetch("http://127.0.0.1:9", "c1", 8L))
    }

    @Test fun `a different revision is a MISS, not a stale hit`() {
        /*
         * The id, the filename and the URL are all identical after a replace — content_rev is the
         * only thing that can tell a panel its copy is out of date. A cache keyed on id alone would
         * serve the previous bundle for ever, which is the exact bug ContentCache's .rev sidecar
         * exists to prevent.
         */
        val base = serve(HTML)
        cache.fetch(base, "c1", 7L)
        assertTrue(cache.isCached("c1", 7L))
        assertFalse(cache.isCached("c1", 8L))
        assertNull(cache.cachedHtml("c1", 8L))
    }

    @Test fun `a new revision reclaims the old one`() {
        val base = serve(HTML)
        cache.fetch(base, "c1", 7L)
        cache.fetch(base, "c1", 8L)
        assertTrue(cache.isCached("c1", 8L))
        assertFalse("the superseded revision should have been deleted", cache.isCached("c1", 7L))
    }

    @Test fun `pruneToPlaylist drops bundles that left the playlist and keeps the rest`() {
        val base = serve(HTML)
        cache.fetch(base, "keep", 1L)
        cache.fetch(base, "drop", 1L)
        cache.pruneToPlaylist(setOf("keep"))
        assertTrue(cache.isCached("keep", 1L))
        assertFalse(cache.isCached("drop", 1L))
    }

    @Test fun `delete removes every revision of one bundle`() {
        val base = serve(HTML)
        cache.fetch(base, "c1", 1L)
        cache.fetch(base, "c2", 1L)
        cache.delete("c1")
        assertFalse(cache.isCached("c1", 1L))
        assertTrue("deleting one bundle must not touch another", cache.isCached("c2", 1L))
    }

    @Test fun `an unreachable server yields null rather than throwing`() {
        // No server at all: the player must degrade to "no cached copy", not crash the render path.
        val dead = "http://127.0.0.1:1"
        assertNull(cache.fetch(dead, "c1", 1L))
        assertNull(cache.cachedHtml("c1", 1L))
    }

    @Test fun `a half-written render is never readable as a whole one`() {
        /*
         * fetch writes to "<name>.part" and renames. A reader must never see the partial file — a
         * truncated document renders as a blank page, which looks exactly like a working cache and
         * is the failure ContentCache's complete-or-nothing rule was written for.
         */
        java.io.File(dir, BundleCache.fileName("c9", 3L) + ".part").writeText("<!doctype html><h1>hal")
        assertFalse(cache.isCached("c9", 3L))
        assertNull(cache.cachedHtml("c9", 3L))
    }

    @Test fun `the superseded-name rule only matches this bundle`() {
        // Guards the glob directly: an id that PREFIXES another id must not cross-match.
        assertTrue(BundleCache.isSupersededName("abc.1.html", "abc", 2L))
        assertFalse(BundleCache.isSupersededName("abc.2.html", "abc", 2L))
        assertFalse(BundleCache.isSupersededName("abcdef.1.html", "abc", 2L))
        assertFalse(BundleCache.isSupersededName("abc.1.html.part", "abc", 2L))
    }
}
