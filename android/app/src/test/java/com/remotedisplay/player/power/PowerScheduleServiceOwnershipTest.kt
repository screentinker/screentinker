package com.remotedisplay.player.power

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression guard for the bug this feature shipped with in review: the schedule was owned by
 * MainActivity.
 *
 * ⚠️ WHY THAT IS FATAL RATHER THAN UNTIDY. Going dark is `lockNow()`, which stops the Activity and
 * lets the system destroy it. An Activity-owned tick therefore blanks the panel and then dies with
 * it: the 06:00 edge never fires, and the schedule works exactly once before the screen stays dark
 * until someone drives to the site. It would pass every functional test that ran inside one
 * daytime window.
 *
 * These are source-level assertions, which is the house style for wiring that cannot be exercised
 * without an emulator (see raspberry-pi-setup.test.js for the same shape). They pin OWNERSHIP,
 * not behaviour — the behaviour is PowerScheduleDecisionTest and PowerWindowTest.
 */
class PowerScheduleServiceOwnershipTest {

    private fun src(rel: String): String {
        // The test runs from android/app; the sources are under src/main/java.
        val f = File("src/main/java/com/remotedisplay/player/$rel")
        assertTrue("source not found: ${f.absolutePath}", f.exists())
        return f.readText()
    }

    @Test
    fun theScheduleIsOwnedByTheForegroundService() {
        val service = src("service/WebSocketService.kt")
        assertTrue(
            "WebSocketService must construct the manager — it is the only component guaranteed to " +
                "outlive lockNow()",
            service.contains("PowerScheduleManager(")
        )
        assertTrue("it must restore before any socket exists", service.contains("it.restore()"))
        assertTrue("and tick on the service lifecycle", service.contains("it.start()"))
        assertTrue("and stop with the service", service.contains("powerSchedule?.stop()"))
    }

    @Test
    fun theActivityOwnsOnlyTheWindowFlag() {
        val activity = src("MainActivity.kt")
        // The Activity may ONLY hold the flag. If it constructs or ticks the manager, the schedule
        // dies with the window it just switched off.
        assertFalse(
            "MainActivity must not construct PowerScheduleManager (see the header of that file)",
            activity.contains("PowerScheduleManager(")
        )
        assertFalse("nor start its tick", Regex("""powerSchedule\?\.start\(""").containsMatchIn(activity))
        assertTrue(
            "it registers the window-flag callback instead",
            activity.contains("onPowerWindow = { off -> applyPowerWindowFlag(off) }")
        )
        assertTrue(
            "and the flag is RELEASED while scheduled off, or a touch relights the panel all night",
            activity.contains("window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)")
        )
        assertTrue(
            "and re-added on the way out",
            activity.contains("window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)")
        )
    }

    @Test
    fun thereIsExactlyOneWayToBlankThePanel() {
        val service = src("service/WebSocketService.kt")
        // The remote command and the schedule must funnel through the same method, or the two
        // implementations drift and the divergence only shows up on hardware.
        assertTrue("blankPanel() must exist", service.contains("private fun blankPanel()"))
        assertTrue("and the schedule must use it", service.contains("if (off) blankPanel() else wakePanel"))
        val lockNowCalls = Regex("""STPolicy\(this@WebSocketService\)\.lockNow\(\)""").findAll(service).count()
        assertTrue("lockNow should be reached through blankPanel only, found $lockNowCalls", lockNowCalls == 1)
    }

    @Test
    fun aScheduledWakeStillWorksWithNoActivityAttached() {
        val service = src("service/WebSocketService.kt")
        // "The screen never came back on" is a site visit, so the wake must not depend on a UI:
        // the wake lock needs only WAKE_LOCK (held by this service), and the player is relaunched
        // when nothing is attached.
        assertTrue(service.contains("private fun wakePanel(bringToFront: Boolean"))
        assertTrue(
            "the service must relaunch MainActivity when no Activity is attached",
            service.contains("wake: no Activity attached — relaunched MainActivity")
        )
        assertTrue(
            "a scheduled edge must ask for the relaunch",
            service.contains("wakePanel(bringToFront = true)")
        )
    }

    @Test
    fun theScheduleIsAdoptedInTheServiceNotTheActivity() {
        val service = src("service/WebSocketService.kt")
        val activity = src("MainActivity.kt")
        // Both the payload field and the command land in the service, so a schedule edit is not
        // lost when it arrives during a window (when the Activity is typically gone).
        assertTrue(service.contains("""powerSchedule?.update(data.optJSONObject("power_schedule"))"""))
        assertTrue(service.contains("""powerSchedule?.update(payload?.optJSONObject("schedule"))"""))
        assertFalse(activity.contains("powerSchedule?.update("))
    }

    @Test
    fun reconnectReassertsTheState() {
        val service = src("service/WebSocketService.kt")
        // While offline the panel's actual state can drift from ours (a touch, an OTA restart).
        // A change-only tick would leave that until the next edge, which overnight is hours away.
        assertTrue(service.contains("powerSchedule?.applyNow(force = true)"))
    }
}
