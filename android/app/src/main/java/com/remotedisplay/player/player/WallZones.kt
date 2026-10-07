package com.remotedisplay.player.player

import kotlin.math.abs

/**
 * A HOLD item (server/lib/hold-item.js): shows nothing new for its duration.
 *
 *   hold://blank   the screen (or zone) goes to its background colour
 *   hold://freeze  the last frame of the item before it stays up, paused
 *
 * Stored like a remote link (a remote_url, no file), so it must never be downloaded, never be
 * treated as "needs the network", and never be skipped as an unknown type — skipping one silently
 * shortens the timeline it exists to keep. The server only sends one to a player that declares
 * playback.hold.
 */
object Hold {
    const val MIME = "application/x-st-hold"
    enum class Mode { BLANK, FREEZE }

    fun isHold(mimeType: String?): Boolean = mimeType == MIME

    /** Anything but an explicit freeze is a blank — the same default as the web player. */
    fun mode(remoteUrl: String?): Mode = if (remoteUrl == "hold://freeze") Mode.FREEZE else Mode.BLANK
}

/**
 * Wall zones (server/lib/wall-layout.js): a video wall with a layout. The zones are percentages of
 * the wall's PLAYER RECT, drawn inside the wall-transformed root view, so the wall crop already shows
 * this panel its slice of every zone.
 *
 * Each zone is paced by the SHARED CLOCK, not the leader relay — the same canonical slot rule as the
 * group-sync scheduler (and the web/Tizen players), so a mixed wall agrees on where every zone is.
 *
 * Pure: no Android types, so every rule is tested on a developer machine (WallZonesTest).
 */
object WallZones {

    /** Wall zones are on only for a wall whose payload says canvas_layout AND carries >1 zone. */
    fun active(isWall: Boolean, canvasLayout: Boolean, zoneCount: Int): Boolean =
        isWall && canvasLayout && zoneCount > 1

    data class ZoneGeom(
        val id: String,
        val xPercent: Float, val yPercent: Float,
        val widthPercent: Float, val heightPercent: Float
    )

    /** The zone's rect in canvas units (lib/wall-layout.js zoneCanvasRect). */
    fun canvasRect(z: ZoneGeom, player: WallController.Rect): WallController.Rect = WallController.Rect(
        x = player.x + z.xPercent / 100f * player.w,
        y = player.y + z.yPercent / 100f * player.h,
        w = z.widthPercent / 100f * player.w,
        h = z.heightPercent / 100f * player.h
    )

    /** Strict overlap (lib/wall-layout.js rectsOverlap): a zone that only touches a seam is not seen. */
    fun overlaps(a: WallController.Rect, b: WallController.Rect): Boolean =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

    /** Is [z] visible on the panel whose slice is [screen]? A zone that is not is never mounted. */
    fun visibleOnPanel(z: ZoneGeom, player: WallController.Rect, screen: WallController.Rect): Boolean =
        overlaps(canvasRect(z, player), screen)

    /** A zone's video is heard only on the panel the server named for it; a per-item mute wins. */
    fun audible(zoneId: String, audioZones: Collection<String>, itemMuted: Boolean): Boolean =
        !itemMuted && zoneId in audioZones

    /**
     * Same bucketing as renderZones / ZoneManager: an item on a zone this layout does not have shares
     * the LARGEST zone, and unassigned items (no zone_id) fill the first zone (in layout order) that
     * has nothing of its own. Returns, per zone id, the indices into [itemZoneIds] in sort_order.
     */
    fun buckets(zones: List<ZoneGeom>, itemZoneIds: List<String?>, itemSortOrders: List<Int>): Map<String, List<Int>> {
        if (zones.isEmpty()) return emptyMap()
        val valid = zones.map { it.id }.toHashSet()
        var largest = zones[0]
        for (z in zones) if (z.widthPercent * z.heightPercent > largest.widthPercent * largest.heightPercent) largest = z
        val by = LinkedHashMap<String?, MutableList<Int>>()
        for (i in itemZoneIds.indices) {
            var zid = itemZoneIds[i]
            if (zid != null && zid !in valid) zid = largest.id
            by.getOrPut(zid) { mutableListOf() }.add(i)
        }
        // Stable sort, as Array.prototype.sort is in the web reference.
        for (list in by.values) list.sortBy { itemSortOrders.getOrElse(it) { 0 } }
        val out = LinkedHashMap<String, List<Int>>()
        var unassignedUsed = false
        for (z in zones) {
            var items: List<Int>? = by[z.id]
            if (items.isNullOrEmpty() && !unassignedUsed && by[null] != null) { unassignedUsed = true; items = by[null] }
            out[z.id] = items ?: emptyList()
        }
        return out
    }

