package com.remotedisplay.player.data

import com.remotedisplay.player.player.PlaylistSelection
import com.remotedisplay.player.service.ConnectionGuard
import com.remotedisplay.player.service.LivenessWatchdog
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Reproduce-then-prove for the background-download × reconnect A-bucket bug. Drives the REAL
 * DownloadCoordinator + ContentCache against a local server that can be GATED (held mid-response)
 * so a download is genuinely in flight when a reconnect is simulated underneath it.
 */
class DownloadCoordinatorTest {
    private lateinit var dir: java.io.File
    private lateinit var cache: ContentCache
    private lateinit var executor: ExecutorService
    private lateinit var coord: DownloadCoordinator
    private var server: ServerSocket? = null

    private val requests = AtomicInteger(0)
    private val acks = Collections.synchronizedList(mutableListOf<String>()) // "id:status"
    @Volatile private var socketUp = true
    @Volatile private var clock = 0L
    private var baseUrl = ""

    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).callTimeout(4, TimeUnit.SECONDS).build()

    @Before fun setUp() {
        dir = Files.createTempDirectory("coord").toFile()
        cache = ContentCache(dir, client)
        executor = Executors.newFixedThreadPool(2)
        requests.set(0); acks.clear(); socketUp = true; clock = 0L
        coord = DownloadCoordinator(cache, { baseUrl }, { socketUp }, { c, s -> acks.add("$c:$s") }, executor, { clock })
    }

    @After fun tearDown() {
        try { coord.shutdown() } catch (_: Exception) {}
        try { executor.shutdownNow() } catch (_: Exception) {}
        server?.close(); dir.deleteRecursively()
    }

    // A server that accepts connections in a loop; each: counts, fires `arrived` on the 1st, awaits
    // `gate` (if any), then writes `respond` and closes. Multiple connections are accepted, so a
    // buggy DUPLICATE download shows up as requests==2.
    private fun serve(gate: CountDownLatch?, arrived: CountDownLatch?, respond: (OutputStream) -> Unit) {
        val s = ServerSocket(0); server = s; baseUrl = "http://127.0.0.1:${s.localPort}"
        Thread {
            try {
                while (!s.isClosed) {
                    val sock = s.accept()
                    if (requests.incrementAndGet() == 1) arrived?.countDown()
                    Thread {
                        try {
                            val r = sock.getInputStream().bufferedReader()
                            while (true) { val l = r.readLine() ?: break; if (l.isEmpty()) break }
                            gate?.await(5, TimeUnit.SECONDS)
                            respond(sock.getOutputStream()); sock.close()
                        } catch (_: Exception) {}
                    }.apply { isDaemon = true; start() }
                }
            } catch (_: Exception) {}
        }.apply { isDaemon = true; start() }
    }
    private fun full(body: String): (OutputStream) -> Unit = { o ->
        o.write("HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n".toByteArray()); o.write(body.toByteArray()); o.flush()
    }
    private fun status(line: String): (OutputStream) -> Unit = { o ->
        o.write("HTTP/1.1 $line\r\nContent-Length: 0\r\n\r\n".toByteArray()); o.flush()
    }
    private fun partFiles() = dir.listFiles { _, n -> n.endsWith(".part") }?.size ?: 0
    private fun await(l: CountDownLatch, what: String) = assertTrue("timeout waiting for $what", l.await(5, TimeUnit.SECONDS))
    private fun waitAck(key: String) { for (i in 0..60) { if (acks.contains(key)) return; Thread.sleep(100) }; fail("no ack '$key' (got $acks)") }

    // ===== THE REPRODUCE-THEN-PROVE: single-flight survives a reconnect mid-download =====
    @Test fun `reconnect mid-download starts NO duplicate — one request, in-flight fetch completes cleanly`() {
        val gate = CountDownLatch(1); val arrived = CountDownLatch(1)
        serve(gate, arrived, full("HELLObytes"))
        coord.ensure("X", "v.bin")                 // download starts, blocks on the gate — genuinely in flight
        await(arrived, "the download to reach the server")
        assertTrue("X is in flight", coord.isInFlight("X"))
        // SIMULATE THE RECONNECT: re-register drives more sweeps for the SAME content
        coord.ensure("X", "v.bin"); coord.ensure("X", "v.bin")
        Thread.sleep(300)                          // give any (buggy) duplicate time to connect
        assertEquals("single-flight: exactly ONE request despite reconnect re-sweeps", 1, requests.get())
        gate.countDown()                           // let the in-flight download finish on its own connection
        waitAck("X:ready")
        assertNotNull("the in-flight download completes and is cached (not orphaned/abandoned)", cache.getCachedFile("X"))
        assertEquals("no partial left", 0, partFiles())
        assertFalse("no longer in flight after completion", coord.isInFlight("X"))
    }

    // ===== partial safety: a reconnect-truncated download is detected + not swapped =====
    @Test fun `reconnect-truncated download is detected as partial, acked failed, never swapped`() {
        serve(null, null) { o -> // declares 100, sends 40 then closes — as a mid-fetch network drop would
            o.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n".toByteArray()); o.write(ByteArray(40)); o.flush()
        }
        coord.ensure("Y", "v.bin"); waitAck("Y:failed")
        assertNull("a truncated file must NOT be cached/swapped", cache.getCachedFile("Y"))
        assertEquals("no partial left behind", 0, partFiles())
    }

    // ===== permanent failure: backoff, no retry storm =====
    @Test fun `a permanently-failing download backs off instead of storming`() {
        serve(null, null, status("404 Not Found"))
        coord.ensure("Z", "v.bin"); waitAck("Z:failed")
        val after1 = requests.get()
        repeat(5) { coord.ensure("Z", "v.bin") }; Thread.sleep(300)  // clock unchanged -> within backoff
        assertEquals("within backoff, NO new attempts (no storm)", after1, requests.get())
        clock = 20_000                                              // past the first 15s backoff step
        coord.ensure("Z", "v.bin"); Thread.sleep(300)
        assertEquals("after backoff elapses, exactly one more attempt", after1 + 1, requests.get())
    }

    // ===== #170: resetBackoff retries a stuck item NOW (genuine reassignment / toggle-back) =====
    @Test fun `resetBackoff re-attempts a stuck item before the backoff elapses`() {
        serve(null, null, status("404 Not Found"))
        coord.ensure("R", "v.bin"); waitAck("R:failed")
        val after1 = requests.get()
        repeat(3) { coord.ensure("R", "v.bin") }; Thread.sleep(200)   // clock unchanged -> in backoff, skipped
        assertEquals("still in backoff -> no new attempt", after1, requests.get())
        coord.resetBackoff("R")                                      // a genuine (re)assignment clears backoff
        coord.ensure("R", "v.bin"); Thread.sleep(300)
        assertEquals("resetBackoff -> retries NOW despite the clock not advancing", after1 + 1, requests.get())
    }

    // ===== #170: resetAllBackoff clears every item (network just (re)connected) =====
    @Test fun `resetAllBackoff clears backoff for all items`() {
        serve(null, null, status("404 Not Found"))
        coord.ensure("A", "v.bin"); waitAck("A:failed")
        coord.ensure("B", "v.bin"); waitAck("B:failed")
        val after = requests.get()
        coord.ensure("A", "v.bin"); coord.ensure("B", "v.bin"); Thread.sleep(200)
        assertEquals("both in backoff -> no new attempts", after, requests.get())
        coord.resetAllBackoff()
        coord.ensure("A", "v.bin"); coord.ensure("B", "v.bin"); Thread.sleep(300)
        assertEquals("both re-attempt after resetAllBackoff", after + 2, requests.get())
    }

    // ===== socket-down DEFER (ownership: watchdog owns recovery) =====
    @Test fun `socket down defers the download to the reconnect, then downloads when back`() {
        serve(null, null, full("data"))
        socketUp = false
        coord.ensure("W", "v.bin"); Thread.sleep(300)
        assertEquals("no download while the socket is down", 0, requests.get())
        socketUp = true
        coord.ensure("W", "v.bin"); waitAck("W:ready")
        assertNotNull("downloads once the socket is back", cache.getCachedFile("W"))
    }

    // ===== teardown cancels in-flight work (no orphan / no Activity pin) =====
    @Test fun `shutdown cancels in-flight download and clears state`() {
        val gate = CountDownLatch(1); val arrived = CountDownLatch(1)
        serve(gate, arrived, full("data"))
        coord.ensure("Q", "v.bin"); await(arrived, "in-flight download")
        coord.shutdown()
        assertFalse("in-flight guard cleared on shutdown (no orphan)", coord.isInFlight("Q"))
        Thread.sleep(200)
        assertNull("nothing cached — the download was cancelled, not abandoned mid-promote", cache.getCachedFile("Q"))
    }

    // ===== 206 Partial Content is refused (never promoted as whole) =====
    @Test fun `a 206 partial-content response is refused, not promoted`() {
        serve(null, null) { o -> // 206 with a matching partial length would pass a naive byte-count check
            o.write("HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\n\r\n".toByteArray()); o.write("abc".toByteArray()); o.flush()
        }
        coord.ensure("P", "v.bin"); waitAck("P:failed")
        assertNull("a 206 partial must not be cached as complete", cache.getCachedFile("P"))
    }

    // ===== INTEGRATED RE-SOAK: playing -> bg download -> reconnect mid-download -> resume =====
    @Test fun `re-soak — one socket, no orphaned download, screen never blanks, download resumes`() {
        val onlyZeroReady: (Int) -> Boolean = { it == 0 } // item 0 cached & playing; item 1 downloading
        val threshold = LivenessWatchdog.thresholdMs(0.5)
        val gate = CountDownLatch(1); val arrived = CountDownLatch(1)
        serve(gate, arrived, full("item1data"))

        // playing item 0; item 1's background download is in flight
        coord.ensure("item1", "v.bin"); await(arrived, "item1 download")
        assertEquals("screen keeps playing item 0 (skips the still-downloading item 1)", 0,
            PlaylistSelection.nextPlayableIndex(2, 0, onlyZeroReady))

        // server goes silent -> watchdog fires (its own signal); screen must NOT blank
        assertTrue(LivenessWatchdog.isHalfOpen(armed = true, connected = true, silenceMs = 50_000, thresholdMs = threshold))
        assertEquals(PlaylistSelection.NonePlayable.KEEP_CURRENT, PlaylistSelection.whenNonePlayable(hasContentOnScreen = true))

        // watchdog reconnect -> exactly ONE socket via ConnectionGuard; the re-sweep does NOT dup the download
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = false, sameUrl = true, socketActive = false))
        coord.ensure("item1", "v.bin"); Thread.sleep(200)
        assertEquals("reconnect re-sweep did not orphan/duplicate the in-flight download", 1, requests.get())
        assertEquals("screen still shows item 0 across the reconnect", 0,
            PlaylistSelection.nextPlayableIndex(2, 0, onlyZeroReady))

        // download RESUMES (its own connection was never torn down) and completes cleanly
        gate.countDown(); waitAck("item1:ready")
        assertNotNull("item 1 downloaded (not orphaned) and is now swappable", cache.getCachedFile("item1"))
        assertFalse(coord.isInFlight("item1"))
        assertEquals("now both items ready -> screen advances to item 1 (only fully-valid content)", 1,
            PlaylistSelection.nextPlayableIndex(2, 0) { true })
    }
}
