package com.remotedisplay.player

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.remotedisplay.player.admin.STPolicy
import com.remotedisplay.player.service.PowerAccessibilityService

/**
 * MDM/device-owner ONLY: a guided, installer-friendly screen to enable the accessibility service that
 * remote screen-view + tap/swipe require. Android exposes no API — not even to a device owner — to flip
 * that switch (anti-malware wall), and Android 13+ additionally gates it behind "restricted settings"
 * on a provisioning-installed app. So the best we can do is make the two manual taps painless: deep-link
 * straight to App info (allow restricted settings) and Accessibility settings, and auto-advance the
 * moment the service binds.
 *
 * Shown only when [STPolicy.isDeviceOwner]; a normal install never reaches here (SetupActivity gates it),
 * and this activity self-guards too — if we're not owner it just proceeds, so it can never trap a
 * non-managed device on an irrelevant screen.
 */
class OwnerAccessibilityActivity : AppCompatActivity() {

    private lateinit var statusPill: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Belt-and-suspenders: never show this on a non-managed device.
        if (!STPolicy(this).isDeviceOwner()) { proceedToNext(); return }

        setContentView(R.layout.activity_owner_accessibility)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        statusPill = findViewById(R.id.a11yStatusPill)

        // Step 1 — App info, where the operator taps ⋮ → "Allow restricted settings".
        findViewById<Button>(R.id.openAppInfoBtn).setOnClickListener {
            try {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:$packageName")))
            } catch (_: Exception) { try { startActivity(Intent(Settings.ACTION_SETTINGS)) } catch (_: Exception) {} }
        }
        // Step 2 — Accessibility settings, where they toggle ScreenTinker on.
        findViewById<Button>(R.id.openA11yBtn).setOnClickListener {
            try { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) } catch (_: Exception) {}
        }

        findViewById<Button>(R.id.continueBtn).setOnClickListener { proceedToNext() }
        findViewById<TextView>(R.id.skipText).setOnClickListener { proceedToNext() }
    }

    override fun onResume() {
        super.onResume()
        // Reflect live state; the moment the service is on, move on automatically — the installer
        // flips the switch and comes back to a panel that's already advancing to its pairing code.
        if (isAccessibilityEnabled()) {
            statusPill.text = "●  Accessibility service: ON"
            statusPill.setTextColor(0xFF22C55E.toInt())
            statusPill.postDelayed({ if (!isFinishing) proceedToNext() }, 700)
        } else {
            statusPill.text = "●  Accessibility service: OFF"
            statusPill.setTextColor(0xFFEF4444.toInt())
        }
    }

    private fun isAccessibilityEnabled(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val mine = ComponentName(this, PowerAccessibilityService::class.java)
        return am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
            it.resolveInfo.serviceInfo.let { si -> ComponentName(si.packageName, si.name) == mine }
        }
    }

    private fun proceedToNext() {
        startActivity(Intent(this, ProvisioningActivity::class.java))
        finish()
    }
}
