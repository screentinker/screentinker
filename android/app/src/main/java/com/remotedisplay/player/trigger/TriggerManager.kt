package com.remotedisplay.player.trigger

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * The one place the trigger stack is assembled: transports -> resolver -> state machine -> overlay.
 *
 * ⚠️ Until this existed, every piece was written and NONE of it was reachable — nothing in the app
 * constructed TriggerListeners or TriggerController, and nothing consumed `triggers` from the device
 * payload. Four files of tested code that could not fire. Keeping the assembly in one class is what
 * stops that recurring: if this is not constructed, the feature is visibly absent rather than
 * quietly inert.
 *
 * Mirrors handleTrigger + the arbitration block in server/player/index.html. The transports do not
 * resolve and the resolver does not render — one handler, one decision, one renderer.
 */
class TriggerManager(
    private val overlay: TriggerRenderer,
    private val log: (level: String, message: String) -> Unit = { _, _ -> },
    /**
     * Run an accepted LOCAL API command (Goal B part 3). Wired to the service's one command
     * dispatch, deliberately — not to a private handler. A command arriving from the LAN must do
     * exactly what the same command from the dashboard does, or the door is a second implementation
     * of every command it accepts.
     */
    private val onLocalCommand: ((type: String, payload: JSONObject?) -> Unit)? = null,
    /** Builds the /api/status body. Supplied by the service, which is what knows any of it. */
    private val localStatus: (() -> JSONObject)? = null
) {
    /** Read-only view of what this device currently holds — the state an installer asks about. */
    var triggers: List<TriggerResolve.Trigger> = emptyList()
        private set
    private var secret: String = ""

    /*
     * ⚠️ org.json's optString RETURNS THE STRING "null" FOR A JSON null ON ANDROID. The server sends
     * `secret: null`, `multicast_group: null` and `clear_all_token: null` whenever they are unset,
     * so the plain `optString(...).takeIf { it.isNotEmpty() }` this replaced produced the four-letter
     * string "null" and treated it as a configured value. Three live consequences, one of them
     * security-relevant:
     *
     *   1. multicast_group "null" -> InetAddress.getByName("null") threw and took the WHOLE UDP
     *      listener down, so UDP triggers were inert on every device without a multicast group —
     *      which is the default. Observed on hardware: 'UDP listener failed: Unable to resolve
     *      host "null"'.
     *   2. secret "null" -> TriggerResolve refuses a fire only when the device secret
     *      isNullOrEmpty(), and "null" is neither. A device with listeners enabled and NO secret
     *      set therefore ACCEPTED `ST1 null <token>` instead of refusing everything.
     *   3. clear_all_token "null" -> the literal token "null" would clear every active trigger.
     *
     * ⚠️ AND A JVM TEST CANNOT SEE THIS. The reference org.json returns the FALLBACK for a JSON
     * null; only Android's implementation returns "null". That is why the suite was green. This
     * helper is what the tests can prove instead: given the string, it must yield absence.
     *
     * The same trap already cost this project once, in the remote_url download path.
     */
    private fun optText(o: org.json.JSONObject?, key: String): String? {
        if (o == null || o.isNull(key)) return null
        val v = o.optString(key, "")
        return if (v.isEmpty() || v == "null") null else v
    }
    private var clearAllToken: String? = null
    private val limiter = TriggerResolve.RateLimiter()
    private var listeners: TriggerListeners? = null

    private val controller = TriggerController(
        show = { t -> if (!overlay.show(t)) log("warn", "\"${t.name}\" rendered nothing") },
        hide = { overlay.hide() }
    )

    /** Counters an installer reads. Same closed set as the web player's. */
    var received = 0; private set
    var accepted = 0; private set
    val rejected = HashMap<String, Int>()
    var lastDatagramAt: Long = 0; private set

    /**
     * Adopt a device payload. Safe to call on every playlist-update: the listeners are only
     * (re)started when the transport configuration actually changes, so a routine refresh does not
     * churn a bound socket.
     */
    fun onPayload(payload: JSONObject) {
        val cfg = payload.optJSONObject("trigger_config")
        val newSecret = optText(cfg, "secret") ?: ""
        val acceptHttp = cfg?.optBoolean("accept_http") ?: false
        val acceptUdp = cfg?.optBoolean("accept_udp") ?: false
        val httpPort = cfg?.optInt("http_port")?.takeIf { it > 0 }
        val udpPort = cfg?.optInt("udp_port")?.takeIf { it > 0 }
        val group = optText(cfg, "multicast_group")

        secret = newSecret
        clearAllToken = optText(cfg, "clear_all_token")
        triggers = parseTriggers(payload.optJSONArray("triggers"))

        /*
         * The inbound control door. Its own object in the payload, NOT a field inside
         * trigger_config, because it is not a trigger setting — it shares a socket with one. Same
         * separation the schema keeps between a trigger definition and the listener flags, and for
         * the same reason: one of these is a content decision and the other is a security one.
         */
        val api = payload.optJSONObject("local_api")
        val acceptLocalApi = api?.optBoolean("enabled") ?: false
        localApiSecret = optText(api, "secret")
        localApiEnabled = acceptLocalApi

        // ⚠️ The local-api flag is part of the restart key. Without it, switching the control door on
        // would change nothing until something else about the transports also changed — the feature
        // would appear inert for an operator who had just enabled it, which is how a working feature
        // gets reported as broken.
        val want = "$acceptHttp/$acceptUdp/$httpPort/$udpPort/$group/$acceptLocalApi"
        if (want != startedWith) {
            listeners?.stop()
            listeners = null
            if (acceptHttp || acceptUdp || acceptLocalApi) {
                val l = TriggerListeners(
                    onPayload = { text, source, ip -> handle(text, source, ip) },
                    onState = { },
                    onLocalApi = { method, path, query, headers, body, ip -> handleLocalApi(method, path, query, headers, body, ip) },
                    onLocalCommand = { type, p -> onLocalCommand?.invoke(type, p) }
                )
                l.start(acceptHttp, acceptUdp, httpPort, udpPort, group, acceptLocalApi)
                listeners = l
            }
            startedWith = want
            log("info", "trigger listeners: http=$acceptHttp udp=$acceptUdp local_api=$acceptLocalApi")
        }
    }

    private var localApiSecret: String? = null
    /*
     * ⚠️ Held as well as gated in the transport, so the flag is checked where the DECISION is made
     * and not only where the bytes arrive. A gate that lives solely in the socket layer is a gate
     * that no test of the decision can see — and it is the decision that says 404.
     */
    private var localApiEnabled = false
    /*
     * ⚠️ ITS OWN LIMITER, not the trigger one. Shared buckets would let a trigger flood lock an
     * operator out of `screen_on` — the command they reach for when a screen is misbehaving — and
     * the two doors cost very different amounts: a trigger is an overlay, a command can be a
     * playlist reload. Tighter than the trigger limiter for that reason.
     */
    private val apiLimiter = TriggerResolve.RateLimiter(perSec = 2.0, burst = 5.0, globalPerSec = 10.0)

    /** Counters, the same closed-set idea the trigger path uses. */
    var apiReceived = 0; private set
    var apiAccepted = 0; private set
    private var warnedQuerySecret = false

    /**
     * ⚠️ THE ONE LOCAL-API HANDLER, mirroring [handle]. The transport reads bytes; LocalApi decides;
     * this counts and logs. Nothing about a command is decided here either — that is the service's
     * single dispatch.
     */
    fun handleLocalApi(
        method: String,
        path: String,
        query: Map<String, String>,
        headers: Map<String, String>,
        body: String,
        sourceIp: String
    ): com.remotedisplay.player.net.LocalApi.Result {
        apiReceived++
        if (!apiLimiter.allow(sourceIp, System.currentTimeMillis())) {
            return com.remotedisplay.player.net.LocalApi.Result(429, "{\"ok\":false,\"error\":\"rate_limited\"}")
        }
        if (query.containsKey("secret") && !warnedQuerySecret) {
            warnedQuerySecret = true
            // Once, not per request: a chatty integration would otherwise fill the log with its own
            // warning and bury whatever else went wrong.
            log("warn", "local API secret arrived in the query string from $sourceIp — it lands in "
                + "proxy logs; send it as Authorization: Bearer if the sender can")
        }
        val r = com.remotedisplay.player.net.LocalApi.handle(
            method, path, query, headers, body,
            com.remotedisplay.player.net.LocalApi.Config(enabled = localApiEnabled, secret = localApiSecret),
            status = { localStatus?.invoke() ?: JSONObject() }
        )
        if (r.command != null) {
            apiAccepted++
            log("info", "local API: ${r.command} from $sourceIp")
        } else if (r.status >= 400) {
            log("warn", "local API: $method $path from $sourceIp -> ${r.status}")
        }
        return r
    }
    private var startedWith: String? = null

    /**
     * ⚠️ THE ONE HANDLER. Both transports arrive here and neither has logic of its own; if either
     * grew its own resolution the two doors would drift and only one would get the next fix.
     */
    fun handle(text: String, source: String, sourceIp: String): TriggerResolve.Verdict {
        received++
        // ⚠️ Stamped even when rejected. A recent timestamp with zero accepts means packets are
        // arriving and the secret is wrong; null means nothing is arriving and it is the network.
        // Counting only successes destroys the single distinction an installer needs.
        lastDatagramAt = System.currentTimeMillis()

        if (!limiter.allow(sourceIp, lastDatagramAt)) {
            bump("rate_limited")
            return TriggerResolve.Verdict(false, reason = TriggerResolve.Reason.MALFORMED)
        }
        val v = TriggerResolve.evaluate(text, triggers, secret, clearAllToken, source)
        if (!v.ok) { bump(v.reason?.toString() ?: "unknown"); return v }
        accepted++
        try { controller.onVerdict(v, source) } catch (e: Throwable) {
            log("warn", "trigger handling failed: ${e.message}")
        }
        return v
    }

    fun sweep() = controller.sweep()
    fun stop() { listeners?.stop(); listeners = null; controller.stop("shutting down") }

    private fun bump(k: String) { rejected[k] = (rejected[k] ?: 0) + 1 }

    private fun parseTriggers(arr: JSONArray?): List<TriggerResolve.Trigger> {
        val out = ArrayList<TriggerResolve.Trigger>()
        for (i in 0 until (arr?.length() ?: 0)) {
            val o = arr?.optJSONObject(i) ?: continue
            val items = ArrayList<Any>()
            val ia = o.optJSONArray("items")
            for (k in 0 until (ia?.length() ?: 0)) ia?.optJSONObject(k)?.let { items.add(it) }
            out.add(TriggerResolve.Trigger(
                id = o.optString("id"),
                name = o.optString("name"),
                matchToken = o.optString("match_token"),
                clearToken = o.optString("clear_token").takeIf { it.isNotEmpty() },
                sourceHttp = o.optBoolean("source_http", true),
                sourceUdp = o.optBoolean("source_udp", false),
                mode = o.optString("mode", "until_cleared"),
                priority = o.optInt("priority", 0),
                maxDurationSec = o.optInt("max_duration_sec", 0),
                leaseSec = if (o.isNull("lease_sec")) null else o.optInt("lease_sec"),
                items = items
            ))
        }
        return out
    }

    companion object { private const val TAG = "TriggerManager" }
}
