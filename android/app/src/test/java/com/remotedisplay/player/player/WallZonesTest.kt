package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wall zones + hold items (WallZones / Hold). The contract is the web player's (server/player/
 * index.html: wallZoneTarget, wallZoneBuckets, mountWallZoneItem) and server/lib/wall-layout.js.
 * A mixed wall only lines up if every player answers these the same way.
 */
class WallZonesTest {

    private fun slot(d: Int, allowed: Boolean = true, live: Boolean = false) = WallZones.SlotItem(d, allowed, live)
    private fun rect(x: Float, y: Float, w: Float, h: Float) = WallController.Rect(x, y, w, h)
    private fun zone(id: String, x: Float, y: Float, w: Float, h: Float) = WallZones.ZoneGeom(id, x, y, w, h)
    private val eps = 1e-3f

    // ------------------------------------------------------------------ slot rule (shared clock)

    @Test fun `slot length is max(1, duration or 10) seconds`() {
        assertEquals(10_000L, WallZones.slotMs(0))
        assertEquals(10_000L, WallZones.slotMs(-5))
        assertEquals(1_000L, WallZones.slotMs(1))
        assertEquals(30_000L, WallZones.slotMs(30))
    }

    @Test fun `target lays the slots end to end on the clock`() {
        val items = listOf(slot(10), slot(20), slot(30))   // period 60s
        WallZones.target(items, 0L)!!.let {
            assertEquals(0, it.index); assertEquals(0f, it.posSec, eps); assertEquals(10f, it.slotSec, eps)
            assertEquals(2, it.prevIndex); assertEquals(1, it.nextIndex); assertEquals(10f, it.secToBoundary, eps)
        }
        WallZones.target(items, 15_000L)!!.let { assertEquals(1, it.index); assertEquals(5f, it.posSec, eps); assertEquals(0, it.prevIndex) }
        WallZones.target(items, 60_000L * 1000 + 59_500L)!!.let { assertEquals(2, it.index); assertEquals(29.5f, it.posSec, eps) }
    }

    @Test fun `a negative clock still lands inside the period`() {
        val t = WallZones.target(listOf(slot(10), slot(10)), -1_000L)!!
        assertEquals(1, t.index); assertEquals(9f, t.posSec, eps)
    }

    @Test fun `excluded items and dwell-0 live items take no slot, a dwell gt 0 live item does`() {
        val items = listOf(slot(10, allowed = false), slot(0, live = true), slot(5), slot(7, live = true))
        val t0 = WallZones.target(items, 0L)!!
        assertEquals(2, t0.index); assertEquals(3, t0.prevIndex)
        val t1 = WallZones.target(items, 6_000L)!!
        assertEquals(3, t1.index); assertEquals(1f, t1.posSec, eps); assertEquals(7f, t1.slotSec, eps)
        assertEquals("period is 12s", 2, WallZones.target(items, 12_000L)!!.index)
    }

    @Test fun `nothing schedulable means no target`() {
        assertNull(WallZones.target(emptyList(), 123L))
        assertNull(WallZones.target(listOf(slot(10, allowed = false), slot(0, live = true)), 123L))
    }

    @Test fun `a lone slot is its own previous and next`() {
        val t = WallZones.target(listOf(slot(8)), 3_000L)!!
        assertEquals(0, t.index); assertEquals(0, t.prevIndex); assertEquals(0, t.nextIndex)
    }

    @Test fun `two zones with the same period stay locked - the timeline-across-screens case`() {
        // Screen 1: Vid A 30s then hold 60s. Screen 2: hold 30s then Vid B 60s. Both 90s periods.
        val a = listOf(slot(30), slot(60))
        val b = listOf(slot(30), slot(60))
        for (now in listOf(0L, 29_999L, 30_000L, 45_000L, 89_999L, 90_000L * 7 + 12_345L)) {
            val ta = WallZones.target(a, now)!!; val tb = WallZones.target(b, now)!!
            assertEquals(ta.index, tb.index); assertEquals(ta.posSec, tb.posSec, eps)
        }
        val mid = WallZones.target(a, 45_000L)!!
        assertEquals(1, mid.index); assertEquals(15f, mid.posSec, eps); assertEquals("a freeze builds A", 0, mid.prevIndex)
    }

    // ------------------------------------------------------------------ loop / clip position

    @Test fun `loop only a clip clearly shorter than its slot`() {
        assertFalse("as long as its slot: must END on its last frame", WallZones.shouldLoop(10f, 10f))
        assertFalse("within 0.3s of the slot", WallZones.shouldLoop(9.8f, 10f))
        assertTrue(WallZones.shouldLoop(9f, 10f))
        assertFalse("longer than its slot", WallZones.shouldLoop(12f, 10f))
        assertFalse("unknown length", WallZones.shouldLoop(0f, 10f))
    }

