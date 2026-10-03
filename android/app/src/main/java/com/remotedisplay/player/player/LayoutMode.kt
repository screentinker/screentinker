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
enum class LayoutMode { WALL, MULTI_ZONE, SINGLE }

/** A video wall wins; else a layout with >1 zone is multi-zone; else single/fullscreen. Absent or
 *  1-zone layouts are SINGLE, so a lone-zone layout never spins up the zone manager. */
fun layoutModeOf(data: JSONObject): LayoutMode {
    if (!data.isNull("wall_config")) return LayoutMode.WALL
    val layout = if (data.isNull("layout")) null else data.optJSONObject("layout")
    val zones = layout?.optJSONArray("zones")
    if (zones != null && zones.length() > 1) return LayoutMode.MULTI_ZONE
    return LayoutMode.SINGLE
}
