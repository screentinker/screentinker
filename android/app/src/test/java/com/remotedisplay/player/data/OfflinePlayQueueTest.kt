package com.remotedisplay.player.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #299 — the queue that stops a disconnected player throwing its plays away.
 *
 * ⚠️ THE BUG: sendPlayStart/sendPlayEnd both opened with `if (socket?.connected() != true) return`,
 * so every play during an outage was discarded at the moment it happened. A measured 5h49m outage
 * lost ~1,040 of them — the screen played perfectly and Reports show a 20,963-second hole.
 *
 * The dangerous failures for a fix like this are the quiet ones: a queue that grows until the panel
 * fills its storage, a flush that clears entries the server never received, or a re-flush that
 * double-counts and turns an under-report into an over-report. Those are what these cover.
 */
class OfflinePlayQueueTest {

    private var n = 0
    private fun play(startedAt: Long = 1_800_000_000L, id: String? = null) = OfflinePlayQueue.Play(
        clientEventId = id ?: "evt-${n++}",
        contentId = "c1",
        widgetId = null,
        contentName = "clip.mp4",
        startedAtSec = startedAt,
        endedAtSec = startedAt + 20,
        completed = true,
    )

    @Test fun THE_BUG_a_play_recorded_offline_is_kept() {
        val q = OfflinePlayQueue()
        q.add(play())
        assertEquals(1, q.size)
        assertEquals(1, q.peekBatch().size)
    }

    @Test fun a_whole_outage_of_plays_survives() {
        // ~1,040 plays is what the real 5h49m outage produced at 20s an item.
        val q = OfflinePlayQueue()
        repeat(1040) { q.add(play(startedAt = 1_800_000_000L + it * 20)) }
        assertEquals(1040, q.size)
        assertEquals(0L, q.dropped)
    }

    @Test fun A_PANEL_OFFLINE_FOR_WEEKS_CANNOT_FILL_ITS_STORAGE() {
        /*
         * The failure mode a naive queue introduces: unbounded growth turns a reporting gap into a
         * dead screen, which is far worse than the bug being fixed.
         */
        val q = OfflinePlayQueue(maxEntries = 100)
        repeat(1000) { q.add(play(startedAt = 1_800_000_000L + it)) }
        assertEquals(100, q.size)
        assertEquals(900L, q.dropped)
    }

    @Test fun when_full_it_drops_the_OLDEST_and_says_so() {
        val q = OfflinePlayQueue(maxEntries = 3)
        q.add(play(id = "a")); q.add(play(id = "b")); q.add(play(id = "c")); q.add(play(id = "d"))
        val ids = q.peekBatch().map { it.clientEventId }
        assertEquals(listOf("b", "c", "d"), ids)
        assertTrue("a silent drop is how the original bug hid", q.dropped > 0)
    }

    @Test fun ENTRIES_ARE_REMOVED_ONLY_BY_ACK() {
        // Peeking is not sending, and sending is not delivery. If a flush vanishes into a dead
        // socket the backlog must still be there.
        val q = OfflinePlayQueue()
        q.add(play(id = "x")); q.add(play(id = "y"))
        q.peekBatch()
        assertEquals("peek must not consume", 2, q.size)
        q.ack(listOf("x"))
        assertEquals(1, q.size)
        assertEquals("y", q.peekBatch()[0].clientEventId)
    }

    @Test fun ACK_BY_ID_SURVIVES_A_QUEUE_THAT_MOVED_UNDER_THE_FLUSH() {
        /*
         * ⚠️ Why ack takes ids and not a count. Live plays keep arriving during a flush, and an
         * eviction can shift the queue too — so "remove the first N" would delete entries the
         * server never saw. This is the case that silently loses data again.
         */
        val q = OfflinePlayQueue()
        q.add(play(id = "old1")); q.add(play(id = "old2"))
        val batch = q.peekBatch()
        q.add(play(id = "new1"))            // arrived while the flush was in flight
        q.ack(batch.map { it.clientEventId })
        assertEquals(1, q.size)
        assertEquals("the newly-arrived play must survive the ack", "new1", q.peekBatch()[0].clientEventId)
    }

    @Test fun a_flush_is_batched_rather_than_sent_in_one_lump() {
        val q = OfflinePlayQueue()
        repeat(OfflinePlayQueue.BATCH * 3) { q.add(play()) }
        assertEquals(OfflinePlayQueue.BATCH, q.peekBatch().size)
    }

    @Test fun it_round_trips_through_persistence() {
        val q = OfflinePlayQueue()
        q.add(play(startedAt = 1_799_999_000L, id = "keep-me"))
        q.add(play(startedAt = 1_799_999_100L, id = "me-too"))
        val text = q.serialize()

        val back = OfflinePlayQueue()
        back.restore(text)
        assertEquals(2, back.size)
        val first = back.peekBatch()[0]
        assertEquals("keep-me", first.clientEventId)
        assertEquals(1_799_999_000L, first.startedAtSec)
        assertEquals(1_799_999_020L, first.endedAtSec)
        assertTrue(first.completed)
        assertEquals("clip.mp4", first.contentName)
    }

    @Test fun A_CORRUPT_FILE_COSTS_THE_BACKLOG_NEVER_THE_BOOT() {
        /*
         * ⚠️ This runs on the boot path, and a panel losing power mid-write is the ordinary case
         * for signage, not an exotic one. Throwing here would brick startup to protect a report.
         */
        for (junk in listOf(null, "", "   ", "{", "not json", "[{\"broken\":", "[1,2,3]", "[{}]")) {
            val q = OfflinePlayQueue()
            q.restore(junk)
            assertEquals("restore($junk) should yield an empty queue, not a crash", 0, q.size)
        }
    }

    @Test fun entries_missing_the_fields_that_make_them_meaningful_are_skipped() {
        // A row with no start time cannot be reported honestly, and one with no id cannot be
        // de-duplicated on replay — both would poison the data they are meant to repair.
        val q = OfflinePlayQueue()
        q.restore("""[{"client_event_id":"ok","started_at":1799999000},{"started_at":1799999000},{"client_event_id":"no-start"}]""")
        assertEquals(1, q.size)
        assertEquals("ok", q.peekBatch()[0].clientEventId)
    }

    @Test fun the_wire_payload_carries_the_real_play_times() {
        // The point of the whole change: the server must learn WHEN it played, not when it heard.
        val q = OfflinePlayQueue()
        q.add(play(startedAt = 1_799_990_000L, id = "e1"))
        val json = q.batchJson(q.peekBatch()).getJSONObject(0)
        assertEquals(1_799_990_000L, json.getLong("started_at"))
        assertEquals(1_799_990_020L, json.getLong("ended_at"))
        assertEquals("e1", json.getString("client_event_id"))
        assertFalse("an id is what makes a re-flush idempotent", json.getString("client_event_id").isEmpty())
    }

    @Test fun clear_empties_it() {
        val q = OfflinePlayQueue()
        q.add(play()); q.clear()
        assertEquals(0, q.size)
    }
}