    @Test fun `clip target wraps a looping clip and clamps a one-shot clip to its end`() {
        assertEquals(2f, WallZones.clipTargetSec(12f, 5f, looping = true), eps)
        assertEquals(10f, WallZones.clipTargetSec(10.1f, 10f, looping = false), eps)
        assertEquals(4f, WallZones.clipTargetSec(4f, 10f, looping = false), eps)
    }

    // ------------------------------------------------------------------ drift correction

    @Test fun `first tick after a mount aligns, seeking only past 0_05s`() {
        assertEquals(WallZones.Correction.SEEK_ALIGN, WallZones.correction(0.2f, alignPending = true, msSinceLastSeek = 0))
        assertEquals(WallZones.Correction.ALIGN, WallZones.correction(0.04f, alignPending = true, msSinceLastSeek = 0))
    }

    @Test fun `steady state - hard seek past 0_3s only after the cooldown, else nudge, else normal`() {
        assertEquals(WallZones.Correction.SEEK, WallZones.correction(0.5f, false, 1201))
        assertEquals("inside the 1.2s cooldown it nudges", WallZones.Correction.NUDGE_SLOWER, WallZones.correction(0.5f, false, 1200))
        assertEquals(WallZones.Correction.NUDGE_FASTER, WallZones.correction(-0.1f, false, 5000))
        assertEquals(WallZones.Correction.NORMAL, WallZones.correction(0.05f, false, 5000))
        assertEquals(0.97f, WallZones.rateFor(WallZones.Correction.NUDGE_SLOWER), eps)
        assertEquals(1.03f, WallZones.rateFor(WallZones.Correction.NUDGE_FASTER), eps)
        assertEquals(1.0f, WallZones.rateFor(WallZones.Correction.SEEK), eps)
    }

    // ------------------------------------------------------------------ bucketing

    @Test fun `orphans go to the largest zone, unassigned fill the first zone with none, sorted by sort_order`() {
        val zones = listOf(zone("a", 0f, 0f, 30f, 100f), zone("b", 30f, 0f, 70f, 100f), zone("c", 0f, 0f, 10f, 10f))
        val ids = listOf("a", "gone", null, "b", null)
        val sorts = listOf(0, 5, 2, 1, 1)
        val out = WallZones.buckets(zones, ids, sorts)
        assertEquals(listOf(0), out["a"])
        assertEquals("orphan (sort 5) after b's own item (sort 1)", listOf(3, 1), out["b"])
        assertEquals("unassigned -> c, the first zone with nothing of its own", listOf(4, 2), out["c"])
    }

    @Test fun `unassigned items go to one zone only`() {
        val zones = listOf(zone("a", 0f, 0f, 50f, 100f), zone("b", 50f, 0f, 50f, 100f))
        val out = WallZones.buckets(zones, listOf(null, null), listOf(0, 1))
        assertEquals(listOf(0, 1), out["a"]); assertEquals(emptyList<Int>(), out["b"])
    }

    // ------------------------------------------------------------------ visibility / audio

    private val player = rect(0f, 0f, 3840f, 1080f)    // a 2x1 wall
    private val left = rect(0f, 0f, 1920f, 1080f)
    private val right = rect(1920f, 0f, 1920f, 1080f)

    @Test fun `a zone is mounted only on the panels it overlaps`() {
        val leftHalf = zone("l", 0f, 0f, 50f, 100f)
        assertTrue(WallZones.visibleOnPanel(leftHalf, player, left))
        assertFalse("touching the seam is not overlapping", WallZones.visibleOnPanel(leftHalf, player, right))
        val straddle = zone("s", 25f, 25f, 50f, 50f)
        assertTrue(WallZones.visibleOnPanel(straddle, player, left))
        assertTrue(WallZones.visibleOnPanel(straddle, player, right))
    }

    @Test fun `zone canvas rect is percent of the player rect, offset by it`() {
        val r = WallZones.canvasRect(zone("z", 50f, 10f, 25f, 50f), rect(100f, 200f, 1000f, 500f))
        assertEquals(600f, r.x, eps); assertEquals(250f, r.y, eps); assertEquals(250f, r.w, eps); assertEquals(250f, r.h, eps)
    }

    @Test fun `audio only for the server-named zones, and a per-item mute still wins`() {
        assertTrue(WallZones.audible("z1", setOf("z1"), itemMuted = false))
        assertFalse(WallZones.audible("z2", setOf("z1"), itemMuted = false))
        assertFalse(WallZones.audible("z1", setOf("z1"), itemMuted = true))
        assertFalse(WallZones.audible("z1", emptyList(), itemMuted = false))
    }

    @Test fun `wall zones need a wall, canvas_layout and more than one zone`() {
        assertTrue(WallZones.active(isWall = true, canvasLayout = true, zoneCount = 2))
        assertFalse(WallZones.active(isWall = true, canvasLayout = true, zoneCount = 1))
        assertFalse(WallZones.active(isWall = true, canvasLayout = false, zoneCount = 4))
        assertFalse(WallZones.active(isWall = false, canvasLayout = true, zoneCount = 4))
    }

