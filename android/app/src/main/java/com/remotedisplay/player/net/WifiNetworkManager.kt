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
    /**
     * True until the server has sent a list in this run, if the stored list could not be read back.
     * A damaged store must never read as "the operator wants nothing": until a real list arrives
     * only adds run, nothing is changed or removed.
     */
    private var destructiveBlocked = false
    private var retiredThisRun = false
    private var removedThisRun = false
    private val reconcileSoon = Runnable { reconcile(force = false) }

    /**
     * Load what was persisted for [deviceId], watch connectivity, and finish any step that was
     * waiting — the step that matters runs offline (a new password for a router that changed).
     */
    @Synchronized
    fun restore(deviceId: String) {
        val d = read(KEY_DESIRED)
        val m = read(KEY_MANAGED)
        desired = d?.map(::desiredFrom) ?: emptyList()
        managed = m?.map(::managedFrom) ?: emptyList()
        destructiveBlocked = d == null || m == null
        // Checked HERE, before anything runs: a list saved for another pairing is not ours to finish.
        releaseIfRepaired(deviceId)
        // Not paired yet (no id to check against): wait for the server's list, change nothing.
        if (deviceId.isEmpty()) destructiveBlocked = true
        // A device owner can see which network it is on (Android 10+ redacts it without location).
        if (mode() == WifiModeLogic.OWNER && Build.VERSION.SDK_INT >= 29) {
            try { STPolicy(context).grantSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) } catch (_: Throwable) { }
        }
        watchConnectivity()
        if (desired.isNotEmpty() || managed.isNotEmpty()) reconcile(force = false)
    }

    /** The list from the server for [deviceId]. Malformed entries are skipped; the rest still apply. */
    @Synchronized
    fun apply(payload: JSONObject, deviceId: String) {
        releaseIfRepaired(deviceId)
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
        destructiveBlocked = false
        write(KEY_DESIRED, JSONArray(list.map(::toJson)))
        reconcile(force = true)
    }

    /**
     * ⚠️ A NEW PAIRING LETS GO, IT DOES NOT WIPE. If this panel was deleted and paired again as a
     * new screen (a new device id), the networks the old one managed stay on the panel and nothing
     * the old screen was waiting to do is done: removing them would cut off exactly the link the
     * re-pairing came in on. They stay on our list as RELEASED — never removed by this player again,
     * but taken over (with the usual in-use guard) if the new screen lists a network with the same
     * SSID, so a new list can never silently overwrite one of them.
     *
     * A stored list without a stored device id is treated the same way: whose it was is unknown.
     */
    private fun releaseIfRepaired(deviceId: String) {
        if (deviceId.isEmpty()) return
        val owner = try { store?.getString(KEY_DEVICE, null) } catch (_: Throwable) { null } ?: memoryDevice
        if (owner != deviceId && (managed.any { !it.released } || desired.isNotEmpty())) {
            Log.i(TAG, "wifi: paired as a new screen; ${managed.size} network(s) stay on the panel, released")
            managed = managed.map { it.copy(released = true) }
            desired = emptyList()
            write(KEY_MANAGED, JSONArray(managed.map(::toJson)))
            write(KEY_DESIRED, JSONArray())
        }
        memoryDevice = deviceId
        try { store?.edit()?.putString(KEY_DEVICE, deviceId)?.apply() } catch (_: Throwable) { }
    }

    @Synchronized
    fun stop() {
        handler.removeCallbacks(reconcileSoon)
        try { callback?.let { cm?.unregisterNetworkCallback(it) } } catch (_: Throwable) { }
        callback = null
    }

    fun mode(): String = modeFor(context)

    /** Plan, run the steps, persist, report. [force]: report even when nothing changed. */
    @Synchronized
    fun reconcile(force: Boolean) {
        val mode = mode()
        dropVanished(mode)
        val plan = WifiPlan.plan(desired, managed, situation(mode))
        // While the stored state is suspect only adds run; the plan's re-matching waits for a real list too.
        if (!destructiveBlocked) managed = plan.managed
        val outcomes = plan.outcomes.toMutableList()
        retiredThisRun = false
        removedThisRun = false
        for (step in plan.steps) {
            if (destructiveBlocked && step !is WifiStep.Add) continue
            /*
             * The link is read again before every change or removal: an add earlier in this run (or
             * Android on its own) may have moved the panel onto the very network a later step targets.
             */
            val target = when (step) { is WifiStep.Update -> step.managed; is WifiStep.Remove -> step.managed; else -> null }
            if (target != null) {
                val now = situation(mode)
                if (WifiPlan.inUse(target, now)) {
                    if (step is WifiStep.Update) outcomes += WifiOutcome(step.desired.id, "deferred", WifiPlan.waitReason(target, now))
                    continue
                }
            }
            val out = try { run(step, mode) } catch (e: Throwable) {
                Log.w(TAG, "wifi step ${step::class.simpleName} failed: ${e.javaClass.simpleName}")   // never the password
                failure(step, if (e is SecurityException) "permission_denied" else "rejected_by_android")
            }
            if (out != null) outcomes += out
        }
        if (Build.VERSION.SDK_INT < 26 && mode != WifiModeLogic.SUGGESTIONS && plan.steps.isNotEmpty()) {
            @Suppress("DEPRECATION") try { wifi?.saveConfiguration() } catch (_: Throwable) { }
        }
        write(KEY_MANAGED, JSONArray(managed.map(::toJson)))
        // A replaced network is removed by the next run, through the same in-use guard as any removal;
        // a removal may have freed an SSID another step was waiting for.
        if (retiredThisRun || removedThisRun) { handler.removeCallbacks(reconcileSoon); handler.postDelayed(reconcileSoon, SETTLE_MS) }
        // Wi-Fi switched off is said on every network that is in place, unchanged ones included.
        val wifiOff = wifi?.isWifiEnabled == false
        report(outcomes.map { if (wifiOff && it.state in listOf("applied", "suggested")) it.copy(reason = "wifi_off") else it }, force)
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
            managed = managed.filter { it.id != d.id } + managedFrom(d, -1)
            return WifiOutcome(d.id, "suggested")
        }
        when (configuredByHand(d)) {
            null -> return WifiOutcome(d.id, "failed", "permission_denied")   // cannot check, so do not risk taking one over
            true -> return WifiOutcome(d.id, "failed", "already_configured_by_hand")
            false -> { }
        }
        val netId = addConfig(configFor(d), mode)
        if (netId < 0) return WifiOutcome(d.id, "failed", "rejected_by_android")
        @Suppress("DEPRECATION") wifi!!.enableNetwork(netId, false)   // may join; never forces a switch
        managed = managed.filter { it.id != d.id } + managedFrom(d, netId)
        return WifiOutcome(d.id, "applied")
    }

    /**
     * WifiPlan only gets here when the panel is not connected on [m] (and reconcile checked again
     * just before). The same network (SSID, security, kind) is changed in place. Anything else is a
     * different network to Android: the replacement is ADDED, and the old one is only RETIRED — it
     * stays on our list under a fresh id that nobody wants, so the next run removes it through the
     * normal path, in-use check and all. A refused replacement leaves the old one exactly as it was.
     */
    private fun update(m: WifiManaged, d: WifiDesired, mode: String): WifiOutcome {
        val sameIdentity = m.ssid == d.ssid && m.security == d.security
        if (sameIdentity && m.netId >= 0 && mode != WifiModeLogic.SUGGESTIONS) {
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
        if (sameIdentity && m.netId < 0 && mode == WifiModeLogic.SUGGESTIONS) {
            // Android 11+ replaces a suggestion with the same SSID and security on add.
            if (Build.VERSION.SDK_INT >= 30) return add(d, mode)
            // Android 10 answers "duplicate" instead: the old one goes first, and comes back if the new one is refused.
            if (!remove(m, mode)) return WifiOutcome(d.id, "failed", "rejected_by_android")
            val out = try { add(d, mode) } catch (e: Throwable) { WifiOutcome(d.id, "failed", "rejected_by_android") }
            if (out.state != "suggested") {
                try { add(WifiDesired(m.id, m.ssid, m.security, m.hidden, m.priority, m.password), mode) } catch (_: Throwable) { }
            }
            return out
        }
        val retired = m.copy(id = RETIRED_PREFIX + java.util.UUID.randomUUID())
        managed = managed.map { if (it.id == m.id) retired else it }
        val out = try { add(d, mode) } catch (e: Throwable) { WifiOutcome(d.id, "failed", "rejected_by_android") }
        if (out.state == "applied" || out.state == "suggested") retiredThisRun = true
        else managed = managed.filter { it.id != d.id }.map { if (it.id == retired.id) m else it }   // refused: undo
        return out
    }

    /**
     * Remove [m] from the panel. True when it is gone; false keeps it on our list so a later run
     * tries again — a refused removal must not leave a credential behind that nobody manages.
     */
    private fun remove(m: WifiManaged, mode: String): Boolean {
        val gone = when {
            m.netId < 0 -> {
                if (Build.VERSION.SDK_INT < 29) true else {
                    val status = wifi!!.removeNetworkSuggestions(listOf(suggestionFor(WifiDesired(m.id, m.ssid, m.security, m.hidden, m.priority, m.password))))
                    status == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS || status == WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_REMOVE_INVALID
                }
            }
            // A saved network from when this player was owner: a non-owner may not remove it on
            // Android 10+. It is kept as RELEASED (never removed, taken over by SSID) — not reported
            // as removed, and not forgotten, or a later owner would see it as set up by hand.
            mode == WifiModeLogic.SUGGESTIONS -> {
                Log.i(TAG, "wifi: cannot remove a saved network without device owner; it stays on the panel, released")
                managed = managed.map { if (it.id == m.id) it.copy(released = true) else it }
                removedThisRun = true
                return true
            }
            else -> {
                @Suppress("DEPRECATION")
                val ok = wifi!!.removeNetwork(m.netId)
                // False also when it is already gone (forgotten on the panel by hand): then it is gone.
                ok || savedNetIds()?.contains(m.netId) == false
            }
        }
        if (gone) { managed = managed.filter { it.id != m.id }; removedThisRun = true }
        return gone
    }

    /**
     * Forget managed entries Android no longer has (someone removed the network on the panel), so the
     * plan adds them again instead of reporting "applied" for something that is not there.
     */
    private fun dropVanished(mode: String) {
        val saved = if (mode != WifiModeLogic.SUGGESTIONS) savedNetIds() else null
        val suggested = if (mode == WifiModeLogic.SUGGESTIONS && Build.VERSION.SDK_INT >= 30)
            try { wifi?.networkSuggestions?.map { it.ssid } } catch (_: Throwable) { null } else null
        managed = managed.filter { m ->
            when {
                m.netId >= 0 && saved != null -> m.netId in saved
                m.netId < 0 && suggested != null -> m.ssid in suggested
                else -> true   // cannot check: keep it
            }
        }
    }

    /** The ids of the saved networks, or null when Android will not tell us. */
    @Suppress("DEPRECATION")
    private fun savedNetIds(): Set<Int>? =
        try { wifi?.configuredNetworks?.map { it.networkId }?.toSet() } catch (_: SecurityException) { null }

    private fun addConfig(c: WifiConfiguration, mode: String): Int {
        if (mode == WifiModeLogic.OWNER && Build.VERSION.SDK_INT >= 31) {
            val r = wifi!!.addNetworkPrivileged(c)
            return if (r.statusCode == WifiManager.AddNetworkResult.STATUS_SUCCESS) r.networkId else -1
        }
        @Suppress("DEPRECATION")
        return wifi!!.addNetwork(c)
    }

    /**
     * A saved network with this name that is not on our list was set up by hand: true. Null when
     * Android will not show us the saved networks — then we cannot tell, and an add could take one
     * over, so the caller refuses.
     */
    @Suppress("DEPRECATION")
    private fun configuredByHand(d: WifiDesired): Boolean? {
        val ours = managed.map { it.netId }.toSet()
        val configs = try { wifi!!.configuredNetworks } catch (_: SecurityException) { null } ?: return null
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

    /**
     * ⚠️ "Wi-Fi active" means CONNECTED over Wi-Fi, not "Wi-Fi is the default route": with Ethernet
     * as the default a panel can still be on Wi-Fi, and that connection is just as much in use.
     */
    @Suppress("DEPRECATION")
    private fun situation(mode: String): WifiSituation {
        val info = try { wifi?.connectionInfo } catch (_: Throwable) { null }
        val netId = info?.networkId?.takeIf { it >= 0 }
        val wifiLinks = try {
            cm?.allNetworks?.count { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true } ?: 0
        } catch (_: Throwable) { -1 }   // cannot tell
        val wifiActive = wifiLinks != 0 || netId != null || info?.supplicantState == android.net.wifi.SupplicantState.COMPLETED
        // connectionInfo names ONE network. With two Wi-Fi links at once (Android 12+), or when we
        // cannot count them, which ones are in use is unknown — and unknown means nothing is changed.
        if (wifiLinks > 1 || wifiLinks < 0) return WifiSituation(mode, Build.VERSION.SDK_INT, true, null, null)
        return WifiSituation(mode, Build.VERSION.SDK_INT, wifiActive, netId, WifiPlan.ssidFromWifiInfo(info?.ssid))
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

    /**
     * The stored list; empty when there is none, NULL when it is there but cannot be trusted — not
     * JSON, or any entry without an id, an SSID or a known security type. One bad entry makes the
     * whole list suspect: read as "fewer networks", it would be an instruction to remove some.
     */
    private fun read(key: String): List<JSONObject>? = try {
        val arr = JSONArray(store?.getString(key, null) ?: "[]")
        val out = (0 until arr.length()).map { arr.get(it) as JSONObject }
        if (out.all { it.optString("id").isNotEmpty() && it.optString("ssid").isNotEmpty() &&
                it.optString("security") in listOf(WifiPlan.SECURITY_OPEN, WifiPlan.SECURITY_WPA2, WifiPlan.SECURITY_WPA3) }) out else null
    } catch (_: Throwable) { null }

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
        o.optBoolean("released", false),
    )

    private fun managedFrom(d: WifiDesired, netId: Int) = WifiManaged(d.id, d.ssid, d.security, d.hidden, d.priority, d.password, netId)

    private fun toJson(d: WifiDesired) = JSONObject().put("id", d.id).put("ssid", d.ssid).put("security", d.security)
        .put("hidden", d.hidden).put("priority", d.priority ?: JSONObject.NULL).put("password", d.password ?: JSONObject.NULL)

    private fun toJson(m: WifiManaged) = toJson(WifiDesired(m.id, m.ssid, m.security, m.hidden, m.priority, m.password))
        .put("net_id", m.netId).put("released", m.released)

    companion object {
        private const val TAG = "WifiNetworks"
        private const val KEY_DESIRED = "desired"
        private const val KEY_MANAGED = "managed"
        private const val KEY_DEVICE = "device_id"
        private const val SETTLE_MS = 4000L
        // A replaced network waiting for its removal: an id the server never sends, so nobody wants it.
        private const val RETIRED_PREFIX = "retired:"

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
