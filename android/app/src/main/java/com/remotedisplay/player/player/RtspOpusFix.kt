package com.remotedisplay.player.player

import java.io.BufferedInputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap

/**
 * ⚠️ media3's RTP Opus reader cannot play standard RTP Opus, and one Opus track takes the whole
 * stream down with it.
 *
 * RtpOpusReader (media3 1.2.1, unchanged upstream as of 2026-10) treats the stream like an Ogg
 * file: it expects the first RTP packet to be an "OpusHead" ID header and the second an "OpusTags"
 * comment header. RFC 7587 RTP Opus sends neither, every packet is audio, so the reader throws "ID
 * Header missing" on the first packet and the load error ends playback of the video too. UniFi
 * Protect cameras offer Opus beside AAC, so every UniFi stream failed this way on Android.
 *
 * The fix rides the socket media3 is given (RtspSources), since media3 offers no way to replace a
 * payload reader:
 *  - the camera's SDP (the DESCRIBE answer) says which tracks are Opus and with how many channels;
 *  - media3's SETUP requests say which interleaved channel each of those tracks arrives on;
 *  - just before the first packet on such a channel, two RTP packets are put in front of it, with
 *    the next-lower sequence numbers and the same timestamp: a standard OpusHead (RFC 7845 5.1:
 *    version 1, the SDP's channel count, 48 kHz, no gain, mapping family 0) and an empty OpusTags.
 * The reader then finds what it expects and plays the real packets that follow as audio. Nothing
 * else in the stream is touched.
 *
 * Pure JVM (no Android types), so it runs as a unit test.
 */
object RtspOpusFix {
    /** An Opus track of the camera's SDP: its control (relative or absolute) and channel count. */
    data class OpusTrack(val control: String, val channels: Int)

    /** The media sections of [sdp] whose only codec is Opus. */
    fun opusTracks(sdp: String): List<OpusTrack> {
        val sections = mutableListOf<MutableList<String>>()
        for (raw in sdp.split('\n')) {
            val l = raw.trimEnd('\r')
            if (l.startsWith("m=")) sections.add(mutableListOf())
            sections.lastOrNull()?.add(l)
        }
        return sections.mapNotNull { sec ->
            val payloads = sec.first().split(' ').drop(3).filter { it.isNotEmpty() }
            val maps = sec.filter { it.startsWith("a=rtpmap:", ignoreCase = true) }.associate {
                val rest = it.substring("a=rtpmap:".length)
                rest.substringBefore(' ') to rest.substringAfter(' ', "")
            }
            val opus = payloads.isNotEmpty() && payloads.all { maps[it]?.substringBefore('/')?.equals("opus", ignoreCase = true) == true }
            val control = sec.firstOrNull { it.startsWith("a=control:", ignoreCase = true) }?.substring("a=control:".length)?.trim()
            if (!opus || control.isNullOrEmpty()) return@mapNotNull null
            val channels = maps[payloads.first()]?.split('/')?.getOrNull(2)?.trim()?.toIntOrNull()?.coerceIn(1, 2) ?: 2
            OpusTrack(control, channels)
        }
    }

    /** Whether a SETUP request for [url] is for the track whose SDP control is [control]. */
    fun matchesControl(url: String, control: String): Boolean {
        if (control.contains("://")) return url.substringBefore('?').trimEnd('/') == control.substringBefore('?').trimEnd('/')
        return Regex("(^|/)" + Regex.escape(control) + "($|[/?])").containsMatchIn(url)
    }

    /** RFC 7845 5.1 identification header: 19 bytes. */
    fun opusHead(channels: Int): ByteArray {
        val b = ByteArray(19)
        "OpusHead".toByteArray(Charsets.US_ASCII).copyInto(b, 0)
        b[8] = 1                                   // version
        b[9] = channels.toByte()
        val preSkip = 312                          // libopus' usual encoder delay (samples at 48 kHz)
        b[10] = (preSkip and 0xff).toByte(); b[11] = (preSkip shr 8).toByte()
        val rate = 48_000
        for (i in 0 until 4) b[12 + i] = (rate shr (8 * i)).toByte()
        // [16..17] output gain 0, [18] channel mapping family 0 (mono/stereo)
        return b
    }

