package com.remotedisplay.player.power

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The first connection after a boot is not a stable one. On the dev panel Android dropped
 * Wi-Fi 3.5 s after the panel went dark on its first socket, and again 61 s after boot while lit.
 * So the panel stays lit until the boot has settled, and a drop in the dark early on relights it.
 */
class PowerScheduleBootSettleTest {

    private val settle = PowerScheduleManager.BOOT_SETTLE_MS
    private val grace = PowerScheduleManager.BOOT_GRACE_MS
    private val hold = PowerScheduleManager.BOOT_DARK_HOLD_MS

    @Test
    fun aConnectEarlyInTheBootKeepsThePanelLitUntilItSettles() {
        assertEquals(settle, PowerScheduleManager.holdAfterConnect(nowElapsedMs = 23_000))
    }

    @Test
    fun aConnectLongAfterBootReleasesAtOnce() {
        // An OTA or a crash restarted only the service: the Wi-Fi has been up for hours.
        assertEquals(0L, PowerScheduleManager.holdAfterConnect(nowElapsedMs = 5 * 3_600_000L))
    }

    @Test
    fun aDropInTheDarkEarlyOnRelightsForAtMostTheHold() {
        assertEquals(200_000L + hold, PowerScheduleManager.relightUntil(wantOff = true, armed = true, nowElapsedMs = 200_000))
    }

    @Test
    fun theRelightNeverRunsPastTheGrace() {
        assertEquals(grace, PowerScheduleManager.relightUntil(wantOff = true, armed = true, nowElapsedMs = grace - 10_000))
    }

    @Test
    fun aDropAfterTheGraceLeavesTheShopDark() {
        assertEquals(0L, PowerScheduleManager.relightUntil(wantOff = true, armed = true, nowElapsedMs = grace))
    }

    @Test
    fun aDropOutsideAnOffWindowChangesNothing() {
        assertEquals(0L, PowerScheduleManager.relightUntil(wantOff = false, armed = true, nowElapsedMs = 30_000))
    }

    @Test
    fun aPanelThatNeverWaitsForAServerNeverRelights() {
        // A player that never calls holdDarkUntilOnline() does not arm the hold, so a lost network means nothing there.
        assertEquals(0L, PowerScheduleManager.relightUntil(wantOff = true, armed = false, nowElapsedMs = 30_000))
    }

    @Test
    fun theWindowsAreOrdered() {
        assertTrue("settle must cover the re-association seen at 61 s", settle >= 90_000L)
        assertTrue("a relight must fit inside the grace", hold < grace)
        assertTrue("the grace is minutes, not the night", grace <= 900_000L)
    }

    @Test
    fun theServiceReportsALostNetworkToTheSchedule() {
        val f = File("src/main/java/com/remotedisplay/player/service/WebSocketService.kt")
        assertTrue("source not found: ${f.absolutePath}", f.exists())
        val s = f.readText()
        val lost = s.indexOf("override fun onLost(network: Network)")
        assertTrue("onLost must exist", lost >= 0)
        assertTrue("onLost must reach the schedule", s.indexOf("powerSchedule?.onNetworkLost()", lost) in lost..(lost + 600))
    }
}