    /** One item as the clock scheduler sees it. */
    data class SlotItem(val durationSec: Int, val allowed: Boolean, val isLive: Boolean)

    /**
     * Where a timeline is on the shared clock. [index] / [prevIndex] / [nextIndex] index the list the
     * caller passed; [posSec] is the position inside the current slot; [slotSec] its length.
     */
    data class Target(
        val index: Int,
        val posSec: Float,
        val slotSec: Float,
        val prevIndex: Int,
        val nextIndex: Int,
        val secToBoundary: Float,
        // floor(syncedNow / period): which pass round the timeline this is.
        val cycle: Long = 0L
    )

    /** THE canonical slot length: max(1, duration_sec || 10) seconds. */
    fun slotMs(durationSec: Int): Long = (if (durationSec > 0) durationSec else 10).toLong().coerceAtLeast(1L) * 1000L

    /**
     * Lay [items] on [syncedNowMs]: items the schedule filter excludes are skipped, and so is a live
     * item with no dwell (an infinite slot would swallow the period). Null when nothing has a slot.
     * PlaylistController.groupScheduleTarget delegates here, so the group scheduler and every wall
     * zone share one rule.
     */
    fun target(items: List<SlotItem>, syncedNowMs: Long): Target? {
        var acc = 0L
        val idx = ArrayList<Int>(); val start = ArrayList<Long>(); val dur = ArrayList<Long>()
        for (i in items.indices) {
            val it = items[i]
            if (!it.allowed) continue
            if (it.isLive && it.durationSec <= 0) continue
            val d = slotMs(it.durationSec)
            idx.add(i); start.add(acc); dur.add(d); acc += d
        }
        if (idx.isEmpty() || acc <= 0L) return null
        val phase = ((syncedNowMs % acc) + acc) % acc
        var ci = idx.size - 1
        for (k in idx.indices) if (phase >= start[k] && phase < start[k] + dur[k]) { ci = k; break }
        val n = idx.size
        return Target(
            index = idx[ci],
            posSec = (phase - start[ci]) / 1000f,
            slotSec = dur[ci] / 1000f,
            prevIndex = idx[(ci - 1 + n) % n],
            nextIndex = idx[(ci + 1) % n],
            secToBoundary = (start[ci] + dur[ci] - phase) / 1000f,
            cycle = Math.floorDiv(syncedNowMs, acc)
        )
    }

    /**
     * ⚠️ Loop a clip ONLY when it is shorter than its slot. A clip as long as its slot (the usual case:
     * duration_sec defaults to the clip length) must END and stay on its last frame — looping it wrapped
     * to frame 0 a few ms before the boundary, so a FREEZE hold after it froze the first frame (found on
     * the web player).
     */
    fun shouldLoop(clipSec: Float, slotSec: Float): Boolean = clipSec > 0f && clipSec < slotSec - 0.3f

    /**
     * Where the clip should be for [posSec] into its slot. A looping clip wraps; a clip that plays once
     * is clamped to its end, so the last frame is held instead of being "corrected" back to the start.
     */
    fun clipTargetSec(posSec: Float, clipSec: Float, looping: Boolean): Float =
        if (clipSec <= 0f) posSec else if (looping) posSec % clipSec else minOf(posSec, clipSec)

    /**
     * A clip that plays ONCE and whose slot has outlasted it is DONE: leave it on its last frame. No
     * drift correction (seeking to posSec % duration jumps back to ~frame 0), and a panel that mounts
     * it in this state seeks to duration − 0.05s and pauses.
     */
    fun clipDone(posSec: Float, clipSec: Float, looping: Boolean): Boolean =
        !looping && clipSec > 0f && posSec >= clipSec - 0.05f

    /**
     * When a zone must remount. A zone with ONE slot never changes index, so a VIDEO's key carries the
     * loop cycle too — otherwise a one-shot clip would sit on its last frame forever. Images and pages
     * do not restart per cycle.
     */
    fun mountKey(index: Int, identity: String, isVideo: Boolean, cycle: Long): String =
        if (isVideo) "$index|$identity|c$cycle" else "$index|$identity"

