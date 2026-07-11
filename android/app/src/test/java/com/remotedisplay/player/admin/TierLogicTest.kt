package com.remotedisplay.player.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #161: the privilege-tier decision, independent of Android/DevicePolicyManager. STPolicy is just the
 * shell that feeds real device state into this pure function.
 */
class TierLogicTest {

    @Test fun unprivileged_is_tier0() {
        assertEquals(0, TierLogic.tier(isDeviceOwner = false, canInstallSilently = false, isAdminActive = false))
    }

    @Test fun device_admin_only_is_tier1() {
        assertEquals(1, TierLogic.tier(isDeviceOwner = false, canInstallSilently = false, isAdminActive = true))
    }

    @Test fun device_owner_is_tier2() {
        assertEquals(2, TierLogic.tier(isDeviceOwner = true, canInstallSilently = true, isAdminActive = true))
    }

    @Test fun delegated_install_without_ownership_is_tier2() {
        // MDM granted DELEGATION_PACKAGE_INSTALLATION: silent install, not owner, not our admin.
        assertEquals(2, TierLogic.tier(isDeviceOwner = false, canInstallSilently = true, isAdminActive = false))
    }

    @Test fun owner_flag_alone_promotes_even_if_silent_flag_lags() {
        // Defensive: owner should win regardless of the canInstallSilently input.
        assertEquals(2, TierLogic.tier(isDeviceOwner = true, canInstallSilently = false, isAdminActive = false))
    }
}
