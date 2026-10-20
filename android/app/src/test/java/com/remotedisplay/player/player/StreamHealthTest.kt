package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The zone video watchdog's rules (StreamHealth). */
class StreamHealthTest {
    private val READY = PlaybackStall.STATE_READY
    private val BUFFERING = PlaybackStall.STATE_BUFFERING
    private val IDLE = PlaybackStall.STATE_IDLE

    private class Rec { val calls = mutableListOf<Pair<Long, String>>() }
    private fun health(rec: Rec) = StreamHealth({ d, why -> rec.calls += d to why })

    @Test fun `a stream drawing new frames is healthy`() {
        val rec = Rec(); val h = health(rec)
        for (t in 0..60) assertFalse(h.observe(t * 2_000L, READY, true, t.toLong() * 30, 0L))
        assertTrue(rec.calls.isEmpty())
    }

    @Test fun `frames stop while it claims to play - a stall after 10 s, reconnect in 2 s`() {
        val rec = Rec(); val h = health(rec)
        h.observe(0, READY, true, 100, 5_000)          // the last frame that changed: the clock starts here
        h.observe(2_000, READY, true, 100, 7_000)      // position moves, the picture does not: still frozen
        h.observe(8_000, READY, true, 100, 13_000)
        assertFalse(h.observe(9_900, READY, true, 100, 14_900))
        assertTrue(h.observe(10_100, READY, true, 100, 15_100))
        assertEquals(listOf(2_000L to "stall"), rec.calls)
    }

    @Test fun `buffering is allowed 30 s before it counts`() {
        val rec = Rec(); val h = health(rec)
        h.observe(0, BUFFERING, true, 100, 0)
        assertFalse(h.observe(29_000, BUFFERING, true, 100, 0))
        assertTrue(h.observe(30_500, BUFFERING, true, 100, 0))
    }

    @Test fun `a paused or idle player is never a stall (wall holds, transitions, the frozen frame)`() {
        val rec = Rec(); val h = health(rec)
        for (t in 0..30) h.observe(t * 2_000L, READY, false, 100, 0)
        for (t in 0..30) h.observe(t * 2_000L, IDLE, true, 100, 0)
        assertTrue(rec.calls.isEmpty())
    }

    @Test fun `no video decoder - progress is the position`() {
        val rec = Rec(); val h = health(rec)
        for (t in 0..10) assertFalse(h.observe(t * 2_000L, READY, true, null, t * 2_000L))   // last progress at 20 s
        assertFalse(h.observe(29_900, READY, true, null, 20_000))
        assertTrue(h.observe(30_100, READY, true, null, 20_000))
    }

    @Test fun `repeated errors back off 2, 4, 8, 15, 30 s - one pending reconnect at a time`() {
        val rec = Rec(); val h = health(rec)
        var now = 0L
        for (expected in listOf(2_000L, 4_000L, 8_000L, 15_000L, 30_000L, 30_000L)) {
            h.error(now)
            h.error(now + 10)   // a second error before the reconnect ran: no second timer
            now += expected
            h.reconnected()
        }
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 15_000L, 30_000L, 30_000L), rec.calls.map { it.first })
        assertTrue(rec.calls.all { it.second == "error" })
    }

    @Test fun `while a reconnect is pending a stall is not reported again`() {
        val rec = Rec(); val h = health(rec)
        h.error(0)
        for (t in 0..20) assertFalse(h.observe(t * 2_000L, READY, true, 100, 0))
        assertEquals(1, rec.calls.size)
    }

    @Test fun `a fault long after the last starts again from 2 s`() {
        val rec = Rec(); val h = health(rec)
        h.error(0); h.reconnected()
        h.error(2_000); h.reconnected()            // 4 s
        h.error(2_000 + 4_000 + 120_000)           // two healthy minutes later
        assertEquals(listOf(2_000L, 4_000L, 2_000L), rec.calls.map { it.first })
    }
}