    /** RFC 7845 5.2 comment header with no vendor string and no comments: 16 bytes. */
    fun opusTags(): ByteArray = "OpusTags".toByteArray(Charsets.US_ASCII) + ByteArray(8)

    /**
     * The two interleaved frames to put in front of [frame] (a whole `$` frame holding the track's
     * first RTP packet): OpusHead and OpusTags as RTP packets with sequence numbers first-2 and
     * first-1, and the same payload type, timestamp and SSRC. Empty when [frame] is not RTP.
     */
    fun headerFrames(frame: ByteArray, channels: Int): ByteArray {
        if (frame.size < 4 + 12) return ByteArray(0)
        val rtp = 4
        if ((frame[rtp].toInt() and 0xc0) != 0x80) return ByteArray(0)   // RTP version 2
        val pt = frame[rtp + 1].toInt() and 0x7f
        val seq = ((frame[rtp + 2].toInt() and 0xff) shl 8) or (frame[rtp + 3].toInt() and 0xff)
        fun packet(seqNo: Int, payload: ByteArray): ByteArray {
            val p = ByteArray(12 + payload.size)
            p[0] = 0x80.toByte()
            p[1] = pt.toByte()
            p[2] = (seqNo shr 8).toByte(); p[3] = seqNo.toByte()
            frame.copyInto(p, 4, rtp + 4, rtp + 12)                       // timestamp + SSRC
            payload.copyInto(p, 12)
            val f = ByteArray(4 + p.size)
            f[0] = '$'.code.toByte(); f[1] = frame[1]
            f[2] = (p.size shr 8).toByte(); f[3] = p.size.toByte()
            p.copyInto(f, 4)
            return f
        }
        return packet((seq - 2) and 0xffff, opusHead(channels)) + packet((seq - 1) and 0xffff, opusTags())
    }

    /** What both directions of one connection have learned. */
    class State {
        @Volatile var tracks: List<OpusTrack> = emptyList()
        val channelCounts = ConcurrentHashMap<Int, Int>()      // interleaved channel -> Opus channels
        val primed = ConcurrentHashMap.newKeySet<Int>()

        /** A whole request media3 sent: a SETUP for an Opus track maps its interleaved channel. */
        fun onRequest(head: String) {
            if (!head.startsWith("SETUP ")) return
            val url = head.substringAfter(' ').substringBefore(' ')
            val track = tracks.firstOrNull { matchesControl(url, it.control) } ?: return
            val transport = head.lineSequence().firstOrNull { it.startsWith("transport:", ignoreCase = true) } ?: return
            val ch = Regex("""interleaved=(\d+)""", RegexOption.IGNORE_CASE).find(transport)?.groupValues?.get(1)?.toIntOrNull() ?: return
            channelCounts[ch] = track.channels
        }
    }

    /** Reads what the camera sends, one whole unit at a time, priming each Opus channel once. */
    class FixingInputStream(inner: InputStream, private val state: State) : InputStream() {
        private val src = BufferedInputStream(inner, 64 * 1024)
        private var buf = ByteArray(0)
        private var pos = 0

        override fun read(): Int {
            if (pos >= buf.size && !fill()) return -1
            return buf[pos++].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (pos >= buf.size && !fill()) return -1
            val n = minOf(len, buf.size - pos)
            System.arraycopy(buf, pos, b, off, n)
            pos += n
            return n
        }

        override fun available(): Int = buf.size - pos

        override fun close() = src.close()

        private fun fill(): Boolean {
            val first = src.read()
            if (first < 0) return false
            buf = if (first == '$'.code) frame() else message(first)
            pos = 0
            return true
        }

