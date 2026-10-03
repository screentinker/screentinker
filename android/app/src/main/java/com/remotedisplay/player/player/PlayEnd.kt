package com.remotedisplay.player.player

/**
 * Did an item actually finish, or was it cut short?
 *
 * ⚠️ THE BUG THIS EXISTS FOR. PlaylistController emitted `play_end` with completed = true on EVERY
 * advance — the literal `true` was passed at the call site, so the flag could not be false however
 * badly playback went. A screen failing every item in about two seconds wrote a perfect run of
 * `completed = 1, duration_sec = 0` rows, and Reports showed 100% completion for content that had
 * never rendered a frame. Observed on a customer instance on 2026-09-28, where 1,393 consecutive
 * rows claimed success while the display showed nothing.
 *
 * That is worse than a missing metric: proof-of-play is what an operator shows an advertiser. A
 * flag that is always true is not a weak signal, it is a false one, and it was being trusted.
 *
 * Kept as a pure object with no Android dependencies for the same reason PlaybackStall and
 * PlaybackFault are: PlaylistController owns a Handler and a Looper and cannot be exercised on the
 * JVM, so the RULE can at least be pinned even where the wiring cannot.
 */
object PlayEnd {

    /**
     * @param faulted the advance was caused by a playback fault (decoder error, or the stall
     *                watchdog giving up) rather than the item reaching its natural end.
     *
     * A fault means the item did not get its turn, whatever the clock says — a video that errors
     * after eight of its ten seconds has not played, it has failed late.
     *
     * Everything else counts as completed. An operator skipping ahead, a playlist republished
     * mid-item and a schedule window closing all cut an item short WITHOUT it having failed, and
     * they are not distinguished here: they are not faults, and reporting them as incomplete would
     * trade one false signal for another. Narrowing further needs the controller to say WHY it
     * advanced, which is a larger change than removing a hardcoded `true`.
     */
    @JvmStatic
    fun completed(faulted: Boolean): Boolean = !faulted
}
