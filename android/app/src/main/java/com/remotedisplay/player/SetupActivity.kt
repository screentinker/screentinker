package com.remotedisplay.player

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
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
    private lateinit var continueBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Skip setup if already completed
        val prefs = getSharedPreferences("remote_display", MODE_PRIVATE)
        if (prefs.getBoolean("setup_complete", false)) {
            proceedToNext()
            return
        }

        setContentView(R.layout.activity_setup)

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
                ActivityCompat.requestPermissions(
                    this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100
                )
            }
        }

        enableAccessibilityBtn.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        enableInstallBtn.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = android.net.Uri.parse("package:$packageName")
                })
            }
        }

        continueBtn.setOnClickListener {
            prefs.edit().putBoolean("setup_complete", true).apply()
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

    private fun updateStatuses() {
        // Accessibility
        val accessibilityEnabled = isAccessibilityEnabled()
        accessibilityStatus.text = if (accessibilityEnabled) "ON" else "OFF"
        accessibilityStatus.setTextColor(
            if (accessibilityEnabled) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
        )
        enableAccessibilityBtn.visibility = if (accessibilityEnabled) View.GONE else View.VISIBLE

        // Install unknown apps
        val canInstall = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            packageManager.canRequestPackageInstalls()
        } else true
        installStatus.text = if (canInstall) "ON" else "OFF"
        installStatus.setTextColor(
            if (canInstall) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
        )
        enableInstallBtn.visibility = if (canInstall) View.GONE else View.VISIBLE

        // Notifications (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val hasNotif = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            notificationStatus.text = if (hasNotif) "ON" else "OFF"
            notificationStatus.setTextColor(
                if (hasNotif) 0xFF22C55E.toInt() else 0xFFEF4444.toInt()
            )
            findViewById<Button>(R.id.enableNotificationBtn).visibility =
                if (hasNotif) View.GONE else View.VISIBLE
        }

        // Update continue button text
        val allGood = accessibilityEnabled && canInstall
        continueBtn.text = if (allGood) "Continue to Setup" else "Continue Anyway"
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
        startActivity(Intent(this, ProvisioningActivity::class.java))
        finish()
    }
}
