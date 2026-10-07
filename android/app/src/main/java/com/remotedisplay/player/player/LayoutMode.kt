package com.remotedisplay.player.player

import org.json.JSONObject

/**
 * How a playlist payload should be rendered.
 *
 * ⚠️ ONE pure decision, shared by the live server update (MainActivity.onPlaylistUpdate) AND the
 * offline cached cold-start restore. They MUST agree: when they diverged, a zoned panel restored
 * from cache rendered one fullscreen rotation (the single-zone path) and only snapped into its zones
 * once the server reconnected, i.e. the "loads fullscreen then jumps to 4 zones" flash. Deriving both
 * from this function is what stops that from silently coming back.
 */
enum class LayoutMode { WALL_ZONES, WALL, MULTI_ZONE, SINGLE }

/** A video wall wins — with its own layout (canvas_layout + >1 zone) it is WALL_ZONES, the zones
 *  drawn across the wall; else a layout with >1 zone is multi-zone; else single/fullscreen. Absent or
 *  1-zone layouts are SINGLE, so a lone-zone layout never spins up the zone manager. */
fun layoutModeOf(data: JSONObject): LayoutMode {
    val layout = if (data.isNull("layout")) null else data.optJSONObject("layout")
    val zones = layout?.optJSONArray("zones")
    if (!data.isNull("wall_config")) {
        val wc = data.optJSONObject("wall_config")
        return if (WallZones.active(true, wc?.optBoolean("canvas_layout", false) == true, zones?.length() ?: 0))
            LayoutMode.WALL_ZONES else LayoutMode.WALL
    }
    if (zones != null && zones.length() > 1) return LayoutMode.MULTI_ZONE
    return LayoutMode.SINGLE
}
