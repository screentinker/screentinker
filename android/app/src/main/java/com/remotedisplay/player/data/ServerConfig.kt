package com.remotedisplay.player.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Which of the two preference stores actually holds this display's identity.
 *
 * Pure on purpose, so the rule can be tested on the JVM without an Android context.
 * See ServerConfigStoreChoiceTest.
 */
internal object StoreChoice {
    data class Snapshot(
        val serverUrl: String,
        val deviceId: String,
        val deviceToken: String,
        val isPaired: Boolean,
    )

    /** How much of a paired identity this store holds. -1 means the store would not open at all. */
    fun score(s: Snapshot?): Int {
        if (s == null) return -1
        var n = 0
        if (s.serverUrl.isNotEmpty()) n++
        if (s.deviceId.isNotEmpty()) n++
        if (s.deviceToken.isNotEmpty()) n++
        if (s.isPaired) n++
        return n
    }

    /**
     * True to use the encrypted store. Ties go to it, so a fresh install and every healthy
     * device stay encrypted; only a store that demonstrably holds MORE of the identity wins.
     */
    fun useSecure(secure: Snapshot?, plain: Snapshot?): Boolean = score(secure) >= score(plain)

    /**
     * The full store decision, including the #312 sticky flag. `secure` is null when the encrypted
     * store would not open or read on this boot; `secureEverFailed` is true once it has EVER failed
     * on this device (recorded in the plain store). Either one forces the plain store, so a board
     * with a flaky Keystore stops betting the display's reachability on it. Otherwise the
     * content-scored rule above decides.
     */
    fun preferSecure(secure: Snapshot?, plain: Snapshot?, secureEverFailed: Boolean): Boolean =
        !secureEverFailed && secure != null && useSecure(secure, plain)
}

class ServerConfig(context: Context) {

    /*
     * ⚠️ TWO STORES, AND THE ONE WE USE IS CHOSEN BY WHAT IS IN IT. #312.
     *
     * This used to be a try/catch: build EncryptedSharedPreferences, and on any exception fall
     * back to plain ones. That picks a store by WHICH ONE OPENS, which is not the same question as
     * which one holds the pairing.
     *
     * On RK3566 / OP-TEE hardware the Keystore is unreliable for a while after a cold boot (the
     * reporter also saw keymaster@4.0-service.optee segfault during boot, unrelated to us). So the
     * encrypted store failed at first install and every real value went to the plain store, and
     * then on any later boot where the Keystore happened to come up in time the app opened the
     * EMPTY encrypted store instead. server_url came back "", the service logged "No server URL
     * configured", and the reconnect backstop had nothing to dial, so it never ran and the panel
     * never came back online. A force-stop and restart fixed it because it re-rolled the dice.
     *
     * It was silent, it looked like a networking bug, and it left a paired display looking
     * factory-fresh. Any device that ever fell back to plain storage was one successful-Keystore
     * boot away from it.
     *
     * So: open both, and use whichever actually holds the identity. Ties go to the encrypted one.
     *
     * ⚠️ NOT MIGRATED on purpose. Copying the plain store into the encrypted one would put this
     * hardware straight back into the failure the next time the Keystore is slow, and copying the
     * other way would write a device token in cleartext on every healthy device. The residual case
     * this cannot fix is a device whose data is ONLY in the encrypted store on a boot where that
     * store will not open: there is nothing readable to select. That is unchanged from before.
     */
    private val plainPrefs: SharedPreferences =
        context.getSharedPreferences("remote_display", Context.MODE_PRIVATE)

    private val securePrefs: SharedPreferences? = try {
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
        Log.w("ServerConfig", "EncryptedSharedPreferences unavailable: ${e.message}")
        null
    }

    // A read can throw on this hardware too, not just the create, so treat that as "no store".
    private fun snapshotOf(p: SharedPreferences?): StoreChoice.Snapshot? = try {
        p?.let {
            StoreChoice.Snapshot(
                it.getString("server_url", "") ?: "",
                it.getString("device_id", "") ?: "",
                it.getString("device_token", "") ?: "",
                it.getBoolean("is_paired", false),
            )
        }
    } catch (e: Exception) {
        Log.w("ServerConfig", "store unreadable, ignoring it: ${e.message}")
        null
    }

