package com.remotedisplay.player.player

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ZoneRenderPlanTest {
    private fun cam() = JSONObject().put("content_id", "cam").put("zone_id", "main").put("mime_type", "video/rtsp")
        .put("remote_url", "rtsps://10.0.0.2:7441/x")
    private fun weather(rev: Long) = JSONObject().put("widget_id", "w").put("zone_id", "side").put("widget_rev", rev)

    @Test fun `a weather refresh re-renders only the weather zone`() {
        // ⚠️ The bug: a widget's data refresh bumped its rev and every zone was torn down, so the
        // camera in the main zone reconnected and went black every few minutes.
        val rendered = mapOf("main" to ZoneRenderPlan.zoneSig(listOf(cam())), "side" to ZoneRenderPlan.zoneSig(listOf(weather(1))))
        assertFalse(ZoneRenderPlan.needsRender(rendered, "main", ZoneRenderPlan.zoneSig(listOf(cam()))))
        assertTrue(ZoneRenderPlan.needsRender(rendered, "side", ZoneRenderPlan.zoneSig(listOf(weather(2)))))
    }

    @Test fun `a new zone renders and a zone left empty is cleared`() {
        val rendered = mapOf("main" to "a", "side" to "b")
        assertTrue(ZoneRenderPlan.needsRender(rendered, "ticker", "c"))
        assertEquals(setOf("side"), ZoneRenderPlan.zonesToClear(rendered, mapOf("main" to "a", "ticker" to "c")))
    }

    @Test fun `a reorder within a zone is a change`() {
        val a = JSONObject().put("content_id", "A").put("zone_id", "z")
        val b = JSONObject().put("content_id", "B").put("zone_id", "z")
        assertNotEquals(ZoneRenderPlan.zoneSig(listOf(a, b)), ZoneRenderPlan.zoneSig(listOf(b, a)))
    }

    @Test fun `a camera's new address or certificate rule reconnects it`() {
        val before = ZoneRenderPlan.itemSig(cam())
        assertNotEquals(before, ZoneRenderPlan.itemSig(cam().put("remote_url", "rtsps://10.0.0.3:7441/x")))
        assertNotEquals(before, ZoneRenderPlan.itemSig(cam().put("tls_self_signed", 1)))
    }

    @Test fun `an edit the zone's rotation reads re-renders that zone`() {
        // A zone left playing keeps its old JSONObjects, so these edits must count as a change.
        val clock = { JSONObject().put("widget_id", "clock").put("zone_id", "corner").put("duration_sec", 20) }
        val before = ZoneRenderPlan.itemSig(clock())
        assertNotEquals(before, ZoneRenderPlan.itemSig(clock().put("duration_sec", 45)))
        assertNotEquals(before, ZoneRenderPlan.itemSig(clock().put("enabled", 0)))
        assertNotEquals(before, ZoneRenderPlan.itemSig(clock().put("play_from", "2026-11-02T08:00")))
        assertNotEquals(before, ZoneRenderPlan.itemSig(clock().put("schedules", org.json.JSONArray().put(JSONObject().put("days", "1-5")))))
        assertNotEquals(before, ZoneRenderPlan.itemSig(clock().put("fit_mode", "cover")))
        assertNotEquals(before, ZoneRenderPlan.itemSig(clock().put("muted", 1)))
        assertEquals(before, ZoneRenderPlan.itemSig(clock()))
    }
}
