package com.remotedisplay.player.service

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log

/**
 * Self-enable ScreenTinker's own AccessibilityService on a provisioned panel.
 *
 * ⚠️ WHY THIS EXISTS. The accessibility service is the ONLY durable whole-screen capture path (it
 * survives OTAs, unlike MediaProjection consent) and the only working D-pad path. But nothing can
 * turn it on programmatically with pure device-owner / DPM APIs — Android deliberately blocks that,
 * because auto-enabling an accessibility service is a powerful capability. The ONE supported way for
 * an app to enable its own service is to hold WRITE_SECURE_SETTINGS and write the Secure setting
 * directly. WRITE_SECURE_SETTINGS is signature/privileged, so a device owner cannot self-grant it;
 * it must be granted once at provisioning:
 *
 *     adb shell pm grant com.remotedisplay.player android.permission.WRITE_SECURE_SETTINGS
 *
 * When that grant is present this flips the service on with no human at the panel; when it is not,
 * every method is a safe no-op and the operator is nudged toward Settings by the dashboard instead.
 */
object AccessibilityEnabler {
    private const val TAG = "A11yEnabler"

    private fun component(context: Context): String =
        ComponentName(context, PowerAccessibilityService::class.java).flattenToString()

    /** Whether [enabledList] (Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, a colon-separated list)
     *  already contains [component]. Case-insensitive; tolerates null/blank. Pure - unit-tested. */
    fun listHasService(enabledList: String?, component: String): Boolean {
        if (enabledList.isNullOrBlank()) return false
        return enabledList.split(':').any { it.equals(component, ignoreCase = true) }
    }

    /** Merge [component] into [enabledList], PRESERVING any other enabled services (e.g. TalkBack) and
     *  never duplicating ours. Pure - unit-tested. This is the write we make to enable ourselves. */
    fun mergeService(enabledList: String?, component: String): String = when {
        enabledList.isNullOrBlank() -> component
        listHasService(enabledList, component) -> enabledList
        else -> "$enabledList:$component"
    }

    /** Whether OUR accessibility service is already listed as enabled. */
    fun isEnabled(context: Context): Boolean =
        listHasService(
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
            component(context)
        )

    /** Whether we were granted WRITE_SECURE_SETTINGS (i.e. provisioning opted in). */
    fun canSelfEnable(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Ensure the service is enabled. Returns true if it is enabled after the call (already-on, or
     * just self-enabled); false if we cannot enable it (no grant, or the write failed) and it is
     * therefore still off. Never throws — a provisioning-dependent convenience, not a hard path.
     */
    fun ensureEnabled(context: Context): Boolean {
        if (isEnabled(context)) return true
        if (!canSelfEnable(context)) {
            Log.i(TAG, "accessibility off and no WRITE_SECURE_SETTINGS grant; leaving it to the operator")
            return false
        }
        return try {
            val comp = component(context)
            val cr = context.contentResolver
            val current = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, mergeService(current, comp))
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            Log.i(TAG, "self-enabled accessibility service via WRITE_SECURE_SETTINGS")
            true
        } catch (e: Exception) {
            Log.w(TAG, "self-enable failed: ${e.message}")
            false
        }
    }
}
