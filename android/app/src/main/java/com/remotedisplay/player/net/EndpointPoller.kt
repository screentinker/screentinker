package com.remotedisplay.player.net

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Saved endpoints: the REST calls this panel makes on its own network, on its own clock.
 *
 * ⚠️ WHY THE POLLING IS HERE AND NOT ON THE SERVER. The panel stands on the private side of the
 * customer's firewall, next to the PLC and the sensor; the server is frequently in another country
 * and has no route to any of it. A server-side poller could not reach the target at all — and a
 * panel that only polls while the dashboard is open is not a poller, it is a button.
 *
 * ⚠️ OWNED BY THE FOREGROUND SERVICE, for the same reason as PowerScheduleManager. An
 * Activity-scoped poller stops whenever the screen sleeps or the system reclaims the Activity,
 * which is most of the time on a panel that is also running a display-power schedule. The two
 * features would silently disable each other.
 */
class EndpointPoller(
    private val context: Context,
    private val onResult: (JSONObject) -> Unit
) {

    private val handler = Handler(Looper.getMainLooper())
    private var tick: Runnable? = null

    /** The definitions, as last given by the server. */
    @Volatile private var endpoints: List<JSONObject> = emptyList()

    /** endpoint id -> last run, monotonic. Not persisted: see [restore]. */
    private val lastRun = HashMap<String, Long>()

    /**
     * ⚠️ The last payload per endpoint, IN MEMORY AND CAPPED.
     *
     * v1 is "cache + event", not an on-device data-source engine — so this is a small map, not a
     * database. Capped because a panel runs for months: an endpoint polled every 30 seconds for a
     * week is 20,000 responses, and keeping them would turn a reporting convenience into an OOM in
     * the middle of playback.
     */
    private val lastPayload = object : LinkedHashMap<String, String>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > 32
    }

    fun cachedPayload(endpointId: String): String? = synchronized(lastPayload) { lastPayload[endpointId] }

    /* ------------------------------------------------------------------ definitions */

    /**
     * Adopt the list from a device payload. Absent or empty CLEARS — the field rides every payload,
     * so "no endpoints" means exactly that, not "no news".
     */
    fun update(arr: JSONArray?) {
        val next = ArrayList<JSONObject>()
        if (arr != null) {
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { next.add(it) }
        }
        val before = endpoints.size
        endpoints = next
        // Drop bookkeeping for endpoints that no longer exist, so the maps cannot grow for ever.
        val live = next.mapNotNull { it.optString("id", "").ifBlank { null } }.toSet()
        synchronized(lastPayload) { lastPayload.keys.retainAll(live) }
        lastRun.keys.retainAll(live)
        if (before != next.size) Log.i(TAG, "endpoints: ${next.size}")
    }

    /**
     * Persisted so a panel that reboots at 03:00 with no WAN still polls its PLC.
     *
     * ⚠️ Only the DEFINITIONS are persisted, never the last run. After a reboot every interval
     * endpoint fires once promptly, which is the right behaviour: the panel has no idea how long it
     * was off, and a stale cached reading is worse than an extra request.
     */
    fun persist() {
        try {
            val arr = JSONArray()
            for (e in endpoints) arr.put(e)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY, arr.toString()).apply()
        } catch (e: Throwable) { Log.w(TAG, "persist: ${e.message}") }
    }

    fun restore() {
        try {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return
            update(JSONArray(raw))
            Log.i(TAG, "restored ${endpoints.size} endpoint(s)")
        } catch (e: Throwable) { Log.w(TAG, "restore: ${e.message}") }
    }

    /* ------------------------------------------------------------------ running */

    fun start() {
        stop()
        val r = object : Runnable {
            override fun run() {
                if (tick !== this) return
                try { sweep() } catch (e: Throwable) { Log.w(TAG, "sweep: ${e.message}") }
                handler.postDelayed(this, TICK_MS)
            }
        }
        tick = r
        handler.postDelayed(r, TICK_MS)
    }

    fun stop() {
        tick?.let { handler.removeCallbacks(it) }
        tick = null
    }

    /** Fire every interval endpoint that is due. */
    private fun sweep() {
        val now = android.os.SystemClock.elapsedRealtime()
        for (e in endpoints) {
            val id = e.optString("id", "")
            if (id.isBlank()) continue
            val everyS = e.optInt("interval_sec", 0)
            if (everyS <= 0) continue                       // event-driven, not on a timer
            val due = lastRun[id]?.let { now - it >= everyS * 1000L } ?: true
            if (due) { lastRun[id] = now; run(e, "interval") }
        }
    }

    /**
     * Fire the endpoints bound to a player event.
     *
     * ⚠️ 'screen_off' is deliberately supported. It is the one an operator uses to tell a building
     * system the sign has gone dark, and dropping it because "the screen is off so nothing matters"
     * would remove the only signal anything downstream gets.
     */
    fun onEvent(event: String) {
        for (e in endpoints) {
            if (e.optString("run_on", "") == event) run(e, event)
        }
    }

    private fun run(e: JSONObject, reason: String) {
        val id = e.optString("id", "")
        // BLOCKING work off the main looper: an unreachable PLC blocks for the whole timeout, and
        // doing that here would freeze playback, the heartbeat and the power tick with it.
        Thread {
            try {
                val payload = JSONObject()
                    .put("url", e.optString("url", ""))
                    .put("method", e.optString("method", "GET"))
                    .put("headers", e.optJSONObject("headers") ?: JSONObject())
                    .put("body", e.optString("body", ""))
                    .put("timeout_ms", e.optLong("timeout_ms", 0L).takeIf { it > 0 } ?: 15000L)
                val result = DeviceHttp.perform(payload)

                if (result.ok && result.snippet.isNotEmpty()) {
                    synchronized(lastPayload) { lastPayload[id] = result.snippet }
                }
                val out = result.toJson()
                    .put("endpoint_id", id)
                    .put("endpoint_name", e.optString("name", ""))
                    .put("reason", reason)
                onResult(out)
                Log.i(TAG, "endpoint ${e.optString("name")} -> ${result.status} ok=${result.ok} (${reason})")
            } catch (t: Throwable) {
                Log.w(TAG, "endpoint run: ${t.message}")
            }
        }.apply { isDaemon = true }.start()
    }

    companion object {
        private const val TAG = "EndpointPoller"
        private const val PREFS = "remote_display"
        private const val KEY = "device_endpoints"

        /*
         * ⚠️ The TICK is 10s; the minimum INTERVAL is 30s (enforced server-side). The tick is only
         * the resolution at which "is anything due" is asked — it is not how often anything runs.
         * Making the tick equal the minimum interval would make a 30s endpoint fire every 30-60s
         * depending on phase, which reads as the schedule being wrong.
         */
        private const val TICK_MS = 10_000L
    }
}
