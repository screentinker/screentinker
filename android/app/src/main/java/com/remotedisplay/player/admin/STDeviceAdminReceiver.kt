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
        Log.i(TAG, "device admin enabled (deviceOwner=${STPolicy(context).isDeviceOwner()})")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.i(TAG, "device admin disabled")
    }
}
