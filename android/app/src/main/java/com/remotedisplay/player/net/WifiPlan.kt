package com.remotedisplay.player.net

/**
 * #720 The decisions behind managed Wi-Fi, with no Android in them (WifiNetworkManager does the
 * Android calls). Pure so every rule here is a JUnit vector — see WifiPlanTest.
 *
 * ⚠️ A PANEL MUST NEVER STRAND ITSELF. A van panel with a typo in a new password and its working
 * network removed is offline until somebody drives to it, which is the site visit this feature
 * exists to avoid. So, in this order:
 *
 *   1. Adds run before changes, and changes before removes.
 *   2. The network the panel is connected on RIGHT NOW is never changed or removed. The step waits
 *      ("deferred") until the panel is no longer on it — it roamed to another managed network that
 *      works, or the connection dropped on its own (the router's password changed, the van left).
 *      Then the waiting step runs on the next reconcile. A new password for the network in use is
 *      therefore applied exactly when the old one stops working, which is when it is needed.
 *   3. If the panel cannot tell WHICH Wi-Fi it is on (no location permission on Android 10+, where
 *      the SSID is redacted), every managed network counts as possibly in use while Wi-Fi is the
 *      active link. Nothing is removed or changed until it is not.
 *
 * Only networks this player added are ever touched ([Managed] is its own list); a network that was
 * configured on the panel by hand is refused rather than adopted (WifiNetworkManager checks).
 */
object WifiModeLogic {
    const val OWNER = "owner"
    const val DIRECT = "direct"
    const val SUGGESTIONS = "suggestions"
    const val UNSUPPORTED = "unsupported"

    /**
     * How this player can manage networks. Device owner and profile owner apps are exempt from the
     * Android 10 restriction that makes WifiManager.addNetwork() fail for ordinary apps; below
     * Android 10 any app may save networks; above it, a non-owner can only suggest them.
     */
    fun mode(sdkInt: Int, isOwner: Boolean, hasWifi: Boolean): String = when {
        !hasWifi -> UNSUPPORTED
        isOwner -> OWNER
        sdkInt <= 28 -> DIRECT
        else -> SUGGESTIONS
    }
}

/** A network as the server sends it (device:wifi-networks). [password] is null for an open one. */
data class WifiDesired(
    val id: String,
    val ssid: String,
    val security: String,
    val hidden: Boolean,
    val priority: Int?,
    val password: String?,
)

/** A network THIS player added. [netId] is the WifiConfiguration id, or -1 for a suggestion. */
data class WifiManaged(
    val id: String,
    val ssid: String,
    val security: String,
    val hidden: Boolean,
    val priority: Int?,
    val password: String?,
    val netId: Int,
) {
    fun sameAs(d: WifiDesired): Boolean =
        ssid == d.ssid && security == d.security && hidden == d.hidden && priority == d.priority && password == d.password
}

/**
 * What the panel knows about its link when it plans. [wifiActive]: Wi-Fi is the active (default)
 * transport. [currentNetId] / [currentSsid]: which network, when Android tells us (null = unknown).
 */
data class WifiSituation(
    val mode: String,
    val sdkInt: Int,
    val wifiActive: Boolean,
    val currentNetId: Int?,
    val currentSsid: String?,
)

sealed class WifiStep {
    data class Add(val desired: WifiDesired) : WifiStep()
    data class Update(val managed: WifiManaged, val desired: WifiDesired) : WifiStep()
    data class Remove(val managed: WifiManaged) : WifiStep()
}

/** One line of the device:wifi-result report. Reason codes are the server's vocabulary. */
data class WifiOutcome(val id: String, val state: String, val reason: String? = null)

data class WifiPlanResult(
    val steps: List<WifiStep>,
    /** Per desired network that is NOT getting a step this round: deferred, unsupported or unchanged. */
    val outcomes: List<WifiOutcome>,
    /** Managed networks whose removal is waiting (no server row to report them on). */
    val removalsWaiting: List<WifiManaged>,
)