    /*
     * ⚠️ STICKY: once the encrypted store has EVER failed to open or read on this device, stop
     * trusting it for identity. #312. Recorded in the plain store, which always opens. On these
     * boards the Keystore is intermittent, and encryption we cannot reliably open is not the
     * protection its presence implies — so we give it up here rather than risk another dark panel
     * on the next boot the Keystore is slow. (Diagnostics via getReasonUnavailable would be nicer,
     * but a single boolean is enough and cannot itself throw.)
     */
    private fun encryptedEverFailed(): Boolean =
        try { plainPrefs.getBoolean("encrypted_unusable", false) } catch (e: Exception) { false }

    private fun markEncryptedUnusable() {
        try {
            if (!plainPrefs.getBoolean("encrypted_unusable", false)) {
                plainPrefs.edit().putBoolean("encrypted_unusable", true).apply()
                Log.w("ServerConfig", "encrypted store failed; recording it as unusable on this device")
            }
        } catch (e: Exception) { /* plain store should always take a write; nothing else we can do */ }
    }

    private val secureSnapshot: StoreChoice.Snapshot? = snapshotOf(securePrefs)
    private val plainSnapshot: StoreChoice.Snapshot? = snapshotOf(plainPrefs)

    // secureSnapshot is null when the store would not open (create threw -> securePrefs null) OR a
    // read threw. Both are an encrypted-store failure on this boot, so record it as sticky.
    private val useSecureStore: Boolean = run {
        if (securePrefs == null || secureSnapshot == null) markEncryptedUnusable()
        StoreChoice.preferSecure(secureSnapshot, plainSnapshot, encryptedEverFailed())
    }

    private val prefs: SharedPreferences = if (useSecureStore) securePrefs!! else plainPrefs

    // The store we did NOT pick. The non-secret identity is mirrored into it on write and
    // reconciled from the winner at construction, so the two can never drift on the address. #312.
    private val otherStore: SharedPreferences? = if (useSecureStore) plainPrefs else securePrefs

    /** Diagnostics only. It reports the choice; it must never be what MAKES the choice. */
    val isUsingFallbackStorage: Boolean get() = prefs !== securePrefs

    init {
        Log.i("ServerConfig", "using ${if (isUsingFallbackStorage) "plain" else "encrypted"} store " +
            "(secure=${StoreChoice.score(secureSnapshot)} plain=${StoreChoice.score(plainSnapshot)}" +
            "${if (encryptedEverFailed()) " secureEverFailed" else ""})")
        reconcileIdentity()
    }

    /*
     * ⚠️ MIRROR + RECONCILE, not migrate. #312.
     *
     * The non-secret identity — server_url, device_id, is_paired — is written to BOTH stores (see
     * the setters) and copied from the winner into the other here, COPY-ONLY, never the token and
     * never a delete. So:
     *   - a store cannot go stale on the address, which is the write-side failure the reporter hit:
     *     "Change server" wrote the new URL to one store while a still-running instance kept reading
     *     the old URL from the other, and the socket dialled the old address forever;
     *   - the device_token stays in the winning store alone, so it is never written in cleartext to
     *     a second file on a healthy device (that was the objection to migrating);
     *   - scoring still favours the token-holding store (it scores one higher), so selection stays
     *     correct, and copy-only means an upgrade can never lose a pairing.
     */
    private fun reconcileIdentity() {
        val other = otherStore ?: return
        try {
            val e = other.edit()
            var wrote = false
            for (k in MIRRORED_STRING_KEYS) {
                val v = prefs.getString(k, "") ?: ""
                if (v.isNotEmpty() && (other.getString(k, "") ?: "") != v) { e.putString(k, v); wrote = true }
            }
            // Copy is_paired only when the winner is paired: an unpair is applied to both stores
            // explicitly (editBoth), so reconcile must never propagate a false that could blank a
            // store, nor resurrect a true the winner does not hold.
            if (prefs.getBoolean("is_paired", false) && !other.getBoolean("is_paired", false)) {
                e.putBoolean("is_paired", true); wrote = true
            }
            if (wrote) { e.apply(); Log.i("ServerConfig", "reconciled identity into the ${if (useSecureStore) "plain" else "encrypted"} store") }
        } catch (e: Exception) {
            Log.w("ServerConfig", "could not reconcile the other store: ${e.message}")
        }
    }

