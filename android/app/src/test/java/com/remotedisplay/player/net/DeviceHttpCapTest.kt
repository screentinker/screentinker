package com.remotedisplay.player.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * The response cap.
 *
 * ⚠️ IT IS A READ LIMIT, NOT A CONTENT-LENGTH CHECK, and that distinction is the test. Trusting
 * Content-Length would be trusting the thing we were pointed at — a hostile or merely broken
 * endpoint can declare 10 bytes and send gigabytes, or declare nothing at all under chunked
 * encoding. A panel has a few hundred MB of heap and a job to do: a 2 GB response must cost it
 * 64 KiB and a truncation flag, not an OOM in the middle of playback.
 */
class DeviceHttpCapTest {

    @Test
    fun readsASmallBodyWhole() {
        val (text, truncated) = DeviceHttp.readCapped(ByteArrayInputStream("""{"temp":21.5}""".toByteArray()))
        assertEquals("""{"temp":21.5}""", text)
        assertFalse(truncated)
    }

    @Test
    fun nullBodyIsEmptyNotACrash() {
        val (text, truncated) = DeviceHttp.readCapped(null)
        assertEquals("", text)
        assertFalse(truncated)
    }

    @Test
    fun stopsAtTheCapAndSaysSo() {
        val big = ByteArray(DeviceHttp.MAX_BODY_BYTES * 3) { 'a'.code.toByte() }
        val (text, truncated) = DeviceHttp.readCapped(ByteArrayInputStream(big))
        assertEquals(DeviceHttp.MAX_BODY_BYTES, text.toByteArray().size)
        assertTrue("a body larger than the cap must report truncated", truncated)
    }

    @Test
    fun exactlyAtTheCapIsNotTruncated() {
        // The honest edge: read == cap alone does not mean there was more, so the flag comes from
        // one extra read rather than from the count.
        val exact = ByteArray(DeviceHttp.MAX_BODY_BYTES) { 'b'.code.toByte() }
        val (text, truncated) = DeviceHttp.readCapped(ByteArrayInputStream(exact))
        assertEquals(DeviceHttp.MAX_BODY_BYTES, text.toByteArray().size)
        assertFalse("a body that is exactly the cap is complete, not truncated", truncated)
    }

    @Test
    fun oneByteOverTheCapIsTruncated() {
        val over = ByteArray(DeviceHttp.MAX_BODY_BYTES + 1) { 'c'.code.toByte() }
        val (_, truncated) = DeviceHttp.readCapped(ByteArrayInputStream(over))
        assertTrue(truncated)
    }

    @Test
    fun aStreamThatNeverEndsStillCostsOnlyTheCap() {
        /*
         * The case Content-Length cannot protect against: an endpoint that just keeps sending. The
         * read must terminate at the cap rather than filling the heap.
         */
        val endless = object : InputStream() {
            override fun read(): Int = 'x'.code
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                java.util.Arrays.fill(b, off, off + len, 'x'.code.toByte())
                return len
            }
        }
        val (text, truncated) = DeviceHttp.readCapped(endless)
        assertEquals(DeviceHttp.MAX_BODY_BYTES, text.toByteArray().size)
        assertTrue(truncated)
    }

    @Test
    fun aStreamThatThrowsMidWayKeepsWhatItGot() {
        // A dropped connection half way through is still worth reporting: the operator sees what
        // arrived instead of an empty snippet and no clue.
        val flaky = object : InputStream() {
            private var served = 0
            override fun read(): Int = -1
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (served >= 10) throw java.io.IOException("connection reset")
                java.util.Arrays.fill(b, off, off + 10, 'z'.code.toByte())
                served += 10
                return 10
            }
        }
        val (text, truncated) = DeviceHttp.readCapped(flaky)
        assertEquals("zzzzzzzzzz", text)
        assertFalse(truncated)
    }

    @Test
    fun theCapIs64KiB() {
        // Pinned because it is quoted in the docs, in the OpenAPI description and in the dashboard.
        assertEquals(64 * 1024, DeviceHttp.MAX_BODY_BYTES)
    }
}
