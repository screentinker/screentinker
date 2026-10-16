package com.remotedisplay.player.player

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * #649: BundleSkip.kt against shared/bundle-skip-vectors.json — the same file the JS players
 * (server/test/bundle-skip.test.js) and the native player (tests/test_bundle_skip.py) are held to —
 * plus the Android-only half: who may call the bridge, and where the listener goes in the document.
 */
class BundleSkipVectorsTest {
    private val v: JsonObject by lazy {
        val path = System.getProperty("bundleSkipVectors") ?: error("bundleSkipVectors system property not set (app/build.gradle.kts)")
        JsonParser.parseString(File(path).readText()).asJsonObject
    }

    private fun toNative(e: JsonElement): Any? = when {
        e.isJsonNull -> null
        e.isJsonObject -> JSONObject(e.toString())
        e.isJsonPrimitive && e.asJsonPrimitive.isString -> e.asString
        e.isJsonPrimitive && e.asJsonPrimitive.isNumber -> e.asNumber
        else -> e.toString()
    }

    @Test fun constants() {
        assertEquals(v.get("minRunMs").asLong, BundleSkip.MIN_RUN_MS)
        assertEquals(v.get("reasonMax").asInt, BundleSkip.REASON_MAX)
        assertEquals("screentinker:skip", BundleSkip.MESSAGE_TYPE)
    }

    @Test fun message() {
        for (el in v.getAsJsonArray("message")) {
            val o = el.asJsonObject
            assertEquals(o.get("name").asString, o.get("expect").asBoolean, BundleSkip.isSkipMessage(toNative(o.get("data"))))
        }
    }

    @Test fun reason() {
        for (el in v.getAsJsonArray("reason")) {
            val o = el.asJsonObject
            val name = o.get("name").asString
            val got = BundleSkip.sanitizeReason(toNative(o.get("raw")))
            if (o.has("expectCodePoints")) {
                val raw = o.get("raw").asString
                val n = o.get("expectCodePoints").asInt
                assertEquals(name, n, got!!.codePointCount(0, got.length))
                assertEquals(name, raw.substring(0, raw.offsetByCodePoints(0, n)), got)
            } else {
                val exp = o.get("expect")
                assertEquals(name, if (exp.isJsonNull) null else exp.asString, got)
            }
        }
    }

    @Test fun guard() {
        for (el in v.getAsJsonArray("guard")) {
            val o = el.asJsonObject
            val name = o.get("name").asString
            val g = BundleSkip.Guard(v.get("minRunMs").asLong)
            o.getAsJsonArray("steps").forEachIndexed { i, se ->
                val s = se.asJsonObject
                if (s.has("ended")) { g.ended(s.get("ended").asLong); return@forEachIndexed }
                val can = !s.has("canAdvance") || s.get("canAdvance").asBoolean
                val sync = s.has("sync") && s.get("sync").asBoolean
                assertEquals("$name step $i", s.get("expect").asString, g.decide(s.get("skip").asString, can, sync))
            }
        }
    }

    @Test fun onlyTheCurrentMountsTokenIsAccepted() {
        var n = 0
        val m = BundleSkip.MountToken { "tok" + (++n) }
        assertFalse("nothing mounted yet", m.accepts("tok1", 0))
        val a = m.mount(5)
        assertTrue(m.accepts(a, 5))
        assertFalse("another token (a widget page, a frame the bundle embeds)", m.accepts("guess", 5))
        assertFalse("no token", m.accepts(null, 5))
        assertFalse("the same bundle after something else was mounted", m.accepts(a, 6))
        val b = m.mount(7)
        assertFalse("the replaced bundle's token", m.accepts(a, 7))
        assertTrue(m.accepts(b, 7))
    }

    @Test fun theListenerRunsFirstButNeverBeforeTheDoctype() {
        val t = "abc123"
        val s = BundleSkip.bridgeScript(t)
        val doc = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>x</title></head><body>hi</body></html>"
        val out = BundleSkip.inject(doc, t)
        assertTrue(out.startsWith("<!doctype html><html lang=\"en\"><head>$s<meta charset"))
        assertEquals(doc, out.replace(s, ""))
        // <HEAD> in any case, with attributes; never mistaken for <header>.
        assertTrue(BundleSkip.inject("<HTML><HEAD id=h><title>x</title></HEAD></HTML>", t).startsWith("<HTML><HEAD id=h>$s"))
        assertTrue(BundleSkip.inject("<html><body><header>x</header></body></html>", t).startsWith("<html>$s<body><header>"))
        assertEquals("<!DOCTYPE html>$s<p>x", BundleSkip.inject("<!DOCTYPE html><p>x", t))
        assertEquals("$s<p>x", BundleSkip.inject("<p>x", t))
    }

    @Test fun theListenerOnlyForwardsTheBundlesOwnSkipWithItsToken() {
        val s = BundleSkip.bridgeScript("abc123")
        assertTrue("only its own window: a frame the bundle embeds is ignored", s.contains("e.source!==window"))
        assertTrue(s.contains("d.type!=='screentinker:skip'"))
        assertTrue(s.contains("b.skip(t,"))
        assertTrue("the token does not stay in the DOM", s.contains("removeChild(s)"))
        for (bad in listOf("", "a'b", "x;alert(1)", "a".repeat(65))) {
            try { BundleSkip.bridgeScript(bad); error("accepted token '$bad'") } catch (_: IllegalArgumentException) { }
        }
    }
}