    // #312: non-secret identity is mirrored to BOTH stores so they cannot drift on the address.
    var serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(value) = editBoth { it.putString("server_url", value) }

    var deviceId: String
        get() = prefs.getString("device_id", "") ?: ""
        set(value) = editBoth { it.putString("device_id", value) }

    // #312: the token stays in the WINNING store only — never mirrored, so it is not written in
    // cleartext to a second file on a healthy device. Selection still favours the store that holds
    // it (it scores one higher), so a read never lands on a tokenless store by preference.
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

    /*
     * #299: plays recorded while the socket was down, as the JSON OfflinePlayQueue serialises.
     * Kept in the same prefs as everything else so it survives a reboot — an outage that spans one
     * is precisely when the backlog matters most.
     */
    var offlinePlayQueue: String
        get() = prefs.getString("offline_play_queue", "") ?: ""
        set(value) = prefs.edit().putString("offline_play_queue", value).apply()

    val isProvisioned: Boolean
        get() = deviceId.isNotEmpty() && serverUrl.isNotEmpty()

    val isPaired: Boolean
        get() = prefs.getBoolean("is_paired", false)

    // #312: is_paired is part of the mirrored identity — write it to both stores, or a one-sided
    // flag would skew the content score and could flip which store wins on the next boot.
    fun setPaired(paired: Boolean) = editBoth { it.putBoolean("is_paired", paired) }

    /*
     * ⚠️ BOTH STORES, not just the selected one. #312.
     *
     * Unpairing only the store in use leaves the other one holding a complete old identity, and
     * because the selection above is by content that stale copy can WIN on the next boot. The
     * display would silently come back as whatever it used to be.
     */
    private fun editBoth(mutate: (SharedPreferences.Editor) -> Unit) {
        for (store in listOfNotNull(securePrefs, plainPrefs)) {
            try { store.edit().also(mutate).apply() } catch (e: Exception) {
                Log.w("ServerConfig", "could not write a store: ${e.message}")
            }
        }
    }

    fun clearDeviceCredentials() = editBoth {
        it.remove("device_id").remove("device_token").remove("is_paired")
    }

    fun clear() {
        // #312: a full wipe must not un-learn that the encrypted store is flaky on this board, or
        // the next pairing would bet reachability on it again. Preserve the sticky flag across it.
        val everFailed = encryptedEverFailed()
        editBoth { it.clear() }
        if (everFailed) markEncryptedUnusable()
    }

    // Playlist cache for offline cold-start
    var cachedPlaylist: String
        get() = prefs.getString("cached_playlist", "") ?: ""
        set(value) = prefs.edit().putString("cached_playlist", value).apply()

    // #234: last playing index + when it started. Lives here, not in PlaylistController, precisely
    // because the controller is rebuilt with every Activity — which is how a relaunch used to reset
    // playback to the first item and starve everything after it.
    var resumeIndex: Int
        get() = prefs.getInt("resume_index", -1)
        set(value) = prefs.edit().putInt("resume_index", value).apply()

    var resumeAt: Long
        get() = prefs.getLong("resume_at", 0L)
        set(value) = prefs.edit().putLong("resume_at", value).apply()

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

    private companion object {
        // #312: the non-secret identity keys mirrored into both stores. The token is deliberately
        // NOT here — it stays in the winning store only. In a companion so it is ready before any
        // instance init block (reconcileIdentity runs from init).
        val MIRRORED_STRING_KEYS = listOf("server_url", "device_id")
    }
}
