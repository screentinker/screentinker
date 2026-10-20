package com.remotedisplay.player.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.Inet6Address
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The ONVIF relay's own limits, enforced on the screen whatever the server asks.
 *
 * ⚠️ The private-address rule is the test that matters: it is what stops a server (or anyone
 * holding its socket) from using a screen as a proxy into the public internet or into the panel's
 * own loopback services. Everything here is pure — no camera, no network.
 */
class OnvifRelayTest {

    private fun ip(s: String): InetAddress = InetAddress.getByName(s)   // literals only: no DNS
    private fun private(s: String) = OnvifRelay.isPrivate(ip(s))

    // ─── private addresses ──────────────────────────────────────────────────────────────────

    @Test
    fun privateIpv4RangesAreAccepted() {
        for (a in listOf(
            "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.64",
            "169.254.10.20", "100.64.0.1", "100.127.255.254"
        )) assertTrue("$a should be private", private(a))
    }

    @Test
    fun loopbackPublicAndSpecialIpv4AreRefused() {
        for (a in listOf(
            "127.0.0.1", "127.8.8.8", "0.0.0.0", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1",
            "192.169.0.1", "100.63.255.255", "100.128.0.1", "239.255.255.250", "224.0.0.1", "255.255.255.255",
            "11.0.0.1", "169.254.169.254"
        )) assertFalse("$a must be refused", private(a))
    }

    @Test
    fun ipv6UlaAndLinkLocalAreAcceptedEverythingElseRefused() {
        for (a in listOf("fc00::1", "fd12:3456:789a::10", "fe80::1", "febf::1")) assertTrue("$a should be private", private(a))
        for (a in listOf("::1", "::", "2001:4860:4860::8888", "fec0::1", "ff02::1", "fe00::1", "64:ff9b::808:808"))
            assertFalse("$a must be refused", private(a))
    }

    @Test
    fun ipv4MappedIpv6IsJudgedAsTheIpv4ItCarries() {
        assertTrue(private("::ffff:192.168.1.10"))
        assertFalse(private("::ffff:127.0.0.1"))
        assertFalse(private("::ffff:8.8.8.8"))
        // And when it arrives as a real Inet6Address (not normalised to Inet4Address by Java).
        fun mapped(a: Int, b: Int, c: Int, d: Int) = Inet6Address.getByAddress(
            null, ByteArray(10) + byteArrayOf(-1, -1, a.toByte(), b.toByte(), c.toByte(), d.toByte()), null
        )
        assertTrue(OnvifRelay.isPrivate(mapped(10, 1, 2, 3)))
        assertFalse(OnvifRelay.isPrivate(mapped(127, 0, 0, 1)))
        assertFalse(OnvifRelay.isPrivate(mapped(8, 8, 4, 4)))
    }

    @Test
    fun everyResolvedAddressMustBePrivate() {
        val both = { _: String -> listOf(ip("192.168.1.5"), ip("93.184.216.34")) }
        assertNull("one public answer is enough to refuse", OnvifRelay.resolvePrivate("cam.local", both))
        val lan = { _: String -> listOf(ip("192.168.1.5"), ip("fd00::5")) }
        assertEquals(2, OnvifRelay.resolvePrivate("cam.local", lan)!!.size)
        assertNull("nothing resolved is refused", OnvifRelay.resolvePrivate("x", { emptyList() }))
        assertNull("a resolver error is refused", OnvifRelay.resolvePrivate("x", { throw java.net.UnknownHostException(it) }))
        assertNull(OnvifRelay.resolvePrivate("127.0.0.1"))
        assertNotNull(OnvifRelay.resolvePrivate("10.1.2.3"))
        assertNotNull("bracketed IPv6 literal", OnvifRelay.resolvePrivate("[fe80::1]"))
    }

    // ─── headers ────────────────────────────────────────────────────────────────────────────

