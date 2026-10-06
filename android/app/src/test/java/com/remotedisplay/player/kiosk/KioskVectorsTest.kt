package com.remotedisplay.player.kiosk

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * #473: KioskLogic.kt against shared/kiosk-vectors.json — the same file the JS players
 * (server/test/kiosk-logic.test.js) and the native player (tests/test_kiosk.py) are held to.
 */
class KioskVectorsTest {
    private val v: JsonObject by lazy {
        val path = System.getProperty("kioskVectors") ?: error("kioskVectors system property not set (app/build.gradle.kts)")
        JsonParser.parseString(File(path).readText()).asJsonObject
    }

    private fun strList(a: JsonArray): List<String> = a.map { it.asString }

    @Test fun parse() {
        for (el in v.getAsJsonArray("parse")) {
            val o = el.asJsonObject
            val cfgEl = o.get("config")
            val cfg = if (cfgEl.isJsonPrimitive) cfgEl.asString else cfgEl.toString()
            val got = KioskConfig.parse(o.get("type").asString, cfg)
            val name = o.get("name").asString
            val exp = o.get("expect")
            if (exp.isJsonNull) { assertEquals(name, null, got); continue }
            val e = exp.asJsonObject
            requireNotNull(got) { "$name: expected a config" }
            assertEquals(name, e.get("url").asString, got.url)
            assertEquals(name, e.get("idleTimeoutSec").asInt, got.idleTimeoutSec)
            assertEquals(name, e.get("warnSec").asInt, got.warnSec)
            assertEquals(name, strList(e.getAsJsonArray("allowedDomains")), got.allowedDomains)
            assertEquals(name, if (e.get("minWebView").isJsonNull) null else e.get("minWebView").asInt, got.minWebView)
            assertEquals(name, e.get("keepConsent").asBoolean, got.keepConsent)
            assertEquals(name, strList(e.getAsJsonArray("keepCookieNames")), got.keepCookieNames)
            assertEquals(name, e.get("homeButton").asBoolean, got.homeButton)
            assertEquals(name, e.get("zoomPct").asInt, got.zoomPct)
            assertEquals(name, e.get("wipeSiteData").asBoolean, got.wipeSiteData)
        }
    }

    @Test fun isAllowed() {
        for (el in v.getAsJsonArray("isAllowed")) {
            val o = el.asJsonObject
            assertEquals(o.get("url").asString, o.get("expect").asBoolean,
                KioskNav.isAllowed(o.get("url").asString, strList(o.getAsJsonArray("allowed"))))
        }
    }

    @Test fun selectCookies() {
        for (el in v.getAsJsonArray("selectCookies")) {
            val o = el.asJsonObject
            val p = o.get("patterns")
            val pats = if (p.isJsonPrimitive && p.asString == "BUILT_IN") CookieKeep.BUILT_IN else strList(p.asJsonArray)
            val exp = o.getAsJsonArray("expect").map { val a = it.asJsonArray; a[0].asString to a[1].asString }
            assertEquals(o.get("name").asString, exp, CookieKeep.select(o.get("header").asString, pats))
        }
    }

    private fun action(e: JsonElement): KioskIdle.Action = when {
        e.isJsonObject -> KioskIdle.Action.Warn(e.asJsonObject.get("warn").asInt)
        else -> when (e.asString) {
            "started" -> KioskIdle.Action.Started; "resumed" -> KioskIdle.Action.Resumed
            "reset" -> KioskIdle.Action.Reset; else -> KioskIdle.Action.None
        }
    }

    @Test fun idle() {
        for (el in v.getAsJsonArray("idle")) {
            val o = el.asJsonObject
            val k = KioskIdle(o.get("idleMs").asLong, o.get("warnMs").asLong)
            for (s in o.getAsJsonArray("steps")) {
                val a = s.asJsonArray
                val t = a[1].asLong
                val got = when (a[0].asString) { "touch" -> k.onTouch(t); "keepAlive" -> k.keepAlive(t); else -> k.tick(t) }
                assertEquals("${o.get("name").asString}: ${a[0].asString}@$t", action(a[2]), got)
            }
        }
    }

    @Test fun isStartPage() {
        for (el in v.getAsJsonArray("isStartPage")) {
            val o = el.asJsonObject
            val url = if (o.get("url").isJsonNull) null else o.get("url").asString
            assertEquals(url.toString(), o.get("expect").asBoolean, isStartPage(url, o.get("start").asString))
        }
    }

    @Test fun errorThrottle() {
        for (el in v.getAsJsonArray("errorThrottle")) {
            val o = el.asJsonObject
            val th = ErrorThrottle(o.get("windowMs").asLong)
            for (s in o.getAsJsonArray("steps")) {
                val a = s.asJsonArray
                assertEquals("${a[0].asString} ${a[1].asString}", a[3].asBoolean, th.shouldReport(a[0].asString, a[1].asString, a[2].asLong))
            }
        }
    }

    @Test fun chromeMajor() {
        for (el in v.getAsJsonArray("chromeMajor")) {
            val o = el.asJsonObject
            assertEquals(if (o.get("expect").isJsonNull) null else o.get("expect").asInt, WebViewVersion.chromeMajor(o.get("ua").asString))
        }
    }
}
