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

    // ── v2: config ──────────────────────────────────────────────────────────────────────────

    @Test fun `v2 options default sensibly and parse`() {
        val d = KioskConfig.parse("webpage", """{"url":"https://a.example","interactive":true}""")!!
        assertFalse(d.keepConsent)
        assertTrue(d.homeButton)
        assertEquals(100, d.zoomPct)
        assertEquals(emptyList<String>(), d.keepCookieNames)
        val c = KioskConfig.parse("webpage", """{"url":"https://a.example","interactive":true,"keep_consent":true,"keep_cookie_names":"my_consent, cc_*, bad;name, *,","home_button":false,"zoom":150}""")!!
        assertTrue(c.keepConsent)
        assertFalse(c.homeButton)
        assertEquals(150, c.zoomPct)
        assertEquals(listOf("my_consent", "cc_*"), c.keepCookieNames)
        assertEquals(400, KioskConfig.parse("webpage", """{"url":"https://a.example","interactive":true,"zoom":9000}""")!!.zoomPct)
        assertEquals(100, KioskConfig.parse("webpage", """{"url":"https://a.example","interactive":true,"zoom":0}""")!!.zoomPct)
    }

    // ── v2: consent cookies ─────────────────────────────────────────────────────────────────

    @Test fun `THE_BUG_ only consent cookies survive, never the login or the basket`() {
        val jar = "PHPSESSID=abc; CookieConsent={stamp:'x',necessary:true}; cart_id=42; euconsent-v2=CPx; " +
                  "cookielawinfo-checkbox-analytics=yes; auth_token=secret; OptanonAlertBoxClosed=2026-10-04"
        val kept = CookieKeep.select(jar, CookieKeep.BUILT_IN).map { it.first }
        assertEquals(listOf("CookieConsent", "euconsent-v2", "cookielawinfo-checkbox-analytics", "OptanonAlertBoxClosed"), kept)
        for (n in listOf("PHPSESSID", "cart_id", "auth_token")) assertFalse(n, n in kept)
    }

    @Test fun `operator names and prefixes extend the list, values keep their equals signs`() {
        val got = CookieKeep.select("shop_gdpr=a=b=c; shop_gdpr_v=2; other=1", listOf("shop_gdpr*"))
        assertEquals(listOf("shop_gdpr" to "a=b=c", "shop_gdpr_v" to "2"), got)
        assertEquals(emptyList<Pair<String, String>>(), CookieKeep.select(null, CookieKeep.BUILT_IN))
        assertEquals(emptyList<Pair<String, String>>(), CookieKeep.select("CookieConsent=1", emptyList()))
        assertFalse(CookieKeep.validPattern("*"))
        assertFalse(CookieKeep.validPattern("a;b"))
        assertTrue(CookieKeep.validPattern("cmplz_*"))
        assertEquals("CookieConsent=1; Domain=shop.example; Path=/; Max-Age=${CookieKeep.MAX_AGE_SEC}",
            CookieKeep.restoreHeader("CookieConsent", "1", "shop.example"))
    }

    // ── v2: error throttle, home, session clock ─────────────────────────────────────────────

    @Test fun `a site that is down reports once per window per host and reason`() {
        val t = ErrorThrottle(windowMs = 60_000)
        assertTrue(t.shouldReport("load_error", "https://shop.example/a", 0))
        assertFalse(t.shouldReport("load_error", "https://shop.example/b", 30_000))
        assertTrue(t.shouldReport("http_error", "https://shop.example/b", 30_000))
        assertTrue(t.shouldReport("load_error", "https://other.example/", 30_000))
        assertTrue(t.shouldReport("load_error", "https://shop.example/a", 60_000))
    }

    @Test fun `home shows only once the visitor has left the start page`() {
        val start = "https://shop.example/menu"
        assertTrue(isStartPage("https://shop.example/menu", start))
        assertTrue(isStartPage("https://SHOP.example/menu/#top", start))
        assertTrue(isStartPage(null, start))
        assertFalse(isStartPage("https://shop.example/menu/item/3", start))
        assertFalse(isStartPage("https://shop.example/menu?page=2", start))
    }

    @Test fun `engaged time ends at the last activity, not at the reset`() {
        val k = KioskIdle(60_000, 10_000)
        k.onTouch(1_000)
        k.onTouch(20_000)
        k.tick(90_000)
        assertEquals(20_000, k.lastActivityAt)
    }

    // ── v2: session queue ───────────────────────────────────────────────────────────────────

    private fun rec(id: String, w: String? = "w1") = KioskSessionRecord(id, w, 1_700_000_000, 42, "idle", 3)

    @Test fun `session queue is bounded, ordered, deduped and survives a round trip`() {
        val q = KioskSessionQueue(cap = 3)
        listOf("a", "b", "b", "c", "d").forEach { q.add(rec(it)) }
        assertEquals(listOf("b", "c", "d"), q.peek().map { it.id })      // oldest dropped, duplicate ignored
        q.ack(listOf("c"))
        val back = KioskSessionQueue.fromJson(q.toJson())
        assertEquals(listOf("b", "d"), back.peek().map { it.id })
        assertEquals(rec("b"), back.peek().first())
        q.add(rec("n", null))
        assertNull(KioskSessionQueue.fromJson(q.toJson()).peek().last().widgetId)
        assertEquals(0, KioskSessionQueue.fromJson("garbage").size)
    }
}
