package com.remotedisplay.player.trigger

/**
 * What the state machine needs from a renderer, and nothing more.
 *
 * ⚠️ An interface rather than a direct dependency on TriggerOverlay for a concrete reason: the
 * overlay needs an Android Context and a view hierarchy, so a TriggerManager typed against it
 * cannot be constructed in a JVM unit test — and the arbitration logic would then be exactly the
 * part with no coverage. That is how the web player shipped a fire path whose only interaction with
 * the renderer was stubbed out, leaving the one thing that decides whether anything appears on
 * screen untested behind a green suite.
 *
 * ⚠️ `show` RETURNS A BOOLEAN and the contract is load-bearing. Arbitration pushes the outgoing
 * trigger onto the held list BEFORE calling it, so a renderer that silently declines leaves the
 * previous trigger both active and held — and clearing it fires it straight back, which an operator
 * experiences as the alarm they just cleared reappearing on its own.
 */
interface TriggerRenderer {
    /** @return false if nothing could be rendered — the trigger did NOT fire. */
    fun show(trigger: TriggerResolve.Trigger): Boolean
    fun hide()

    /**
     * #845: the state machine has finished an operation (a verdict, a lease sweep, a stop). Whatever
     * show/hide calls it made are all queued by now, so this is the one point where "is an overlay on
     * screen" is settled; see TriggerPresence. Optional: a renderer that reports nothing ignores it.
     */
    fun settled() {}
}
