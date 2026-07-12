package com.remotedisplay.player.admin

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import android.util.Log
import com.remotedisplay.player.data.ServerConfig

/**
 * Reads the OPTIONAL admin-extras bundle that device-owner provisioning (QR / NFC / cloud) can carry,
 * and pre-seeds the server URL so a freshly-enrolled panel skips manual URL entry — the operator just
 * reads the pairing code off the screen.
 *
 * Strictly additive and safe: a normal APK install never invokes provisioning, and a QR with no bundle
 * (or no "server_url" key) is a no-op — the standard first-run setup flow is completely untouched. Any
 * parse failure is swallowed, so a malformed bundle can never block enrollment or break the app.
 */
object ProvisioningExtras {
    private const val TAG = "ProvisioningExtras"

    fun apply(context: Context, intent: Intent?): Boolean {
        return try {
            val extras = extrasBundle(intent) ?: return false
            val url = extras.getString("server_url")?.trim()?.trimEnd('/')
            if (url.isNullOrEmpty()) return false
            val cfg = ServerConfig(context)
            cfg.serverUrl = url
            cfg.setPendingAutoConnect(true)                 // let the setup screen auto-advance to pairing
            extras.getString("device_name")?.trim()?.takeIf { it.isNotEmpty() }?.let { cfg.deviceName = it }
            Log.i(TAG, "Pre-seeded server URL from provisioning bundle")
            true
        } catch (e: Exception) {
            Log.w(TAG, "no/invalid provisioning extras (ignored): ${e.message}")
            false
        }
    }

    @Suppress("DEPRECATION")
    private fun extrasBundle(intent: Intent?): PersistableBundle? {
        if (intent == null) return null
        val key = DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            intent.getParcelableExtra(key, PersistableBundle::class.java)
        else
            intent.getParcelableExtra(key)
    }
}
