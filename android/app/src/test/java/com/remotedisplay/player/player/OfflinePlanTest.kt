package com.remotedisplay.player.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #818 the Android offline schedule plan consumer. The contract is shared with
 * server/lib/offline-schedule-plan.js (the builder) and samsung-sssp3/app/offline-plan.js (the other
 * consumer), so the selection and dependency rules asserted here must agree with both.
 *
 * The defect these pin: a panel must NOT replay its last non-empty playlist through an unscheduled
 * gap or past the end of its schedule. The plan is what lets a disconnected panel know "right now is
 * a gap" or "right now is playlist B", with no server.
 */
class OfflinePlanTest {

    private val H = 60L * 60L * 1000L
    private fun at(hour: Long) = java.util.Date.UTC(126, 0, 1, hour.toInt(), 0, 0) // 2026-01-01 UTC

    /** The canonical A / gap / B timeline, 9-10 A, 10-11 gap, 11-12 B, valid 09:00..12:00. */
    private fun planAGapB(): JSONObject {
        val payloadA = JSONObject().put("assignments", JSONArray().put(JSONObject().put("content_id", "a1").put("content_rev", 3)))
        val payloadB = JSONObject().put("assignments", JSONArray().put(JSONObject().put("content_id", "b1").put("content_rev", 1)))
        val payloadGap = JSONObject().put("assignments", JSONArray()).put("default_content", JSONObject().put("content_id", "idle").put("content_rev", 2))
        return JSONObject()
            .put("protocol_version", 1)
            .put("generated_at_utc_ms", at(9))
            .put("valid_until_utc_ms", at(12))
            .put("timezone", "UTC")
            .put("intervals", JSONArray()
                .put(JSONObject().put("start_utc_ms", at(9)).put("end_utc_ms", at(10)).put("schedule_id", "sa").put("playlist_id", "A"))
                .put(JSONObject().put("start_utc_ms", at(10)).put("end_utc_ms", at(11)).put("schedule_id", JSONObject.NULL))
                .put(JSONObject().put("start_utc_ms", at(11)).put("end_utc_ms", at(12)).put("schedule_id", "sb").put("playlist_id", "B")))
            .put("states", JSONArray()
                .put(JSONObject().put("schedule_id", "sa").put("playlist_id", "A").put("payload", payloadA))
                .put(JSONObject().put("schedule_id", "sb").put("playlist_id", "B").put("payload", payloadB))
                .put(JSONObject().put("schedule_id", JSONObject.NULL).put("playlist_id", JSONObject.NULL).put("payload", payloadGap)))
    }

    @Test fun `read rejects anything that is not a trustworthy plan`() {
        assertNull(OfflinePlan.read(null as String?))
        assertNull(OfflinePlan.read(""))
        assertNull(OfflinePlan.read("null"))
        assertNull(OfflinePlan.read("not json"))
        val base = planAGapB().toString()
        assertNull("wrong protocol", OfflinePlan.read(JSONObject(base).put("protocol_version", 2).toString()))
        assertNull("no intervals", OfflinePlan.read(JSONObject(base).apply { remove("intervals") }.toString()))
        assertNull("no states", OfflinePlan.read(JSONObject(base).apply { remove("states") }.toString()))
        assertNull("no validity", OfflinePlan.read(JSONObject(base).apply { remove("valid_until_utc_ms") }.toString()))
        assertTrue("a complete envelope is accepted", OfflinePlan.read(base) != null)
    }

    @Test fun `a time outside the plan validity is not usable - fall back to the plain cache`() {
        val plan = planAGapB()
        assertFalse("before it was generated", OfflinePlan.select(plan, at(8)).valid)
        assertFalse("at/after it expires", OfflinePlan.select(plan, at(12)).valid)
        assertFalse(OfflinePlan.select(plan, at(13)).valid)
    }

    @Test fun `inside a scheduled window the matching state is selected`() {
        val s = OfflinePlan.select(planAGapB(), at(9) + 30 * 60 * 1000L) // 09:30, inside A
        assertTrue(s.valid)
        assertEquals("sa", s.interval!!.optString("schedule_id"))
        assertEquals("a1", s.state!!.optJSONObject("payload")!!.optJSONArray("assignments")!!.optJSONObject(0)!!.optString("content_id"))
    }

    @Test fun `in a gap the idle-default state is selected, never a playlist`() {
        val s = OfflinePlan.select(planAGapB(), at(10) + 1) // just inside the 10-11 gap
        assertTrue(s.valid)
        assertTrue("gap interval has no schedule", s.interval!!.isNull("schedule_id"))
        // Resolves to the default/standby row (empty assignments + default_content), NOT playlist A.
        val payload = s.state!!.optJSONObject("payload")!!
        assertEquals(0, payload.optJSONArray("assignments")!!.length())
        assertEquals("idle", payload.optJSONObject("default_content")!!.optString("content_id"))
    }

    @Test fun `half-open boundaries - the end minute belongs to the next interval`() {
        assertEquals("sa", OfflinePlan.select(planAGapB(), at(9)).interval!!.optString("schedule_id")) // start inclusive
        assertTrue("10:00 is the gap, not A", OfflinePlan.select(planAGapB(), at(10)).interval!!.isNull("schedule_id"))
        assertEquals("sb", OfflinePlan.select(planAGapB(), at(11)).interval!!.optString("schedule_id"))
    }

    @Test fun `statePayloadFor returns the payload to render, or null outside validity`() {
        assertEquals("b1", OfflinePlan.statePayloadFor(planAGapB(), at(11))!!.optJSONArray("assignments")!!.optJSONObject(0)!!.optString("content_id"))
        assertNull(OfflinePlan.statePayloadFor(planAGapB(), at(12)))
    }

    @Test fun `nextTransitionAfter gives the next boundary, for scheduling the rollover`() {
        val plan = planAGapB()
        assertEquals(at(10), OfflinePlan.nextTransitionAfter(plan, at(9) + 1))
        assertEquals(at(11), OfflinePlan.nextTransitionAfter(plan, at(10)))
        assertEquals(at(12), OfflinePlan.nextTransitionAfter(plan, at(11) + 1)) // valid_until is the last edge
        assertNull("nothing left once expired", OfflinePlan.nextTransitionAfter(plan, at(12)))
    }

    @Test fun `dependencies lists every state's media plus default_content, de-duplicated`() {
        val deps = OfflinePlan.dependencies(planAGapB())
        val ids = deps.map { it.optString("content_id") }.sorted()
        assertEquals(listOf("a1", "b1", "idle"), ids)
    }

    @Test fun `dependencies de-dups a shared asset across states but keeps distinct revisions`() {
        val shared = JSONObject().put("content_id", "shared").put("content_rev", 5)
        val sharedNewer = JSONObject().put("content_id", "shared").put("content_rev", 6)
        val plan = JSONObject()
            .put("protocol_version", 1).put("generated_at_utc_ms", at(9)).put("valid_until_utc_ms", at(12))
            .put("intervals", JSONArray()).put("states", JSONArray()
                .put(JSONObject().put("schedule_id", "x").put("payload", JSONObject().put("assignments", JSONArray().put(shared).put(JSONObject(shared.toString())))))
                .put(JSONObject().put("schedule_id", "y").put("payload", JSONObject().put("assignments", JSONArray().put(JSONObject(sharedNewer.toString()))))))
        val deps = OfflinePlan.dependencies(plan)
        assertEquals("rev 5 once (deduped), rev 6 once (distinct)", 2, deps.size)
        assertEquals(listOf(5L, 6L), deps.map { it.optLong("content_rev") }.sorted())
    }
}
