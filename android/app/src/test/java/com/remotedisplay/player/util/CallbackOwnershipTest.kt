package com.remotedisplay.player.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #508: ProvisioningActivity.onDestroy usually runs AFTER the MainActivity it handed off to has
 * installed its own onUnpaired/onRegistered. Clearing those fields outright wiped MainActivity's, so
 * a device deleted from the dashboard never showed its new pairing code. It may release only its own.
 */
class CallbackOwnershipTest {
    private class Slot { var onUnpaired: (() -> Unit)? = null }

    private fun releaseIfOwn(slot: Slot, mine: (() -> Unit)?) {
        if (CallbackOwnership.isOwn(slot.onUnpaired, mine)) slot.onUnpaired = null
    }

    @Test fun releasesItsOwnCallback() {
        val slot = Slot()
        val provisioning: () -> Unit = {}
        slot.onUnpaired = provisioning
        releaseIfOwn(slot, provisioning)
        assertTrue(slot.onUnpaired == null)
    }

    @Test fun leavesTheNextActivitysCallbackInPlace() {
        // The #508 order: Provisioning installs, MainActivity binds and replaces it, THEN
        // Provisioning's onDestroy runs its clear.
        val slot = Slot()
        val provisioning: () -> Unit = {}
        val main: () -> Unit = {}
        slot.onUnpaired = provisioning
        slot.onUnpaired = main
        releaseIfOwn(slot, provisioning)
        assertTrue("MainActivity's callback survives", slot.onUnpaired === main)
    }

    @Test fun aSecondClearIsHarmless() {
        // Cleared once on pairing, again in onDestroy: the second call owns nothing any more.
        val slot = Slot()
        val main: () -> Unit = {}
        slot.onUnpaired = main
        releaseIfOwn(slot, null)
        assertTrue(slot.onUnpaired === main)
    }

    @Test fun identityNotEquality() {
        val a: () -> Unit = {}
        val b: () -> Unit = {}
        assertFalse(CallbackOwnership.isOwn(a, b))
        assertFalse(CallbackOwnership.isOwn(null, a))
        assertFalse(CallbackOwnership.isOwn(a, null))
        assertTrue(CallbackOwnership.isOwn(a, a))
    }
}
