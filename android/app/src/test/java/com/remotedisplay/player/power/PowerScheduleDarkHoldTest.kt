package com.remotedisplay.player.power

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A panel restarted inside a scheduled-off window must reach the server before it goes dark.
 *
 * Going dark first puts the device to sleep before Wi-Fi has associated, and with the screen off
 * Android barely scans: the panel then sits offline until the morning edge wakes the screen. The
 * hold delays only the OFF, and only for a bounded time, so a panel with no WAN still goes dark.
 */
class PowerScheduleDarkHoldTest {

    private val hold = PowerScheduleManager.BOOT_DARK_HOLD_MS

    @Test
    fun aScheduledOffWaitsWhileTheHoldRuns() {
        assertTrue(
            PowerScheduleManager.deferDark(wantOff = true, nowElapsedMs = 20_000, holdUntilElapsedMs = 20_000 + hold)
        )
    }

    @Test
    fun aScheduledOffAppliesOnceTheHoldHasExpired() {
        // No WAN at all: the panel must still go dark, a few minutes late rather than never.
        assertFalse(
            PowerScheduleManager.deferDark(wantOff = true, nowElapsedMs = 20_000 + hold, holdUntilElapsedMs = 20_000 + hold)
        )
    }

    @Test
    fun aReleasedHoldNeverDefers() {
        // releaseDarkHold() sets 0: after the socket connects the OFF applies at once.
        assertFalse(
            PowerScheduleManager.deferDark(wantOff = true, nowElapsedMs = 5_000, holdUntilElapsedMs = 0)
        )
    }

    @Test
    fun anOnIsNeverDelayed() {
        assertFalse(
            PowerScheduleManager.deferDark(wantOff = false, nowElapsedMs = 5_000, holdUntilElapsedMs = 5_000 + hold)
        )
    }

    @Test
    fun theHoldIsBoundedToMinutesNotHours() {
        assertTrue("the hold must outlast a slow boot-to-socket", hold >= 60_000L)
        assertTrue("and stay short enough that a dark shop is not lit all night", hold <= 600_000L)
    }

    @Test
    fun theServiceHoldsBeforeRestoringAndReleasesOnConnect() {
        val f = File("src/main/java/com/remotedisplay/player/service/WebSocketService.kt")
        assertTrue("source not found: ${f.absolutePath}", f.exists())
        val service = f.readText()
        // Search inside the PowerScheduleManager block: other service-owned managers restore() too.
        val block = service.indexOf("PowerScheduleManager(")
        assertTrue("the power schedule must be created in the service", block >= 0)
        val hold = service.indexOf("it.holdDarkUntilOnline()", block)
        val restore = service.indexOf("it.restore()", block)
        assertTrue("the hold must be armed", hold >= 0)
        assertTrue("before restore() applies the window", hold < restore)
        assertTrue(
            "the connect handler must release the hold before the forced re-assert",
            service.contains("powerSchedule?.releaseDarkHold(); powerSchedule?.applyNow(force = true)")
        )
    }
}
