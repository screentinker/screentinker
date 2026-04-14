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
}
