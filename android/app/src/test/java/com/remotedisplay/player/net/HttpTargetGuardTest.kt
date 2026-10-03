package com.remotedisplay.player.net

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The device-side target guard against its SHARED contract — the same
 * shared/http-target-vectors.json the server answers to, read directly (no snapshot), wired in
 * app/build.gradle.kts.
 *
 * ⚠️ The assertion that matters is the scheme allowlist. It is the only thing standing between
 * "fetch a URL and return 64KiB" and "read a file off this device and return 64KiB" — on Android,
 * `content://` reads through content providers, which is exactly how one app's private data gets
 * exposed to another.
 */
class HttpTargetGuardTest {

    private fun allowed(url: String?) = HttpTargetGuard.check(url) is HttpTargetGuard.Verdict.Allow
    private fun reason(url: String?) =
        (HttpTargetGuard.check(url) as? HttpTargetGuard.Verdict.Deny)?.reason

    @Test
    fun conformsToSharedVectors() {
        val path = System.getProperty("httpTargetVectors")
            ?: error("httpTargetVectors system property not set (configured in app/build.gradle.kts)")
        val vectors = JsonParser.parseString(File(path).readText()).asJsonObject.getAsJsonArray("vectors")

        val failures = StringBuilder()
        var count = 0
        for (el in vectors) {
            val v = el.asJsonObject
            val url = v.get("url").asString
            val expect = v.getAsJsonObject("expect")
            val wantAllow = expect.get("allow").asBoolean
            val gotAllow = allowed(url)
            if (gotAllow != wantAllow) {
                failures.append("  ${v.get("name").asString}\n    $url -> allow=$gotAllow, expected $wantAllow\n")
            } else if (!wantAllow && expect.has("reason")) {
                val wantReason = expect.get("reason").asString
                val gotReason = reason(url)
                if (gotReason != wantReason) {
                    failures.append("  ${v.get("name").asString}\n    $url -> reason=$gotReason, expected $wantReason\n")
                }
            }
            count++
        }
        assertTrue("the contract should not shrink", count >= 24)
        assertEquals("Kotlin disagrees with shared/http-target-vectors.json:\n$failures", 0, failures.length)
    }

    @Test
    fun rfc1918IsAllowedBecauseItIsTheEntireFeature() {
        // Named loudly: this is the OPPOSITE of what a server-side SSRF guard does, and anyone
        // tidying the two into agreement would delete the feature. The panel exists to talk to the
        // PLC on the shop network.
        for (h in listOf("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "127.0.0.1")) {
            assertTrue("$h must be reachable from a panel", allowed("http://$h/x"))
        }
    }

    @Test
    fun localFileReadsAreRefused() {
        assertEquals("bad_scheme", reason("file:///data/data/com.remotedisplay.player/shared_prefs/remote_display.xml"))
        assertEquals("bad_scheme", reason("content://com.android.contacts/contacts"))
        assertEquals("bad_scheme", reason("content://media/external/images/media"))
        assertEquals("bad_scheme", reason("ftp://192.168.1.50/f"))
        assertEquals("bad_scheme", reason("ws://192.168.1.50/s"))
    }

    @Test
    fun linkLocalGoesWholesaleAndNarrowly() {
        for (h in listOf("169.254.169.254", "169.254.0.1", "169.254.255.255")) {
            assertEquals("metadata_address", reason("http://$h/"))
        }
        // The neighbouring ranges stay allowed, so the block does not creep.
        assertTrue(allowed("http://169.253.0.1/"))
        assertTrue(allowed("http://169.255.0.1/"))
        assertTrue(allowed("http://100.64.0.1/"))
    }

    @Test
    fun isBlockedAddressBacksTheResolvedRecheck() {
        // A hostname resolving to the metadata service is the obvious way round a string check, so
        // the resolved-address re-check must use THIS predicate rather than a second list.
        assertTrue(HttpTargetGuard.isBlockedAddress("169.254.169.254"))
        assertTrue(HttpTargetGuard.isBlockedAddress("fe80::1"))
        assertTrue(HttpTargetGuard.isBlockedAddress("[fe80::1]"))
        assertTrue(HttpTargetGuard.isBlockedAddress("fd00:ec2::254"))
        assertFalse(HttpTargetGuard.isBlockedAddress("192.168.1.1"))
        assertFalse(HttpTargetGuard.isBlockedAddress(null))
        assertFalse(HttpTargetGuard.isBlockedAddress(""))
    }

    @Test
    fun neverThrows() {
        for (junk in listOf(null, "", " ", "http://", "http://[::", "\u0000", "nonsense", "//x/y")) {
            val v = HttpTargetGuard.check(junk)
            assertTrue("junk input must get a verdict", v is HttpTargetGuard.Verdict.Allow || v is HttpTargetGuard.Verdict.Deny)
        }
    }
}
