package com.remotedisplay.player.remote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 3.0 screen share: the Android receiver's wire handling, held to what the server relay
 * (server/lib/screen-share.js) sends and accepts and what the web receiver
 * (server/lib/screen-share-player.js) does with the same messages.
 */
class ScreenShareProtocolTest {

    private fun startJson() = JSONObject()
        .put("session_id", "abc_DEF-123")
        .put("shared_by", "Gail")
        .put("guest", true)
        .put("audio", true)
        .put("max_seconds", 1800)
        .put("ice_servers", JSONArray().put(JSONObject().put("urls", "stun:stun.example:3478")))

    @Test fun parsesAStart() {
        val s = ScreenShareProtocol.parseStart(startJson())!!
        assertEquals("abc_DEF-123", s.sessionId)
        assertEquals("Gail", s.sharedBy)
        assertTrue(s.guest)
        assertEquals(1800, s.maxSeconds)
        assertEquals(1, s.iceServers.length())
    }

    @Test fun refusesAStartWithoutAUsableSessionId() {
        assertNull(ScreenShareProtocol.parseStart(null))
        assertNull(ScreenShareProtocol.parseStart(JSONObject()))
        assertNull(ScreenShareProtocol.parseStart(startJson().put("session_id", 42)))
        assertNull(ScreenShareProtocol.parseStart(startJson().put("session_id", "../../x")))
        assertNull(ScreenShareProtocol.parseStart(startJson().put("session_id", "")))
    }

    @Test fun missingOptionalFieldsDefault() {
        val s = ScreenShareProtocol.parseStart(JSONObject().put("session_id", "s1"))!!
        assertEquals("", s.sharedBy)
        assertFalse(s.guest)
        assertEquals(3600, s.maxSeconds)
        assertEquals(0, s.iceServers.length())
    }

    @Test fun cleansTheNameItShowsOnTheTv() {
        // A guest typed it: bidi overrides, zero-width and control characters go, length is bounded.
        assertEquals("evil txt", ScreenShareProtocol.cleanName("evil‮​\ttxt"))
        assertEquals(40, ScreenShareProtocol.cleanName("x".repeat(100)).length)
        assertEquals("", ScreenShareProtocol.cleanName(null))
    }

    @Test fun localBackstopClampsLikeTheWebReceiver() {
        assertEquals(60_000L + 5000L, ScreenShareProtocol.maxDurationMs(5))
        assertEquals(1800_000L + 5000L, ScreenShareProtocol.maxDurationMs(1800))
        assertEquals(8 * 3600_000L + 5000L, ScreenShareProtocol.maxDurationMs(999_999))
    }

    @Test fun signallingUrlNeverCarriesTheToken() {
        assertEquals("wss://signage.example.com/api/devices/dev-1/screen-share/ws",
            ScreenShareProtocol.wsUrl("https://signage.example.com/", "dev-1"))
        assertEquals("ws://10.0.0.5:3001/st/api/devices/d%2F2/screen-share/ws",
            ScreenShareProtocol.wsUrl("http://10.0.0.5:3001/st", "d/2"))
    }

    @Test fun authIsTheFirstMessageShape() {
        val o = JSONObject(ScreenShareProtocol.authMessage("tok", "s1"))
        assertEquals("auth", o.getString("type"))
        assertEquals("tok", o.getString("device_token"))
        assertEquals("s1", o.getString("session_id"))
    }

    @Test fun offerAndCandidatesUseGo2rtcShape() {
        val offer = JSONObject(ScreenShareProtocol.offerMessage("v=0\r\n"))
        assertEquals("webrtc/offer", offer.getString("type"))
        assertEquals("v=0\r\n", offer.getString("value"))
        val c = JSONObject(ScreenShareProtocol.candidateMessage("candidate:1 1 udp 1 1.2.3.4 5 typ host", "0", 0))
        assertEquals("webrtc/candidate", c.getString("type"))
        assertEquals("0", c.getString("mid"))
        assertEquals(0, c.getInt("mline"))
        val bare = JSONObject(ScreenShareProtocol.candidateMessage("candidate:x", null, null))
        assertFalse(bare.has("mid")); assertFalse(bare.has("mline"))
    }

    @Test fun statesAreOnlyTheOnesTheRelayAccepts() {
        for (s in listOf("connecting", "connected", "playing", "failed", "disconnected", "unsupported")) {
            assertEquals(s, JSONObject(ScreenShareProtocol.stateMessage(s)).getString("value"))
        }
        try { ScreenShareProtocol.stateMessage("hacked"); throw AssertionError("accepted an unknown state") }
        catch (_: IllegalArgumentException) {}
    }

