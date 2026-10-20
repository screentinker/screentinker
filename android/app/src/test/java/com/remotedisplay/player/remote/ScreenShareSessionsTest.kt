package com.remotedisplay.player.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 3.0 screen share, several presenters: the controller's bookkeeping (ScreenShareSessions), held to
 * the web receiver's sessions{}/order[]/layoutState rules (server/lib/screen-share-player.js).
 */
class ScreenShareSessionsTest {

    private class Rx(val id: String)

    private fun filled(vararg ids: String) = ScreenShareSessions<Rx>().also { s -> ids.forEach { s.add(it, Rx(it)) } }

    @Test fun keepsStartOrderOldestFirst() {
        val s = filled("a", "b", "c")
        assertEquals(listOf("a", "b", "c"), s.order)
        assertEquals(3, s.size)
        assertTrue("b" in s)
    }

    @Test fun aFifthStartHandsBackTheOldestAndForgetsIt() {
        val s = filled("a", "b", "c", "d")
        val a = s["a"]!!
        val replaced = s.add("e", Rx("e"))
        assertEquals(1, replaced.size)
        assertSame(a, replaced[0])
        assertEquals(listOf("b", "c", "d", "e"), s.order)
        // Its late end changes nothing: it was already forgotten.
        assertFalse(s.ended("a", a))
        assertEquals(4, s.size)
    }

    @Test fun aRepeatedStartIsIgnored() {
        val s = filled("a")
        val first = s["a"]!!
        assertEquals(emptyList<Rx>(), s.add("a", Rx("a")))
        assertSame(first, s["a"])
        assertEquals(1, s.size)
    }

    @Test fun onlyTheLastEndEmptiesIt() {
        val s = filled("a", "b")
        assertTrue(s.ended("a", s["a"]!!))
        assertFalse(s.isEmpty)               // still sharing: stay ducked
        assertTrue(s.ended("b", s["b"]!!))
        assertTrue(s.isEmpty)                // the last one: un-duck
    }

    @Test fun anEndOnlyForgetsTheSameReceiver() {
        val s = ScreenShareSessions<Rx>()
        val old = Rx("a"); val new = Rx("a")
        s.add("a", old)
        assertTrue(s.ended("a", old))
        s.add("a", new)
        assertFalse(s.ended("a", old))       // a stale end for a reused id
        assertSame(new, s["a"])
    }

    @Test fun stopTargetsMatchStopApplies() {
        val s = filled("a", "b", "c")
        assertEquals(listOf("a", "b", "c"), s.stopTargets(null).map { it.id })
        assertEquals(listOf("a", "b", "c"), s.stopTargets("").map { it.id })
        assertEquals(listOf("b"), s.stopTargets("b").map { it.id })
        assertEquals(emptyList<String>(), s.stopTargets("gone").map { it.id })   // a late stop for an older share
    }

    @Test fun layoutDrivesVisibleAndAudioAndIsForgottenWithTheLastShare() {
        val s = filled("a", "b", "c")
        assertEquals("c", s.audioId())
        s.layout = ScreenShareProtocol.Layout("b", "a", 3)
        assertEquals(listOf("b"), s.visibleIds())
        assertEquals("a", s.audioId())
        s.ended("a", s["a"]!!)
        assertEquals("c", s.audioId())       // the layout's audio has gone: the newest
        s.ended("b", s["b"]!!)
        assertEquals(listOf("c"), s.visibleIds())
        s.ended("c", s["c"]!!)
        assertEquals(ScreenShareProtocol.Layout.NONE, s.layout)
        assertNull(s.audioId())
    }

    @Test fun aLayoutBeforeTheStartIsRememberedForIt() {
        val s = ScreenShareSessions<Rx>()
        s.layout = ScreenShareProtocol.Layout("b", "b", 2)
        s.add("a", Rx("a")); s.add("b", Rx("b"))
        assertEquals(listOf("b"), s.visibleIds())
        assertEquals("b", s.audioId())
    }
}
