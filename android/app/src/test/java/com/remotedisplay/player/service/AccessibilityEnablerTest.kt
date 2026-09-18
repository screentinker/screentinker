package com.remotedisplay.player.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure list logic behind device-owner accessibility self-enable.
 *
 * ⚠️ REGRESSION GUARDS. Enabling our service writes Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
 * (a colon-separated list). It MUST preserve any other enabled service (e.g. TalkBack) rather than
 * clobber it, and MUST NOT add ours twice. It also must recognise ours case-insensitively so it does
 * not re-add an already-enabled service on every boot.
 */
class AccessibilityEnablerTest {

    private val ours = "com.remotedisplay.player/com.remotedisplay.player.service.PowerAccessibilityService"
    private val talkback = "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService"

    @Test fun `merge into an empty list is just ours`() {
        assertEquals(ours, AccessibilityEnabler.mergeService(null, ours))
        assertEquals(ours, AccessibilityEnabler.mergeService("", ours))
    }

    @Test fun `merge preserves an existing OTHER service (does not clobber TalkBack)`() {
        assertEquals("$talkback:$ours", AccessibilityEnabler.mergeService(talkback, ours))
    }

    @Test fun `merge is idempotent - ours is never duplicated`() {
        assertEquals(ours, AccessibilityEnabler.mergeService(ours, ours))
        assertEquals("$talkback:$ours", AccessibilityEnabler.mergeService("$talkback:$ours", ours))
    }

    @Test fun `listHasService detects membership, case-insensitively`() {
        assertTrue(AccessibilityEnabler.listHasService("$talkback:$ours", ours))
        assertTrue(AccessibilityEnabler.listHasService(ours.uppercase(), ours))
        assertFalse(AccessibilityEnabler.listHasService(talkback, ours))
        assertFalse(AccessibilityEnabler.listHasService(null, ours))
        assertFalse(AccessibilityEnabler.listHasService("", ours))
    }
}
