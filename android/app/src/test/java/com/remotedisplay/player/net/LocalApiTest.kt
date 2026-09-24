package com.remotedisplay.player.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The inbound local REST door's DECISION half (Goal B part 3).
 *
 * ⚠️ These are the assertions that cannot be made once the logic lives in a socket handler, which is
 * the whole reason LocalApi is separable from TriggerListeners: a refusal is only testable if you can
 * ask for one without binding a port.
 *
 * The cases worth having are all about what must NOT happen:
 *   - the door must be invisible when disabled, not merely closed
 *   - a panel with the flag on and no secret must refuse everything, not accept anything
 *   - a command the panel implements but that is not on the list must be refused, and refused with a
 *     status that sends an integrator to their permissions rather than their spelling
 *   - the status body must not be reachable without the secret, because it is the cheapest thing on
 *     the door and therefore the first thing anyone tries
 */
class LocalApiTest {

    private val cfg = LocalApi.Config(enabled = true, secret = "0123456789abcdef0123")
    private val status = { JSONObject().put("ok", true).put("name", "Lobby 1") }

    private fun get(path: String, q: Map<String, String> = emptyMap(), h: Map<String, String> = emptyMap(),
                    c: LocalApi.Config = cfg) =
        LocalApi.handle("GET", path, q, h, "", c, status)

    private fun post(path: String, body: String, q: Map<String, String> = emptyMap(),
                     h: Map<String, String> = mapOf("authorization" to "Bearer 0123456789abcdef0123"),
                     c: LocalApi.Config = cfg) =
        LocalApi.handle("POST", path, q, h, body, c, status)

    private fun auth() = mapOf("authorization" to "Bearer 0123456789abcdef0123")

    /* ------------------------------------------------------------------ the door */

    @Test
    fun `disabled is INVISIBLE, not forbidden`() {
        // ⚠️ 404 and not 403. A 403 advertises the feature to anyone scanning the segment: it says
        // "this panel has a control API and you have the wrong key". A panel that was never switched
        // on must look like a panel that has no such door.
        val r = get("/api/status", h = auth(), c = LocalApi.Config(enabled = false, secret = "x".repeat(20)))
        assertEquals(404, r.status)
        assertTrue(r.body.contains("not_found"))
        assertNull(r.command)
    }

    @Test
    fun `⚠️ enabled with NO secret refuses everything`() {
        /*
         * The trap TriggerManager documents for the string "null": a panel switched on before it was
         * configured must be CLOSED for the window in between, not open. A fleet enabled by a script
         * and secured later is exactly how that window happens.
         */
        val r = get("/api/status", h = auth(), c = LocalApi.Config(enabled = true, secret = null))
        assertEquals(503, r.status)
        assertTrue(r.body.contains("no_secret_configured"))
        val r2 = get("/api/status", h = auth(), c = LocalApi.Config(enabled = true, secret = ""))
        assertEquals(503, r2.status)
    }

    /* ------------------------------------------------------------------ the secret */

    @Test
    fun `status is NOT readable without the secret`() {
        // The cheapest request on the door, so the first one anybody tries.
        assertEquals(401, get("/api/status").status)
        assertEquals(401, get("/api/status", h = mapOf("authorization" to "Bearer wrong")).status)
        val ok = get("/api/status", h = auth())
        assertEquals(200, ok.status)
        assertTrue(ok.body.contains("Lobby 1"))
    }

    @Test
    fun `the secret is accepted as a bearer header, a bare header, or a query parameter`() {
        assertEquals(200, get("/api/status", h = mapOf("authorization" to "Bearer 0123456789abcdef0123")).status)
        // Bare, because plenty of gear writes the header but not the scheme.
        assertEquals(200, get("/api/status", h = mapOf("authorization" to "0123456789abcdef0123")).status)
        // Case-insensitive scheme: hand-concatenated HTTP gets this wrong constantly.
        assertEquals(200, get("/api/status", h = mapOf("authorization" to "bearer 0123456789abcdef0123")).status)
        // ⚠️ Query, for AMX NetLinx and Extron Global Scripter, which cannot set a header at all.
        assertEquals(200, get("/api/status", q = mapOf("secret" to "0123456789abcdef0123")).status)
    }

    @Test
    fun `an EMPTY header falls through to the query rather than failing outright`() {
        // A sender that emits `Authorization:` with nothing after it would otherwise be refused even
        // though it also sent a perfectly good ?secret= — a confusing 401 on a correct request.
        val r = get("/api/status", q = mapOf("secret" to "0123456789abcdef0123"),
                    h = mapOf("authorization" to ""))
        assertEquals(200, r.status)
    }

