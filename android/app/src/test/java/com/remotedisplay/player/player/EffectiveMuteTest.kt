package com.remotedisplay.player.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression guards for the mute combination. Each silencer alone mutes; nothing mutes only when
 * all are clear; clearing one while another is held stays muted (the trigger-ends-during-talk and
 * talk-ends-on-a-muted-item cases that used to restore full volume).
 */
class EffectiveMuteTest {

    @Test fun `all clear plays`() {
        assertFalse(EffectiveMute.of(itemMuted = false, wallMuted = false, triggerMuted = false, talkMuted = false))
    }

    @Test fun `any single silencer mutes`() {
        assertTrue(EffectiveMute.of(true, false, false, false))
        assertTrue(EffectiveMute.of(false, true, false, false))
        assertTrue(EffectiveMute.of(false, false, true, false))
        assertTrue(EffectiveMute.of(false, false, false, true))
    }

    @Test fun `trigger clearing on an item the operator muted stays muted`() {
        assertTrue(EffectiveMute.of(itemMuted = true, wallMuted = false, triggerMuted = false, talkMuted = false))
    }

    @Test fun `trigger clearing while talk is still active stays muted`() {
        assertTrue(EffectiveMute.of(itemMuted = false, wallMuted = false, triggerMuted = false, talkMuted = true))
    }

    @Test fun `every combination is muted unless all four are clear`() {
        for (bits in 0 until 16) {
            val f = BooleanArray(4) { (bits shr it) and 1 == 1 }
            val m = EffectiveMute.of(f[0], f[1], f[2], f[3])
            if (bits == 0) assertFalse(m) else assertTrue("bits=$bits", m)
        }
    }
}
