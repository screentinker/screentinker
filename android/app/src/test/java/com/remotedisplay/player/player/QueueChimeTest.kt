package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class QueueChimeTest {
    @Test fun volumeIsTheWidgetsSettingClampedToZeroToOne() {
        assertEquals(0.5f, QueueChime.volume("0.5"), 0f)
        assertEquals(0f, QueueChime.volume("0"), 0f)
        assertEquals(1f, QueueChime.volume("7"), 0f)
        assertEquals(0f, QueueChime.volume("-1"), 0f)
        assertEquals(0.7f, QueueChime.volume(" 0.7 "), 1e-6f)
    }

    @Test fun anUnusableVolumeFallsBackToTheWebPlayersDefault() {
        for (raw in listOf(null, "", "loud", "NaN", "Infinity", "undefined")) {
            assertEquals(raw.toString(), QueueChime.DEFAULT_VOLUME, QueueChime.volume(raw), 0f)
        }
    }

    @Test fun onlyAWidgetRenderPageMayAskForAChime() {
        assertTrue(QueueChime.isWidgetPage("https://s.example/api/widgets/abc-123/render?device=d&rev=4"))
        assertTrue(QueueChime.isWidgetPage("http://10.0.0.5:3001/api/widgets/w1/render#panel"))
        assertTrue(QueueChime.isWidgetPage("https://s.example/api/widgets/w1/render"))
        assertFalse(QueueChime.isWidgetPage(null))
        assertFalse(QueueChime.isWidgetPage("bundle:content-1:rev3"))                        // a bundle's key
        assertFalse(QueueChime.isWidgetPage("https://www.youtube.com/embed/x"))
        assertFalse(QueueChime.isWidgetPage("https://s.example/api/content/c1/bundle?rev=2"))
        assertFalse(QueueChime.isWidgetPage("https://evil.example/?u=/api/widgets/w1/render"))
        assertFalse(QueueChime.isWidgetPage("https://s.example/api/widgets/w1/render-other"))
    }

    @Test fun aBurstOfCallsIsOneChime() {
        var now = 1_000_000L
        val gate = QueueChime.Gate(clock = { now })
        assertTrue(gate.admit())
        now += 500; assertFalse(gate.admit())
        now += 2_400; assertFalse(gate.admit())          // 2.9 s after the first
        now += 100; assertTrue(gate.admit())             // 3.0 s: a new chime
        now += 10; assertFalse(gate.admit())
    }

    @Test fun theSoundIsTwoShortTonesAndNeverLonger() {
        val pcm = QueueChime.synth(1f, 44_100)
        val seconds = pcm.size / 44_100.0
        assertTrue("about 0.9 s, was $seconds", seconds in 0.85..1.0)
        // It starts and ends (near) silent: no click, no tail.
        assertTrue(pcm.take(20).all { abs(it.toInt()) < 200 })
        assertTrue(pcm.takeLast(200).all { abs(it.toInt()) < 50 })
        // The first tone is loud near its peak; the gap between the tones is quieter than the peaks.
        val peak1 = pcm.slice(882 until 4_410).maxOf { abs(it.toInt()) }
        val peak2 = pcm.slice(16_758 + 882 until 16_758 + 4_410).maxOf { abs(it.toInt()) }
        assertTrue("first tone audible ($peak1)", peak1 > 8_000)
        assertTrue("second tone audible ($peak2)", peak2 > 8_000)
    }

    @Test fun volumeScalesTheSoundAndZeroIsSilent() {
        val loud = QueueChime.synth(1f).maxOf { abs(it.toInt()) }
        val quiet = QueueChime.synth(0.25f).maxOf { abs(it.toInt()) }
        assertTrue("loud $loud vs quiet $quiet", quiet < loud / 3)
        assertTrue(QueueChime.synth(0f).all { abs(it.toInt()) <= 4 })
    }

    @Test fun theTonesMatchTheWebPlayer() {
        assertEquals(listOf(Triple(880.0, 0.0, 0.35), Triple(660.0, 0.38, 0.5)), QueueChime.TONES)
        assertEquals("STQueueChime", QueueChime.BRIDGE)
        assertEquals(3_000L, QueueChime.MIN_GAP_MS)
    }
}
