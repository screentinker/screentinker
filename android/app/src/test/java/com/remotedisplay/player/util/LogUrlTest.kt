package com.remotedisplay.player.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** GHSA-rvxj 13.2: what a URL may look like in DebugLog (streamed to read-only viewers). */
class LogUrlTest {
    @Test fun `query and fragment are dropped, path kept`() {
        assertEquals("https://example.com/dash/view?…", LogUrl.redact("https://example.com/dash/view?token=s3cr3t&x=1#frag"))
        assertEquals("https://example.com/a?…", LogUrl.redact("https://example.com/a#access_token=abc"))
    }

    @Test fun `userinfo is dropped`() {
        assertEquals("http://cam.local:8080/snap.jpg", LogUrl.redact("http://admin:hunter2@cam.local:8080/snap.jpg"))
        assertEquals("https://host?…", LogUrl.redact("https://u:p@host?k=v"))
    }

    @Test fun `plain urls are untouched`() {
        assertEquals("https://example.com/page", LogUrl.redact("https://example.com/page"))
        assertEquals("about:blank", LogUrl.redact("about:blank"))
    }

    @Test fun `inline payload schemes keep only the scheme`() {
        assertEquals("data:…", LogUrl.redact("data:text/html;base64,PGh0bWw+"))
        assertEquals("javascript:…", LogUrl.redact("javascript:alert(document.cookie)"))
    }

    @Test fun `an @ in the path is not mistaken for userinfo`() {
        assertEquals("https://example.com/users/@me", LogUrl.redact("https://example.com/users/@me"))
    }

    @Test fun `null and long urls are safe`() {
        assertEquals("null", LogUrl.redact(null))
        val long = "https://example.com/" + "a".repeat(1000)
        assertFalse(LogUrl.redact(long).length > 210)
    }
}