object WifiPlan {
    const val SECURITY_OPEN = "open"
    const val SECURITY_WPA2 = "wpa2"
    const val SECURITY_WPA3 = "wpa3"

    /** Why this network cannot be managed on this panel at all, or null when it can. */
    fun unsupportedReason(d: WifiDesired, mode: String, sdkInt: Int): String? = when {
        mode == WifiModeLogic.UNSUPPORTED -> "rejected_by_android"
        d.security !in listOf(SECURITY_OPEN, SECURITY_WPA2, SECURITY_WPA3) -> "rejected_by_android"
        d.security == SECURITY_WPA3 && sdkInt < 29 -> "wpa3_needs_android_10"
        // WifiNetworkSuggestion.Builder.setIsHiddenSsid is API 30.
        mode == WifiModeLogic.SUGGESTIONS && d.hidden && sdkInt < 30 -> "hidden_needs_android_11"
        else -> null
    }

    /** Is the panel (possibly) connected on [m] right now? Unknown counts as yes while Wi-Fi is up. */
    fun inUse(m: WifiManaged, s: WifiSituation): Boolean {
        if (!s.wifiActive) return false
        if (s.currentNetId != null && s.currentNetId >= 0 && m.netId >= 0) return m.netId == s.currentNetId
        if (!s.currentSsid.isNullOrEmpty()) return m.ssid == s.currentSsid
        return true
    }

    private fun waitReason(s: WifiSituation): String =
        if ((s.currentNetId != null && s.currentNetId >= 0) || !s.currentSsid.isNullOrEmpty()) "connected_network_in_use"
        else "connected_network_unknown"

    /**
     * The steps that bring [managed] towards [desired] without stranding the panel. [appliedState]
     * is what an unchanged, managed network reports ("applied", or "suggested" in suggestions mode).
     */
    fun plan(desired: List<WifiDesired>, managed: List<WifiManaged>, s: WifiSituation): WifiPlanResult {
        val appliedState = if (s.mode == WifiModeLogic.SUGGESTIONS) "suggested" else "applied"
        val byId = managed.associateBy { it.id }
        val wanted = desired.associateBy { it.id }
        val adds = mutableListOf<WifiStep>()
        val updates = mutableListOf<WifiStep>()
        val removes = mutableListOf<WifiStep>()
        val outcomes = mutableListOf<WifiOutcome>()
        val waiting = mutableListOf<WifiManaged>()

        for (d in desired) {
            val m = byId[d.id]
            val unsupported = unsupportedReason(d, s.mode, s.sdkInt)
            when {
                unsupported != null -> outcomes += WifiOutcome(d.id, "unsupported", unsupported)
                m == null -> adds += WifiStep.Add(d)
                m.sameAs(d) -> outcomes += WifiOutcome(d.id, appliedState)
                inUse(m, s) -> outcomes += WifiOutcome(d.id, "deferred", waitReason(s))
                else -> updates += WifiStep.Update(m, d)
            }
        }
        for (m in managed) {
            if (m.id in wanted) continue
            if (inUse(m, s)) waiting += m else removes += WifiStep.Remove(m)
        }
        return WifiPlanResult(adds + updates + removes, outcomes, waiting)
    }

    /**
     * "ssid" in quotes, the form WifiConfiguration.SSID and preSharedKey take. No escaping: the
     * framework takes everything between the first and the last quote as the name.
     */
    fun quoted(s: String): String = "\"" + s + "\""

    /** A 64-hex-digit WPA2 key goes in raw; a passphrase goes in quoted. */
    fun pskForConfig(password: String): String =
        if (password.length == 64 && password.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) password
        else quoted(password)

    /** WifiInfo.getSSID() returns the name in quotes, or "<unknown ssid>" when it is redacted. */
    fun ssidFromWifiInfo(raw: String?): String? {
        if (raw.isNullOrEmpty() || raw == "<unknown ssid>" || raw == "0x") return null
        return if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) raw.substring(1, raw.length - 1) else null
    }
}
