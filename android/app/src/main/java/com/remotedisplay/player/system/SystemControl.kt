package com.remotedisplay.player.system

import android.content.Context
import android.media.AudioManager
import android.provider.Settings
import android.util.Log
import android.view.Window
import android.view.WindowManager
import kotlin.math.roundToInt

/**
 * #160 Track A — system-control capabilities that need NO device owner. Graceful degradation:
 *  - Tier 0 (no permission): media volume, per-window brightness (dims OUR window only).
 *  - Tier 1 (WRITE_SETTINGS granted): system-wide brightness + screen-off timeout.
 *
 * Every setter is best-effort: returns false / no-ops when the capability isn't present and never
 * throws, so an unsupported control degrades cleanly instead of crashing the player.
 */
class SystemControl(private val context: Context) {

    private val audio: AudioManager
        get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    /** Tier-1 gate: whether the operator has granted WRITE_SETTINGS (system brightness/timeout). */
    fun canWriteSettings(): Boolean = try { Settings.System.canWrite(context) } catch (_: Throwable) { false }

    // ---- Tier 0 — no permission -----------------------------------------------------------------

    /** Media (STREAM_MUSIC) volume, [fraction] 0..1. No permission needed. */
    fun setMediaVolume(fraction: Double): Boolean = try {
        val am = audio
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        am.setStreamVolume(AudioManager.STREAM_MUSIC, (fraction.coerceIn(0.0, 1.0) * max).roundToInt(), 0)
        true
    } catch (e: Throwable) { Log.w(TAG, "setMediaVolume: ${e.message}"); false }

    fun getMediaVolume(): Double = try {
        val am = audio
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (max > 0) am.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max else 0.0
    } catch (_: Throwable) { 0.0 }

    /**
     * Per-window brightness, [fraction] 0..1 (dims only OUR window — no permission). A negative
     * value restores "follow system". Needs the Activity [window]; safe to call from the UI thread.
     */
    fun setWindowBrightness(window: Window, fraction: Double): Boolean = try {
        val lp = window.attributes
        lp.screenBrightness =
            if (fraction < 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            else fraction.coerceIn(0.0, 1.0).toFloat()
        window.attributes = lp
        true
    } catch (e: Throwable) { Log.w(TAG, "setWindowBrightness: ${e.message}"); false }

    // ---- Tier 1 — WRITE_SETTINGS ----------------------------------------------------------------

    /**
     * System-wide brightness, [fraction] 0..1 (disables auto-brightness first). Works two ways with
     * no user grant needed on a device owner (setSystemSetting), else via a WRITE_SETTINGS grant.
     */
    fun setSystemBrightness(fraction: Double): Boolean {
        val v = (fraction.coerceIn(0.0, 1.0) * 255).roundToInt().coerceIn(0, 255)
        val policy = com.remotedisplay.player.admin.STPolicy(context)
        if (policy.isDeviceOwner()) {
            policy.setSystemSetting(Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL.toString())
            return policy.setSystemSetting(Settings.System.SCREEN_BRIGHTNESS, v.toString())
        }
        if (!canWriteSettings()) return false
        return try {
            val cr = context.contentResolver
            Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
            Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS, v)
            true
        } catch (e: Throwable) { Log.w(TAG, "setSystemBrightness: ${e.message}"); false }
    }

    /** Screen-off timeout in [ms] (<= 0 = never / Int.MAX_VALUE). Device owner or WRITE_SETTINGS. */
    fun setScreenOffTimeout(ms: Int): Boolean {
        val v = if (ms <= 0) Int.MAX_VALUE else ms
        val policy = com.remotedisplay.player.admin.STPolicy(context)
        if (policy.isDeviceOwner()) return policy.setSystemSetting(Settings.System.SCREEN_OFF_TIMEOUT, v.toString())
        if (!canWriteSettings()) return false
        return try {
            Settings.System.putInt(context.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, v)
            true
        } catch (e: Throwable) { Log.w(TAG, "setScreenOffTimeout: ${e.message}"); false }
    }

    companion object { private const val TAG = "SystemControl" }
}
