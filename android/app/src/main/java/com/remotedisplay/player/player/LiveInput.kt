package com.remotedisplay.player.player

/**
 * The screen's own HDMI INPUT as a playlist item (mime video/hdmi-in, remote_url hdmi://<port>).
 *
 * Verified on a Fire TV Cube 3rd gen (Fire OS 7 / Android 9) with a BrightSign on HDMI IN: an
 * ordinary app — no system permission — lists the input through TvInputManager and plays it in a
 * TvView, full screen or boxed into a zone, with normal views drawn over it.
 *
 * ⚠️ NEVER CAPTURABLE. The picture is a hardware video plane. `screencap` exits 1 while it is on
 * screen and an in-app PixelCopy reads black where it sits, so screenshots, the live view and any
 * re-streaming of it are impossible by design — see LiveInputPlayer for what is shown instead.
 *
 * Pure (no Android types) so the choices are tested on a developer machine (LiveInputTest).
 */
object LiveInput {
    const val MIME = "video/hdmi-in"

    /** How long a freshly tuned input may take to show a picture before it counts as failed. */
    const val TUNE_TIMEOUT_MS = 15_000L

    /** A picture that drops out (cable pulled, source asleep) this long is a fault, not a blip. */
    const val SIGNAL_LOSS_MS = 10_000L

    fun isLiveInput(mimeType: String?): Boolean = mimeType == MIME

    /** hdmi:// -> 0 (the first input), hdmi://2 -> 2, anything else -> null. */
    fun parsePort(url: String?): Int? {
        val m = Regex("""^hdmi://([1-9][0-9]?)?$""", RegexOption.IGNORE_CASE).find(url?.trim() ?: return null) ?: return null
        return m.groupValues[1].toIntOrNull() ?: 0
    }

    /** What the player knows about one TvInputInfo, reduced to what the choice needs. */
    data class Candidate(val id: String, val isHdmi: Boolean, val passthrough: Boolean, val hidden: Boolean, val parentId: String?)

    /**
     * The HARDWARE HDMI inputs, in the order the system lists them. A CEC device behind a port shows
     * up as a second input with that port as its parent (on the Cube: "…/HDMI110008", "Playback_2");
     * it is the same socket, so it is not a separate port and is left out.
     */
    fun hardwareInputs(all: List<Candidate>): List<Candidate> =
        all.filter { it.isHdmi && it.passthrough && !it.hidden && it.parentId == null }

    /** The input for [port] (0 = first), or null when this device has no such input. */
    fun pick(all: List<Candidate>, port: Int): Candidate? {
        val hw = hardwareInputs(all)
        return if (port <= 0) hw.firstOrNull() else hw.getOrNull(port - 1)
    }

    /** States of one tune, and what each callback means for it. */
    enum class Verdict { WAIT, PLAYING, FAULT }

    /**
     * Has an input that is not showing a picture been dark for long enough to give up on it?
     * [darkSinceMs] is when the picture went away (or when tuning began); 0 = it is showing.
     */
    fun verdict(everShown: Boolean, darkSinceMs: Long, nowMs: Long): Verdict {
        if (darkSinceMs == 0L) return Verdict.PLAYING
        val limit = if (everShown) SIGNAL_LOSS_MS else TUNE_TIMEOUT_MS
        return if (nowMs - darkSinceMs >= limit) Verdict.FAULT else Verdict.WAIT
    }
}
