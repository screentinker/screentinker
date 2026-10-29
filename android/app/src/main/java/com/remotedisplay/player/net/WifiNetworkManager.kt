package com.remotedisplay.player.net

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.remotedisplay.player.admin.STPolicy
import org.json.JSONArray
import org.json.JSONObject

/**
 * #720 The Wi-Fi networks an operator listed for this screen on the device page, applied here.
 *
 * The server sends the whole list (device:wifi-networks) on every change and every connect; this
 * class brings the panel towards it with the rules in [WifiPlan] — adds first, and never a change to
 * or removal of the network the panel is connected on — and reports per network what happened
 * (device:wifi-result, through [onResult]). It re-plans whenever connectivity changes, because a
 * step that waited ("deferred") runs as soon as the panel is no longer on that network.
 *
 * How it applies depends on [WifiModeLogic.mode]:
 *   owner        device owner: saved networks (addNetworkPrivileged on API 31+, else addNetwork)
 *   direct       Android 9 and older: saved networks with addNetwork
 *   suggestions  Android 10+, not owner: WifiNetworkSuggestion, which Android may decline
 *
 * ⚠️ ONLY ITS OWN NETWORKS. Android has no tag on a saved network, so this keeps its own list of
 * what it added ([WifiManaged]); nothing else is ever updated or removed. A network with the same
 * name that someone saved on the panel by hand is refused (already_configured_by_hand), never
 * adopted: adding over it would make it ours, and a later removal would delete the operator's own.
 *
 * ⚠️ THE LIST IS KEYSTORE-BACKED OR NOT KEPT. Both lists hold passwords (a waiting step may need
 * one after a reboot). They live in EncryptedSharedPreferences under an Android Keystore master
 * key. Where that store will not open, they are kept in memory only — never in plain prefs — and
 * the server sends the list again on the next connect.
 */
