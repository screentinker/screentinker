package com.remotedisplay.player.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class ServerConfig(context: Context) {

    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "remote_display_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        // Fallback to regular prefs if encryption not available
        Log.w("ServerConfig", "EncryptedSharedPreferences unavailable, using regular: ${e.message}")
        context.getSharedPreferences("remote_display", Context.MODE_PRIVATE)
    }

    var serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(value) = prefs.edit().putString("server_url", value).apply()

    var deviceId: String
        get() = prefs.getString("device_id", "") ?: ""
        set(value) = prefs.edit().putString("device_id", value).apply()

    var deviceToken: String
        get() = prefs.getString("device_token", "") ?: ""
        set(value) = prefs.edit().putString("device_token", value).apply()

    var deviceName: String
        get() = prefs.getString("device_name", "Unnamed Display") ?: "Unnamed Display"
        set(value) = prefs.edit().putString("device_name", value).apply()

    // Provisioned by the server during pairing — a unique 6-digit PIN for the hidden
    // settings menu on each device. If the server doesn't send one (backward compat),
    // generate a random PIN locally on first access so every device still has a unique gate.
    var settingsPin: String
        get() {
            val stored = prefs.getString("settings_pin", null)
            if (stored != null) return stored
            // First access, no server-provided PIN — generate one locally
            val generated = (100000..999999).random().toString()
            prefs.edit().putString("settings_pin", generated).apply()
            return generated
        }
        set(value) = prefs.edit().putString("settings_pin", value).apply()

    // #device-owner: set when a provisioned server URL was pre-seeded (QR admin-extras bundle), so the
    // setup screen can auto-advance to the pairing code instead of waiting for a manual "Connect" tap.
    // Consumed once. Absent on a normal install -> setup behaves exactly as before.
    fun setPendingAutoConnect(v: Boolean) { prefs.edit().putBoolean("pending_auto_connect", v).apply() }
    fun consumePendingAutoConnect(): Boolean {
        val v = prefs.getBoolean("pending_auto_connect", false)
        if (v) prefs.edit().remove("pending_auto_connect").apply()
        return v
    }

    // #160: last-set per-window brightness (0..1; -1 = follow system). Persisted so it survives an
    // app relaunch and the dashboard slider reflects it. (System brightness/timeout live in the OS.)
    var windowBrightness: Float
        get() = prefs.getFloat("window_brightness", -1f)
        set(value) = prefs.edit().putFloat("window_brightness", value).apply()

    val isProvisioned: Boolean
        get() = deviceId.isNotEmpty() && serverUrl.isNotEmpty()

    val isPaired: Boolean
        get() = prefs.getBoolean("is_paired", false)

    fun setPaired(paired: Boolean) {
        prefs.edit().putBoolean("is_paired", paired).apply()
    }

    fun clearDeviceCredentials() {
        prefs.edit()
            .remove("device_id")
            .remove("device_token")
            .remove("is_paired")
            .apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    // Playlist cache for offline cold-start
    var cachedPlaylist: String
        get() = prefs.getString("cached_playlist", "") ?: ""
        set(value) = prefs.edit().putString("cached_playlist", value).apply()

    fun clearPlaylistCache() {
        prefs.edit().remove("cached_playlist").apply()
    }

    // #139 OTA attempt state. Persisted (not in-memory) on purpose: the OTA loop is driven
    // by Fire OS restarting the app, which re-fires the update check; an in-memory counter
    // would reset on every restart and never back off. `otaTargetVersion` is the version we
    // are currently trying to install; `otaAttempts` counts install attempts for it;
    // `otaLastAttemptAt` gates the post-cap retry backoff.
    var otaTargetVersion: String
        get() = prefs.getString("ota_target_version", "") ?: ""
        set(value) = prefs.edit().putString("ota_target_version", value).apply()

    var otaAttempts: Int
        get() = prefs.getInt("ota_attempts", 0)
        set(value) = prefs.edit().putInt("ota_attempts", value).apply()

    var otaLastAttemptAt: Long
        get() = prefs.getLong("ota_last_attempt_at", 0L)
        set(value) = prefs.edit().putLong("ota_last_attempt_at", value).apply()

    // #139: true once the "entering backoff" status has been reported for the current target,
    // so the dashboard line fires on the transition only — not on every backed-off poll (Fire OS
    // restarts re-fire the check constantly). Reset on a new target / on clear.
    var otaBackoffReported: Boolean
        get() = prefs.getBoolean("ota_backoff_reported", false)
        set(value) = prefs.edit().putBoolean("ota_backoff_reported", value).apply()

    fun clearOtaState() {
        prefs.edit()
            .remove("ota_target_version")
            .remove("ota_attempts")
            .remove("ota_last_attempt_at")
            .remove("ota_backoff_reported")
            .apply()
    }
}
