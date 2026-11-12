package com.remotedisplay.player.player

import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sin

/**
 * The "Now serving" queue chime (docs/now-serving-queue.md), on Android.
 *
 * The queue widget asks its player to chime once per called number. The web player hears that as a
 * postMessage from the widget's iframe (server/player/index.html playQueueChime). Android mounts a
 * widget as the WebView's TOP-LEVEL page, so there is no parent to tell: the page calls the
 * [BRIDGE] JavaScript interface instead (server/lib/queue/widget.js chime()).
 *
 * Same contract as the web player:
 *  - one short sound of two tones (880 Hz then 660 Hz, ~0.9 s), synthesised, never looped;
 *  - honoured only while the screen may be heard: not on a wall follower, not under a trigger
 *    alarm or a talk/PA call, not when the item showing the widget is muted (the caller decides);
 *  - at most one chime per [MIN_GAP_MS], so a burst of calls is one chime, never a run;
 *  - volume 0..1 from the widget's own setting, then the device's media volume on top (the sound
 *    plays as media, so the system volume applies by itself). 0 plays nothing.
 *
 * Pure (no Android types), so the rules are pinned by QueueChimeTest on the JVM.
 */
object QueueChime {
    /** The JavaScript interface name the widget page looks for. */
    const val BRIDGE = "STQueueChime"

    /** A burst of calls inside this window is one chime (the web player's 3 s). */
    const val MIN_GAP_MS = 3_000L

    /** The widget's default when it sends nothing usable (the web player's 0.6). */
    const val DEFAULT_VOLUME = 0.6f

    const val SAMPLE_RATE = 44_100

    /** The two tones: frequency (Hz), start (s), length (s). Identical to the web player. */
    val TONES = listOf(Triple(880.0, 0.0, 0.35), Triple(660.0, 0.38, 0.5))

    /** The widget's volume as 0..1. Anything that is not a finite number falls back to [DEFAULT_VOLUME]. */
    fun volume(raw: String?): Float {
        val v = raw?.trim()?.toFloatOrNull() ?: return DEFAULT_VOLUME
        if (!v.isFinite()) return DEFAULT_VOLUME
        return v.coerceIn(0f, 1f)
    }

    /** Whether a widget mounted at [url] may ask for a chime: only a widget render page. */
    fun isWidgetPage(url: String?): Boolean =
        url != null && Regex("^https?://[^?#]+/api/widgets/[^/?#]+/render(?:[?#]|$)").containsMatchIn(url)

    /** At most one chime per [gapMs]. [clock] is injectable for tests. */
    class Gate(private val gapMs: Long = MIN_GAP_MS, private val clock: () -> Long = System::currentTimeMillis) {
        private var last = Long.MIN_VALUE
        fun admit(): Boolean {
            val now = clock()
            if (last != Long.MIN_VALUE && now - last < gapMs) return false
            last = now
            return true
        }
    }

    /**
     * The chime as 16-bit mono PCM at [sampleRate]: each tone rises in 20 ms and decays
     * exponentially to silence, like the web player's gain ramps (0.0001 -> 0.5*v -> 0.0001).
     * [volume] 0 gives silence; the caller skips playing it.
     */
    fun synth(volume: Float, sampleRate: Int = SAMPLE_RATE): ShortArray {
        val v = volume.coerceIn(0f, 1f).toDouble()
        val total = TONES.maxOf { it.second + it.third } + 0.05
        val out = DoubleArray((total * sampleRate).toInt())
        if (!(v > 0.0)) return ShortArray(out.size)
        val floor = 0.0001
        val peak = maxOf(0.0002, 0.5 * v)
        for ((freq, at, len) in TONES) {
            val start = (at * sampleRate).toInt()
            val n = (len * sampleRate).toInt()
            val attack = (0.02 * sampleRate).toInt()
            for (i in 0 until n) {
                val idx = start + i
                if (idx >= out.size) break
                val g = if (i < attack) {
                    floor * exp(ln(peak / floor) * i / attack)
                } else {
                    peak * exp(ln(floor / peak) * (i - attack).toDouble() / (n - attack))
                }
                out[idx] += g * sin(2 * PI * freq * i / sampleRate)
            }
        }
        return ShortArray(out.size) { (out[it].coerceIn(-1.0, 1.0) * Short.MAX_VALUE).toInt().toShort() }
    }
}