    /** What one drift-correction tick should do (the group-sync maths). */
    enum class Correction { SEEK_ALIGN, ALIGN, SEEK, NUDGE_SLOWER, NUDGE_FASTER, NORMAL }

    const val ALIGN_EPS_SEC = 0.05f
    const val HARD_SEEK_SEC = 0.3f
    const val SEEK_COOLDOWN_MS = 1200L

    /**
     * [driftSec] = current − target. First tick after a mount ([alignPending]) snaps once if off by
     * more than 0.05s; after that a hard seek only past 0.3s AND the 1.2s cooldown (a seek flushes the
     * decoder — seeking every tick on a weak panel spirals to black), else a ±3% rate nudge, else 1.0.
     */
    fun correction(driftSec: Float, alignPending: Boolean, msSinceLastSeek: Long): Correction {
        val ad = abs(driftSec)
        return when {
            alignPending -> if (ad > ALIGN_EPS_SEC) Correction.SEEK_ALIGN else Correction.ALIGN
            ad > HARD_SEEK_SEC && msSinceLastSeek > SEEK_COOLDOWN_MS -> Correction.SEEK
            ad > ALIGN_EPS_SEC -> if (driftSec > 0) Correction.NUDGE_SLOWER else Correction.NUDGE_FASTER
            else -> Correction.NORMAL
        }
    }

    /** The playback rate a correction implies (seeks reset to 1.0). */
    fun rateFor(c: Correction): Float = when (c) {
        Correction.NUDGE_SLOWER -> 0.97f
        Correction.NUDGE_FASTER -> 1.03f
        else -> 1.0f
    }

    /** What a zone must do when the clock lands it on a hold. */
    enum class HoldAction { RELEASE, PAUSE_CURRENT, BUILD_PREVIOUS_AT_END, NOTHING }

    /**
     * FREEZE keeps the zone's current picture, paused. A panel that arrives mid-hold has no picture,
     * so it builds the PREVIOUS slot's item at its last frame — what the other panels are showing. A
     * previous slot that is itself a hold (or nothing) leaves the background. BLANK releases.
     */
    fun holdAction(mode: Hold.Mode, zoneHasPicture: Boolean, prevIsHold: Boolean, hasPrev: Boolean): HoldAction = when {
        mode == Hold.Mode.BLANK -> HoldAction.RELEASE
        zoneHasPicture -> HoldAction.PAUSE_CURRENT
        hasPrev && !prevIsHold -> HoldAction.BUILD_PREVIOUS_AT_END
        else -> HoldAction.NOTHING
    }

    /**
     * A zone's background_color (CSS, as the dashboard writes it) as an ARGB int, or null for
     * transparent. #rgb, #rrggbb and #rrggbbaa (CSS order — alpha LAST, unlike Android's #aarrggbb).
     * Anything else (a name, rgba(), junk) is transparent rather than a crash.
     */
    fun parseCssColor(s: String?): Int? {
        val v = s?.trim()?.lowercase() ?: return null
        if (!v.startsWith("#")) return null
        val hex = v.substring(1)
        if (!hex.all { it in '0'..'9' || it in 'a'..'f' }) return null
        val rgba = when (hex.length) {
            3 -> hex.map { "$it$it" }.joinToString("") + "ff"
            6 -> hex + "ff"
            8 -> hex
            else -> return null
        }
        val r = rgba.substring(0, 2).toInt(16); val g = rgba.substring(2, 4).toInt(16)
        val b = rgba.substring(4, 6).toInt(16); val a = rgba.substring(6, 8).toInt(16)
        return (a shl 24) or (r shl 16) or (g shl 8) or b
    }

    /**
     * The "did the wall config change" key. canvas_layout and audio_zones are part of it: set or clear
     * a wall's layout and nothing else in the config changes.
     */
    fun configKey(
        wallId: String, isLeader: Boolean, rotation: Int,
        screen: WallController.Rect, player: WallController.Rect,
        canvasLayout: Boolean, audioZones: List<String>
    ): String = "$wallId:$isLeader:r$rotation:s${screen.x},${screen.y},${screen.w},${screen.h}:" +
        "p${player.x},${player.y},${player.w},${player.h}:z${if (canvasLayout) 1 else 0}:${audioZones.joinToString(",")}"
}