    @Test
    fun onlyContentTypeAndAuthorizationPassThrough() {
        val h = JSONObject()
            .put("Content-Type", "application/soap+xml; charset=utf-8")
            .put("AUTHORIZATION", "Digest username=\"admin\"")
            .put("Host", "evil.example")
            .put("Cookie", "a=b")
            .put("X-Forwarded-For", "1.2.3.4")
            .put("Transfer-Encoding", "chunked")
        val out = OnvifRelay.filterHeaders(h)
        assertEquals(setOf("content-type", "authorization"), out.keys)
        assertEquals("application/soap+xml; charset=utf-8", out["content-type"])
        assertEquals("Digest username=\"admin\"", out["authorization"])
    }

    @Test
    fun headerValuesWithLineBreaksOrNonStringsAreDropped() {
        val out = OnvifRelay.filterHeaders(
            JSONObject().put("authorization", "Basic x\r\nHost: evil").put("content-type", 42)
        )
        assertTrue(out.isEmpty())
        assertTrue(OnvifRelay.filterHeaders(null).isEmpty())
    }

    // ─── payload validation ─────────────────────────────────────────────────────────────────

    private fun bad(p: JSONObject?) = (OnvifRelay.parse(p) as? OnvifRelay.Parsed.Bad)?.error
    private fun ok(p: JSONObject) = (OnvifRelay.parse(p) as OnvifRelay.Parsed.Ok).op

    @Test
    fun malformedPayloadsAreRefusedWithAReason() {
        assertEquals("bad-request", bad(null))
        assertEquals("bad-request", bad(JSONObject().put("op", "soap")))
        assertEquals("bad-op", bad(JSONObject().put("id", "1").put("op", "connect")))
        assertEquals("bad-url", bad(JSONObject().put("id", "1").put("op", "soap")))
        for (u in listOf("file:///etc/hosts", "content://x/y", "ftp://10.0.0.1/", "rtsp://10.0.0.1/", "//10.0.0.1/x", "not a url"))
            assertEquals(u, "bad-url", bad(JSONObject().put("id", "1").put("op", "get").put("url", u)))
    }

    @Test
    fun soapBodyIsCappedAt64KiBOfUtf8() {
        val p = JSONObject().put("id", "1").put("op", "soap").put("url", "http://192.168.1.10/onvif/device_service")
        assertNotNull(ok(p.put("body", "a".repeat(64 * 1024))))
        assertEquals("body-too-large", bad(p.put("body", "a".repeat(64 * 1024 + 1))))
        // Counted in bytes, not chars: 22k three-byte characters is over the cap.
        assertEquals("body-too-large", bad(p.put("body", "€".repeat(22 * 1024))))
    }

    @Test
    fun timeoutsDefaultAndAreCapped() {
        val soap = JSONObject().put("id", "1").put("op", "soap").put("url", "https://10.0.0.5/onvif/device_service")
        assertEquals(8000L, ok(soap).timeoutMs)
        assertEquals(15000L, ok(soap.put("timeout_ms", 600000)).timeoutMs)
        assertEquals(4000L, ok(soap.put("timeout_ms", 4000)).timeoutMs)
        assertEquals(8000L, ok(soap.put("timeout_ms", -5)).timeoutMs)
        val probe = JSONObject().put("id", "2").put("op", "probe")
        assertEquals(3000L, ok(probe).timeoutMs)
        assertEquals(10000L, ok(probe.put("timeout_ms", 15000)).timeoutMs)
        assertNull(ok(probe).host)
        assertEquals("192.168.1.20", ok(probe.put("host", " 192.168.1.20 ")).host)
    }

    @Test
    fun getCarriesNoBodyAndFiltersHeaders() {
        val op = ok(JSONObject().put("id", "1").put("op", "get").put("url", "http://192.168.1.10/snap.jpg")
            .put("body", "ignored").put("headers", JSONObject().put("Authorization", "Basic eA==").put("Range", "bytes=0-")))
        assertEquals("", op.body)
        assertEquals(mapOf("authorization" to "Basic eA=="), op.headers)
    }

