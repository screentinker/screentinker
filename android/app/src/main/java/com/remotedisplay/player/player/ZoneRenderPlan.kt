package com.remotedisplay.player.player

import org.json.JSONObject

/**
 * Which zones a playlist update re-renders. Pure, so it is unit-tested without Android views.
 *
 * ⚠️ Only the zones whose OWN items changed. Every zone used to be torn down on any change, and a
 * weather widget's data refresh bumps its rev every few minutes, so a camera or video in the next
 * zone went black each time.
 */
object ZoneRenderPlan {
    /**
     * One assignment's structural signature: what decides how it renders. Widget rev is in it (an
     * edit changes the content, never the id); a live item's URL and certificate rule decide how it
     * connects (the full-screen path does this through liveConnectionOf); #660's see-through tick
     * changes the render URL. MainActivity's whole-playlist signature is built from the same strings.
     */
    fun itemSig(a: JSONObject): String =
        "${a.optString("content_id")}:${a.optString("zone_id")}:${a.optString("widget_id")}:${a.optLong("widget_rev", 0L)}" +
            (if (a.optString("mime_type") == "video/rtsp" || a.optString("mime_type") == "video/hls")
                ":${a.optString("remote_url")}" + (if (a.optInt("tls_self_signed", 0) == 1) ":tls-self-signed" else "") else "") +
            (if (a.optInt("transparent_bg", 0) == 1) ":t" else "") +
            // What the zone's rotation reads from these objects. A zone left playing keeps its old
            // JSONObjects, so an edit to any of these has to re-render that zone (and only it), or a
            // new schedule, a disabled item or a new dwell never reached a zone that kept playing.
            ":${a.optInt("duration_sec", 0)}:${a.optInt("enabled", 1)}:${a.optString("fit_mode")}:${a.optInt("muted", 0)}" +
            ":${a.optString("play_from")}:${a.optString("play_until")}:${a.opt("schedules") ?: ""}:${a.opt("play_when") ?: ""}"

    /** A zone's items in play order: a reorder is a change, so it is NOT sorted here. */
    fun zoneSig(items: List<JSONObject>): String = items.joinToString("|") { itemSig(it) }

    /** Does this zone need re-rendering? Yes when it is new or its items changed. */
    fun needsRender(rendered: Map<String, String>, zoneId: String, sig: String): Boolean = rendered[zoneId] != sig

    /** Zones rendered before that now have nothing of their own: they are cleared. */
    fun zonesToClear(rendered: Map<String, String>, wanted: Map<String, String>): Set<String> = rendered.keys - wanted.keys
}