    @Test fun parsesWhatTheRelaySends() {
        assertTrue(ScreenShareProtocol.parseIncoming("""{"type":"ready","session_id":"s1"}""") is ScreenShareProtocol.Incoming.Ready)
        val a = ScreenShareProtocol.parseIncoming("""{"type":"webrtc/answer","value":"v=0\r\nx"}""")
        assertEquals("v=0\r\nx", (a as ScreenShareProtocol.Incoming.Answer).sdp)
        val c = ScreenShareProtocol.parseIncoming("""{"type":"webrtc/candidate","value":"candidate:1","mid":"1"}""")
        assertEquals(ScreenShareProtocol.Incoming.Candidate("candidate:1", "1", 0), c)
        val c2 = ScreenShareProtocol.parseIncoming("""{"type":"webrtc/candidate","value":"candidate:1","mline":1}""")
        assertEquals(ScreenShareProtocol.Incoming.Candidate("candidate:1", null, 1), c2)
        assertEquals(ScreenShareProtocol.Incoming.Ended("max_duration"),
            ScreenShareProtocol.parseIncoming("""{"type":"ended","reason":"max_duration"}"""))
        assertEquals(ScreenShareProtocol.Incoming.Ended("ended"), ScreenShareProtocol.parseIncoming("""{"type":"ended"}"""))
    }

    @Test fun ignoresJunk() {
        for (t in listOf(null, "", "nope", "[]", """{"type":"webrtc/answer","value":"not sdp"}""",
                """{"type":"webrtc/answer","value":5}""", """{"type":"webrtc/candidate","value":""}""", """{"type":"screen_joined"}""")) {
            assertTrue("should ignore $t", ScreenShareProtocol.parseIncoming(t) is ScreenShareProtocol.Incoming.Ignored)
        }
    }

    @Test fun aLateStopForAnOlderShareDoesNotEndTheCurrentOne() {
        assertTrue(ScreenShareProtocol.stopApplies("s2", "s2"))
        assertTrue(ScreenShareProtocol.stopApplies("s2", null))
        assertTrue(ScreenShareProtocol.stopApplies("s2", ""))
        assertFalse(ScreenShareProtocol.stopApplies("s2", "s1"))
        assertFalse(ScreenShareProtocol.stopApplies(null, "s1"))
    }

    @Test fun badgeMatchesTheWebPlayer() {
        assertEquals("Shared by Gail · guest", ScreenShareProtocol.badgeText("Shared by {name}", "guest", "Gail", true))
        assertEquals("Shared by Ann", ScreenShareProtocol.badgeText("Shared by {name}", "guest", "Ann", false))
    }

    @Test fun codeOnlyTakesAPngDataUrlAsTheQr() {
        val ok = ScreenShareProtocol.parseCode(JSONObject().put("code", "K7QM-3XHP").put("url", "https://signage.example.com/share")
            .put("qr", "data:image/png;base64,iVBORw0KGgo="))!!
        assertEquals("K7QM-3XHP", ok.code)
        assertEquals("signage.example.com/share", ok.shownUrl)
        assertEquals("iVBORw0KGgo=", ok.qrPngBase64)
        val evil = ScreenShareProtocol.parseCode(JSONObject().put("code", "K7QM-3XHP").put("qr", "https://evil.example/x.png"))!!
        assertNull(evil.qrPngBase64)
        assertEquals("/share", evil.shownUrl)
        assertNull(ScreenShareProtocol.parseCode(JSONObject().put("code", JSONObject.NULL)))
        assertNull(ScreenShareProtocol.parseCode(null))
    }

    @Test fun letterboxFitsLikeObjectFitContain() {
        assertEquals(Pair(1920, 1080), ScreenShareProtocol.fit(1920, 1080, 1280, 720))
        assertEquals(Pair(1440, 1080), ScreenShareProtocol.fit(1920, 1080, 1024, 768))   // pillarbox
        assertEquals(Pair(1080, 607), ScreenShareProtocol.fit(1080, 1920, 1920, 1080))   // portrait panel
        assertEquals(Pair(100, 50), ScreenShareProtocol.fit(100, 50, 0, 0))
    }

    // ------------------------------------------------------------ several presenters at once

    @Test fun startCarriesWhetherThePresenterSharesSound() {
        assertTrue(ScreenShareProtocol.parseStart(startJson())!!.audio)
        assertFalse(ScreenShareProtocol.parseStart(startJson().put("audio", false))!!.audio)
        assertFalse(ScreenShareProtocol.parseStart(startJson().apply { remove("audio") })!!.audio)
        assertFalse(ScreenShareProtocol.parseStart(startJson().put("audio", "yes"))!!.audio)
    }

    private fun r(x: Float, y: Float, w: Float, h: Float) = ScreenShareProtocol.Rect(x, y, w, h)

