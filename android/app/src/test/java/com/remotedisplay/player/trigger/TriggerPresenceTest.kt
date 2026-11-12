package com.remotedisplay.player.trigger

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #845: "a trigger is on screen" drives ScreenShareBus.suppress (an alert outranks a screen share).
 * Held here: it rises at once, falls only at a settled point, never reports off in the middle of a
 * supersede or a clear that restores a held trigger, and TriggerManager settles after every
 * operation that can change the screen.
 */
class TriggerPresenceTest {

    private fun recorder(): Pair<MutableList<Boolean>, TriggerPresence> {
        val seen = mutableListOf<Boolean>()
        return seen to TriggerPresence { seen.add(it) }
    }

    @Test fun risesAtOnceAndFallsOnlyWhenSettled() {
        val (seen, p) = recorder()
        p.shown()
        assertEquals(listOf(true), seen)
        p.settle(true)                       // still up: nothing new
        assertEquals(listOf(true), seen)
        p.settle(false)
        assertEquals(listOf(true, false), seen)
        assertFalse(p.on)
    }

    @Test fun isIdempotent() {
        val (seen, p) = recorder()
        p.settle(false); p.settle(false)
        p.shown(); p.shown(); p.settle(true)
        assertEquals(listOf(true), seen)
    }

    /**
     * The main-thread queue as TriggerOverlay uses it: a supersede (or clear + restore of a held
     * trigger) queues hide, then show (which marks shown), then the manager's settled() check. The
     * share must never be told "off" in between.
     */
    private class FakeOverlay(val presence: TriggerPresence) : TriggerRenderer {
        val queue = ArrayDeque<() -> Unit>()
        var box: String? = null
        override fun show(trigger: TriggerResolve.Trigger): Boolean {
            queue.add { box = trigger.id; presence.shown() }
            return true
        }
        override fun hide() { queue.add { box = null } }
        override fun settled() { queue.add { presence.settle(box != null) } }
        fun drain() { while (queue.isNotEmpty()) queue.removeFirst().invoke() }
    }

    private fun trig(id: String, token: String, priority: Int, clear: String? = null) = JSONObject()
        .put("id", id).put("name", id).put("match_token", token).put("clear_token", clear ?: JSONObject.NULL)
        .put("source_http", true).put("mode", "until_cleared").put("priority", priority)
        .put("max_duration_sec", 0).put("lease_sec", 60)
        .put("items", JSONArray().put(JSONObject().put("content_id", "c-$id")))

    private val secret = "s".repeat(16)
    private fun payload() = JSONObject()
        .put("triggers", JSONArray().put(trig("low", "LOW", 10, "LOW_CLR")).put(trig("high", "HIGH", 100, "HIGH_CLR")))
        .put("trigger_config", JSONObject().put("secret", secret)
            .put("accept_http", false).put("accept_udp", false).put("clear_all_token", "ALLSTOP"))

    private fun setup(): Triple<MutableList<Boolean>, FakeOverlay, TriggerManager> {
        val (seen, p) = recorder()
        val o = FakeOverlay(p)
        val m = TriggerManager(o, log = { _, _ -> })
        m.onPayload(payload())
        return Triple(seen, o, m)
    }

    private fun TriggerManager.send(token: String) = handle("ST1 $secret $token", "http", "1.2.3.4")

    @Test fun aSupersedeNeverFlashesTheShareBack() {
        val (seen, o, m) = setup()
        m.send("LOW"); o.drain()
        assertEquals(listOf(true), seen)
        m.send("HIGH"); o.drain()            // supersedes: LOW is held
        assertEquals(listOf(true), seen)
        m.send("HIGH_CLR"); o.drain()        // clear: hide, then LOW restored
        assertEquals("a clear that restores a held trigger must not report off", listOf(true), seen)
        m.send("LOW_CLR"); o.drain()         // the last one gone
        assertEquals(listOf(true, false), seen)
    }

    @Test fun clearAllAndStopBothSettleOff() {
        val (seen, o, m) = setup()
        m.send("LOW"); m.send("HIGH"); o.drain()
        m.send("ALLSTOP"); o.drain()
        assertEquals(listOf(true, false), seen)
        m.send("LOW"); o.drain()
        m.stop(); o.drain()                  // Activity destroyed: the share must come back
        assertEquals(listOf(true, false, true, false), seen)
    }

    @Test fun aSweepSettlesToo() {
        val (seen, o, m) = setup()
        m.send("LOW"); o.drain()
        o.box = null                         // the overlay went away on its own
        m.sweep(); o.drain()
        assertEquals(listOf(true, false), seen)
    }

    @Test fun aRejectedPacketChangesNothing() {
        val (seen, o, m) = setup()
        m.send("LOW"); o.drain()
        m.handle("garbage", "http", "1.2.3.4"); o.drain()
        assertEquals(listOf(true), seen)
        assertTrue(o.box == "low")
    }
}
