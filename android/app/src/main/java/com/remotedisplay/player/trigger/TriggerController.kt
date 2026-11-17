package com.remotedisplay.player.trigger

import android.util.Log

/**
 * Collisions, the held set and the lease — the Android half of docs/triggers-design.md §6/§7/§8.
 *
 * ⚠️ THIS MIRRORS THE JS STATE MACHINE IN server/player/index.html AND IS NOT YET HELD TO SHARED
 * VECTORS. The resolver is (shared/trigger-vectors.json); this is not, because the vector format
 * covers a single decision and this is a sequence of them. That is a real drift risk and it is
 * named here rather than left to be discovered: if these two disagree, an alarm behaves differently
 * on an Android panel than on the screen beside it. Extending the vectors to sequences is the right
 * next move.
 *
 * The rules, in one place so they can be compared to the JS by reading:
 *  - highest priority wins; ties go to the last arrival
 *  - only `until_cleared` is HELD when preempted — a spent `once` must not return later
 *  - a restored trigger restarts at item 1; being covered is not a renewal of its lease
 *  - a re-fire of the active trigger is a no-op that RENEWS the lease
 *  - a re-assert of a HELD trigger renews it without disturbing the screen
 *  - the lease ticks while held, and a lapsed hold is dropped rather than restored
 *  - a `once` trigger ends after its playlist's length, capped by max_duration_sec (GHSA-rvxj 7.6)
 */