    @Test fun rectsAreTheWebReceiversExactly() {
        // server/lib/screen-share-player.js rects(n, portrait)
        val full = listOf(r(0f, 0f, 1f, 1f))
        assertEquals(full, ScreenShareProtocol.rects(0, false))
        assertEquals(full, ScreenShareProtocol.rects(1, false))
        assertEquals(full, ScreenShareProtocol.rects(1, true))
        assertEquals(listOf(r(0f, 0f, .5f, 1f), r(.5f, 0f, .5f, 1f)), ScreenShareProtocol.rects(2, false))
        assertEquals(listOf(r(0f, 0f, 1f, .5f), r(0f, .5f, 1f, .5f)), ScreenShareProtocol.rects(2, true))
        val three = listOf(r(0f, 0f, .5f, .5f), r(.5f, 0f, .5f, .5f), r(.25f, .5f, .5f, .5f))   // third centred underneath
        assertEquals(three, ScreenShareProtocol.rects(3, false))
        assertEquals(three, ScreenShareProtocol.rects(3, true))
        val four = listOf(r(0f, 0f, .5f, .5f), r(.5f, 0f, .5f, .5f), r(0f, .5f, .5f, .5f), r(.5f, .5f, .5f, .5f))
        assertEquals(four, ScreenShareProtocol.rects(4, false))
        assertEquals(four, ScreenShareProtocol.rects(4, true))
    }

    @Test fun aFrameOnlyWhenSeveralTilesShow() {
        assertEquals(0, ScreenShareProtocol.tileBorderPx(1))
        assertEquals(2, ScreenShareProtocol.tileBorderPx(2))
        assertEquals(2, ScreenShareProtocol.tileBorderPx(4))
    }

    private fun layout(spot: String?, audio: String?) = ScreenShareProtocol.Layout(spot, audio, 0)

    @Test fun visibleIdsFollowTheSpotlightOnlyWhenItIsLive() {
        val order = listOf("a", "b", "c")
        assertEquals(order, ScreenShareProtocol.visibleIds(order, ScreenShareProtocol.Layout.NONE))
        assertEquals(listOf("b"), ScreenShareProtocol.visibleIds(order, layout("b", null)))
        assertEquals(order, ScreenShareProtocol.visibleIds(order, layout("gone", null)))   // not ours: tiles
        assertEquals(listOf("a", "b", "c", "d"), ScreenShareProtocol.visibleIds(listOf("a", "b", "c", "d", "e"), ScreenShareProtocol.Layout.NONE))
        assertEquals(emptyList<String>(), ScreenShareProtocol.visibleIds(emptyList(), layout("a", null)))
    }

    @Test fun audioIsTheLayoutsWhenLiveElseTheNewest() {
        val order = listOf("a", "b", "c")
        assertEquals("a", ScreenShareProtocol.audioId(order, layout(null, "a")))
        assertEquals("c", ScreenShareProtocol.audioId(order, layout(null, null)))
        assertEquals("c", ScreenShareProtocol.audioId(order, layout("a", "gone")))
        assertNull(ScreenShareProtocol.audioId(emptyList(), layout(null, "a")))
    }

    @Test fun parsesTheLayoutEvent() {
        val l = ScreenShareProtocol.parseLayout(JSONObject().put("spotlight", "s_1").put("audio", "s-2").put("count", 3))
        assertEquals(ScreenShareProtocol.Layout("s_1", "s-2", 3), l)
        assertEquals(ScreenShareProtocol.Layout(null, null, 2),
            ScreenShareProtocol.parseLayout(JSONObject().put("spotlight", JSONObject.NULL).put("audio", JSONObject.NULL).put("count", 2)))
    }

    @Test fun aBadLayoutEventIsNoPreference() {
        assertEquals(ScreenShareProtocol.Layout.NONE, ScreenShareProtocol.parseLayout(null))
        assertEquals(ScreenShareProtocol.Layout.NONE, ScreenShareProtocol.parseLayout(JSONObject()))
        assertEquals(ScreenShareProtocol.Layout.NONE, ScreenShareProtocol.parseLayout(
            JSONObject().put("spotlight", 42).put("audio", true).put("count", "x")))
        assertEquals(ScreenShareProtocol.Layout.NONE, ScreenShareProtocol.parseLayout(
            JSONObject().put("spotlight", "../x").put("audio", "").put("count", -1)))
    }

    @Test fun aFifthStartReplacesTheOldest() {
        assertEquals(emptyList<String>(), ScreenShareProtocol.toReplace(emptyList()))
        assertEquals(emptyList<String>(), ScreenShareProtocol.toReplace(listOf("a", "b", "c")))
        assertEquals(listOf("a"), ScreenShareProtocol.toReplace(listOf("a", "b", "c", "d")))
        assertEquals(listOf("a", "b"), ScreenShareProtocol.toReplace(listOf("a", "b", "c", "d", "e")))
    }
}
