package com.remotedisplay.player.trigger

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ⚠️ org.json's optString RETURNS THE STRING "null" FOR A JSON null ON ANDROID.
 *
 * The server sends `secret: null`, `multicast_group: null` and `clear_all_token: null` whenever
 * they are unset (ws/deviceSocket.js builds trigger_config with `|| null`). TriggerManager read
 * them with `optString(...).takeIf { it.isNotEmpty() }`, which turns that JSON null into the
 * four-letter string "null" and treats it as a configured value. Three live consequences:
 *
 *   1. multicast_group "null" -> InetAddress.getByName("null") threw and killed the WHOLE UDP
 *      listener, so UDP triggers were inert on every device with no multicast group — the default.
 *      Observed on real hardware: 'UDP listener failed: Unable to resolve host "null"'.
 *   2. secret "null" -> TriggerResolve refuses a fire only when the device secret isNullOrEmpty(),
 *      and "null" is neither, so a device with listeners enabled and NO secret set ACCEPTED
 *      `ST1 null <token>` rather than refusing everything.
 *   3. clear_all_token "null" -> the literal token "null" would clear every active trigger.
 *
 * ⚠️ AND THIS IS WHY THE SUITE WAS GREEN. The reference org.json used by JVM unit tests returns the
 * FALLBACK for a JSON null; only Android's implementation returns "null". No test running here can
 * reproduce the platform behaviour — so these assert the thing that IS provable on both: given the
 * literal string "null", the parse must yield absence.
 *
 * The same trap already cost this project once, in the remote_url download path.
 */
class TriggerConfigNullTest {

    /** Mirrors TriggerManager.optText — the rule under test. */
    private fun optText(o: JSONObject?, key: String): String? {
        if (o == null || o.isNull(key)) return null
        val v = o.optString(key, "")
        return if (v.isEmpty() || v == "null") null else v
    }

    @Test fun THE_BUG_the_string_null_is_treated_as_absent() {
        // This is what Android's optString hands back for a JSON null.
        val o = JSONObject("""{"secret":"null","multicast_group":"null","clear_all_token":"null"}""")
        assertNull("a secret of \"null\" must not count as configured", optText(o, "secret"))
        assertNull("a group of \"null\" is what killed the UDP listener", optText(o, "multicast_group"))
        assertNull("a clear-all token of \"null\" would clear every trigger", optText(o, "clear_all_token"))
    }

    @Test fun a_real_JSON_null_is_absent() {
        val o = JSONObject(); o.put("secret", JSONObject.NULL)
        assertNull(optText(o, "secret"))
    }

    @Test fun a_missing_key_is_absent() {
        assertNull(optText(JSONObject(), "secret"))
        assertNull(optText(null, "secret"))
    }

    @Test fun an_empty_string_is_absent() {
        assertNull(optText(JSONObject("""{"secret":""}"""), "secret"))
    }

    @Test fun a_REAL_value_still_survives() {
        // The fix must not throw the baby out: a configured secret has to keep working.
        val o = JSONObject("""{"secret":"798b015fd7dd3a8a90e7417fa2e51c51","multicast_group":"239.7.7.7"}""")
        assertEquals("798b015fd7dd3a8a90e7417fa2e51c51", optText(o, "secret"))
        assertEquals("239.7.7.7", optText(o, "multicast_group"))
    }

    @Test fun a_value_merely_CONTAINING_null_is_not_absent() {
        // Only the exact string is the sentinel; "nullify" is a legitimate token.
        assertEquals("nullify", optText(JSONObject("""{"t":"nullify"}"""), "t"))
        assertEquals("null-ish", optText(JSONObject("""{"t":"null-ish"}"""), "t"))
    }

    /* ---- the security half: what the resolver does once the secret is absent ---- */

    private fun alarm() = TriggerResolve.Trigger(
        id = "t1", name = "alarm", matchToken = "ALARM1", clearToken = "CLEAR1",
        sourceHttp = true, sourceUdp = true, mode = "until_cleared",
        priority = 10, maxDurationSec = 60, leaseSec = 120, items = listOf(mapOf("content_id" to "c1"))
    )

    @Test fun AN_UNCONFIGURED_DEVICE_REFUSES_EVERY_FIRE() {
        /*
         * The invariant the "null" secret defeated. With no secret set, no payload may fire —
         * including one that offers the string the bug produced.
         */
        for (deviceSecret in listOf(null, "")) {
            val v = TriggerResolve.evaluate("ST1 null ALARM1", listOf(alarm()), deviceSecret, null, "udp")
            assertFalse("an unconfigured device must refuse a fire (secret=$deviceSecret)", v.ok)
        }
    }

    @Test fun a_configured_device_still_fires_on_the_right_secret() {
        val v = TriggerResolve.evaluate("ST1 s3cret ALARM1", listOf(alarm()), "s3cret", null, "udp")
        assertTrue("a correct secret must still fire", v.ok)
    }
}
