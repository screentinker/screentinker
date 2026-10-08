package com.remotedisplay.player.audience

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The counting half of audience counting: boxes in, per-minute integers out. These pin the rules
 * the server validates (server/lib/audience.js), so a player can never produce a bucket it refuses.
 */
class AudienceAggregatorTest {
    private val promo = ScreenItem("content", "c-1")
    private val clock = ScreenItem("widget", "w-1")
    private val face = FaceBox(0.5f, 0.5f, 0.2f)
    private val T0 = 1_700_000_040_000L          // the start of a minute (1_700_000_040 % 60 == 0)

    /** Run [faces] at [fps] from [fromMs] for [ms], returning every bucket that closed. */
    private fun AudienceAggregator.run(faces: List<FaceBox>, fromMs: Long, ms: Long, fps: Int = 2): List<AudienceBucket> {
        val out = ArrayList<AudienceBucket>()
        var t = fromMs
        while (t < fromMs + ms) { out += onFrame(faces, t); t += 1000L / fps }
        return out
    }

    @Test fun aSingleFrameFlickerCountsAsNobody() {
        val a = AudienceAggregator()
        a.item = promo
        a.onFrame(listOf(face), T0)
        a.run(emptyList(), T0 + 500, 5_000)
        val b = a.flushAll(T0 + 6_000).single()
        assertEquals(0, b.arrivals)
        assertEquals(0, b.presentMax)
    }

    @Test fun aLookIsOneArrivalOneImpressionCountedWhenItEnds() {
        val a = AudienceAggregator(minDwellMs = 1000)
        a.item = promo
        a.run(listOf(face), T0, 4_000)                 // 4s in view
        a.run(emptyList(), T0 + 4_000, 3_000)          // then gone long enough to end the track
        val b = a.flushAll(T0 + 8_000).single()
        assertEquals(1, b.arrivals)
        assertEquals(1, b.impressions)
        assertEquals(1, b.presentMax)
        assertEquals(1, b.dwell[1])                    // 2-5s
        assertTrue("average presence reflects the frames with someone in them", b.presentAvgX100() in 40..70)
    }

    @Test fun aGlanceShorterThanMinDwellIsAnArrivalButNotAnImpression() {
        val a = AudienceAggregator(minDwellMs = 2000)
        a.item = promo
        a.run(listOf(face), T0, 1_000)
        a.run(emptyList(), T0 + 1_000, 3_000)
        val b = a.flushAll(T0 + 5_000).single()
        assertEquals(1, b.arrivals)
        assertEquals(0, b.impressions)
        assertEquals(1, b.dwell[0])
    }

    @Test fun twoPeopleAreTwoTracksAndTheMaxIsTwo() {
        val a = AudienceAggregator()
        a.item = promo
        a.run(listOf(face, FaceBox(0.15f, 0.4f, 0.15f)), T0, 3_000)
        a.run(emptyList(), T0 + 3_000, 3_000)
        val b = a.flushAll(T0 + 7_000).single()
        assertEquals(2, b.arrivals)
        assertEquals(2, b.presentMax)
    }

    @Test fun aFaceMovingSlowlyStaysOneTrack() {
        val a = AudienceAggregator()
        a.item = promo
        var t = T0
        for (i in 0 until 10) { a.onFrame(listOf(FaceBox(0.4f + i * 0.01f, 0.5f, 0.2f)), t); t += 500 }
        a.run(emptyList(), t, 3_000)
        assertEquals(1, a.flushAll(t + 4_000).single().arrivals)
    }

    @Test fun bucketsCloseAtTheMinuteAndAreAttributedToTheItemTheyCameFor() {
        val a = AudienceAggregator()
        a.item = promo
        a.run(listOf(face), T0 + 50_000, 5_000)        // confirmed while the promo is on screen
        a.item = clock                                  // the item changes mid-look
        val closed = a.run(listOf(face), T0 + 55_000, 10_000)   // crosses into the next minute
        val first = closed.filter { it.start == T0 / 1000 }
        assertTrue("the first minute closed once the next began", first.isNotEmpty())
        a.run(emptyList(), T0 + 65_000, 3_000)
        val rest = a.flushAll(T0 + 70_000)
        val promoNext = rest.single { it.item == promo }
        assertEquals("counted in the minute it ENDED, for the item it came to look at", 1, promoNext.arrivals)
        assertEquals((T0 + 60_000) / 1000, promoNext.start)
        assertTrue(rest.any { it.item == clock && it.frames > 0 })
    }

    @Test fun everyBucketIsAShapeTheServerAccepts() {
        val a = AudienceAggregator()
        a.item = promo
        a.run(listOf(face, FaceBox(0.2f, 0.2f, 0.1f)), T0, 30_000)
        a.run(emptyList(), T0 + 30_000, 3_000)
        a.item = ScreenItem.NONE
        a.run(listOf(face), T0 + 33_000, 1_000)
        for (b in a.flushAll(T0 + 40_000)) {
            val o = b.toJson()
            val keys = o.keys().asSequence().toSet()
            assertTrue("only the keys the server names: $keys",
                keys.all { it in setOf("id", "start", "seconds", "item_kind", "item_id", "present_max", "present_avg_x100", "arrivals", "impressions", "dwell") })
            assertEquals(0L, o.getLong("start") % 60)
            assertTrue(o.getInt("impressions") <= o.getInt("arrivals"))
            assertTrue(o.getInt("present_avg_x100") <= o.getInt("present_max") * 100)
            assertEquals(6, o.getJSONArray("dwell").length())
            assertTrue(Regex("^[A-Za-z0-9:_-]{1,80}$").matches(o.getString("id")))
            if (o.getString("item_kind") == "none") assertFalse(o.has("item_id"))
        }
    }

    @Test fun dwellBucketsMatchTheServerLabels() {
        assertEquals(0, AudienceAggregator.dwellIndex(1_999))
        assertEquals(1, AudienceAggregator.dwellIndex(2_000))
        assertEquals(2, AudienceAggregator.dwellIndex(14_999))
        assertEquals(3, AudienceAggregator.dwellIndex(15_000))
        assertEquals(4, AudienceAggregator.dwellIndex(59_999))
        assertEquals(5, AudienceAggregator.dwellIndex(600_000))
    }

    @Test fun theQueueRoundTripsDedupesAcksAndIsBounded() {
        val a = AudienceAggregator()
        a.item = promo
        a.run(listOf(face), T0, 3_000)
        a.run(emptyList(), T0 + 3_000, 3_000)
        val bs = a.flushAll(T0 + 7_000)
        val q = AudienceQueue(cap = 3)
        q.addAll(bs); q.addAll(bs)
        assertEquals(bs.size, q.size)
        val back = AudienceQueue.fromJson(q.toJson())
        assertEquals(q.size, back.size)
        val orig = bs.first().toJson().toString()
        assertEquals("a persisted bucket sends exactly what it would have", JSONObject(orig).toString(), back.peek().first().toJson().toString())
        back.ack(listOf(bs.first().id))
        assertEquals(q.size - 1, back.size)
        val many = (0 until 5).map { AudienceBucket(T0 / 1000 + it * 60L, 60, promo) }
        q.addAll(many)
        assertEquals(3, q.size)
        assertEquals("oldest dropped first", many.last().id, q.peek().last().id)
        assertEquals(0, AudienceQueue.fromJson("not json").size)
    }
}
