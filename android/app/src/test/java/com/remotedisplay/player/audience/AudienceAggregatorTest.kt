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
                keys.all { it in setOf("id", "start", "seconds", "item_kind", "item_id", "present_max", "present_avg_x100", "arrivals", "impressions", "dwell", "segment", "observed_ms") })
            assertEquals(0L, o.getLong("start") % 60)
            assertTrue(o.getInt("impressions") <= o.getInt("arrivals"))
            assertTrue(o.getInt("present_avg_x100") <= o.getInt("present_max") * 100)
            assertEquals(6, o.getJSONArray("dwell").length())
            assertTrue(Regex("^[A-Za-z0-9:_-]{1,80}$").matches(o.getString("id")))
            if (o.getString("item_kind") == "none") assertFalse(o.has("item_id"))
            assertTrue(o.getInt("segment") in 0..9999)
            assertTrue(o.getLong("observed_ms") in 0..o.getInt("seconds") * 1000L)
        }
    }

    @Test fun observedTimeIsTheTimeEachItemWasOnScreenWhileCounting() {
        val a = AudienceAggregator()
        a.item = promo
        a.run(listOf(face), T0, 10_000)                // 10 s of the promo
        a.item = clock
        a.run(emptyList(), T0 + 10_000, 50_000)        // then 50 s of the clock, same minute
        val bs = a.flushAll(T0 + 59_999)
        val p = bs.single { it.item == promo }
        val c = bs.single { it.item == clock }
        assertEquals("the first frame of a run credits nothing; every later frame its 500 ms", 9_500L, p.observedMs)
        assertEquals(50_000L, c.observedMs)
        assertTrue(p.observedMs + c.observedMs <= 60_000L)
    }

    @Test fun aStalledCameraIsNotTimeWatched() {
        val a = AudienceAggregator(maxFrameGapMs = 2_000)
        a.item = promo
        a.onFrame(emptyList(), T0)
        a.onFrame(emptyList(), T0 + 30_000)            // 30 s with no frame at all
        assertEquals(2_000L, a.flushAll(T0 + 30_001).single().observedMs)
    }

    @Test fun aBucketThatOnlyCarriesDeparturesHasNoObservedTime() {
        val a = AudienceAggregator()
        a.item = promo
        a.run(listOf(face), T0 + 50_000, 5_000)        // confirmed on the promo
        a.item = clock
        a.run(listOf(face), T0 + 55_000, 10_000)       // still looking, into the next minute
        a.run(emptyList(), T0 + 65_000, 3_000)         // leaves: filed for the promo, now off screen
        val promoNext = a.flushAll(T0 + 70_000).single { it.item == promo }
        assertEquals(1, promoNext.arrivals)
        assertEquals(0, promoNext.frames)
        assertEquals("arrivals only: no fake time with nobody in view", 0L, promoNext.observedMs)
        assertEquals(0L, promoNext.toJson().getLong("observed_ms"))
    }

    @Test fun aRestartInsideAMinuteIsANewSegmentAndBothPartsAreQueued() {
        val a = AudienceAggregator()
        a.item = promo
        a.segment = 1
        a.run(listOf(face), T0, 3_000)
        a.run(emptyList(), T0 + 3_000, 3_000)
        val first = a.flushAll(T0 + 7_000)              // camera off
        a.segment = 2                                   // camera on again, same minute
        a.run(listOf(face), T0 + 20_000, 3_000)
        a.run(emptyList(), T0 + 23_000, 3_000)
        val second = a.flushAll(T0 + 27_000)
        assertEquals(1, first.single().segment)
        assertEquals(2, second.single().segment)
        assertEquals("m${T0 / 1000}-s1-content-c-1", first.single().id)
        val q = AudienceQueue()
        q.addAll(first); q.addAll(second)
        assertEquals("the second part is not mistaken for a resend of the first", 2, q.size)
        assertEquals(listOf(1, 2), q.peek().map { it.segment })
    }

    @Test fun theIdFitsTheServerEvenForALongItemId() {
        val long = ScreenItem("content", "a".repeat(64))
        val id = AudienceBucket(T0 / 1000, 60, long, segment = 9999).id
        assertTrue(id.length <= 80)
        assertTrue(id.startsWith("m${T0 / 1000}-s9999-content-aaa"))
        assertTrue(Regex("^[A-Za-z0-9:_-]{1,80}$").matches(id))
    }

    @Test fun aBucketQueuedByAnOlderBuildIsResentUnchanged() {
        val old = JSONObject("""{"id":"m${T0 / 1000}-content-c-1","start":${T0 / 1000},"seconds":60,"item_kind":"content","item_id":"c-1",
            "present_max":1,"present_avg_x100":50,"arrivals":1,"impressions":1,"dwell":[0,1,0,0,0,0]}""")
        val b = AudienceQueue.fromJson("[$old]").peek().single()
        assertEquals("the same id, so the server sees the lost-ack resend it already has", "m${T0 / 1000}-content-c-1", b.id)
        assertEquals(0, b.toJson().getInt("segment"))
        assertEquals("absent observed_ms meant the whole bucket", 60_000L, b.toJson().getLong("observed_ms"))
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
