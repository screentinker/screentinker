package com.remotedisplay.player.net

import org.json.JSONObject

/**
 * The INBOUND half of device REST: a local control system asks this panel to do something, or asks
 * what it is doing. Goal B, part 3.
 *
 * Parts 1 and 2 point outward — the panel calls the PLC. This points inward: the PLC, the Crestron
 * processor or the Home Assistant box calls the panel. The two exist for the same reason and it is
 * not symmetry for its own sake: an AV control system on the customer's LAN cannot reach the
 * ScreenTinker server (it is in another country, behind an outbound-only firewall, and frequently
 * has no credentials the installer is allowed to hold), but it can reach the screen in the same
 * rack. Today an installer's only option is to drive the dashboard, which means a browser, a login
 * and the WAN — three things a room-control system does not have.
 *
 * ⚠️ NOTHING HERE TOUCHES A SOCKET, and nothing here performs a command. This is the DECISION half,
 * the same split TriggerResolve has from TriggerListeners, and for the same reason: the door that
 * reads bytes and the code that decides what they mean must be separable, or the only way to test
 * the decision is to open a port.
 *
 * ⚠️ OFF BY DEFAULT, AND ITS OWN FLAG. It shares the trigger HTTP port because it is the same door
 * on the same socket, but it is emphatically NOT the same permission: `accept_http` means "a LAN
 * host may put an overlay on this screen", while this means "a LAN host may change what this screen
 * is doing". One flag for both would mean every site that wanted triggers silently also got remote
 * control, and nobody would know until it was used.
 */
object LocalApi {

    /** What the caller must present. Header preferred; see [Config] for why the query form exists. */
    const val HEADER = "authorization"

    data class Config(
        val enabled: Boolean = false,
        val secret: String? = null
    )

    /**
     * The answer to give the caller, and — separately — the command to run if there is one.
     *
     * ⚠️ The two are separate so the reply can be written and the socket closed BEFORE the command
     * runs. `screen_off` blanks the panel and `refresh` tears down the WebView; doing either while
     * still holding the response would answer a control system with a dropped connection on a
     * command that worked, and a control system reads that as failure and retries.
     */
    data class Result(
        val status: Int,
        val body: String,
        val command: String? = null,
        val payload: JSONObject? = null
    )

    /*
     * ⚠️ A SUBSET OF ALLOWED_COMMANDS, AND MUCH SMALLER THAN IT — the same relationship
     * MESH_COMMANDS has to the full set, decided the same way: not "what can the panel do" but
     * "what is this caller entitled to ask".
     *
     * Who the caller is matters. A dashboard command carries a session or a `full` API token issued
     * by someone who can already see the whole fleet. This one carries a secret that will be typed
     * into a Crestron program, committed to a site's integration repo, mailed to a subcontractor and
     * left in place for the life of the building. It is a ROOM CONTROL credential, and the command
     * set is the one a room control system needs:
     *
     *   refresh                — reload the playlist ("the sign is stale, kick it")
     *   screen_on / screen_off — the actual reason this feature exists: the room's AV system turns
     *                            the display on with the projector and off when the room empties
     *   set_volume             — the audio system owns the room's volume, not the sign
     *   set_brightness         — per-window (Tier 0); house lights up, sign down
     *   set_system_brightness  — the same intent where the panel is device-owner (Tier 1)
     *
     * What is deliberately ABSENT, and why each one:
     *
     *   shell, install_apk     — code execution and software installation from a LAN credential.
     *                            No.
     *   set_server_url         — repoints the panel at another server. That is a complete takeover
     *                            of the screen from inside the LAN, and it is reversible only by
     *                            visiting the panel.
     *   update                 — pulls and installs an APK. Same class as install_apk.
     *   http_request           — would turn every panel into an open request relay for anything on
     *                            the segment. The caller is already on the LAN, so it is not new
     *                            REACH; what it is, is laundering — the request would arrive at the
     *                            PLC from the screen, with the screen's credentials, and the audit
     *                            trail would name the screen.
     *   launch                 — starts an arbitrary app on the panel.
     *   settings, kiosk_unlock — open the way OUT of kiosk mode, which is the thing kiosk mode is.
     *   set_time, set_timezone — a wrong clock breaks every schedule at once and the symptom points
     *                            at the schedule.
     *   set_power_schedule     — a definition, not a room action; it belongs to whoever owns the
     *                            site's operating hours, not to a wall panel.
     *   reboot, shutdown       — the one genuinely arguable exclusion. An integrator will ask for
     *                            it. It is out of v1 because every other command here is undone by
     *                            sending its opposite, and these are not: a reboot loop from a
     *                            stuck automation is a fleet on the floor, and a panel that is
     *                            rebooting is a panel that cannot be told to stop. Adding it later
     *                            is one line; taking it back is a fleet visit.
     */
    val COMMANDS: List<String> = listOf(
        "refresh", "screen_on", "screen_off", "set_volume", "set_brightness", "set_system_brightness"
    )

