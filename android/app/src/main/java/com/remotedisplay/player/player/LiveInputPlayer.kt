package com.remotedisplay.player.player

import android.content.Context
import android.media.tv.TvContract
import android.media.tv.TvInputInfo
import android.media.tv.TvInputManager
import android.media.tv.TvView
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import com.remotedisplay.player.util.DebugLog

/**
 * Plays the screen's HDMI input in a TvView (see LiveInput for what was verified and why it can
 * never be captured). One per surface: the fullscreen player owns one, each zone that shows an input
 * owns its own. Main thread only.
 *
 * [onFault] is the same contract as a video error: the input could not be opened, or its picture
 * went away and stayed away (LiveInput.verdict). The playlist then skips it exactly as it skips a
 * dead stream, so a cable box that is switched off never holds the screen on black.
 */
class LiveInputPlayer(
    private val context: Context,
    private val container: ViewGroup,
    private val indexInContainer: Int = 0,
    private val onFault: (reason: String) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var tv: TvView? = null
    private var tunedId: String? = null
    private var everShown = false
    private var darkSince = 0L
    private var generation = 0
    private val watchdog = Runnable { check() }

    val isActive: Boolean get() = tunedId != null

    /** Tune [url] (hdmi://<port>) and show it. Returns false when there is no such input here. */
    fun play(url: String, muted: Boolean): Boolean {
        val port = LiveInput.parsePort(url)
        val target = port?.let { pickInput(context, it) }
        if (target == null) {
            DebugLog.w(TAG, "no HDMI input for $url on this device")
            return false
        }
        val view = tv ?: TvView(context).also {
            container.addView(it, indexInContainer.coerceIn(0, container.childCount),
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            tv = it
        }
        view.visibility = View.VISIBLE
        val gen = ++generation
        val retune = tunedId != target
        if (retune) { everShown = false; darkSince = System.currentTimeMillis() }
        view.setCallback(object : TvView.TvInputCallback() {
            override fun onVideoAvailable(inputId: String) { if (gen == generation) { everShown = true; darkSince = 0L } }
            override fun onVideoUnavailable(inputId: String, reason: Int) {
                if (gen == generation && darkSince == 0L) darkSince = System.currentTimeMillis()
                DebugLog.w(TAG, "picture unavailable on $inputId (reason $reason)")
            }
            override fun onConnectionFailed(inputId: String) { if (gen == generation) fault("connection failed") }
            override fun onDisconnected(inputId: String) { if (gen == generation) fault("disconnected") }
        })
        // The same input re-shown (a one-item playlist coming round) keeps its session and its
        // signal state: no re-tune flash, and a source that is dark stays on the clock that began
        // when it went dark — restarting it on every re-show would hold the screen on black forever.
        if (retune) {
            DebugLog.i(TAG, "tuning $url -> $target")
            view.tune(target, TvContract.buildChannelUriForPassthroughInput(target))
            tunedId = target
        }
        setMuted(muted)
        arm()
        return true
    }

    fun setMuted(muted: Boolean) {
        try { tv?.setStreamVolume(if (muted) 0f else 1f) } catch (_: Throwable) {}
    }

    /** Release the input (another item is taking the surface). */
    fun stop() {
        generation++
        handler.removeCallbacks(watchdog)
        tv?.let { v ->
            try { v.reset() } catch (_: Throwable) {}
            v.visibility = View.GONE
        }
        tunedId = null
    }

    fun release() {
        stop()
        tv?.let { try { container.removeView(it) } catch (_: Throwable) {} }
        tv = null
    }

    private fun arm() {
        handler.removeCallbacks(watchdog)
        handler.postDelayed(watchdog, 1_000L)
    }

    private fun check() {
        if (tunedId == null) return
        when (LiveInput.verdict(everShown, darkSince, System.currentTimeMillis())) {
            LiveInput.Verdict.FAULT -> fault(if (everShown) "signal lost" else "no picture after tuning")
            else -> arm()
        }
    }

    private fun fault(reason: String) {
        DebugLog.w(TAG, "live input fault: $reason ($tunedId)")
        stop()
        onFault(reason)
    }

    companion object {
        private const val TAG = "LiveInput"

        private fun candidates(context: Context): List<LiveInput.Candidate> {
            val tim = context.getSystemService(Context.TV_INPUT_SERVICE) as? TvInputManager ?: return emptyList()
            return try {
                tim.tvInputList.map { i: TvInputInfo ->
                    LiveInput.Candidate(
                        id = i.id,
                        isHdmi = i.type == TvInputInfo.TYPE_HDMI,
                        passthrough = i.isPassthroughInput,
                        hidden = try { i.isHidden(context) } catch (_: Throwable) { false },
                        parentId = i.parentId,
                    )
                }
            } catch (t: Throwable) { emptyList() }
        }

        fun pickInput(context: Context, port: Int): String? = LiveInput.pick(candidates(context), port)?.id

        /** Does this device have an HDMI input an app can play? (PlayerCapabilities: playback.hdmi_in) */
        fun deviceHasInput(context: Context): Boolean = LiveInput.hardwareInputs(candidates(context)).isNotEmpty()
    }
}
