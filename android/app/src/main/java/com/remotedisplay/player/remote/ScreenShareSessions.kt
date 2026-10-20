package com.remotedisplay.player.remote

/**
 * 3.0 screen share, several presenters at once — the controller's BOOKKEEPING, with no Android or
 * WebRTC in it so the JVM tests (ScreenShareSessionsTest) can hold it to the web receiver's rules
 * (server/lib/screen-share-player.js: sessions{} + order[], MAX_TILES, layoutState):
 *
 *  - sessions in start order, oldest first; a start beyond [ScreenShareProtocol.MAX_TILES] hands back
 *    the OLDEST to be stopped with reason "replaced" (and forgets them at once, so they never count
 *    again);
 *  - a session is forgotten when it has ENDED (its receiver's onEnded), not when it is asked to stop,
 *    and only by the very value that was added under that id — a late end of an evicted receiver can
 *    never forget a newer one;
 *  - the last layout is remembered, so a later start is laid out right, and reset when the last
 *    session is gone (web: layoutState = {spotlight: null, audio: null}).
 *
 * Not thread-safe: the controller touches it on the main thread only.
 */
class ScreenShareSessions<R : Any> {
    private val byId = LinkedHashMap<String, R>()

    var layout: ScreenShareProtocol.Layout = ScreenShareProtocol.Layout.NONE

    /** Session ids, oldest first. */
    val order: List<String> get() = byId.keys.toList()
    val isEmpty: Boolean get() = byId.isEmpty()
    val size: Int get() = byId.size
    operator fun contains(id: String): Boolean = id in byId
    operator fun get(id: String): R? = byId[id]
    fun entries(): List<Pair<String, R>> = byId.entries.map { it.key to it.value }

    /**
     * Add session [id] (newest). Returns the values to stop with "replaced" to make room — already
     * forgotten here. A duplicate id is the caller's to refuse first (web: start() returns when
     * sessions[id] exists); here it is ignored and nothing is replaced.
     */
    fun add(id: String, value: R): List<R> {
        if (id in byId) return emptyList()
        val out = ScreenShareProtocol.toReplace(order).mapNotNull { byId.remove(it) }
        byId[id] = value
        return out
    }

    /**
     * Session [id] has ended. True when it was still counted (and was [value]); the caller un-ducks
     * when this is true and [isEmpty] — the playlist comes back with the LAST share gone.
     */
    fun ended(id: String, value: R): Boolean {
        if (byId[id] !== value) return false
        byId.remove(id)
        if (byId.isEmpty()) layout = ScreenShareProtocol.Layout.NONE
        return true
    }

    /** device:screenshare-stop: with an id only that session (if ours), without every session. */
    fun stopTargets(stopId: String?): List<R> =
        if (stopId.isNullOrEmpty()) byId.values.toList() else listOfNotNull(byId[stopId])

    fun visibleIds(): List<String> = ScreenShareProtocol.visibleIds(order, layout)
    fun audioId(): String? = ScreenShareProtocol.audioId(order, layout)
}
