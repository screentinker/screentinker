package com.remotedisplay.player.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #720 WifiPlan / WifiModeLogic. The vectors that matter most are the stranding ones: a panel must
 * never change or remove the network it is connected on, and must assume the worst when it cannot
 * tell which one that is.
 */
class WifiPlanTest {

    private fun d(id: String, ssid: String = id, security: String = "wpa2", password: String? = "password-$id",
                  hidden: Boolean = false, priority: Int? = null) =
        WifiDesired(id, ssid, security, hidden, priority, if (security == "open") null else password)

    private fun m(id: String, ssid: String = id, security: String = "wpa2", password: String? = "password-$id",
                  netId: Int = 10, hidden: Boolean = false, priority: Int? = null) =
        WifiManaged(id, ssid, security, hidden, priority, if (security == "open") null else password, netId)

    private fun sit(mode: String = WifiModeLogic.DIRECT, sdk: Int = 28, wifiActive: Boolean = true,
                    netId: Int? = null, ssid: String? = null) = WifiSituation(mode, sdk, wifiActive, netId, ssid)

    // ── mode ──────────────────────────────────────────────────────────────────────────────────────

    @Test fun `owner wins on any Android version`() {
        assertEquals("owner", WifiModeLogic.mode(34, isOwner = true, hasWifi = true))
        assertEquals("owner", WifiModeLogic.mode(23, isOwner = true, hasWifi = true))
    }

    @Test fun `not owner - direct up to Android 9, suggestions from Android 10`() {
        assertEquals("direct", WifiModeLogic.mode(23, isOwner = false, hasWifi = true))
        assertEquals("direct", WifiModeLogic.mode(28, isOwner = false, hasWifi = true))
        assertEquals("suggestions", WifiModeLogic.mode(29, isOwner = false, hasWifi = true))
        assertEquals("suggestions", WifiModeLogic.mode(34, isOwner = false, hasWifi = true))
    }

    @Test fun `no Wi-Fi hardware is unsupported, owner or not`() {
        assertEquals("unsupported", WifiModeLogic.mode(34, isOwner = true, hasWifi = false))
        assertEquals("unsupported", WifiModeLogic.mode(28, isOwner = false, hasWifi = false))
    }

    // ── what a panel cannot do ────────────────────────────────────────────────────────────────────

    @Test fun `WPA3 needs Android 10 as a suggestion and Android 11 as a saved network`() {
        assertEquals("wpa3_needs_android_10", WifiPlan.unsupportedReason(d("a", security = "wpa3"), "direct", 28))
        assertEquals("wpa3_needs_android_10", WifiPlan.unsupportedReason(d("a", security = "wpa3"), "owner", 28))
        assertNull(WifiPlan.unsupportedReason(d("a", security = "wpa3"), "suggestions", 29))
        assertEquals("wpa3_needs_android_11", WifiPlan.unsupportedReason(d("a", security = "wpa3"), "owner", 29))
        assertNull(WifiPlan.unsupportedReason(d("a", security = "wpa3"), "owner", 30))
    }

    @Test fun `a raw 64-hex WPA2 key cannot be suggested, only saved`() {
        val hex = "ab".repeat(32)
        assertEquals("hex_key_needs_saved_network", WifiPlan.unsupportedReason(d("a", password = hex), "suggestions", 30))
        assertNull(WifiPlan.unsupportedReason(d("a", password = hex), "owner", 30))
        assertNull(WifiPlan.unsupportedReason(d("a", password = hex), "direct", 28))
    }

    @Test fun `a hidden network can be suggested only from Android 11`() {
        assertEquals("hidden_needs_android_11", WifiPlan.unsupportedReason(d("a", hidden = true), "suggestions", 29))
        assertNull(WifiPlan.unsupportedReason(d("a", hidden = true), "suggestions", 30))
        // Saved directly or as owner, hidden works on any version.
        assertNull(WifiPlan.unsupportedReason(d("a", hidden = true), "direct", 23))
        assertNull(WifiPlan.unsupportedReason(d("a", hidden = true), "owner", 29))
    }

