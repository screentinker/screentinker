package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The string rules behind RtspSources: which URLs are RTSPS, the default port, log redaction. */
class RtspUrlTest {
    @Test fun `rtsps is recognised in any case, rtsp is not rtsps`() {
        assertTrue(RtspUrl.isRtsps("rtsps://cam/x"))
        assertTrue(RtspUrl.isRtsps("  RTSPS://cam/x"))
        assertFalse(RtspUrl.isRtsps("rtsp://cam/x"))
        assertFalse(RtspUrl.isRtsps(null))
    }

    @Test fun `an rtsps URL without a port gets 322, media3 would otherwise dial 554`() {
        assertEquals("rtsps://10.0.0.5:322/abc", RtspUrl.withDefaultPort("rtsps://10.0.0.5/abc"))
        assertEquals("rtsps://u:p@cam.local:322/abc?x=1", RtspUrl.withDefaultPort("rtsps://u:p@cam.local/abc?x=1"))
        assertEquals("rtsps://cam:322", RtspUrl.withDefaultPort("rtsps://cam"))
        assertEquals("rtsps://[fd00::5]:322/s", RtspUrl.withDefaultPort("rtsps://[fd00::5]/s"))
    }

    @Test fun `a URL that names its port keeps it`() {
        assertEquals("rtsps://10.0.0.5:7441/abc", RtspUrl.withDefaultPort("rtsps://10.0.0.5:7441/abc"))
        assertEquals("rtsps://u:p@cam:7441/abc", RtspUrl.withDefaultPort("rtsps://u:p@cam:7441/abc"))
        assertEquals("rtsps://[fd00::5]:7441/s", RtspUrl.withDefaultPort("rtsps://[fd00::5]:7441/s"))
        // a ':' in the password is not a port
        assertEquals("rtsps://u:p:q@cam:322/s", RtspUrl.withDefaultPort("rtsps://u:p:q@cam/s"))
    }

    @Test fun `logs never carry the camera password`() {
        assertEquals("rtsp://admin:***@10.0.0.5/s", RtspUrl.redact("rtsp://admin:secret@10.0.0.5/s"))
        assertEquals("rtsps://v:***@cam:7441/s", RtspUrl.redact("rtsps://v:p%40ss@cam:7441/s"))
        assertEquals("rtsp://cam/s", RtspUrl.redact("rtsp://cam/s"))
        assertEquals("rtsp://user@cam/s", RtspUrl.redact("rtsp://user@cam/s"))
        assertEquals("null", RtspUrl.redact(null))
    }
}