class WifiNetworkManager(
    private val context: Context,
    private val onResult: (JSONObject) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val wifi: WifiManager? = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private val cm: ConnectivityManager? = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val store: SharedPreferences? = openStore(context)

    private var desired: List<WifiDesired> = emptyList()
    private var managed: List<WifiManaged> = emptyList()
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var lastReport: String? = null
    private var memoryDevice: String? = null
    private val reconcileSoon = Runnable { reconcile(force = false) }

    /** Load what was persisted, watch connectivity, and finish any step that was waiting. */
    fun restore() {
        desired = read(KEY_DESIRED).map(::desiredFrom)
        managed = read(KEY_MANAGED).map(::managedFrom)
        // A device owner can see which network it is on (Android 10+ redacts it without location).
        if (mode() == WifiModeLogic.OWNER && Build.VERSION.SDK_INT >= 29) {
            try { STPolicy(context).grantSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) } catch (_: Throwable) { }
        }
        watchConnectivity()
        if (desired.isNotEmpty() || managed.isNotEmpty()) reconcile(force = false)
    }

    /**
     * The list from the server for [deviceId]. Malformed entries are skipped; the rest still apply.
     *
     * ⚠️ A NEW PAIRING LETS GO, IT DOES NOT WIPE. If this panel was deleted and paired again as a
     * new screen (a new device id), the networks the old one managed stay on the panel and become
     * ordinary saved networks: the new screen starts with an empty list, and removing the old ones
     * would cut off exactly the link the re-pairing came in on.
     */
    fun apply(payload: JSONObject, deviceId: String) {
        val owner = try { store?.getString(KEY_DEVICE, null) } catch (_: Throwable) { null } ?: memoryDevice
        if (owner != null && owner != deviceId && managed.isNotEmpty()) {
            Log.i(TAG, "wifi: paired as a new screen; ${managed.size} network(s) stay on the panel, no longer managed")
            managed = emptyList()
            write(KEY_MANAGED, JSONArray())
        }
        memoryDevice = deviceId
        try { store?.edit()?.putString(KEY_DEVICE, deviceId)?.apply() } catch (_: Throwable) { }
        val arr = payload.optJSONArray("networks") ?: return
        val list = mutableListOf<WifiDesired>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id", "")
            val ssid = o.optString("ssid", "")
            if (id.isEmpty() || ssid.isEmpty()) continue
            list += desiredFrom(o)
        }
        desired = list
        write(KEY_DESIRED, JSONArray(list.map(::toJson)))
        reconcile(force = true)
    }

    fun stop() {
        handler.removeCallbacks(reconcileSoon)
        try { callback?.let { cm?.unregisterNetworkCallback(it) } } catch (_: Throwable) { }
        callback = null
    }

    fun mode(): String = modeFor(context)

    /** Plan, run the steps, persist, report. [force]: report even when nothing changed. */
    @Synchronized
    fun reconcile(force: Boolean) {
        val s = situation()
        val plan = WifiPlan.plan(desired, managed, s)
        val outcomes = plan.outcomes.toMutableList()
        val wifiOff = wifi?.isWifiEnabled == false
        for (step in plan.steps) {
            val out = try { run(step, s.mode) } catch (e: Throwable) {
                Log.w(TAG, "wifi step ${step::class.simpleName} failed: ${e.javaClass.simpleName}")   // never the password
                failure(step, if (e is SecurityException) "permission_denied" else "rejected_by_android")
            }
            if (out != null) outcomes += if (wifiOff && out.state in listOf("applied", "suggested")) out.copy(reason = "wifi_off") else out
        }
        if (Build.VERSION.SDK_INT < 26 && s.mode != WifiModeLogic.SUGGESTIONS && plan.steps.isNotEmpty()) {
            @Suppress("DEPRECATION") try { wifi?.saveConfiguration() } catch (_: Throwable) { }
        }
        write(KEY_MANAGED, JSONArray(managed.map(::toJson)))
        report(outcomes, force)
    }

    // ── steps ─────────────────────────────────────────────────────────────────────────────────────

    private fun run(step: WifiStep, mode: String): WifiOutcome? = when (step) {
        is WifiStep.Add -> add(step.desired, mode)
        is WifiStep.Update -> update(step.managed, step.desired, mode)
        is WifiStep.Remove -> { remove(step.managed, mode); null }
    }

    private fun failure(step: WifiStep, reason: String): WifiOutcome? = when (step) {
        is WifiStep.Add -> WifiOutcome(step.desired.id, "failed", reason)
        is WifiStep.Update -> WifiOutcome(step.desired.id, "failed", reason)
        is WifiStep.Remove -> null
    }

    private fun add(d: WifiDesired, mode: String): WifiOutcome {
        if (mode == WifiModeLogic.SUGGESTIONS) {
            if (Build.VERSION.SDK_INT < 29) return WifiOutcome(d.id, "unsupported", "rejected_by_android")
            val status = wifi!!.addNetworkSuggestions(listOf(suggestionFor(d)))
            if (status != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS && status != WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_DUPLICATE) {
                return WifiOutcome(d.id, "failed", if (status == WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_APP_DISALLOWED) "permission_denied" else "rejected_by_android")
            }
            managed = managed + managedFrom(d, -1)
            return WifiOutcome(d.id, "suggested")
        }
        if (configuredByHand(d)) return WifiOutcome(d.id, "failed", "already_configured_by_hand")
        val netId = addConfig(configFor(d), mode)
        if (netId < 0) return WifiOutcome(d.id, "failed", "rejected_by_android")
        @Suppress("DEPRECATION") wifi!!.enableNetwork(netId, false)   // may join; never forces a switch
        managed = managed + managedFrom(d, netId)
        return WifiOutcome(d.id, "applied")
    }

    private fun update(m: WifiManaged, d: WifiDesired, mode: String): WifiOutcome {
        // A new name or security type is a different network to Android: replace it. WifiPlan only
        // gets here when the panel is not connected on it, so the replacement cannot strand it.
        if (mode == WifiModeLogic.SUGGESTIONS || m.ssid != d.ssid || m.security != d.security) {
            remove(m, mode)
            return add(d, mode)
        }
        val c = configFor(d)
        @Suppress("DEPRECATION")
        c.networkId = m.netId
        @Suppress("DEPRECATION")
        val netId = wifi!!.updateNetwork(c)
        if (netId < 0) return WifiOutcome(d.id, "failed", "rejected_by_android")
        @Suppress("DEPRECATION") wifi.enableNetwork(netId, false)
        managed = managed.map { if (it.id == m.id) managedFrom(d, netId) else it }
        return WifiOutcome(d.id, "applied")
    }

    private fun remove(m: WifiManaged, mode: String) {
        if (mode == WifiModeLogic.SUGGESTIONS || m.netId < 0) {
            if (Build.VERSION.SDK_INT >= 29) wifi!!.removeNetworkSuggestions(listOf(suggestionFor(WifiDesired(m.id, m.ssid, m.security, m.hidden, m.priority, m.password))))
        } else {
            // False when it is already gone (someone forgot it on the panel): it is not ours to keep either way.
            @Suppress("DEPRECATION") wifi!!.removeNetwork(m.netId)
        }
        managed = managed.filter { it.id != m.id }
    }

    private fun addConfig(c: WifiConfiguration, mode: String): Int {
        if (mode == WifiModeLogic.OWNER && Build.VERSION.SDK_INT >= 31) {
            val r = wifi!!.addNetworkPrivileged(c)
            return if (r.statusCode == WifiManager.AddNetworkResult.STATUS_SUCCESS) r.networkId else -1
        }
        @Suppress("DEPRECATION")
        return wifi!!.addNetwork(c)
    }

    /**
     * A saved network with this name that is not on our list was set up by hand. Readable below
     * Android 10, and as device owner; elsewhere the call returns nothing and we cannot tell, which
     * only happens in suggestions mode, where nothing saved is ever touched.
     */
    @Suppress("DEPRECATION")
    private fun configuredByHand(d: WifiDesired): Boolean {
        val ours = managed.map { it.netId }.toSet()
        val configs = try { wifi!!.configuredNetworks } catch (_: SecurityException) { null } ?: return false
        return configs.any { it.SSID == WifiPlan.quoted(d.ssid) && it.networkId !in ours }
    }

    @Suppress("DEPRECATION")
    private fun configFor(d: WifiDesired): WifiConfiguration = WifiConfiguration().apply {
        SSID = WifiPlan.quoted(d.ssid)
        hiddenSSID = d.hidden
        d.priority?.let { priority = it }   // a hint only on newer Android; documented as such
        when (d.security) {
            WifiPlan.SECURITY_OPEN -> allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
            WifiPlan.SECURITY_WPA2 -> {
                allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
                preSharedKey = WifiPlan.pskForConfig(d.password ?: "")
            }
            WifiPlan.SECURITY_WPA3 -> {
                // WifiPlan refuses WPA3 below Android 10 (wpa3_needs_android_10), so 29 is the floor here.
                if (Build.VERSION.SDK_INT >= 30) setSecurityParams(WifiConfiguration.SECURITY_TYPE_SAE)
                else if (Build.VERSION.SDK_INT >= 29) allowedKeyManagement.set(WifiConfiguration.KeyMgmt.SAE)   // SAE implies PMF
                preSharedKey = WifiPlan.quoted(d.password ?: "")
            }
        }
    }

    @RequiresApi(29)
    private fun suggestionFor(d: WifiDesired): WifiNetworkSuggestion {
        val b = WifiNetworkSuggestion.Builder().setSsid(d.ssid)
        if (Build.VERSION.SDK_INT >= 30) b.setIsHiddenSsid(d.hidden)
        d.priority?.let { b.setPriority(it) }
        when (d.security) {
            WifiPlan.SECURITY_WPA2 -> b.setWpa2Passphrase(d.password ?: "")
            WifiPlan.SECURITY_WPA3 -> b.setWpa3Passphrase(d.password ?: "")
        }
        return b.build()
    }

    // ── what the panel is connected on ────────────────────────────────────────────────────────────

    @Suppress("DEPRECATION")
    private fun situation(): WifiSituation {
        val active = try { cm?.activeNetwork?.let { cm.getNetworkCapabilities(it) } } catch (_: Throwable) { null }
        val wifiActive = active?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val info = try { wifi?.connectionInfo } catch (_: Throwable) { null }
        val netId = info?.networkId?.takeIf { it >= 0 }
        return WifiSituation(mode(), Build.VERSION.SDK_INT, wifiActive, netId, WifiPlan.ssidFromWifiInfo(info?.ssid))
    }

    /** Any change of link re-plans, a few seconds later so a handover settles first. */
    private fun watchConnectivity() {
        if (callback != null || cm == null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = soon()
            override fun onLost(network: Network) = soon()
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = soon()
        }
        try {
            cm.registerNetworkCallback(NetworkRequest.Builder().build(), cb)
            callback = cb
        } catch (e: Throwable) { Log.w(TAG, "wifi: cannot watch connectivity: ${e.message}") }
    }

    private fun soon() {
        if (desired.isEmpty() && managed.isEmpty()) return
        handler.removeCallbacks(reconcileSoon)
        handler.postDelayed(reconcileSoon, SETTLE_MS)
    }

    // ── report ────────────────────────────────────────────────────────────────────────────────────

    private fun report(outcomes: List<WifiOutcome>, force: Boolean) {
        val ids = desired.map { it.id }.toSet()
        val arr = JSONArray()
        for (o in outcomes.filter { it.id in ids }) {
            arr.put(JSONObject().put("id", o.id).put("state", o.state).apply { o.reason?.let { put("reason", it) } })
        }
        val body = JSONObject().put("mode", mode()).put("results", arr)
        val key = body.toString()
        if (!force && key == lastReport) return
        lastReport = key
        onResult(body)
    }

    // ── persistence (Keystore-backed, or memory only) ─────────────────────────────────────────────

    private fun read(key: String): List<JSONObject> = try {
        val arr = JSONArray(store?.getString(key, null) ?: "[]")
        (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
    } catch (_: Throwable) { emptyList() }

    private fun write(key: String, arr: JSONArray) {
        try { store?.edit()?.putString(key, arr.toString())?.apply() } catch (e: Throwable) { Log.w(TAG, "wifi: store write failed: ${e.message}") }
    }

    private fun desiredFrom(o: JSONObject) = WifiDesired(
        o.optString("id"), o.optString("ssid"), o.optString("security", WifiPlan.SECURITY_WPA2),
        o.optBoolean("hidden", false), if (o.has("priority") && !o.isNull("priority")) o.optInt("priority") else null,
        if (o.has("password") && !o.isNull("password")) o.optString("password") else null,
    )

    private fun managedFrom(o: JSONObject) = WifiManaged(
        o.optString("id"), o.optString("ssid"), o.optString("security", WifiPlan.SECURITY_WPA2),
        o.optBoolean("hidden", false), if (o.has("priority") && !o.isNull("priority")) o.optInt("priority") else null,
        if (o.has("password") && !o.isNull("password")) o.optString("password") else null, o.optInt("net_id", -1),
    )

    private fun managedFrom(d: WifiDesired, netId: Int) = WifiManaged(d.id, d.ssid, d.security, d.hidden, d.priority, d.password, netId)

    private fun toJson(d: WifiDesired) = JSONObject().put("id", d.id).put("ssid", d.ssid).put("security", d.security)
        .put("hidden", d.hidden).put("priority", d.priority ?: JSONObject.NULL).put("password", d.password ?: JSONObject.NULL)

    private fun toJson(m: WifiManaged) = toJson(WifiDesired(m.id, m.ssid, m.security, m.hidden, m.priority, m.password)).put("net_id", m.netId)

    companion object {
        private const val TAG = "WifiNetworks"
        private const val KEY_DESIRED = "desired"
        private const val KEY_MANAGED = "managed"
        private const val KEY_DEVICE = "device_id"
        private const val SETTLE_MS = 4000L

        /** owner / direct / suggestions / unsupported — what device_info.wifi_mode reports. */
        fun modeFor(context: Context): String {
            val hasWifi = context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI) &&
                context.applicationContext.getSystemService(Context.WIFI_SERVICE) != null
            val owner = try { STPolicy(context).isDeviceOwner() } catch (_: Throwable) { false }
            return WifiModeLogic.mode(Build.VERSION.SDK_INT, owner, hasWifi)
        }

        private fun openStore(context: Context): SharedPreferences? = try {
            val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            EncryptedSharedPreferences.create(
                context, "wifi_networks_secure", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Throwable) {
            Log.w(TAG, "wifi: Keystore-backed store unavailable, keeping the list in memory only: ${e.message}")
            null
        }
    }
}
