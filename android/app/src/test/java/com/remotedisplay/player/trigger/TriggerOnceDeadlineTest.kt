package com.remotedisplay.player.trigger

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * GHSA-rvxj 7.6: a `once` trigger ends after its playlist's (estimated) length, capped by
 * max_duration_sec — the web player's triggerFire rule. Android used to hold it forever.
 */
class TriggerOnceDeadlineTest {

    private fun item(sec: Int?, mime: String = "image/jpeg") = JSONObject().put("content_id", "c").put("mime_type", mime)
        .apply { if (sec != null) put("duration_sec", sec) }

    private fun t(id: String, mode: String, cap: Int = 0, items: List<Any> = listOf(item(10)),
                  priority: Int = 0, lease: Int? = null) =
        TriggerResolve.Trigger(id, id, id, null, true, true, mode, priority, cap, lease, items)

    private class Rig {
        var clock = 1_000_000L
        var visible: String? = null
        val ctl = TriggerController(show = { visible = it.id }, hide = { visible = null }, now = { clock })
        fun fire(tr: TriggerResolve.Trigger) = ctl.onVerdict(TriggerResolve.Verdict(true, TriggerResolve.Action.FIRE, tr), "udp")
        fun advance(ms: Long) { clock += ms; ctl.sweep() }
    }

    @Test fun `natural length is the sum of durations, 10s when unset, YouTube excluded`() {
        val tr = t("a", "once", items = listOf(item(5), item(null), item(0), item(30, "video/youtube")))
        assertEquals(25, TriggerController.naturalSeconds(tr))
    }

    @Test fun `once without a cap ends when the playlist has played through`() {
        val r = Rig()
        r.fire(t("a", "once", items = listOf(item(5), item(7))))
        r.advance(11_000); assertEquals("a", r.visible)
        r.advance(2_000); assertNull("a once trigger must end by itself", r.ctl.active); assertNull(r.visible)
    }

    @Test fun `max_duration_sec caps a longer playlist`() {
        val r = Rig()
        r.fire(t("a", "once", cap = 15, items = listOf(item(60))))
        r.advance(14_000); assertEquals("a", r.visible)
        r.advance(2_000); assertNull("the cap must win over the playlist", r.ctl.active)
    }

    @Test fun `a cap longer than the playlist does not extend it`() {
        assertEquals(10, TriggerController.onceSeconds(t("a", "once", cap = 600)))
    }

    @Test fun `until_cleared is not ended by max_duration_sec (web player parity)`() {
        val r = Rig()
        r.fire(t("a", "until_cleared", cap = 5))
        r.advance(60_000)
        assertEquals("a", r.visible)
        assertNull(TriggerController.onceSeconds(t("a", "until_cleared", cap = 5)))
    }

    @Test fun `a re-fire does not push the once deadline out`() {
        val r = Rig()
        val a = t("a", "once", items = listOf(item(10)))
        r.fire(a)
        r.advance(8_000); r.fire(a)
        r.advance(3_000)
        assertNull("re-asserting is not replaying", r.ctl.active)
    }

    @Test fun `a once that ends restores what it covered`() {
        val r = Rig()
        r.fire(t("lo", "until_cleared", priority = 1))
        r.fire(t("hi", "once", priority = 5, items = listOf(item(10))))
        assertEquals("hi", r.visible)
        r.advance(11_000)
        assertEquals("lo", r.visible)
    }
}
