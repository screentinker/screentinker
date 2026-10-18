package com.remotedisplay.player.player

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** media3 wants OpusHead + OpusTags before RTP Opus audio; the socket puts them there. */
class RtspOpusFixTest {
    // A UniFi Protect DESCRIBE answer (without enableSrtp): AAC, Opus, HEVC.
    private val unifi = listOf(
        "v=0", "o=- 1035 0 IN IP4 192.168.1.10", "s=x", "t=0 0", "a=control:*",
        "m=audio 0 RTP/AVP 96", "a=rtpmap:96 mpeg4-generic/16000/1", "a=control:trackID=0",
        "m=audio 0 RTP/AVP 96", "a=rtpmap:96 opus/48000/2", "a=control:trackID=1",
        "m=video 0 RTP/AVP 97", "a=control:trackID=2", "a=rtpmap:97 H265/90000",
    ).joinToString("\r\n", postfix = "\r\n")

    @Test fun `the SDP's Opus track is found with its control and channels`() {
        assertEquals(listOf(RtspOpusFix.OpusTrack("trackID=1", 2)), RtspOpusFix.opusTracks(unifi))
        assertEquals(emptyList<RtspOpusFix.OpusTrack>(), RtspOpusFix.opusTracks("v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:v\r\n"))
    }

    @Test fun `a SETUP url matches its control however the base was joined`() {
        assertTrue(RtspOpusFix.matchesControl("rtsps://10.0.0.5:7441/tok/trackID=1", "trackID=1"))
        assertTrue(RtspOpusFix.matchesControl("rtsps://10.0.0.5:7441/tok/trackID=1?x=1", "trackID=1"))
        assertTrue(!RtspOpusFix.matchesControl("rtsps://10.0.0.5:7441/tok/trackID=10", "trackID=1"))
        assertTrue(RtspOpusFix.matchesControl("rtsp://cam/s/a", "rtsp://cam/s/a"))
    }

    @Test fun `OpusHead and OpusTags are the standard 19 and 16 bytes`() {
        val h = RtspOpusFix.opusHead(2)
        assertEquals(19, h.size)
        assertEquals("OpusHead", String(h, 0, 8, Charsets.US_ASCII))
        assertEquals(1, h[8].toInt()); assertEquals(2, h[9].toInt())
        assertEquals(48_000, (h[12].toInt() and 0xff) or ((h[13].toInt() and 0xff) shl 8) or ((h[14].toInt() and 0xff) shl 16))
        assertEquals("OpusTags", String(RtspOpusFix.opusTags(), 0, 8, Charsets.US_ASCII))
        assertEquals(16, RtspOpusFix.opusTags().size)
    }

    @Test fun `the first packet on the Opus channel is preceded by the two headers, once`() {
        val state = RtspOpusFix.State()
        val sdpReply = "RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: ${unifi.length}\r\n\r\n$unifi"
        // media3's SETUP for the Opus track, written through the watching stream.
        val sink = ByteArrayOutputStream()
        val out = RtspOpusFix.WatchingOutputStream(sink, state)
        val ins0 = RtspOpusFix.FixingInputStream(ByteArrayInputStream(sdpReply.toByteArray(Charsets.ISO_8859_1)), state)
        ins0.readBytes()
        val setup = "SETUP rtsps://10.0.0.5:7441/tok/trackID=1 RTSP/1.0\r\nCSeq: 4\r\nTransport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n"
        out.write(setup.toByteArray(Charsets.ISO_8859_1))
        assertEquals(setup, sink.toString("ISO-8859-1"))
        assertEquals(2, state.channelCounts[2])

        // RTP: V=2, PT=96, seq=1000, ts=0x01020304, ssrc=0x0a0b0c0d, 3 bytes of audio.
        val rtp = byteArrayOf(0x80.toByte(), 96, 0x03, 0xe8.toByte(), 1, 2, 3, 4, 10, 11, 12, 13, 7, 7, 7)
        val opusFrame = byteArrayOf('$'.code.toByte(), 2, 0, rtp.size.toByte()) + rtp
        val videoFrame = byteArrayOf('$'.code.toByte(), 4, 0, 2, 9, 9)
        val got = RtspOpusFix.FixingInputStream(ByteArrayInputStream(opusFrame + videoFrame + opusFrame), state).readBytes()

        val headFrame = 4 + 12 + 19
        val tagsFrame = 4 + 12 + 16
        assertEquals(headFrame + tagsFrame + opusFrame.size + videoFrame.size + opusFrame.size, got.size)
        assertEquals(2, got[1].toInt())                                         // same channel
        assertEquals(1000 - 2, ((got[6].toInt() and 0xff) shl 8) or (got[7].toInt() and 0xff))
        assertArrayEquals(rtp.copyOfRange(4, 12), got.copyOfRange(8, 16))       // timestamp + SSRC kept
        assertEquals("OpusHead", String(got, 16, 8, Charsets.US_ASCII))
        assertEquals(1000 - 1, ((got[headFrame + 6].toInt() and 0xff) shl 8) or (got[headFrame + 7].toInt() and 0xff))
        assertEquals("OpusTags", String(got, headFrame + 16, 8, Charsets.US_ASCII))
        assertArrayEquals(opusFrame + videoFrame + opusFrame, got.copyOfRange(headFrame + tagsFrame, got.size))
    }
}
