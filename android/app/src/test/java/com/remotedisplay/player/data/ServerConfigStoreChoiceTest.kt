package com.remotedisplay.player.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #312 — which preference store a paired display reads its identity from.
 *
 * The old code picked whichever store OPENED. On RK3566 / OP-TEE the Keystore is unreliable right
 * after a cold boot, so a display whose data had gone to the plain store at install time would, on
 * any later boot where the Keystore happened to work, open the EMPTY encrypted store instead:
 * server_url came back blank, the service logged "No server URL configured", and the reconnect
 * backstop had nothing to dial. Silent, and it looked exactly like a networking fault.
 *
 * The rule is now "use the store that actually holds the identity", and this is that rule.
 */
class ServerConfigStoreChoiceTest {

    private fun paired(url: String = "http://srv:3001") =
        StoreChoice.Snapshot(url, "dev-1", "tok-1", true)

    private val empty = StoreChoice.Snapshot("", "", "", false)

    @Test fun `the reported failure - identity in plain, encrypted store empty but openable`() {
        // This is the whole bug: before, the encrypted store opened and won, and the panel went dark.
        assertFalse(StoreChoice.useSecure(secure = empty, plain = paired()))
    }

    @Test fun `a healthy device stays on the encrypted store`() {
        assertTrue(StoreChoice.useSecure(secure = paired(), plain = empty))
    }

    @Test fun `a fresh install has nothing anywhere and still prefers encryption`() {
        assertTrue(StoreChoice.useSecure(secure = empty, plain = empty))
    }

    @Test fun `an unopenable encrypted store falls back, which is the old behaviour and still right`() {
        assertTrue(StoreChoice.useSecure(secure = null, plain = paired()) == false)
        assertFalse(StoreChoice.useSecure(secure = null, plain = empty))
    }

    @Test fun `a partly provisioned store beats an empty one`() {
        // Provisioned but not yet paired: a server URL is still an identity worth keeping.
        val provisioned = StoreChoice.Snapshot("http://srv:3001", "", "", false)
        assertFalse(StoreChoice.useSecure(secure = empty, plain = provisioned))
        assertTrue(StoreChoice.useSecure(secure = provisioned, plain = empty))
    }

    @Test fun `when both hold something, the more complete one wins and ties go to encrypted`() {
        val halfPlain = StoreChoice.Snapshot("http://srv:3001", "dev-1", "", false)
        assertTrue(StoreChoice.useSecure(secure = paired(), plain = halfPlain))
        assertFalse(StoreChoice.useSecure(secure = halfPlain, plain = paired()))
        assertTrue(StoreChoice.useSecure(secure = paired(), plain = paired("http://other:3001")))
    }

    @Test fun `score counts each piece of identity once`() {
        assertTrue(StoreChoice.score(null) == -1)
        assertTrue(StoreChoice.score(empty) == 0)
        assertTrue(StoreChoice.score(paired()) == 4)
    }

    // #312 (write side / sticky flag): the full decision, including "this board's encrypted store
    // has failed before, so stop betting on it".

    @Test fun `a healthy device with a working encrypted store still prefers it`() {
        assertTrue(StoreChoice.preferSecure(secure = paired(), plain = empty, secureEverFailed = false))
    }

    @Test fun `an encrypted store that would not open this boot forces plain`() {
        // secure == null means it did not open or read on this boot.
        assertFalse(StoreChoice.preferSecure(secure = null, plain = paired(), secureEverFailed = false))
    }

    @Test fun `once the encrypted store has ever failed, it is never chosen again`() {
        // Even a fully-populated, currently-openable encrypted store loses when the sticky flag is set:
        // on these boards a store that opens today may not tomorrow, and a dark panel is the cost.
        assertFalse(StoreChoice.preferSecure(secure = paired(), plain = paired(), secureEverFailed = true))
        assertFalse(StoreChoice.preferSecure(secure = paired(), plain = empty, secureEverFailed = true))
    }

    @Test fun `sticky flag clear, the normal content rule still applies`() {
        assertFalse(StoreChoice.preferSecure(secure = empty, plain = paired(), secureEverFailed = false))
        assertTrue(StoreChoice.preferSecure(secure = empty, plain = empty, secureEverFailed = false))
    }
}