    @Test fun `config key changes when canvas_layout or audio_zones change`() {
        val base = WallZones.configKey("w", false, 0, left, player, false, emptyList())
        assertNotEquals(base, WallZones.configKey("w", false, 0, left, player, true, emptyList()))
        assertNotEquals(WallZones.configKey("w", false, 0, left, player, true, listOf("a")),
            WallZones.configKey("w", false, 0, left, player, true, listOf("b")))
        assertEquals(base, WallZones.configKey("w", false, 0, left, player, false, emptyList()))
    }

    // ------------------------------------------------------------------ holds

    @Test fun `hold mime and modes`() {
        assertTrue(Hold.isHold("application/x-st-hold"))
        assertFalse(Hold.isHold("video/mp4")); assertFalse(Hold.isHold(null))
        assertEquals(Hold.Mode.FREEZE, Hold.mode("hold://freeze"))
        assertEquals(Hold.Mode.BLANK, Hold.mode("hold://blank"))
        assertEquals("anything else is a blank", Hold.Mode.BLANK, Hold.mode(null))
    }

    @Test fun `freeze keeps the zone's picture, or builds the previous item when the panel joined mid-hold`() {
        assertEquals(WallZones.HoldAction.RELEASE, WallZones.holdAction(Hold.Mode.BLANK, true, false, true))
        assertEquals(WallZones.HoldAction.PAUSE_CURRENT, WallZones.holdAction(Hold.Mode.FREEZE, true, false, true))
        assertEquals(WallZones.HoldAction.BUILD_PREVIOUS_AT_END, WallZones.holdAction(Hold.Mode.FREEZE, false, false, true))
        assertEquals(WallZones.HoldAction.NOTHING, WallZones.holdAction(Hold.Mode.FREEZE, false, prevIsHold = true, hasPrev = true))
        assertEquals(WallZones.HoldAction.NOTHING, WallZones.holdAction(Hold.Mode.FREEZE, false, false, hasPrev = false))
    }

    @Test fun `a hold ends on its timer and never needs the network`() {
        assertTrue(ItemTiming.endsOnTimer(Hold.MIME, isWidget = false))
        val hold = PlaylistItem(assignmentId = 1, contentId = "h", filename = "Hold", mimeType = Hold.MIME,
            filepath = "", durationSec = 30, fileSize = 0, sortOrder = 0, remoteUrl = "hold://freeze")
        assertFalse(OfflineGate.needsNetwork(hold))
    }

    // ------------------------------------------------------------------ colour

    @Test fun `zone background colour parses CSS hex, anything else is transparent`() {
        assertEquals(0xFF112233.toInt(), WallZones.parseCssColor("#112233"))
        assertEquals(0xFFAABBCC.toInt(), WallZones.parseCssColor("#abc"))
        assertEquals("CSS #rrggbbaa: alpha last", 0x80112233.toInt(), WallZones.parseCssColor("#11223380"))
        assertNull(WallZones.parseCssColor("transparent"))
        assertNull(WallZones.parseCssColor(null))
        assertNull(WallZones.parseCssColor("#12345"))
        assertNull(WallZones.parseCssColor("#gggggg"))
    }

    // ------------------------------------------------------------------ addendum

    @Test fun `a one-shot clip whose slot outlasted it is done, a looping or still-running one is not`() {
        assertTrue(WallZones.clipDone(10.2f, 10f, looping = false))
        assertTrue("within 0.05s of the end", WallZones.clipDone(9.96f, 10f, looping = false))
        assertFalse(WallZones.clipDone(9.9f, 10f, looping = false))
        assertFalse("a looping clip is never done", WallZones.clipDone(12f, 10f, looping = true))
        assertFalse("unknown length", WallZones.clipDone(5f, 0f, looping = false))
    }

    @Test fun `target carries the loop cycle, floor(now over period)`() {
        val items = listOf(slot(10), slot(20))   // period 30s
        assertEquals(0L, WallZones.target(items, 29_999L)!!.cycle)
        assertEquals(1L, WallZones.target(items, 30_000L)!!.cycle)
        assertEquals(-1L, WallZones.target(items, -1L)!!.cycle)
    }

    @Test fun `a one-slot zone remounts its video every cycle, but not its image`() {
        val one = listOf(slot(12))
        val a = WallZones.target(one, 11_000L)!!; val b = WallZones.target(one, 13_000L)!!
        assertEquals("one slot never changes index", a.index, b.index)
        assertNotEquals(WallZones.mountKey(a.index, "vid", true, a.cycle), WallZones.mountKey(b.index, "vid", true, b.cycle))
        assertEquals(WallZones.mountKey(a.index, "img", false, a.cycle), WallZones.mountKey(b.index, "img", false, b.cycle))
    }
}
