package com.remotedisplay.player.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The layout-mode decision the live update and the offline cached cold-start SHARE.
 *
 * ⚠️ REGRESSION GUARD (zone cold-start flash). The cached restore used to ignore the layout and
 * always render fullscreen, so a 4-zone panel came up as one fullscreen item after a reboot and only
 * snapped into zones when the server reconnected. Both paths now derive from layoutModeOf(); these
 * pin its answers so a zoned payload can never be classified as SINGLE again.
 */
class LayoutModeTest {

    private fun zones(n: Int): JSONArray {
        val a = JSONArray()
        for (i in 0 until n) a.put(JSONObject().put("id", "z$i").put("width_percent", 50.0).put("height_percent", 50.0))
        return a
    }

    private fun payload(layoutZones: JSONArray? = null, wall: JSONObject? = null): JSONObject {
        val p = JSONObject().put("assignments", JSONArray())
        if (wall != null) p.put("wall_config", wall)
        if (layoutZones != null) p.put("layout", JSONObject().put("id", "L1").put("zones", layoutZones))
        return p
    }

    @Test fun `four-zone layout is multi-zone`() {
        assertEquals(LayoutMode.MULTI_ZONE, layoutModeOf(payload(layoutZones = zones(4))))
    }

    @Test fun `two-zone layout is multi-zone`() {
        assertEquals(LayoutMode.MULTI_ZONE, layoutModeOf(payload(layoutZones = zones(2))))
    }

    @Test fun `single-zone layout is SINGLE, not multi-zone`() {
        // A 1-zone layout must NOT spin up the zone manager.
        assertEquals(LayoutMode.SINGLE, layoutModeOf(payload(layoutZones = zones(1))))
    }

    @Test fun `no layout is SINGLE`() {
        assertEquals(LayoutMode.SINGLE, layoutModeOf(payload()))
    }

    @Test fun `explicit null layout is SINGLE (does not throw)`() {
        assertEquals(LayoutMode.SINGLE, layoutModeOf(JSONObject().put("assignments", JSONArray()).put("layout", JSONObject.NULL)))
    }

    @Test fun `wall_config wins over a multi-zone layout`() {
        val p = payload(layoutZones = zones(4), wall = JSONObject().put("rows", 2).put("cols", 2))
        assertEquals(LayoutMode.WALL, layoutModeOf(p))
    }

    @Test fun `explicit null wall_config is not a wall`() {
        val p = payload(layoutZones = zones(3))
        p.put("wall_config", JSONObject.NULL)
        assertEquals(LayoutMode.MULTI_ZONE, layoutModeOf(p))
    }
}
