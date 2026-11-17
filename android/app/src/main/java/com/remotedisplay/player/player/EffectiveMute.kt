package com.remotedisplay.player.player

/**
 * The one rule for whether the base content may make a sound.
 *
 * ⚠️ Four independent silencers with different lifetimes: the ITEM's own mute (operator flag or the
 * live dashboard toggle), a WALL follower (permanent while following), a TRIGGER overlay (for the
 * alarm's duration) and a TALK/share duck (for the call). Each is held as its own flag and the
 * effective mute is derived here every time a volume is decided, so clearing one can never undo
 * another — and a derived value is never written back into the item's own flag.
 */
object EffectiveMute {
    fun of(itemMuted: Boolean, wallMuted: Boolean, triggerMuted: Boolean, talkMuted: Boolean): Boolean =
        itemMuted || wallMuted || triggerMuted || talkMuted
}