    @Test fun `an unknown security type is refused, not guessed`() {
        assertEquals("rejected_by_android", WifiPlan.unsupportedReason(d("a", security = "wep"), "direct", 28))
    }

    @Test fun `an unsupported network gets no step and is reported as such`() {
        val r = WifiPlan.plan(listOf(d("a", security = "wpa3")), emptyList(), sit(sdk = 28))
        assertTrue(r.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("a", "unsupported", "wpa3_needs_android_10")), r.outcomes)
    }

    // ── order ─────────────────────────────────────────────────────────────────────────────────────

    @Test fun `adds come before changes, and changes before removes`() {
        val managed = listOf(m("keep", netId = 1), m("change", netId = 2), m("drop", netId = 3))
        val desired = listOf(d("change", password = "new-password"), d("keep"), d("new"))
        val r = WifiPlan.plan(desired, managed, sit(wifiActive = false))
        assertEquals(listOf("Add", "Update", "Remove"), r.steps.map { it::class.simpleName })
        assertEquals(WifiOutcome("keep", "applied"), r.outcomes.single())
    }

    @Test fun `an unchanged network reports suggested in suggestions mode`() {
        val r = WifiPlan.plan(listOf(d("a")), listOf(m("a", netId = -1)), sit(mode = "suggestions", sdk = 30, wifiActive = false))
        assertEquals(listOf(WifiOutcome("a", "suggested")), r.outcomes)
    }

    // ── stranding ─────────────────────────────────────────────────────────────────────────────────

    @Test fun `THE ONE THAT MATTERS - the network in use is never removed`() {
        // The operator replaced the van's network: added "new", deleted "old" — and the panel is on "old".
        val r = WifiPlan.plan(listOf(d("new")), listOf(m("old", netId = 7)), sit(netId = 7))
        assertEquals(listOf("Add"), r.steps.map { it::class.simpleName })
        assertEquals(listOf("old"), r.removalsWaiting.map { it.id })
    }

    @Test fun `once the panel is on another network, the old one goes`() {
        val r = WifiPlan.plan(listOf(d("new")), listOf(m("old", netId = 7), m("new", netId = 8)), sit(netId = 8))
        assertEquals(listOf("Remove"), r.steps.map { it::class.simpleName })
        assertEquals("old", (r.steps.single() as WifiStep.Remove).managed.id)
        assertTrue(r.removalsWaiting.isEmpty())
    }

    @Test fun `a new password for the network in use waits until that connection is gone`() {
        val managed = listOf(m("van", netId = 7))
        val desired = listOf(d("van", password = "typo-in-the-new-one"))
        val held = WifiPlan.plan(desired, managed, sit(netId = 7))
        assertTrue(held.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("van", "deferred", "connected_network_in_use")), held.outcomes)
        // The router's password changed, the old one stopped working, Wi-Fi is down: NOW apply it.
        val dropped = WifiPlan.plan(desired, managed, sit(wifiActive = false))
        assertEquals(listOf("Update"), dropped.steps.map { it::class.simpleName })
    }

    @Test fun `changes to OTHER networks are not held back by the one in use`() {
        val managed = listOf(m("inuse", netId = 7), m("other", netId = 8))
        val desired = listOf(d("inuse"), d("other", password = "changed"))
        val r = WifiPlan.plan(desired, managed, sit(netId = 7))
        assertEquals(listOf("Update"), r.steps.map { it::class.simpleName })
        assertEquals("other", (r.steps.single() as WifiStep.Update).desired.id)
    }

    @Test fun `in suggestions mode the SSID identifies the network in use`() {
        val managed = listOf(m("a", ssid = "Depot", netId = -1), m("b", ssid = "Yard", netId = -1))
        val r = WifiPlan.plan(emptyList(), managed, sit(mode = "suggestions", sdk = 30, ssid = "Depot"))
        assertEquals(listOf("b"), r.steps.map { (it as WifiStep.Remove).managed.id })
        assertEquals(listOf("a"), r.removalsWaiting.map { it.id })
    }

    @Test fun `CANNOT TELL which network - nothing is changed or removed while Wi-Fi is up`() {
        val managed = listOf(m("a", netId = -1), m("b", netId = -1))
        val desired = listOf(d("a", password = "changed"))
        val r = WifiPlan.plan(desired, managed, sit(mode = "suggestions", sdk = 30))
        assertTrue("nothing may run blind", r.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("a", "deferred", "connected_network_unknown")), r.outcomes)
        assertEquals(listOf("b"), r.removalsWaiting.map { it.id })
        // Adds are never blind — a new network cannot strand anything.
        val withAdd = WifiPlan.plan(desired + d("c"), managed, sit(mode = "suggestions", sdk = 30))
        assertEquals(listOf("Add"), withAdd.steps.map { it::class.simpleName })
    }

    @Test fun `on Ethernet (Wi-Fi not the active link) everything can run`() {
        val managed = listOf(m("a", netId = 3))
        val r = WifiPlan.plan(emptyList(), managed, sit(wifiActive = false))
        assertEquals(listOf("Remove"), r.steps.map { it::class.simpleName })
    }

    @Test fun `an empty list on a panel that manages nothing is a no-op`() {
        val r = WifiPlan.plan(emptyList(), emptyList(), sit())
        assertTrue(r.steps.isEmpty() && r.outcomes.isEmpty() && r.removalsWaiting.isEmpty())
    }

    // ── re-added networks, mode changes ────────────────────────────────────────────────────────────

    @Test fun `deleted and re-added with the same SSID is the SAME network, not an add over the one in use`() {
        // The dashboard gave it a new id; the panel is connected on it.
        val managed = listOf(m("old-id", ssid = "Van", netId = 7))
        val same = WifiPlan.plan(listOf(d("new-id", ssid = "Van", password = "password-old-id")), managed, sit(netId = 7))
        assertTrue("no Android call for a new id alone", same.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("new-id", "applied")), same.outcomes)
        assertEquals(listOf("new-id"), same.managed.map { it.id })
        assertTrue(same.removalsWaiting.isEmpty())
        // ...and with a different password it is a CHANGE to the network in use, so it waits.
        val changed = WifiPlan.plan(listOf(d("new-id", ssid = "Van", password = "typo")), managed, sit(netId = 7))
        assertTrue(changed.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("new-id", "deferred", "connected_network_in_use")), changed.outcomes)
    }

    @Test fun `an id that is still wanted is never taken over by another entry with the same SSID`() {
        val managed = listOf(m("a", ssid = "X", netId = 1))
        val r = WifiPlan.plan(listOf(d("a", ssid = "X"), d("b", ssid = "X")), managed, sit(wifiActive = false))
        assertEquals(listOf("a"), r.managed.map { it.id })
        assertTrue("b must not write over a's network", r.steps.isEmpty())
        assertEquals(WifiOutcome("b", "failed", "rejected_by_android"), r.outcomes.first { it.id == "b" })
    }

    @Test fun `a suggestion is moved over to a saved network once the player is owner`() {
        val managed = listOf(m("a", netId = -1))
        val r = WifiPlan.plan(listOf(d("a")), managed, sit(mode = "owner", sdk = 33, wifiActive = false))
        assertEquals(listOf("Update"), r.steps.map { it::class.simpleName })
        // ...but not while it is the network in use.
        val held = WifiPlan.plan(listOf(d("a")), managed, sit(mode = "owner", sdk = 33, ssid = "a"))
        assertTrue(held.steps.isEmpty())
        assertEquals("deferred", held.outcomes.single().state)
    }

    @Test fun `a saved network left by a revoked owner is left alone in suggestions mode`() {
        val r = WifiPlan.plan(listOf(d("a")), listOf(m("a", netId = 4)), sit(mode = "suggestions", sdk = 33, wifiActive = false))
        assertTrue(r.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("a", "applied")), r.outcomes)
    }

    @Test fun `the wait reason never claims to know more than inUse did`() {
        // Suggestions (netId -1) with a known netId but no SSID: inUse cannot use the netId, so "unknown".
        val m = m("a", netId = -1)
        val s = sit(mode = "suggestions", sdk = 30, netId = 3)
        assertTrue(WifiPlan.inUse(m, s))
        assertEquals("connected_network_unknown", WifiPlan.waitReason(m, s))
        assertEquals("connected_network_in_use", WifiPlan.waitReason(m(id = "b", netId = 3), sit(netId = 3)))
    }

    // ── one network per SSID, released networks ─────────────────────────────────────────────────

    @Test fun `renaming a network onto the SSID of the one in use waits instead of overwriting it`() {
        // B (in use) was deleted on the dashboard; A was renamed to B's SSID.
        val managed = listOf(m("a", ssid = "Alpha", netId = 1), m("b", ssid = "Bravo", netId = 2))
        val desired = listOf(d("a", ssid = "Bravo", password = "password-a"))
        val held = WifiPlan.plan(desired, managed, sit(netId = 2))
        assertTrue("nothing may write over Bravo while the panel is on it", held.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("a", "deferred", "waiting_for_other_network")), held.outcomes)
        assertEquals(listOf("b"), held.removalsWaiting.map { it.id })
    }

    @Test fun `when the other one is not in use it is removed, and the rename follows on the NEXT run`() {
        val managed = listOf(m("a", ssid = "Alpha", netId = 1), m("b", ssid = "Bravo", netId = 2))
        val desired = listOf(d("a", ssid = "Bravo", password = "password-a"))
        val first = WifiPlan.plan(desired, managed, sit(wifiActive = false))
        assertEquals(listOf("Remove"), first.steps.map { it::class.simpleName })
        assertEquals("b", (first.steps.single() as WifiStep.Remove).managed.id)
        assertEquals("waiting_for_other_network", first.outcomes.single().reason)
        val next = WifiPlan.plan(desired, listOf(m("a", ssid = "Alpha", netId = 1)), sit(wifiActive = false))
        assertEquals(listOf("Update"), next.steps.map { it::class.simpleName })
    }

    @Test fun `a swap A to Bravo and B to Charlie never writes Bravo while B holds it`() {
        val managed = listOf(m("a", ssid = "Alpha", netId = 1), m("b", ssid = "Bravo", netId = 2))
        val desired = listOf(d("a", ssid = "Bravo", password = "password-a"), d("b", ssid = "Charlie", password = "password-b"))
        // B in use: its own rename waits, and A waits for B.
        val held = WifiPlan.plan(desired, managed, sit(netId = 2))
        assertTrue(held.steps.isEmpty())
        assertEquals(setOf("deferred"), held.outcomes.map { it.state }.toSet())
        // Not in use: B moves away first; A only when Bravo is free.
        val free = WifiPlan.plan(desired, managed, sit(wifiActive = false))
        assertEquals(listOf("b"), free.steps.map { (it as WifiStep.Update).managed.id })
        assertEquals(WifiOutcome("a", "deferred", "waiting_for_other_network"), free.outcomes.single())
    }

    @Test fun `renamed onto a released network - refused like one set up by hand, nothing given up`() {
        val managed = listOf(m("a", ssid = "Alpha", netId = 1), m("x", ssid = "Bravo", netId = 5).copy(released = true))
        val r = WifiPlan.plan(listOf(d("a", ssid = "Bravo", password = "password-x")), managed, sit(wifiActive = false))
        assertTrue("Alpha keeps working, Bravo is not touched", r.steps.isEmpty())
        assertEquals(listOf(WifiOutcome("a", "failed", "already_configured_by_hand")), r.outcomes)
        assertEquals(managed, r.managed)
    }

    @Test fun `two desired networks with one SSID are never both written`() {
        val r = WifiPlan.plan(listOf(d("a", ssid = "Same"), d("b", ssid = "Same")), emptyList(), sit(wifiActive = false))
        assertEquals(1, r.steps.size)
        assertEquals(WifiOutcome("b", "failed", "rejected_by_android"), r.outcomes.single())
    }

    @Test fun `a released network is never removed, but a new list with its SSID takes it over`() {
        val managed = listOf(m("old", ssid = "Van", netId = 7).copy(released = true))
        val nothing = WifiPlan.plan(emptyList(), managed, sit(wifiActive = false))
        assertTrue("released means left alone", nothing.steps.isEmpty() && nothing.removalsWaiting.isEmpty())
        // The new screen lists "Van" with another password while the panel is on it: taken over, and it waits.
        val r = WifiPlan.plan(listOf(d("new", ssid = "Van", password = "other")), managed, sit(netId = 7))
        assertTrue(r.steps.isEmpty())
        assertEquals("deferred", r.outcomes.single().state)
        assertEquals(false, r.managed.single().released)
        assertEquals("new", r.managed.single().id)
    }

    @Test fun `of two unclaimed entries with one SSID, the one with the same security is taken over`() {
        // A replaced WPA2 "Van" still waits for its removal; the WPA3 "Van" was deleted on the dashboard and added again.
        val managed = listOf(m("retired:x", ssid = "Van", netId = 5), m("a", ssid = "Van", security = "wpa3", password = "pw-a", netId = 9))
        val r = WifiPlan.plan(listOf(d("new", ssid = "Van", security = "wpa3", password = "pw-a")), managed, sit(mode = WifiModeLogic.OWNER, sdk = 34, wifiActive = false))
        assertEquals("applied", r.outcomes.single().state)
        assertEquals(9, r.managed.single { it.id == "new" }.netId)
        assertTrue("the working configuration is not removed", r.steps.none { it is WifiStep.Remove && it.managed.netId == 9 })
    }

    @Test fun `a second released entry with the SSID does not block the one taken over`() {
        val managed = listOf(m("old1", ssid = "Van", netId = 3).copy(released = true),
            m("old2", ssid = "Van", netId = -1).copy(released = true))
        val r = WifiPlan.plan(listOf(d("new", ssid = "Van", password = "other")), managed, sit(wifiActive = false))
        assertEquals(listOf("new"), r.steps.filterIsInstance<WifiStep.Update>().map { it.desired.id })
        assertTrue(r.outcomes.none { it.reason == "already_configured_by_hand" })
    }

    @Test fun `a leftover suggestion is not in use while the panel is on the saved network that replaced it`() {
        val saved = m("a", ssid = "Van", netId = 4)
        val leftover = m("retired:x", ssid = "Van", netId = -1)
        val s = sit(mode = WifiModeLogic.OWNER, sdk = 34, netId = 4, ssid = "Van")
        assertEquals(false, WifiPlan.inUse(leftover, s, listOf(saved, leftover)))
        assertTrue("on the suggestion itself it is", WifiPlan.inUse(leftover, sit(mode = WifiModeLogic.OWNER, sdk = 34, netId = 12, ssid = "Van"), listOf(saved, leftover)))
        assertTrue(WifiPlan.plan(listOf(d("a", ssid = "Van", password = "password-a")), listOf(saved, leftover), s).steps.single() is WifiStep.Remove)
    }

    @Test fun `a suggestion is never moved over while the panel is on a saved network with its SSID`() {
        // Released saved "Van" (in use) and our suggestion "Van": the move would write over the saved one.
        val managed = listOf(m("old", ssid = "Van", netId = 4).copy(released = true), m("a", ssid = "Van", netId = -1))
        val r = WifiPlan.plan(listOf(d("a", ssid = "Van", password = "password-a")), managed,
            sit(mode = WifiModeLogic.OWNER, sdk = 34, netId = 4, ssid = "Van"))
        assertTrue(r.steps.isEmpty())
        assertEquals("deferred", r.outcomes.single().state)
    }

    // ── network ids after a reboot ────────────────────────────────────────────────────────────────

    private fun saved(netId: Int, ssid: String, security: String? = "wpa2") = WifiSaved(netId, ssid, security)

    @Test fun `after a reboot each entry gets the id Android uses now, found by SSID and security`() {
        // Before: Depot 5, Van 7, Hidden 8. Android numbers them afresh: Office (by hand) 0, Depot 1, Van 2, Hidden 3.
        val managed = listOf(m("depot", ssid = "Depot", netId = 5), m("van", ssid = "Van", netId = 7), m("hidden", ssid = "Hidden", security = "open", netId = 8))
        val now = listOf(saved(0, "Office"), saved(1, "Depot"), saved(2, "Van"), saved(3, "Hidden", "open"), saved(5, "Van", "open"))
        val r = WifiPlan.resolve(managed, now)
        assertEquals(listOf(1, 2, 3), r.map { it.netId })
    }

    @Test fun `after a reboot a removal hits our network, not the one that took over its old id`() {
        val managed = listOf(m("van", ssid = "Van", netId = 5))
        val now = listOf(saved(2, "Van"), saved(5, "AndroidWifi", "open"))
        val r = WifiPlan.plan(emptyList(), WifiPlan.resolve(managed, now), sit(netId = 5, ssid = "AndroidWifi"))
        assertEquals(2, (r.steps.single() as WifiStep.Remove).managed.netId)
    }

    @Test fun `an entry Android no longer has is dropped, a suggestion is left alone`() {
        val managed = listOf(m("gone", netId = 4), m("sugg", netId = -1))
        assertEquals(listOf("sugg"), WifiPlan.resolve(managed, listOf(saved(4, "other"))).map { it.id })
    }

    @Test fun `one saved network belongs to one entry, the live one first`() {
        val managed = listOf(m("retired:x", ssid = "Van", netId = 1), m("old", ssid = "Van", netId = 2).copy(released = true), m("van", ssid = "Van", netId = 3))
        val r = WifiPlan.resolve(managed, listOf(saved(6, "Van")))
        assertEquals(listOf("van"), r.map { it.id })
        assertEquals(6, r.single().netId)
    }

    @Test fun `saved networks Android will not show have unknown ids, and unknown is never the network in use`() {
        val r = WifiPlan.resolve(listOf(m("van", ssid = "Van", netId = 3), m("sugg", netId = -1)), null)
        assertEquals(listOf(WifiPlan.NET_ID_UNKNOWN, -1), r.map { it.netId })
        assertTrue("unknown id, unknown SSID: possibly in use", WifiPlan.inUse(r[0], sit(netId = 3)))
        assertEquals("connected_network_unknown", WifiPlan.waitReason(r[0], sit(netId = 3)))
        assertTrue("the SSID still tells", WifiPlan.inUse(r[0], sit(netId = 3, ssid = "Van")))
    }

    @Test fun `the security of a saved network from its key management`() {
        fun bits(vararg b: Int) = java.util.BitSet().apply { b.forEach { set(it) } }
        assertEquals("wpa2", WifiPlan.securityOf(bits(1), false))
        assertEquals("wpa2", WifiPlan.securityOf(bits(4), false))
        assertEquals("transition mode is not one of our WPA3 networks", "wpa2", WifiPlan.securityOf(bits(1, 8), false))
        assertEquals("wpa3", WifiPlan.securityOf(bits(8), false))
        assertEquals("open", WifiPlan.securityOf(bits(0), false))
        assertNull("WEP", WifiPlan.securityOf(bits(0), true))
        assertNull("enterprise", WifiPlan.securityOf(bits(2, 3), false))
    }

    // ── small helpers ─────────────────────────────────────────────────────────────────────────────

    @Test fun `a 64-hex key goes in raw, a passphrase in quotes`() {
        val hex = "ab".repeat(32)
        assertEquals(hex, WifiPlan.pskForConfig(hex))
        assertEquals("\"correct horse\"", WifiPlan.pskForConfig("correct horse"))
        assertEquals("\"" + "g".repeat(64) + "\"", WifiPlan.pskForConfig("g".repeat(64)))
    }

    @Test fun `the SSID from WifiInfo is unquoted, and a redacted one is unknown`() {
        assertEquals("Depot", WifiPlan.ssidFromWifiInfo("\"Depot\""))
        assertNull(WifiPlan.ssidFromWifiInfo("<unknown ssid>"))
        assertNull(WifiPlan.ssidFromWifiInfo(null))
        assertNull(WifiPlan.ssidFromWifiInfo("0x"))
        assertNull("a hex SSID is not something we compare against", WifiPlan.ssidFromWifiInfo("4465706f74"))
    }
}