class TriggerController(
    private val show: (TriggerResolve.Trigger) -> Unit,
    private val hide: () -> Unit,
    private val now: () -> Long = { System.currentTimeMillis() }
) {
    data class Active(val trigger: TriggerResolve.Trigger, val since: Long, val source: String,
                      var leaseUntil: Long?, val endsAt: Long? = null)
    data class Held(val trigger: TriggerResolve.Trigger, val source: String, var leaseUntil: Long?)

    var active: Active? = null; private set
    val held = mutableListOf<Held>()

    private fun leaseUntil(t: TriggerResolve.Trigger): Long? =
        t.leaseSec?.takeIf { it > 0 }?.let { now() + it * 1000L }

    private fun endsAt(t: TriggerResolve.Trigger): Long? = onceSeconds(t)?.let { now() + it * 1000L }

    fun onVerdict(v: TriggerResolve.Verdict, source: String) {
        if (!v.ok) return
        when (v.action) {
            TriggerResolve.Action.CLEAR_ALL -> {
                // "Stop everything" that leaves something queued to reappear is not stop everything.
                held.clear(); stop("clear-all")
            }
            TriggerResolve.Action.CLEAR -> {
                val t = v.trigger ?: return
                if (active?.trigger?.id == t.id) { stop("cleared"); promote() }
                else held.removeAll { it.trigger.id == t.id }   // cleared while covered
            }
            TriggerResolve.Action.FIRE -> fire(v.trigger ?: return, source)
            else -> {}
        }
    }

    private fun fire(t: TriggerResolve.Trigger, source: String) {
        val a = active
        if (a != null && a.trigger.id == t.id) {
            /*
             * ⚠️ A re-fire is a no-op that RENEWS. PLC and Crestron gear re-assert on a timer and
             * broadcast duplicates packets; restarting per repeat would freeze a multi-item
             * emergency loop on item 1 for as long as the sender keeps talking. The same repeat is
             * the liveness signal the lease is built on.
             */
            a.leaseUntil = leaseUntil(t)
            return
        }
        val h = held.firstOrNull { it.trigger.id == t.id }
        if (h != null) {
            // Still true, just covered. Renew without touching the screen — otherwise an alarm that
            // never stopped being asserted would lapse and then fail to return.
            h.leaseUntil = leaseUntil(t)
            return
        }
        if (a != null && t.priority < a.trigger.priority) {
            Log.i(TAG, "[trigger] \"${t.name}\" (p${t.priority}) dropped — " +
                       "\"${a.trigger.name}\" (p${a.trigger.priority}) is showing")
            return
        }
        if (a != null && a.trigger.mode == "until_cleared") {
            held.add(Held(a.trigger, a.source, a.leaseUntil))
        }
        active = Active(t, now(), source, leaseUntil(t), endsAt(t))
        show(t)
        Log.i(TAG, "[trigger] fired \"${t.name}\" via $source (${t.mode})")
    }

    fun stop(reason: String) {
        val was = active
        active = null
        hide()
        if (was != null) Log.i(TAG, "[trigger] cleared \"${was.trigger.name}\" ($reason)")
    }

    /** Bring back the highest-priority thing that is still true; ties to the most recently held. */
    fun promote() {
        if (active != null || held.isEmpty()) return
        var best = 0
        for (i in 1 until held.size) if (held[i].trigger.priority >= held[best].trigger.priority) best = i
        val h = held.removeAt(best)
        // Restarts at item 1, and KEEPS its remaining lease: being covered is not a renewal.
        active = Active(h.trigger, now(), h.source, h.leaseUntil)
        show(h.trigger)
        Log.i(TAG, "[trigger] restoring held \"${h.trigger.name}\" (still asserted)")
    }

    /** ⚠️ Covers held entries too: the lease is about the world, not about the screen. */
    fun sweep() {
        val t = now()
        val a = active
        // GHSA-rvxj 7.6: a `once` ends when its playlist has played through, or at its cap. Checked
        // before the lease so the log names the real reason. Not held, so nothing to sweep there.
        if (a?.endsAt != null && t >= a.endsAt) {
            val capped = a.trigger.maxDurationSec in 1..naturalSeconds(a.trigger)
            stop(if (capped) "cap reached" else "played once"); promote(); return
        }
        if (a?.leaseUntil != null && t > a.leaseUntil!!) {
            Log.w(TAG, "[trigger] lease expired, auto-cleared \"${a.trigger.name}\"")
            stop("lease expired"); promote(); return
        }
        val before = held.size
        held.removeAll { it.leaseUntil != null && t > it.leaseUntil!! }
        if (held.size != before) Log.i(TAG, "[trigger] ${before - held.size} held trigger(s) lapsed")
    }

    companion object {
        private const val TAG = "TriggerController"

        /*
         * ⚠️ THE WEB PLAYER'S `once` RULE, PORTED (triggerFire in server/player/index.html). Android
         * used to parse max_duration_sec and never read it, and its overlay loops a playlist forever,
         * so a single "play once" fire held the screen until something cleared it — and the org
         * "leased" policy, which caps play-once triggers through max_duration_sec, did nothing here.
         *
         *  - only `once` ends by itself; max_duration_sec is an UPPER BOUND on it, 0 = no cap, and it
         *    does not apply to until_cleared (exactly as on the web player)
         *  - the natural length is ESTIMATED as the sum of duration_sec (10 s when unset/0), the same
         *    estimate the web player makes, YouTube items excluded because neither player shows them
         *  - the cap wins over a longer playlist
         *  - a re-fire renews the lease but NOT this deadline: re-asserting is not replaying
         *
         * Enforced by sweep(), so it lands on the next sweep tick (MainActivity runs it every 5 s).
         */
        internal fun naturalSeconds(t: TriggerResolve.Trigger): Int {
            var n = 0
            for (raw in t.items) {
                val o = raw as? org.json.JSONObject
                if (o != null && (o.optString("mime_type") == "video/youtube" || o.has("youtube_id"))) continue
                val d = o?.optDouble("duration_sec", 0.0) ?: 0.0
                n += if (d.isNaN() || d <= 0.0) 10 else kotlin.math.ceil(d).toInt()
            }
            return n
        }

        /** Seconds a `once` trigger stays up, or null for a mode that does not end by itself. */
        internal fun onceSeconds(t: TriggerResolve.Trigger): Int? {
            if (t.mode != "once") return null
            val natural = naturalSeconds(t)
            val cap = t.maxDurationSec
            return if (cap > 0) minOf(cap, natural) else natural
        }
    }
}