    /** Paths this door answers. Everything else on the socket is a trigger, exactly as before. */
    fun isLocalApiPath(path: String): Boolean = path == "/api/status" || path == "/api/command"

    private fun err(status: Int, code: String): Result =
        Result(status, "{\"ok\":false,\"error\":\"$code\"}")

    /**
     * ⚠️ Length-checked compare, same as TriggerResolve.secretMatches and for the same stated
     * reason: not because timing is the threat (the secret crosses an unauthenticated LAN in
     * cleartext, so anyone able to time it can simply read it) but because comparing a 4-byte string
     * to a 64-byte one should not cost less.
     */
    private fun secretOk(given: String?, expected: String?): Boolean {
        if (given.isNullOrEmpty() || expected.isNullOrEmpty()) return false
        if (given.length != expected.length) return false
        var diff = 0
        for (i in given.indices) diff = diff or (given[i].code xor expected[i].code)
        return diff == 0
    }

    /**
     * Decide what to do with one request.
     *
     * @param method  GET or POST, already uppercased by the transport.
     * @param path    the path with its query stripped.
     * @param query   parsed query parameters.
     * @param headers request headers, keys LOWERCASED by the transport.
     * @param body    the request body, already length-capped by the transport.
     * @param status  built lazily — a refused request must not pay for it, and more importantly must
     *                not be a way to read the panel's state without the secret.
     */
    fun handle(
        method: String,
        path: String,
        query: Map<String, String>,
        headers: Map<String, String>,
        body: String,
        config: Config,
        status: () -> JSONObject
    ): Result {
        // 404, not 403: a disabled door must be indistinguishable from a panel that has no such
        // door, or the response itself advertises the feature to anyone scanning the segment.
        if (!config.enabled) return err(404, "not_found")

        /*
         * ⚠️ NO SECRET CONFIGURED IS A CLOSED DOOR, not an open one. The same trap TriggerManager
         * documents for `secret: "null"`: a panel with the flag on and no credential set must refuse
         * everything, because the alternative is a fleet that was switched on before it was
         * configured and accepted anything for the window in between.
         */
        if (config.secret.isNullOrEmpty()) return err(503, "no_secret_configured")

        /*
         * Header first, query second. The header is right and the query string is a concession —
         * ⚠️ and it is a real cost, not a free one: a query secret lands in every proxy log, every
         * browser history and every `netstat`-adjacent diagnostic on the way. It is here for exactly
         * the reason the trigger door takes one (AMX NetLinx cannot set a request header at all, and
         * Extron's Global Scripter forbids the modules that would), and the panel logs a warning the
         * first time one arrives so a site that CAN send a header finds out it should.
         */
        val bearer = headers[HEADER]?.trim()?.let {
            if (it.regionMatches(0, "Bearer ", 0, 7, ignoreCase = true)) it.substring(7).trim() else it
        }
        val given = bearer?.takeIf { it.isNotEmpty() } ?: query["secret"]
        if (!secretOk(given, config.secret)) return err(401, "bad_secret")

        return when {
            method == "GET" && path == "/api/status" -> {
                val s = try { status() } catch (e: Throwable) { JSONObject() }
                Result(200, s.toString())
            }
            method == "POST" && path == "/api/command" -> command(body, query)
            // A door that exists but not for this method. 405 with Allow, like the trigger door.
            path == "/api/status" -> err(405, "GET only")
            else -> err(405, "POST only")
        }
    }

    private fun command(body: String, query: Map<String, String>): Result {
        var type = ""
        var payload: JSONObject? = null
        try {
            val j = JSONObject(body)
            type = j.optString("type", "")
            payload = j.optJSONObject("payload")
            /*
             * ⚠️ Flat bodies are accepted too: {"type":"set_volume","volume":40} as well as
             * {"type":"set_volume","payload":{"volume":40}}. Not politeness — a control system that
             * hand-concatenates JSON gets one level of nesting right and two wrong, and the nested
             * form failing SILENTLY (a valid command with an empty payload is a volume of zero) is
             * worse than either shape being refused.
             */
            if (payload == null) {
                val flat = JSONObject(body)
                flat.remove("type")
                if (flat.length() > 0) payload = flat
            }
        } catch (e: Throwable) {
            // No JSON at all: allow ?type= on the query, for the same gear the trigger door's GET
            // exists for. The body stays the documented form.
            type = query["type"] ?: ""
        }
        if (type.isEmpty()) return err(400, "type required")
        /*
         * ⚠️ Not in COMMANDS is 403, not 400. The command may well be perfectly valid — `reboot` is
         * a real command this panel implements — and answering "invalid" about a command that
         * exists sends an integrator to check their spelling instead of their permissions.
         */
        if (!COMMANDS.contains(type)) {
            return Result(403, "{\"ok\":false,\"error\":\"command_not_permitted\",\"type\":\"$type\"}")
        }
        return Result(200, "{\"ok\":true,\"type\":\"$type\"}", command = type, payload = payload)
    }
}
