package com.remotedisplay.player.admin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log

/**
 * #161 device-owner privilege wrapper. Every method DEGRADES SAFELY when the app is not device owner
 * (or lacks the delegated scope / admin policy): actions return false and never throw, so callers work
 * unchanged off-tier and the app stays fully functional at Tier 0/1. Device owner is an OPTIONAL power-up.
 *
 * Tiers:
 *   0 — unprivileged (no admin). Screen/reboot "system control" is theater on a non-rooted panel.
 *   1 — device admin active (FORCE_LOCK) → lockNow() works; nothing else.
 *   2 — device owner, or granted DELEGATION_PACKAGE_INSTALLATION by a foreign owner → silent install;
 *       full owner additionally unlocks reboot/lock-task/status-bar/keyguard/time/uninstall-block.
 */
class STPolicy(context: Context) {
    private val app = context.applicationContext
    private val dpm: DevicePolicyManager? =
        app.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
    private val admin: ComponentName = STDeviceAdminReceiver.component(app)
    private val pkg: String = app.packageName

    // ---- tier detection (read-only; safe on any device) ------------------------------------------
    fun isDeviceOwner(): Boolean = try { dpm?.isDeviceOwnerApp(pkg) == true } catch (_: Throwable) { false }
    fun isAdminActive(): Boolean = try { dpm?.isAdminActive(admin) == true } catch (_: Throwable) { false }

