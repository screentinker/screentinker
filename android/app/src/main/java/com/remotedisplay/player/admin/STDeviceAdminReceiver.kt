package com.remotedisplay.player.admin

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * #161 device-owner foundation. The DeviceAdminReceiver ScreenTinker enrolls as — required to become
 * device owner (via `adb dpm set-device-owner` or QR provisioning) or a plain device admin (FORCE_LOCK).
 *
 * Deliberately minimal: it carries the admin component + policy declarations (res/xml/device_admin.xml);
 * all actual policy is driven through [STPolicy], which degrades safely when we are not owner/admin, so
 * enrolling is an OPTIONAL power-up and the app stays fully functional at Tier 0/1 without it.
 */
class STDeviceAdminReceiver : DeviceAdminReceiver() {
    companion object {
        private const val TAG = "STDeviceAdmin"

        /** The admin component every DevicePolicyManager call is scoped to. */
        fun component(context: Context): ComponentName =
            ComponentName(context.applicationContext, STDeviceAdminReceiver::class.java)
    }

    override fun onEnabled(context: Context, intent: Intent) {
        val policy = STPolicy(context)
        Log.i(TAG, "device admin enabled (deviceOwner=${policy.isDeviceOwner()})")
        // Zero-touch onboarding for a fresh owner: set ourselves HOME, whitelist kiosk + a11y, grant
        // notifications — so the panel skips the manual first-run wizard. No-op when not owner.
        policy.applyOnboardingPolicy()
    }

    // Fires when device-owner provisioning completes. The intent carries the optional admin-extras
    // bundle (server URL) — apply it so the panel self-configures. No bundle -> harmless no-op.
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        Log.i(TAG, "provisioning complete — applying admin extras (if any)")
        ProvisioningExtras.apply(context, intent)
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.i(TAG, "device admin disabled")
    }
}
