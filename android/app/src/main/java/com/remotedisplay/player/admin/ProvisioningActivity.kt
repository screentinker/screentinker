package com.remotedisplay.player.admin

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * Handles the Android 10+ fully-managed (QR / NFC / cloud) device-owner provisioning handshake.
 *
 * WHY THIS EXISTS: `adb dpm set-device-owner` sets the owner directly and SKIPS this flow — which
 * is why ADB enrollment worked but scanning the QR failed with "something went wrong, contact your
 * IT admin". On Android 12+ the platform REQUIRES the DPC to answer ADMIN_POLICY_COMPLIANCE after
 * it installs + sets the owner; with no handler, provisioning rolls back with that generic error.
 *
 *  - GET_PROVISIONING_MODE (API 29+): the platform asks what kind of provisioning we support.
 *    We answer "fully managed device" (device owner) and finish.
 *  - ADMIN_POLICY_COMPLIANCE (API 30+, REQUIRED on 12+): the DPC's post-setup screen. The player
 *    self-configures on first boot (pairing screen), so we have nothing blocking to apply here —
 *    report success so setup completes and the device lands on the player.
 *
 * Both intents are system-only (guarded by BIND_DEVICE_ADMIN in the manifest).
 */
class ProvisioningActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val action = intent?.action
        Log.i(TAG, "Provisioning intent received: $action")

        // The compliance/mode intents also carry the admin-extras bundle — apply it here too so the
        // server URL is seeded even if onProfileProvisioningComplete doesn't fire on this OS version.
        ProvisioningExtras.apply(this, intent)

        when (action) {
            DevicePolicyManager.ACTION_GET_PROVISIONING_MODE -> {
                val result = Intent().putExtra(
                    DevicePolicyManager.EXTRA_PROVISIONING_MODE,
                    DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE
                )
                setResult(RESULT_OK, result)
            }
            // ADMIN_POLICY_COMPLIANCE and anything else: nothing to enforce during setup — succeed
            // so the platform completes provisioning rather than treating a non-OK result as failure.
            else -> setResult(RESULT_OK)
        }
        finish()
    }

    companion object { private const val TAG = "Provisioning" }
}
