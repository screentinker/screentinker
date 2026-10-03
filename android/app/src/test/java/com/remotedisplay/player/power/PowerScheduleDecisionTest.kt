package com.remotedisplay.player.power

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The manual-override rule, as a truth table.
 *
 * This is the part of the feature an operator actually interacts with under pressure: they are
 * standing in front of a screen that has gone dark on schedule, they press "screen on" in the
 * dashboard, and what happens next has to be obvious. Both wrong answers are bad in ways that are
 * hard to diagnose later:
 *
 *   - override forever -> the operator who woke a screen once silently loses the schedule, and
 *     nobody connects the dark-screens-stopped-working report to a button pressed weeks ago;
 *   - no override      -> the panel fights them, going dark again within 60 seconds while they
 *     are looking at it, which reads as "the dashboard doesn't work".
 *
 * The rule is: the press wins until the window ENDS, then the schedule resumes by itself.
 */
class PowerScheduleDecisionTest {

    @Test
    fun outsideAWindowTheScreenIsOnAndAnyOverrideIsSpent() {
        val d = PowerScheduleManager.decide(scheduledOff = false, manualOverride = false)
        assertFalse(d.off)
        assertTrue("leaving the window must clear the exemption, or it applies to the NEXT one", d.clearOverride)

        val withOverride = PowerScheduleManager.decide(scheduledOff = false, manualOverride = true)
        assertFalse(withOverride.off)
        assertTrue(withOverride.clearOverride)
    }

    @Test
    fun insideAWindowTheScreenIsOff() {
        val d = PowerScheduleManager.decide(scheduledOff = true, manualOverride = false)
        assertTrue(d.off)
        assertFalse(d.clearOverride)
    }

    @Test
    fun insideAWindowAnOperatorOverrideKeepsItOn() {
        val d = PowerScheduleManager.decide(scheduledOff = true, manualOverride = true)
        assertFalse("the operator asked for this screen, and the window has not ended yet", d.off)
        assertFalse("the exemption survives until the window ends, not until the next tick", d.clearOverride)
    }

    /**
     * The sequence that matters, walked end to end: dark at 22:00, woken by hand at 23:00, and
     * dark again on the FOLLOWING night without anyone touching it.
     */
    @Test
    fun theOverrideLastsExactlyOneWindow() {
        var override = false

        // 22:00 — the window starts, nothing pressed.
        var d = PowerScheduleManager.decide(scheduledOff = true, manualOverride = override)
        assertTrue(d.off)

        // 23:00 — the operator presses screen on.
        override = true
        d = PowerScheduleManager.decide(scheduledOff = true, manualOverride = override)
        assertFalse("stays on for the rest of the window", d.off)
        if (d.clearOverride) override = false
        assertTrue("still exempt at 02:00", override)

        // 06:00 — the window ends. The exemption is spent here, not before.
        d = PowerScheduleManager.decide(scheduledOff = false, manualOverride = override)
        assertFalse(d.off)
        if (d.clearOverride) override = false
        assertFalse("the exemption must be gone once the window ends", override)

        // 22:00 the next night — dark again, with nobody doing anything.
        d = PowerScheduleManager.decide(scheduledOff = true, manualOverride = override)
        assertTrue("the schedule resumes by itself the following night", d.off)
    }

    @Test
    fun decisionIsPureAndTotal() {
        // Four inputs, four answers, no other states to be in.
        val seen = HashSet<String>()
        for (off in listOf(true, false)) for (ov in listOf(true, false)) {
            val d = PowerScheduleManager.decide(off, ov)
            seen.add("$off/$ov -> ${d.off}/${d.clearOverride}")
        }
        assertEquals(4, seen.size)
    }
}