        private fun frame(): ByteArray {
            val head = readExactly(3)
            val len = ((head[1].toInt() and 0xff) shl 8) or (head[2].toInt() and 0xff)
            val frame = byteArrayOf('$'.code.toByte()) + head + readExactly(len)
            val ch = head[0].toInt() and 0xff
            val channels = state.channelCounts[ch] ?: return frame
            if (!state.primed.add(ch)) return frame
            return headerFrames(frame, channels) + frame
        }

        private fun message(first: Int): ByteArray {
            val head = StringBuilder().append(first.toChar())
            while (true) {
                val c = src.read()
                if (c < 0) throw EOFException("camera closed mid-message")
                head.append(c.toChar())
                if (head.endsWith("\r\n\r\n") || head.endsWith("\n\n")) break
                if (head.length > MAX_HEADER) throw IOException("RTSP header too long")
            }
            val headers = head.toString()
            val length = headerValue(headers, "content-length")?.toIntOrNull() ?: 0
            val body = if (length > 0) readExactly(length) else ByteArray(0)
            if ((headerValue(headers, "content-type") ?: "").startsWith("application/sdp", ignoreCase = true)) {
                state.tracks = opusTracks(String(body, Charsets.ISO_8859_1))
            }
            return headers.toByteArray(Charsets.ISO_8859_1) + body
        }

        private fun readExactly(n: Int): ByteArray {
            val out = ByteArray(n)
            var got = 0
            while (got < n) {
                val r = src.read(out, got, n - got)
                if (r < 0) throw EOFException("camera closed mid-message")
                got += r
            }
            return out
        }
    }

    /** Passes everything media3 writes straight through, reading the request heads on the way. */
    class WatchingOutputStream(private val inner: OutputStream, private val state: State) : OutputStream() {
        private val pending = StringBuilder()

        override fun write(b: Int) {
            inner.write(b)
            see(byteArrayOf(b.toByte()), 0, 1)
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            inner.write(b, off, len)
            see(b, off, len)
        }

        override fun flush() = inner.flush()
        override fun close() = inner.close()

        private fun see(b: ByteArray, off: Int, len: Int) {
            pending.append(String(b, off, len, Charsets.ISO_8859_1))
            while (true) {
                val end = pending.indexOf("\r\n\r\n")
                if (end < 0) break
                val head = pending.substring(0, end + 4)
                val body = headerValue(head, "content-length")?.toIntOrNull() ?: 0
                if (pending.length < end + 4 + body) break
                state.onRequest(head)
                pending.delete(0, end + 4 + body)
            }
            if (pending.length > MAX_HEADER) pending.setLength(0)
        }
    }

    /** The socket media3 is given: [inner], with both directions passed through the fix. */
    class FixingSocket(private val inner: Socket) : Socket() {
        private val state = State()
        private val input by lazy { FixingInputStream(inner.getInputStream(), state) }
        private val output by lazy { WatchingOutputStream(inner.getOutputStream(), state) }
        override fun getInputStream(): InputStream = input
        override fun getOutputStream(): OutputStream = output
        override fun close() = inner.close()
        override fun isConnected(): Boolean = inner.isConnected
        override fun isClosed(): Boolean = inner.isClosed
        override fun getInetAddress(): InetAddress? = inner.inetAddress
        override fun getPort(): Int = inner.port
        override fun setSoTimeout(timeout: Int) { inner.soTimeout = timeout }
        override fun getSoTimeout(): Int = inner.soTimeout
        override fun shutdownInput() = inner.shutdownInput()
        override fun shutdownOutput() = inner.shutdownOutput()
    }

    private const val MAX_HEADER = 64 * 1024

    private fun headerValue(headers: String, name: String): String? =
        headers.lineSequence().firstOrNull { it.startsWith("$name:", ignoreCase = true) }
            ?.substringAfter(':')?.trim()
}
