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
    /**
     * Let go after a new pairing (WifiNetworkManager): still on the panel, never removed by this
     * player again, but taken over when the new screen lists a network with the same SSID.
     */
    val released: Boolean = false,
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
    /** The managed list with ids moved over to re-added networks (see [WifiPlan.plan]). */
    val managed: List<WifiManaged> = emptyList(),
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
        // A SAVED WPA3 network needs WifiConfiguration.setSecurityParams (API 30): on Android 10 the
        // framework refuses SAE without PMF, and requirePmf is not public API. Suggestions have it on 29.
        d.security == SECURITY_WPA3 && mode != WifiModeLogic.SUGGESTIONS && sdkInt < 30 -> "wpa3_needs_android_11"
        // WifiNetworkSuggestion.Builder.setIsHiddenSsid is API 30.
        mode == WifiModeLogic.SUGGESTIONS && d.hidden && sdkInt < 30 -> "hidden_needs_android_11"
        // setWpa2Passphrase takes a passphrase only; a raw 64-hex key works as a saved network.
        mode == WifiModeLogic.SUGGESTIONS && d.security == SECURITY_WPA2 && isHexKey(d.password) -> "hex_key_needs_saved_network"
        else -> null
    }

    fun isHexKey(p: String?): Boolean =
        p != null && p.length == 64 && p.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

    /** Is the panel (possibly) connected on [m] right now? Unknown counts as yes while Wi-Fi is up. */
    fun inUse(m: WifiManaged, s: WifiSituation): Boolean {
        if (!s.wifiActive) return false
        if (knowsNetId(m, s)) return m.netId == s.currentNetId
        if (!s.currentSsid.isNullOrEmpty()) return m.ssid == s.currentSsid
        return true
    }

    private fun knowsNetId(m: WifiManaged, s: WifiSituation) = s.currentNetId != null && s.currentNetId >= 0 && m.netId >= 0

    /** Why [m] waits — the same test as [inUse], so the reason never claims more than it knows. */
    fun waitReason(m: WifiManaged, s: WifiSituation): String =
        if (knowsNetId(m, s) || !s.currentSsid.isNullOrEmpty()) "connected_network_in_use" else "connected_network_unknown"

    /**
     * Is [m] in the form this mode manages? A device owner saves networks; a suggestion left over
     * from before the player became owner is moved over. The other way round (owner revoked) there
     * is nothing a non-owner may do to a saved network, so it is left as it is.
     */
    private fun rightKind(m: WifiManaged, mode: String): Boolean = mode == WifiModeLogic.SUGGESTIONS || m.netId >= 0

    /**
     * The steps that bring [managed] towards [desired] without stranding the panel. An unchanged,
     * managed network reports "applied" ("suggested" in suggestions mode).
     *
     * ⚠️ MATCHED BY SSID TOO. Deleting a network on the dashboard and adding it again gives it a new
     * id. Matched by id alone that is "add the new one, remove the old one" — and the add overwrites
     * the very configuration the panel may be connected on, past the in-use guard. A desired network
     * without an id match takes over an unclaimed managed entry with the same SSID instead (a released
     * one included). So does a network RENAMED onto the SSID of a released entry: the released entry
     * is taken over and the renamed one's old entry is retired. [WifiPlanResult.managed] carries both.
     *
     * ⚠️ NEVER WRITE OVER ANOTHER MANAGED NETWORK. Android keys a saved network or a suggestion by
     * SSID and security, so writing a network under an SSID that another managed entry holds would
     * overwrite that entry's configuration — possibly the one in use. Such a step simply waits
     * ("waiting_for_other_network") until the other entry is gone through its own, guarded path;
     * the manager runs again after any removal, so it follows on the next run. Two desired networks
     * with the same SSID (the server refuses that) are never both written: the second is refused.
     */
    fun plan(desired: List<WifiDesired>, managed: List<WifiManaged>, s: WifiSituation): WifiPlanResult {
        val appliedState = if (s.mode == WifiModeLogic.SUGGESTIONS) "suggested" else "applied"
        val outcomes = mutableListOf<WifiOutcome>()
        val seenSsid = mutableSetOf<String>()
        val wanted = desired.filter { d ->
            if (seenSsid.add(d.ssid)) true else { outcomes += WifiOutcome(d.id, "failed", "rejected_by_android"); false }
        }
        val wantedIds = wanted.map { it.id }.toSet()
        val rebound = managed.toMutableList()
        for (d in wanted) {
            val own = rebound.indexOfFirst { it.id == d.id }
            val free = rebound.indexOfFirst { it.ssid == d.ssid && it.id !in wantedIds && (own < 0 || it.released) }
            if (free < 0) continue
            if (own >= 0) rebound[own] = rebound[own].copy(id = RETIRED_PLAN_PREFIX + rebound[own].id)
            rebound[free] = rebound[free].copy(id = d.id, released = false)
        }
        val byId = rebound.associateBy { it.id }
        val adds = mutableListOf<WifiStep>()
        val updates = mutableListOf<WifiStep>()
        val removes = mutableListOf<WifiStep>()
        val waiting = mutableListOf<WifiManaged>()

        for (d in wanted) {
            val m = byId[d.id]
            val unsupported = unsupportedReason(d, s.mode, s.sdkInt)
            // Another managed entry holding the SSID this step would write.
            val holder = rebound.firstOrNull { it.id != d.id && it.ssid == d.ssid }
            when {
                // The previous version (if any) stays: a working network is not dropped for one the panel cannot use.
                unsupported != null -> outcomes += WifiOutcome(d.id, "unsupported", unsupported)
                m != null && m.sameAs(d) && rightKind(m, s.mode) -> outcomes += WifiOutcome(d.id, if (m.netId >= 0) "applied" else appliedState)
                m != null && inUse(m, s) -> outcomes += WifiOutcome(d.id, "deferred", waitReason(m, s))
                holder != null -> outcomes += WifiOutcome(d.id, "deferred", "waiting_for_other_network")
                m == null -> adds += WifiStep.Add(d)
                else -> updates += WifiStep.Update(m, d)
            }
        }
        for (m in rebound) {
            if (m.id in wantedIds || m.released) continue
            if (inUse(m, s)) waiting += m else removes += WifiStep.Remove(m)
        }
        return WifiPlanResult(adds + updates + removes, outcomes, waiting, rebound)
    }

    /** A managed entry the plan retired (its network was renamed onto a released one); removed like any other. */
    const val RETIRED_PLAN_PREFIX = "retired-plan:"

    /**
     * "ssid" in quotes, the form WifiConfiguration.SSID and preSharedKey take. No escaping: the
     * framework takes everything between the first and the last quote as the name.
     */
    fun quoted(s: String): String = "\"" + s + "\""

    /** A 64-hex-digit WPA2 key goes in raw; a passphrase goes in quoted. */
    fun pskForConfig(password: String): String = if (isHexKey(password)) password else quoted(password)

    /** WifiInfo.getSSID() returns the name in quotes, or "<unknown ssid>" when it is redacted. */
    fun ssidFromWifiInfo(raw: String?): String? {
        if (raw.isNullOrEmpty() || raw == "<unknown ssid>" || raw == "0x") return null
        return if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) raw.substring(1, raw.length - 1) else null
    }
}
