package com.remotedisplay.player.trigger

/**
 * #845: "is a trigger overlay on screen", reported to whoever must give way to it (the screen share
 * overlay, its meeting-room code and its sound: ScreenShareBus.suppress). The Android half of the web
 * player's `STScreenShare.suppress(!!triggerActive)` call in triggerSyncAudio.
 *
 * The rule that keeps a supersede (or a clear that restores a held trigger) from flashing the share
 * for a frame:
 *  - it RISES at once, the moment an overlay box is on screen ([shown]), so an alert is never drawn
 *    under a share, not even for one frame;
 *  - it FALLS only at a settled point ([settle]), after the state machine has finished the whole
 *    operation (TriggerManager calls TriggerRenderer.settled() after every verdict, sweep and stop).
 *    A hide immediately followed by the next show therefore never reports "off" in between.
 *
 * No Android in here so the JVM tests (TriggerPresenceTest) can hold it to that. Main thread only.
 */
class TriggerPresence(private val onChange: (Boolean) -> Unit) {
    var on: Boolean = false
        private set

    /** An overlay box was just put on screen. */
    fun shown() = set(true)

    /** The operation is over: [showing] is whether an overlay box is on screen now. */
    fun settle(showing: Boolean) = set(showing)

    private fun set(v: Boolean) {
        if (v == on) return
        on = v
        onChange(v)
    }
}