    @Test
    fun `a secret of a different length is refused without comparing content`() {
        assertEquals(401, get("/api/status", h = mapOf("authorization" to "Bearer 0123456789abcdef")).status)
        assertEquals(401, get("/api/status", h = mapOf("authorization" to "Bearer 0123456789abcdef01234567")).status)
    }

    /* ------------------------------------------------------------------ commands */

    @Test
    fun `an allowed command is returned for the caller to run, and answered 200`() {
        val r = post("/api/command", """{"type":"screen_off"}""")
        assertEquals(200, r.status)
        assertEquals("screen_off", r.command)
        assertTrue(r.body.contains("\"ok\":true"))
    }

    @Test
    fun `⚠️ a real command that is not on the list is 403, not 400`() {
        /*
         * `reboot` IS a command this panel implements. Answering "invalid command" would send an
         * integrator to check their spelling, when the honest answer is that this door does not grant
         * it. 400 and 403 send someone to two different places, and only one of them is the right one.
         */
        for (t in listOf("reboot", "shell", "install_apk", "set_server_url", "http_request", "launch",
                         "kiosk_unlock", "settings", "set_power_schedule", "update")) {
            val r = post("/api/command", """{"type":"$t"}""")
            assertEquals("$t must be refused", 403, r.status)
            assertNull("$t must not be handed to the dispatcher", r.command)
            assertTrue(r.body.contains("command_not_permitted"))
        }
    }

    @Test
    fun `the payload is taken nested OR flat`() {
        // ⚠️ Both, because a control system that hand-concatenates JSON gets one level of nesting
        // right and two wrong — and the nested form failing SILENTLY is the worst outcome: a valid
        // set_volume with an empty payload is a volume of zero.
        val nested = post("/api/command", """{"type":"set_volume","payload":{"volume":40}}""")
        assertEquals(40, nested.payload?.optInt("volume"))
        val flat = post("/api/command", """{"type":"set_volume","volume":40}""")
        assertEquals(40, flat.payload?.optInt("volume"))
        // And `type` is not left in the flat payload, where a handler might read it as data.
        assertFalse(flat.payload!!.has("type"))
    }

    @Test
    fun `a non-JSON body can still name a command on the query`() {
        // Same gear the trigger door's GET support exists for.
        val r = LocalApi.handle("POST", "/api/command", mapOf("type" to "refresh"), auth(), "not json at all", cfg, status)
        assertEquals(200, r.status)
        assertEquals("refresh", r.command)
    }

    @Test
    fun `a command with no type is 400`() {
        assertEquals(400, post("/api/command", """{}""").status)
        assertEquals(400, post("/api/command", """{"type":""}""").status)
    }

    @Test
    fun `⚠️ a wrong secret on a command never reaches the command`() {
        val r = LocalApi.handle("POST", "/api/command", emptyMap(), mapOf("authorization" to "Bearer nope"),
                                """{"type":"screen_off"}""", cfg, status)
        assertEquals(401, r.status)
        assertNull(r.command)
    }

    /* ------------------------------------------------------------------ methods and paths */

    @Test
    fun `the methods are fixed per path`() {
        assertEquals(405, LocalApi.handle("POST", "/api/status", emptyMap(), auth(), "", cfg, status).status)
        assertEquals(405, LocalApi.handle("GET", "/api/command", emptyMap(), auth(), "", cfg, status).status)
    }

    @Test
    fun `only the two paths are this door's`() {
        assertTrue(LocalApi.isLocalApiPath("/api/status"))
        assertTrue(LocalApi.isLocalApiPath("/api/command"))
        // ⚠️ Everything else on that socket is a TRIGGER. A near-miss must fall through rather than
        // be answered here, or a site POSTing triggers to /api/commands stops working.
        for (p in listOf("/", "/api", "/api/commands", "/api/status/", "/API/status", "/trigger")) {
            assertFalse(p, LocalApi.isLocalApiPath(p))
        }
    }

    /* ------------------------------------------------------------------ the status body */

    @Test
    fun `a status builder that throws yields an empty body, not a 500`() {
        // A control system polling status must not be able to take the door down with a panel-side
        // bug, and "{}" is a far better answer than a dropped connection.
        val r = LocalApi.handle("GET", "/api/status", emptyMap(), auth(), "", cfg) { throw RuntimeException("boom") }
        assertEquals(200, r.status)
        assertEquals("{}", r.body)
    }

    @Test
    fun `the command list is the room-control set and nothing more`() {
        assertEquals(
            listOf("refresh", "screen_on", "screen_off", "set_volume", "set_brightness", "set_system_brightness").sorted(),
            LocalApi.COMMANDS.sorted()
        )
    }
}
