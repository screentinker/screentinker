package com.remotedisplay.player.player

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * feat/transition-engine (native Android port). Two guarantees:
 *  1. Transitions.parse() is tolerant — a valid object resolves; anything malformed/empty -> null so the
 *     compositor hard-cuts (never a black frame), mirroring the server's "unknown shader -> no transition".
 *  2. TransitionSpec.sig() makes a transition edit change the playlist fingerprint — the exact fix for the
 *     bug that made transitions "never apply" on cached-playlist devices (web/Tizen) until the fingerprint
 *     included the transition.
 */
class TransitionParseTest {

    private fun spec(json: String): TransitionSpec? = Transitions.parse(JSONObject(json))

    @Test fun `valid transition resolves effects, params and duration`() {
        val t = spec("""{"effects":[{"shader":"CRTCollapse","params":{"lineHold":0.2,"flashGain":1.0}}],"durationMs":800}""")!!
        assertEquals(1, t.effects.size)
        assertEquals("CRTCollapse", t.effects[0].shader)
        assertEquals(0.2f, t.effects[0].params["lineHold"])
        assertEquals(1.0f, t.effects[0].params["flashGain"])
        assertEquals(800, t.durationMs)
    }

    @Test fun `multiple effects are preserved in order`() {
        val t = spec("""{"effects":[{"shader":"CRTCollapse","params":{}},{"shader":"Etch","params":{}}],"durationMs":500}""")!!
        assertEquals(listOf("CRTCollapse", "Etch"), t.effects.map { it.shader })
    }

    @Test fun `effect with no shader is dropped, all-empty yields null (hard cut, never black)`() {
        assertNull(spec("""{"effects":[{"params":{"x":1}}],"durationMs":800}"""))
        assertNull(spec("""{"effects":[],"durationMs":800}"""))
        assertNull(spec("""{"durationMs":800}"""))          // no effects array
        assertNull(Transitions.parse(null))                 // absent transition
    }

    @Test fun `duration is bounded even if the payload is out of range`() {
        assertEquals(3000, spec("""{"effects":[{"shader":"Etch","params":{}}],"durationMs":999999}""")!!.durationMs)
        assertEquals(150, spec("""{"effects":[{"shader":"Etch","params":{}}],"durationMs":1}""")!!.durationMs)
        assertEquals(800, spec("""{"effects":[{"shader":"Etch","params":{}}]}""")!!.durationMs) // default
    }

    // ===== the fingerprint (THE bug) =====

    @Test fun `sig is stable regardless of param key order`() {
        val a = spec("""{"effects":[{"shader":"CRTCollapse","params":{"a":1,"b":2}}],"durationMs":800}""")!!
        val b = spec("""{"effects":[{"shader":"CRTCollapse","params":{"b":2,"a":1}}],"durationMs":800}""")!!
        assertEquals("param-order must not change the signature (else spurious re-renders)", a.sig(), b.sig())
    }

    @Test fun `a shader, param, or duration change all change the signature`() {
        val base = spec("""{"effects":[{"shader":"CRTCollapse","params":{"lineHold":0.2}}],"durationMs":800}""")!!
        val shader = spec("""{"effects":[{"shader":"Etch","params":{"lineHold":0.2}}],"durationMs":800}""")!!
        val param = spec("""{"effects":[{"shader":"CRTCollapse","params":{"lineHold":0.5}}],"durationMs":800}""")!!
        val dur = spec("""{"effects":[{"shader":"CRTCollapse","params":{"lineHold":0.2}}],"durationMs":1200}""")!!
        assertNotEquals(base.sig(), shader.sig())
        assertNotEquals(base.sig(), param.sig())
        assertNotEquals(base.sig(), dur.sig())
    }

    @Test fun `adding or changing a transition flips the item signature (would-be de-dup is broken)`() {
        // Reproduces the cached-playlist bug at the PlaylistController level: same content, only the
        // transition differs -> the item signature MUST differ so the update isn't silently dropped.
        fun itemSig(t: TransitionSpec?): String =
            "cid|" + "" + "|" + "" + "|" + "" + "|" + (t?.sig() ?: "")   // mirrors PlaylistController.sig() shape

        val none = itemSig(null)
        val withTx = itemSig(spec("""{"effects":[{"shader":"CRTCollapse","params":{}}],"durationMs":800}"""))
        val otherTx = itemSig(spec("""{"effects":[{"shader":"Etch","params":{}}],"durationMs":800}"""))
        assertNotEquals("adding a transition must change the fingerprint", none, withTx)
        assertNotEquals("swapping the shader must change the fingerprint", withTx, otherTx)
        assertTrue(none.endsWith("|"))                      // no transition -> empty suffix
    }
}