    @Test
    fun aPublicOrLoopbackDestinationIsRefusedBeforeAnyConnection() {
        for (u in listOf("http://8.8.8.8/onvif/device_service", "http://127.0.0.1:8080/api", "https://[::1]/x", "http://0.0.0.0/"))  {
            val r = OnvifRelay.perform(JSONObject().put("id", "x1").put("op", "soap").put("url", u).put("body", "<a/>"))
            assertEquals(u, "not-private", r.getString("error"))
            assertFalse(r.getBoolean("ok"))
            assertEquals("x1", r.getString("id"))
        }
        val p = OnvifRelay.perform(JSONObject().put("id", "x2").put("op", "probe").put("host", "8.8.8.8"))
        assertEquals("not-private", p.getString("error"))
    }

    @Test
    fun aFifthConcurrentOperationIsBusy() {
        // Four probes park inside the multicast-lock callback; the fifth must be refused at once.
        val entered = CountDownLatch(4)
        val gate = CountDownLatch(1)
        val threads = (1..4).map { n ->
            Thread {
                OnvifRelay.perform(JSONObject().put("id", "p$n").put("op", "probe").put("timeout_ms", 500)) {
                    entered.countDown(); gate.await(10, TimeUnit.SECONDS); {}
                }
            }.apply { isDaemon = true; start() }
        }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val r = OnvifRelay.perform(JSONObject().put("id", "p5").put("op", "probe"))
            assertEquals("busy", r.getString("error"))
            assertEquals("p5", r.getString("id"))
        } finally {
            gate.countDown()
            threads.forEach { it.join(5000) }
        }
    }

    // ─── bytes ──────────────────────────────────────────────────────────────────────────────

    @Test
    fun readUpToRefusesRatherThanTruncates() {
        assertEquals(10, OnvifRelay.readUpTo(ByteArrayInputStream(ByteArray(10)), 10)!!.size)
        assertNull(OnvifRelay.readUpTo(ByteArrayInputStream(ByteArray(11)), 10))
        assertEquals(0, OnvifRelay.readUpTo(null, 10)!!.size)
    }

    @Test
    fun jpegMagic() {
        assertTrue(OnvifRelay.isJpeg(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())))
        assertFalse(OnvifRelay.isJpeg("<html>".toByteArray()))
        assertFalse(OnvifRelay.isJpeg(byteArrayOf(0xFF.toByte(), 0xD8.toByte())))
    }

    // ─── WS-Discovery ───────────────────────────────────────────────────────────────────────

    @Test
    fun probeMessageIsByteForByteTheServers() {
        // node -e 'console.log(require("./server/lib/onvif/soap.js").probeMessage("uuid:00000000-1111-2222-3333-444444444444"))'
        val expected = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:a=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\"><s:Header><a:Action s:mustUnderstand=\"1\">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action><a:MessageID>uuid:00000000-1111-2222-3333-444444444444</a:MessageID><a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand=\"1\">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header><s:Body><Probe xmlns=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\"><Types xmlns:dn=\"http://www.onvif.org/ver10/network/wsdl\">dn:NetworkVideoTransmitter</Types></Probe></s:Body></s:Envelope>"
        assertEquals(expected, OnvifRelay.probeMessage("uuid:00000000-1111-2222-3333-444444444444"))
    }

    @Test
    fun probeMessageIdIsFreshAndEscaped() {
        val a = OnvifRelay.probeMessage()
        val b = OnvifRelay.probeMessage()
        assertFalse(a == b)
        assertTrue(Regex("<a:MessageID>uuid:[0-9a-f-]{36}</a:MessageID>").containsMatchIn(a))
        assertTrue(OnvifRelay.probeMessage("uuid:<&>").contains("<a:MessageID>uuid:&lt;&amp;&gt;</a:MessageID>"))
    }
}
