package com.remotedisplay.player.trigger

import java.io.IOException
import java.io.InputStream

/**
 * The HTTP trigger door's resource limits (GHSA-rvxj 7.3), kept pure so they test on the JVM.
 *
 * ⚠️ EVERYTHING HERE RUNS BEFORE THE SECRET IS CHECKED. The socket is unauthenticated, so whatever it
 * costs to read a request is a cost anyone on the LAN can impose. Before this, each accepted socket got
 * its own thread with no cap, and the request line and headers went through BufferedReader.readLine(),
 * which grows a line without limit and loops headers forever; the 5 s soTimeout resets on every byte,
 * so a slow sender held a thread and a growing buffer indefinitely. Now:
 *
 *  - at most [MAX_CLIENTS] requests are handled at once; the next socket is closed on accept,
 *  - a line longer than [MAX_LINE_BYTES] or more than [MAX_HEADER_LINES] headers aborts the request,
 *  - the whole request head must arrive within [REQUEST_DEADLINE_MS].
 *
 * Real senders (AMX/Extron/Crestron, curl, the web dashboard's test button) send one short request
 * line and a handful of headers, nowhere near any of these.
 */
object HttpRequestLimits {
    const val MAX_CLIENTS = 8
    const val MAX_LINE_BYTES = 8 * 1024
    const val MAX_HEADER_LINES = 64
    const val REQUEST_DEADLINE_MS = 10_000L

    class TooLarge(msg: String) : IOException(msg)

    /**
     * One CRLF- or LF-terminated line, decoded as UTF-8 (what BufferedReader did before), without the
     * terminator. Null at EOF before any byte, like readLine(). Reads byte by byte, so callers must
     * pass a buffered stream and use the SAME stream for the body.
     */
    fun readLine(input: InputStream, maxBytes: Int, deadlineMs: Long, now: () -> Long): String? {
        val buf = java.io.ByteArrayOutputStream(128)
        var any = false
        while (true) {
            if (now() > deadlineMs) throw TooLarge("request head not received in time")
            val b = input.read()
            if (b < 0) return if (any) finish(buf) else null
            any = true
            if (b == '\n'.code) return finish(buf)
            if (buf.size() >= maxBytes) throw TooLarge("header line over $maxBytes bytes")
            buf.write(b)
        }
    }

    private fun finish(buf: java.io.ByteArrayOutputStream): String {
        val s = String(buf.toByteArray(), Charsets.UTF_8)
        return if (s.endsWith('\r')) s.substring(0, s.length - 1) else s
    }

    data class Head(val requestLine: String, val headers: Map<String, String>, val contentLength: Int)

    /**
     * Request line + headers. Header names lowercased; the first [keepHeaders] are kept (the control
     * door reads Authorization), the rest are read and dropped up to [MAX_HEADER_LINES], past which the
     * request is refused. Null at EOF before a request line.
     */
    fun readHead(input: InputStream, deadlineMs: Long, now: () -> Long, keepHeaders: Int = 32): Head? {
        val requestLine = readLine(input, MAX_LINE_BYTES, deadlineMs, now) ?: return null
        var contentLength = 0
        val headers = HashMap<String, String>()
        var count = 0
        while (true) {
            val h = readLine(input, MAX_LINE_BYTES, deadlineMs, now) ?: break
            if (h.isEmpty()) break
            if (++count > MAX_HEADER_LINES) throw TooLarge("more than $MAX_HEADER_LINES headers")
            if (h.startsWith("Content-Length:", true)) {
                contentLength = h.substringAfter(':').trim().toIntOrNull() ?: 0
            }
            val c = h.indexOf(':')
            if (c > 0 && headers.size < keepHeaders) {
                headers[h.substring(0, c).trim().lowercase()] = h.substring(c + 1).trim()
            }
        }
        return Head(requestLine, headers, contentLength)
    }
}
