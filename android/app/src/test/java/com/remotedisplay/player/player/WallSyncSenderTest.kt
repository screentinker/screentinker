package com.remotedisplay.player.player

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** GHSA-rvxj 3.7 (follower half): a follower that knows its leader ignores sync from anyone else. */
class WallSyncSenderTest {
    private fun sync(from: String?) = JSONObject().put("wall_id", "w1").put("current_index", 2).apply { if (from != null) put("device_id", from) }

    @Test fun `known leader - its sync is applied`() {
        assertTrue(WallController.acceptsSyncFrom("lead", sync("lead")))
    }

    @Test fun `known leader - another member's sync is ignored`() {
        assertFalse(WallController.acceptsSyncFrom("lead", sync("other")))
        assertFalse(WallController.acceptsSyncFrom("lead", sync(null)))
    }

    @Test fun `unknown leader (older server) - unchanged behaviour`() {
        assertTrue(WallController.acceptsSyncFrom(null, sync("anyone")))
        assertTrue(WallController.acceptsSyncFrom("", sync("anyone")))
    }
}
