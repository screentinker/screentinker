package com.remotedisplay.player.util

/**
 * Who owns a callback slot on the long-lived WebSocketService?
 *
 * ⚠️ Several Activities assign the same fields (onUnpaired, onRegistered, …) and the service outlives
 * all of them. An Activity tearing down must release ONLY the callback it installed: by the time its
 * onDestroy runs, the next Activity has often already bound and installed its own, and nulling the
 * field outright silently disconnects that one (#508). Identity, not equality — two lambdas from the
 * same source line are still different callbacks.
 */
object CallbackOwnership {
    /** True when [current] is exactly the callback [mine] that the caller installed. */
    fun isOwn(current: Any?, mine: Any?): Boolean = mine != null && current === mine
}
