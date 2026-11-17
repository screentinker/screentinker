package com.remotedisplay.player.trigger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.InputStream

/** GHSA-rvxj 7.3: the unauthenticated HTTP trigger door's request-head limits. */
class HttpRequestLimitsTest {
    private val never = Long.MAX_VALUE
    private fun s(text: String): InputStream = BufferedInputStream(ByteArrayInputStream(text.toByteArray()))

    @Test fun `a normal GET parses, headers lowercased, body left on the stream`() {
        val input = s("POST /trigger HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc\r\nContent-Length: 13\r\n\r\nST1 sec token")
        val h = HttpRequestLimits.readHead(input, never, { 0L })!!
        assertEquals("POST /trigger HTTP/1.1", h.requestLine)
        assertEquals("Bearer abc", h.headers["authorization"])
        assertEquals(13, h.contentLength)
        val body = ByteArray(13); val n = input.read(body)
        assertEquals("ST1 sec token", String(body, 0, n))
    }

    @Test fun `bare LF line endings still work (hand-built AMX strings)`() {
        val h = HttpRequestLimits.readHead(s("GET /?m=ST1%20a%20b HTTP/1.0\nHost: x\n\n"), never, { 0L })!!
        assertEquals("GET /?m=ST1%20a%20b HTTP/1.0", h.requestLine)
        assertEquals("x", h.headers["host"])
    }

    @Test fun `empty connection is null, like readLine`() {
        assertNull(HttpRequestLimits.readHead(s(""), never, { 0L }))
    }

    @Test fun `an endless request line is refused`() {
        val endless = object : InputStream() { override fun read() = 'A'.code }
        try { HttpRequestLimits.readHead(endless, never, { 0L }); fail() } catch (e: HttpRequestLimits.TooLarge) { }
    }

    @Test fun `an endless header list is refused`() {
        val sb = StringBuilder("GET / HTTP/1.1\r\n")
        repeat(HttpRequestLimits.MAX_HEADER_LINES + 1) { sb.append("X-$it: y\r\n") }
        sb.append("\r\n")
        try { HttpRequestLimits.readHead(s(sb.toString()), never, { 0L }); fail() } catch (e: HttpRequestLimits.TooLarge) { }
    }

    @Test fun `only the first 32 headers are kept`() {
        val sb = StringBuilder("GET / HTTP/1.1\r\n")
        repeat(40) { sb.append("X-$it: y\r\n") }
        sb.append("\r\n")
        assertEquals(32, HttpRequestLimits.readHead(s(sb.toString()), never, { 0L })!!.headers.size)
    }

    @Test fun `a slow sender is cut off at the deadline`() {
        var clock = 0L
        val slow = object : InputStream() { override fun read(): Int { clock += 1000; return 'A'.code } }
        try { HttpRequestLimits.readHead(slow, 5_000L, { clock }); fail() } catch (e: HttpRequestLimits.TooLarge) { }
        assertTrue(clock <= 6_000L)
    }
}
