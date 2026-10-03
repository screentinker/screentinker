package com.remotedisplay.player

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.remotedisplay.player.service.PowerAccessibilityService

class SetupActivity : AppCompatActivity() {

    private lateinit var accessibilityStatus: TextView
    private lateinit var installStatus: TextView
    private lateinit var notificationStatus: TextView
    private lateinit var enableAccessibilityBtn: Button
    private lateinit var enableInstallBtn: Button
    private lateinit var fullscreenStatus: TextView
    private lateinit var enableFullscreenBtn: Button
    private lateinit var batteryStatus: TextView
    private lateinit var enableBatteryBtn: Button
    private lateinit var overlayStatus: TextView
    private lateinit var enableOverlayBtn: Button
    private lateinit var writeSettingsStatus: TextView
    private lateinit var enableWriteSettingsBtn: Button
    private lateinit var continueBtn: Button

    /**
     * Opened from the in-service Settings menu to REVIEW permissions, not as first-run setup.
     *
     * The difference matters: proceedToNext() always goes to ProvisioningActivity, so without this
     * a paired, playing screen would be sent to the pairing page by the button it was told to press.
     * In manage mode the screen simply returns to the player.
     */
    private val manageOnly: Boolean get() = intent?.getBooleanExtra(EXTRA_MANAGE_ONLY, false) == true

    companion object {
        const val EXTRA_MANAGE_ONLY = "EXTRA_MANAGE_ONLY"
    }

    @SuppressLint("BatteryLife")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Skip setup if already completed — but NOT when we were opened deliberately to review
        // permissions from the in-service Settings menu. That is the whole point of manage mode:
        // every device that can reach it has setup_complete set, so without this exemption the
        // screen closes before it draws and the menu entry appears to do nothing.
        val prefs = getSharedPreferences("remote_display", MODE_PRIVATE)
        if (!manageOnly && prefs.getBoolean("setup_complete", false)) {
            proceedToNext()
            return
        }

        // #device-owner: a device owner self-configures the kiosk essentials (HOME launcher, kiosk
        // lock-task, notifications) with no user taps, and silent-install makes "unknown sources"
        // moot — so skip the entire manual first-run wizard. Accessibility stays optional (it can't
        // be auto-enabled). Guarded on ownership, so a NORMAL install still gets the full wizard.
        val ownerPolicy = com.remotedisplay.player.admin.STPolicy(this)
        if (!manageOnly && ownerPolicy.isDeviceOwner()) {
            ownerPolicy.applyOnboardingPolicy()
            prefs.edit().putBoolean("setup_complete", true).apply()
            // Remote control needs the accessibility service, and it's the one thing no policy can
            // enable — so on an MDM deploy, route the installer through the guided enable screen when
            // it's still off (it auto-advances once on). Already on -> straight to pairing.
            if (isAccessibilityEnabled()) {
                proceedToNext()
            } else {
                startActivity(Intent(this, OwnerAccessibilityActivity::class.java))
                finish()
            }
            return
        }

        setContentView(R.layout.activity_setup)

        // App's UI is up — clear the boot "Starting display…" notification.
        getSystemService(NotificationManager::class.java)?.cancel(999)

        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        accessibilityStatus = findViewById(R.id.accessibilityStatus)
        installStatus = findViewById(R.id.installStatus)
        notificationStatus = findViewById(R.id.notificationStatus)
        enableAccessibilityBtn = findViewById(R.id.enableAccessibilityBtn)
        enableInstallBtn = findViewById(R.id.enableInstallBtn)
        continueBtn = findViewById(R.id.continueBtn)