    /** Scopes a foreign device owner (MDM) delegated to us. Empty when none / pre-O / unsupported. */
    fun delegatedScopes(): List<String> = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) dpm?.getDelegatedScopes(null, pkg) ?: emptyList()
        else emptyList()
    } catch (_: Throwable) { emptyList() }

    /**
     * A foreign DPC (MDM) manages this device: an active admin outside our package while we are NOT
     * owner. Public getActiveAdmins() signal (a normal app can't read the owner component directly).
     * Errs safe (managed => true) so self-OTA stands down on a managed panel. Single source for #166.
     */
    fun hasForeignDeviceOwner(): Boolean = try {
        if (isDeviceOwner()) false
        else dpm?.activeAdmins?.any { it.packageName != pkg } == true
    } catch (_: Throwable) { false }

    /** Silent PackageInstaller (no confirm dialog): device owner OR delegated install scope. */
    fun canInstallSilently(): Boolean =
        isDeviceOwner() || delegatedScopes().contains(SCOPE_PACKAGE_INSTALLATION)

    /** 0 unprivileged / 1 device-admin / 2 owner-or-delegated-install. */
    fun tier(): Int = TierLogic.tier(isDeviceOwner(), canInstallSilently(), isAdminActive())

    // ---- Tier-2 actions — no-op/false off-tier. Wired to commands/UI in Slice 3 (#161). ----------
    /** Owner-only clean reboot (replaces the input-keyevent/power-dialog theater). */
    fun reboot(): Boolean = owned("reboot") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) { dpm!!.reboot(admin); true } else false
    }

    /** Lock the screen now. Works at Tier 1 (device admin FORCE_LOCK) too — lighter than full owner. */
    fun lockNow(): Boolean = try {
        if (isDeviceOwner() || isAdminActive()) { dpm!!.lockNow(); true } else false
    } catch (e: Throwable) { Log.w(TAG, "lockNow: ${e.message}"); false }

    /** Whitelist ourselves for silent kiosk lock-task (startLockTask() is called on the Activity). */
    fun setLockTaskAllowed(enabled: Boolean): Boolean = owned("setLockTaskPackages") {
        dpm!!.setLockTaskPackages(admin, if (enabled) arrayOf(pkg) else emptyArray()); true
    }

    fun setStatusBarDisabled(disabled: Boolean): Boolean = owned("setStatusBarDisabled") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) { dpm!!.setStatusBarDisabled(admin, disabled); true } else false
    }

    fun setKeyguardDisabled(disabled: Boolean): Boolean = owned("setKeyguardDisabled") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) { dpm!!.setKeyguardDisabled(admin, disabled); true } else false
    }

    fun setTime(millis: Long): Boolean = owned("setTime") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) dpm!!.setTime(admin, millis) else false
    }

    fun setTimeZone(tz: String): Boolean = owned("setTimeZone") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) dpm!!.setTimeZone(admin, tz) else false
    }

    fun setUninstallBlocked(blocked: Boolean): Boolean = owned("setUninstallBlocked") {
        dpm!!.setUninstallBlocked(admin, pkg, blocked); true
    }

    /**
     * #160: a device owner can write a whitelisted SYSTEM setting (screen brightness / mode /
     * screen-off timeout) with NO WRITE_SETTINGS grant. API 28+. No-op/false off-owner.
     */
    fun setSystemSetting(setting: String, value: String): Boolean = owned("setSystemSetting") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) { dpm!!.setSystemSetting(admin, setting, value); true } else false
    }

    // ---- onboarding policy: the zero-touch first-run setup a device owner CAN do itself -----------

    /** Make ourselves the persistent HOME/launcher with NO user tap (the kiosk boot requirement). */
    fun setSelfHomeLauncher(enable: Boolean): Boolean = owned("setSelfHomeLauncher") {
        if (enable) {
            val filter = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            // MainActivity by name to avoid the admin package depending on the activity class.
            dpm!!.addPersistentPreferredActivity(admin, filter, ComponentName(pkg, "$pkg.MainActivity"))
        } else {
            dpm!!.clearPackagePersistentPreferredActivities(admin, pkg)
        }
        true
    }

    /** Silently grant one of OUR runtime permissions (e.g. POST_NOTIFICATIONS). API 23+. */
    fun grantSelfPermission(permission: String): Boolean = owned("grantSelfPermission") {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            dpm!!.setPermissionGrantState(admin, pkg, permission, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        else false
    }

    /**
     * Reset the permitted-accessibility policy to the DEFAULT (null = all services allowed). We used to
     * whitelist just our own service here, but a restrictive list gave no real benefit (default already
     * permits us) and risked interacting badly with ECM / OEM Settings UIs — so we now explicitly clear
     * any prior restriction instead. Runs on device-owner startup too, so panels enrolled by an older
     * build that DID set the restrictive list get it undone. Does NOT enable a11y (no DPM API can).
     */
    fun clearAccessibilityRestriction(): Boolean = owned("clearAccessibilityRestriction") {
        dpm!!.setPermittedAccessibilityServices(admin, null); true
    }

    /**
     * Applied on enrollment (and re-applied when the setup screen sees an owner). Best-effort: each step
     * degrades to false off-tier / on error, so it can never block enrollment. Lets a freshly-provisioned
     * panel skip the manual first-run wizard. Accessibility still needs the one-time manual/ADB enable.
     */
    fun applyOnboardingPolicy() {
        if (!isDeviceOwner()) return
        setSelfHomeLauncher(true)                    // become HOME — no overlay/full-screen-intent boot path needed
        setLockTaskAllowed(true)                     // pre-whitelist kiosk lock-task
        clearAccessibilityRestriction()              // ensure a11y is NOT policy-restricted (undo the old whitelist)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            grantSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        Log.i(TAG, "onboarding policy applied (device owner)")
    }

    /** Run [body] only when we are the device owner; log + degrade to false otherwise or on error. */
    private inline fun owned(what: String, body: () -> Boolean): Boolean {
        if (!isDeviceOwner()) return false
        return try { body() } catch (e: Throwable) { Log.w(TAG, "$what: ${e.message}"); false }
    }

    private companion object {
        const val TAG = "STPolicy"
        // DevicePolicyManager.DELEGATION_PACKAGE_INSTALLATION — inlined to avoid an API-level guard on
        // the constant itself (it's a plain String since API 26; the value is stable AOSP).
        const val SCOPE_PACKAGE_INSTALLATION = "delegation-package-installation"
    }
}

/** Pure tier decision, extracted so it's unit-testable without a device / DevicePolicyManager. */
object TierLogic {
    fun tier(isDeviceOwner: Boolean, canInstallSilently: Boolean, isAdminActive: Boolean): Int = when {
        isDeviceOwner || canInstallSilently -> 2
        isAdminActive -> 1
        else -> 0
    }
}
