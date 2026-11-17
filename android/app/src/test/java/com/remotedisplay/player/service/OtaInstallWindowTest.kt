package com.remotedisplay.player.service

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** GHSA-rvxj 3.2: the accessibility service may only auto-confirm inside an armed, unexpired window. */
class OtaInstallWindowTest {
    @After fun reset() = OtaInstallWindow.disarm()

    @Test fun `never armed is closed`() {
        assertFalse(OtaInstallWindow.isOpen(0L, 1_000_000L))
    }

    @Test fun `armed is open until the window passes`() {
        val t0 = 1_000_000L
        OtaInstallWindow.arm(t0)
        assertTrue(OtaInstallWindow.isOpen(t0))
        assertTrue(OtaInstallWindow.isOpen(t0 + OtaInstallWindow.WINDOW_MS - 1))
        assertFalse(OtaInstallWindow.isOpen(t0 + OtaInstallWindow.WINDOW_MS))
    }

    @Test fun `disarm closes it at once`() {
        OtaInstallWindow.arm(5_000L)
        OtaInstallWindow.disarm()
        assertFalse(OtaInstallWindow.isOpen(5_001L))
    }

    @Test fun `a clock that jumped backwards does not hold it open forever`() {
        val t0 = 10_000_000L
        val until = t0 + OtaInstallWindow.WINDOW_MS
        assertFalse(OtaInstallWindow.isOpen(until, t0 - 60_000L))
    }
}