        // Show notification row on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            findViewById<View>(R.id.notificationRow).visibility = View.VISIBLE
            findViewById<Button>(R.id.enableNotificationBtn).setOnClickListener {
                val granted = ContextCompat.checkSelfPermission(
                    this, Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    // requestPermissions() does nothing once the answer is already given, so it
                    // cannot be the way back. App notification settings can toggle it either way.
                    openFirstAvailable(appNotificationSettings(), appDetailsSettings(), Intent(Settings.ACTION_SETTINGS))
                } else {
                    ActivityCompat.requestPermissions(
                        this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100
                    )
                }
            }
        }

        enableAccessibilityBtn.setOnClickListener {
            openFirstAvailable(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS), appDetailsSettings(), Intent(Settings.ACTION_SETTINGS))
        }

        enableInstallBtn.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                openFirstAvailable(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply { data = Uri.parse("package:$packageName") },
                    appDetailsSettings(),
                    unavailable = adbHint("appops set $packageName REQUEST_INSTALL_PACKAGES allow"),
                )
            }
        }

        fullscreenStatus = findViewById(R.id.fullscreenStatus)
        enableFullscreenBtn = findViewById(R.id.enableFullscreenBtn)
        batteryStatus = findViewById(R.id.batteryStatus)
        enableBatteryBtn = findViewById(R.id.enableBatteryBtn)
        overlayStatus = findViewById(R.id.overlayStatus)
        enableOverlayBtn = findViewById(R.id.enableOverlayBtn)

        // Display-over-other-apps: alternate boot-launch path. With this granted the
        // boot receiver can directly start the activity from the background, which
        // works where you can't set a launcher (e.g. Android TV).
        enableOverlayBtn.setOnClickListener {
            openFirstAvailable(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply { data = Uri.parse("package:$packageName") },
                appDetailsSettings(),
                unavailable = adbHint("appops set $packageName SYSTEM_ALERT_WINDOW allow"),
            )
        }

        // #160 Track-A: WRITE_SETTINGS — one-time grant that unlocks remote system-brightness +
        // screen-off-timeout control. Optional; media volume + per-window brightness need no grant.
        writeSettingsStatus = findViewById(R.id.writeSettingsStatus)
        enableWriteSettingsBtn = findViewById(R.id.enableWriteSettingsBtn)
        enableWriteSettingsBtn.setOnClickListener {
            // No generic-Settings fallback here: Android TV has no "modify system settings" page
            // anywhere, so landing on the Settings root was a dead end dressed up as a screen.
            openFirstAvailable(
                Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).apply { data = Uri.parse("package:$packageName") },
                unavailable = adbHint("appops set $packageName WRITE_SETTINGS allow"),
            )
        }

        // Default launcher / HOME: a kiosk MUST be the default launcher, else Android returns to the
        // stock launcher and tears down + recreates the player on a loop (it never renders). Request
        // the HOME role (clean system dialog on API 29+); fall back to the Home-app picker in Settings.
        // OPTIONAL: location, solely so the device page can show the Wi-Fi network name. Requested
        // only when someone taps this row — never at startup, and nothing else in the player depends
        // on it. Once granted (or permanently denied) requestPermissions() stops prompting, so an
        // already-answered row sends you to app settings where it can be changed either way.
        findViewById<Button>(R.id.enableLocationBtn).setOnClickListener {
            if (hasLocationPermission()) openAppSettings()
            else ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                101
            )
        }
        findViewById<Button>(R.id.enableLauncherBtn).setOnClickListener { promptSetDefaultLauncher() }

        // Launch-on-boot needs USE_FULL_SCREEN_INTENT, which Android 14+ auto-revokes
        // for non-calling apps — so the boot full-screen launcher silently fails until
        // the user grants it. Older versions auto-grant it, so only show the row where
        // it can actually be off.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // USE_FULL_SCREEN_INTENT is auto-granted before Android 14 — hide the row.
            findViewById<View>(R.id.fullscreenRow).visibility = View.GONE
        } else {
            enableFullscreenBtn.setOnClickListener {
                // This is the row that crashed Android TV: neither intent exists there, and the
                // fallback threw from inside the catch. See openFirstAvailable.
                openFirstAvailable(
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply { data = Uri.parse("package:$packageName") },
                    appNotificationSettings(),
                    unavailable = adbHint("appops set $packageName USE_FULL_SCREEN_INTENT allow"),
                )
            }
        }

        // Battery-optimization exemption keeps the boot receiver from being deferred
        // and the app from being killed in standby (esp. on OEM / TV boxes).
        enableBatteryBtn.setOnClickListener {
            val exempt = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .isIgnoringBatteryOptimizations(packageName)
            if (exempt) {
                // ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS only ASKS to add an exemption — it
                // offers no way to remove one, so it is a dead end for someone already exempt.
                // The system list is where an exemption can actually be turned back off.
                openFirstAvailable(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), appDetailsSettings())
            } else {
                // On Android TV both of these resolve to the OS's EmptyStubActivity — a screen that
                // draws nothing — so they are skipped and the adb route is offered instead.
                openFirstAvailable(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply { data = Uri.parse("package:$packageName") },
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                    unavailable = adbHint("dumpsys deviceidle whitelist +$packageName"),
                )
            }
        }

        if (manageOnly) {
            // "Continue anyway" and the skip hint are first-run language; here the only action is
            // to go back to what was already playing.
            continueBtn.text = getString(R.string.settings_perm_done)
            findViewById<TextView>(R.id.skipText).visibility = View.GONE
        }

        continueBtn.setOnClickListener {
            if (!manageOnly) prefs.edit().putBoolean("setup_complete", true).apply()
            proceedToNext()
        }

        findViewById<TextView>(R.id.skipText).setOnClickListener {
            prefs.edit().putBoolean("setup_complete", true).apply()
            proceedToNext()
        }

        updateStatuses()
    }

    override fun onResume() {
        super.onResume()
        updateStatuses()
    }

    /**
     * Bind a permission row's button. Granted rows used to set the button GONE, which left the
     * choice one-way: every permission on this screen is granted in system Settings and the app
     * cannot revoke any of them itself, so hiding the only route to that screen meant there was no
     * way back. Reported on #234 — "if I make the app as Home launcher but later on want to remove
     * it then how can I do it?".
     *
     * The button now stays put and relabels. Same tap target, same destination; the label is honest
     * that Settings is where the change happens rather than promising we can revoke it ourselves.
     */
    private fun bindPermissionButton(btn: Button, granted: Boolean, enableLabel: String) {
        btn.visibility = View.VISIBLE
        btn.text = if (granted) "Manage" else enableLabel
    }

    /** Last-resort destination: this app's own settings page, where everything can be reached. */
    private fun openAppSettings() {
        openFirstAvailable(appDetailsSettings(), Intent(Settings.ACTION_SETTINGS))
    }

    private fun appDetailsSettings() =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply { data = Uri.parse("package:$packageName") }

    private fun appNotificationSettings() =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply { putExtra(Settings.EXTRA_APP_PACKAGE, packageName) }

    private fun adbHint(cmd: String) = getString(R.string.setup_screen_unavailable, "adb shell $cmd")

    /**
     * Open the first of [candidates] this build can actually show; tell the installer how to grant
     * the permission over adb when none can.
     *
     * Android TV ships a different Settings app from phones and whole screens are simply absent.
     * On Google TV 14 (reproduced on the onn_stick emulator, 2026-09-18) there is no
     * ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, no ACTION_APP_NOTIFICATION_SETTINGS and no
     * ACTION_MANAGE_WRITE_SETTINGS, and the two battery-optimisation intents resolve to
     * com.android.tv.settings/.EmptyStubActivity — an activity that draws nothing. Every row here
     * used to startActivity() and hope: the "Launch on Boot" row threw ActivityNotFoundException
     * from INSIDE its catch block and killed the app, "Background Activity" opened the stub, and
     * "System Settings" fell back to the Settings root where the permission does not exist. From
     * the couch all three are "I clicked it and nothing came up".
     *
     * So: resolve before starting, treat the stub as absent, and never end in silence.
     */
    private fun openFirstAvailable(vararg candidates: Intent, unavailable: String? = null): Boolean {
        for (intent in candidates) {
            val target = try { packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) } catch (_: Exception) { null }
            if (target == null || target.activityInfo?.name?.endsWith("EmptyStubActivity") == true) continue
            try { startActivity(intent); return true } catch (_: Exception) { /* try the next one */ }
        }
        // A dialog, not a toast: on a TV a toast is two lines and the adb command is the payload.
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.setup_screen_unavailable_title))
            .setMessage(unavailable ?: getString(R.string.setup_screen_unavailable_plain))
            .setPositiveButton(android.R.string.ok, null)
            .show()
        return false
    }

    private fun updateStatuses() {
        // Accessibility
        val accessibilityEnabled = isAccessibilityEnabled()
        accessibilityStatus.text = if (accessibilityEnabled) "ON" else "OFF"
        accessibilityStatus.setTextColor(
            if (accessibilityEnabled) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
        )
        bindPermissionButton(enableAccessibilityBtn, accessibilityEnabled, "Enable")

        // Install unknown apps
        val canInstall = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            packageManager.canRequestPackageInstalls()
        } else true
        installStatus.text = if (canInstall) "ON" else "OFF"
        installStatus.setTextColor(
            if (canInstall) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
        )
        bindPermissionButton(enableInstallBtn, canInstall, "Enable")

        // Notifications (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val hasNotif = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            notificationStatus.text = if (hasNotif) "ON" else "OFF"
            notificationStatus.setTextColor(
                if (hasNotif) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
            )
            bindPermissionButton(findViewById(R.id.enableNotificationBtn), hasNotif, "Enable")
        }

        // Launch on boot (full-screen intent — only restrictable on Android 14+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val canFsi = getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
            fullscreenStatus.text = if (canFsi) "ON" else "OFF"
            fullscreenStatus.setTextColor(if (canFsi) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
            bindPermissionButton(enableFullscreenBtn, canFsi, "Enable")
        }

        // Battery optimization exemption
        val ignoringBattery = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .isIgnoringBatteryOptimizations(packageName)
        batteryStatus.text = if (ignoringBattery) "ON" else "OFF"
        batteryStatus.setTextColor(if (ignoringBattery) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        bindPermissionButton(enableBatteryBtn, ignoringBattery, "Enable")

        // Display over other apps
        val canOverlay = Settings.canDrawOverlays(this)
        overlayStatus.text = if (canOverlay) "ON" else "OFF"
        overlayStatus.setTextColor(if (canOverlay) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        bindPermissionButton(enableOverlayBtn, canOverlay, "Enable")

        // #160 WRITE_SETTINGS (system brightness / screen-off timeout)
        val canWrite = Settings.System.canWrite(this)
        writeSettingsStatus.text = if (canWrite) "ON" else "OFF"
        writeSettingsStatus.setTextColor(if (canWrite) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        bindPermissionButton(enableWriteSettingsBtn, canWrite, "Enable")

        // Optional Wi-Fi-name permission
        val hasLoc = hasLocationPermission()
        val locationStatus = findViewById<TextView>(R.id.locationStatus)
        locationStatus.text = if (hasLoc) "ON" else "OFF"
        locationStatus.setTextColor(if (hasLoc) 0xFF22C55E.toInt() else 0xFF64748B.toInt())
        bindPermissionButton(findViewById(R.id.enableLocationBtn), hasLoc, "Enable")

        // Default launcher (HOME): kiosk foreground stability requires being the default launcher.
        val isDefaultHome = isDefaultLauncher()
        val launcherStatus = findViewById<TextView>(R.id.launcherStatus)
        launcherStatus.text = if (isDefaultHome) "ON" else "OFF"
        launcherStatus.setTextColor(if (isDefaultHome) 0xFF22C55E.toInt() else 0xFFEF4444.toInt())
        bindPermissionButton(findViewById(R.id.enableLauncherBtn), isDefaultHome, "Set")

        // Update continue button text
        val allGood = accessibilityEnabled && canInstall
        // updateStatuses() runs after onCreate's setup and re-labels this button every time, so the
        // manage-mode label has to be honoured HERE too — setting it once earlier was silently
        // overwritten. In review mode there is nothing to continue TO; the only action is going back.
        continueBtn.text = when {
            manageOnly -> getString(R.string.settings_perm_done)
            allGood -> "Continue to Setup"
            else -> "Continue Anyway"
        }
    }

    /** Either location permission is enough for the SSID; coarse suffices below Android 10. */
    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun isDefaultLauncher(): Boolean {
        // Ask the SAME authority the action uses. This used to read resolveActivity(MATCH_DEFAULT_ONLY),
        // which can name us when we are merely a HOME candidate rather than the chosen home app — so
        // the row could say ON while the system still had the OEM launcher as home, and the button
        // then opened the "become home" request dialog instead of the picker. Reported on #234:
        // "in the apk I have granted the permission ... BUT in the settings of the tablet it still
        // shows the tablet native launcher as home."
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                val rm = getSystemService(android.app.role.RoleManager::class.java)
                if (rm != null && rm.isRoleAvailable(android.app.role.RoleManager.ROLE_HOME)) {
                    return rm.isRoleHeld(android.app.role.RoleManager.ROLE_HOME)
                }
            } catch (_: Exception) { /* fall through to the pre-Q check */ }
        }
        val ri = packageManager.resolveActivity(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME),
            PackageManager.MATCH_DEFAULT_ONLY
        )
        return ri?.activityInfo?.packageName == packageName
    }

    private fun promptSetDefaultLauncher() {
        // Android 10+ (Q): request the HOME role — a clean one-tap system dialog.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                val rm = getSystemService(android.app.role.RoleManager::class.java)
                if (rm != null && rm.isRoleAvailable(android.app.role.RoleManager.ROLE_HOME) &&
                    !rm.isRoleHeld(android.app.role.RoleManager.ROLE_HOME)) {
                    startActivityForResult(rm.createRequestRoleIntent(android.app.role.RoleManager.ROLE_HOME), 200)
                    return
                }
            } catch (_: Exception) { /* fall through to the settings picker */ }
        }
        // Fallback: open the "Home app" picker in Settings (works on every version / OEM).
        openFirstAvailable(Intent(Settings.ACTION_HOME_SETTINGS), Intent(Settings.ACTION_SETTINGS))
    }

    private fun isAccessibilityEnabled(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val enabledServices = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        val myComponent = ComponentName(this, PowerAccessibilityService::class.java)
        return enabledServices.any {
            it.resolveInfo.serviceInfo.let { si ->
                ComponentName(si.packageName, si.name) == myComponent
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        updateStatuses()
    }

    private fun proceedToNext() {
        // Reviewing permissions on a live screen must never restart pairing — just go back.
        if (manageOnly) { finish(); return }
        startActivity(Intent(this, ProvisioningActivity::class.java))
        finish()
    }
}
