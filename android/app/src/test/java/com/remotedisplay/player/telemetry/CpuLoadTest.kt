package com.remotedisplay.player.telemetry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CpuLoadTest {

    private fun loadOf(vararg lines: String?): CpuLoad {
        val it = lines.iterator()
        return CpuLoad { if (it.hasNext()) it.next() else null }
    }

    @Test fun `first sample has nothing to compare against`() {
        assertNull(loadOf("cpu  100 0 100 800 0 0 0 0 0 0").sample())
    }

    @Test fun `busy over total between two samples`() {
        val l = loadOf("cpu  100 0 100 800 0 0 0 0 0 0", "cpu  250 0 150 900 0 0 0 0 0 0")
        l.sample()
        // busy +200, idle +100 -> 200 / 300
        assertEquals(66.67, l.sample()!!, 0.01)
    }

    @Test fun `iowait counts as idle`() {
        val l = loadOf("cpu  0 0 0 0 0 0 0 0", "cpu  50 0 0 25 25 0 0 0")
        l.sample()
        assertEquals(50.0, l.sample()!!, 0.001)
    }

    @Test fun `unreadable proc stat leaves the key out`() {
        val l = loadOf(null, null)
        assertNull(l.sample()); assertNull(l.sample())
    }

    @Test fun `garbage and per-core lines are rejected`() {
        assertNull(CpuLoad.parse("cpu0 1 2 3 4 5"))
        assertNull(CpuLoad.parse("cpu  a b c d e"))
        assertNull(CpuLoad.parse(""))
    }

    @Test fun `no elapsed ticks gives no reading`() {
        val l = loadOf("cpu  1 1 1 1 0", "cpu  1 1 1 1 0")
        l.sample()
        assertNull(l.sample())
    }
}
