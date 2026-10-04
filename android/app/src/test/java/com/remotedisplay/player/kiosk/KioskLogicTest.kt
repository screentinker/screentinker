package com.remotedisplay.player.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KioskLogicTest {

    // ── config ──────────────────────────────────────────────────────────────────────────────

    @Test fun `only an interactive webpage widget is a kiosk item`() {
        assertNull(KioskConfig.parse("webpage", """{"url":"https://shop.example"}"""))
        assertNull(KioskConfig.parse("webpage", """{"url":"https://shop.example","interactive":false}"""))
        assertNull(KioskConfig.parse("clock", """{"url":"https://shop.example","interactive":true}"""))
        assertNull(KioskConfig.parse("webpage", """{"url":"ftp://shop.example","interactive":true}"""))
        assertNull(KioskConfig.parse("webpage", "not json"))
        assertNull(KioskConfig.parse("webpage", null))
        assertNotNull(KioskConfig.parse("webpage", """{"url":"https://shop.example/menu","interactive":true}"""))
    }

    @Test fun `defaults, clamps and the start host is always allowed`() {
        val c = KioskConfig.parse("webpage", """{"url":"https://Shop.Example/menu","interactive":true,"idle_timeout_sec":2,"allowed_domains":"cdn.example, https://pay.example/x ,bad"}""")!!
        assertEquals(15, c.idleTimeoutSec)
        assertEquals(KioskConfig.DEFAULT_WARN_SEC, c.warnSec)
        assertEquals(listOf("shop.example", "cdn.example", "pay.example"), c.allowedDomains)
        assertNull(c.minWebView)
        val d = KioskConfig.parse("webpage", """{"url":"https://a.example","interactive":true,"allowed_domains":["b.example"],"min_webview":90}""")!!
        assertEquals(listOf("a.example", "b.example"), d.allowedDomains)
        assertEquals(90, d.minWebView)
        assertEquals(60, d.idleTimeoutSec)
    }

    // ── navigation ──────────────────────────────────────────────────────────────────────────

    @Test fun `allowlist matches the domain and its subdomains, nothing else`() {
        val allowed = listOf("shop.example")
        assertTrue(KioskNav.isAllowed("https://shop.example/basket", allowed))
        assertTrue(KioskNav.isAllowed("https://www.shop.example/", allowed))
        assertTrue(KioskNav.isAllowed("http://m.shop.example?x=1", allowed))
        assertFalse(KioskNav.isAllowed("https://evilshop.example/", allowed))
        assertFalse(KioskNav.isAllowed("https://shop.example.evil.com/", allowed))
        assertFalse(KioskNav.isAllowed("https://other.example/", allowed))
    }

    @Test fun `THE_BUG_ non-web schemes never navigate, whatever the host looks like`() {
        val allowed = listOf("shop.example")
        for (u in listOf("intent://shop.example#Intent;end", "market://details?id=x", "tel:123", "mailto:a@shop.example",
                         "file:///sdcard/x", "javascript:alert(1)", "content://x", "https://user@evil.com/")) {
            assertFalse(u, KioskNav.isAllowed(u, allowed))
        }
        assertTrue(KioskNav.isAllowed("about:blank", allowed))
    }

    // ── WebView version ─────────────────────────────────────────────────────────────────────

    @Test fun `chromium major from a WebView user agent`() {
        val ua = "Mozilla/5.0 (Linux; Android 11; rk3566 Build/RQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.106 Mobile Safari/537.36"
        assertEquals(83, WebViewVersion.chromeMajor(ua))
        assertTrue(WebViewVersion.tooOld(ua, 90))
        assertFalse(WebViewVersion.tooOld(ua, 80))
        assertFalse(WebViewVersion.tooOld(ua, null))
        assertFalse("unknown version: try the page", WebViewVersion.tooOld("weird", 90))
    }

    // ── session clock ───────────────────────────────────────────────────────────────────────

    @Test fun `a page nobody touches is never a session`() {
        val k = KioskIdle(60_000, 10_000)
        assertEquals(KioskIdle.Action.None, k.tick(1_000_000))
        assertEquals(KioskIdle.Action.None, k.keepAlive(1_000_000))   // a playing video alone starts nothing
        assertFalse(k.inSession)
    }

    @Test fun `touch, idle, countdown, reset`() {
        val k = KioskIdle(60_000, 10_000)
        assertEquals(KioskIdle.Action.Started, k.onTouch(0))
        assertEquals(KioskIdle.Action.None, k.tick(59_999))
        assertEquals(KioskIdle.Action.Warn(10), k.tick(60_000))
        assertEquals(KioskIdle.Action.Warn(1), k.tick(69_500))
        assertEquals(KioskIdle.Action.Reset, k.tick(70_000))
        assertFalse(k.inSession)
    }

    @Test fun `a tap during the countdown keeps the visitor's session`() {
        val k = KioskIdle(60_000, 10_000)
        k.onTouch(0)
        k.tick(65_000)
        assertEquals(KioskIdle.Action.Resumed, k.onTouch(65_000))
        assertEquals(KioskIdle.Action.None, k.tick(124_999))
        assertTrue(k.inSession)
    }

    @Test fun `media playing in the page keeps the session alive`() {
        val k = KioskIdle(60_000, 10_000)
        k.onTouch(0)
        for (t in 5_000L..200_000L step 5_000L) assertTrue(k.keepAlive(t) != KioskIdle.Action.Reset)
        assertEquals(KioskIdle.Action.None, k.tick(200_000))
        assertEquals(KioskIdle.Action.Reset, k.tick(270_000))
    }

    @Test fun `no countdown configured resets straight away`() {
        val k = KioskIdle(30_000, 0)
        k.onTouch(0)
        assertEquals(KioskIdle.Action.Reset, k.tick(30_000))
    }
}
