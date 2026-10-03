package com.remotedisplay.player

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.util.Log
import com.remotedisplay.player.service.LiveVideoService
import com.remotedisplay.player.service.MediaProjectionService

/**
 * Transparent activity that requests MediaProjection permission.
 * Shows a system dialog asking "Start recording?" - user taps "Start now" once.
 */
class ScreenCapturePermissionActivity : Activity() {

    companion object {
        private const val REQUEST_CODE = 1001
        private const val TAG = "ScreenCapturePermission"

        // Store the result intent so the service can use it
        var resultCode: Int = RESULT_CANCELED
            private set
        var resultData: Intent? = null
            private set
        var hasPermission = false
            private set

        /**
         * Re-arm system capture after a restart, if this panel had it and can regrant it silently.
         *
         * ⚠️ WHY: MediaProjection consent does NOT survive the app restarting, and an OTA restarts
         * the app. `screen_capture_granted` has been written since #5 and was NEVER READ, so every
         * update silently dropped a panel from whole-screen capture to drawing only the player's own
         * window — the live view showing "just the playlist" and going blank over Settings, with no
         * error and nothing in the dashboard to say why. Reported by a customer whose two panels both
         * lost it on the same update.
         *
         * ⚠️ GATED ON DEVICE OWNER, deliberately. Requesting raises the system consent dialog, and on
         * a panel that is NOT device-owned that dialog would appear over live signage content with
         * nobody there to dismiss it — worse than the degraded capture it fixes. A device owner is
         * the case where the grant is dialog-free. Everyone else is surfaced in the dashboard
         * instead (capture_mode telemetry) rather than interrupted.
         *
         * Accessibility capture needs none of this and survives updates, which is why it is the
         * path the dashboard recommends.
         */
        /** Set false the first time a restore attempt turns out to raise a visible dialog. */
        private const val PREF_AUTO_RESTORE = "screen_capture_auto_restore"
        /** How long a SILENT grant is allowed to take before we conclude a dialog is on screen. */
        private const val SILENT_GRANT_WINDOW_MS = 1500L

        /**
         * ⚠️ THE PROBE ROLE TRAVELS ON THE LAUNCH INTENT, NOT IN A SHARED FLAG.
         *
         * It was a process-wide `restoreAttempt` boolean, and that was wrong in two ways, both of
         * which broke the LIVE-VIDEO path rather than the restore it was written for. This activity
         * has the default launchMode, so every request starts a NEW instance: a `device:live-publish`
         * arriving while a restore was in flight got its own onCreate, read the flag as still true,
         * and withdrew the OPERATOR'S consent dialog 1500ms later — live video failing to start,
         * silently, for a reason nothing logged. And a denied result never cleared the flag, so one
         * cancelled restore armed the probe over every later request for the life of the process.
         *
         * An extra on the intent cannot be read by a launch that did not carry it.
         */
        private const val EXTRA_PROBE = "silent_restore_probe"

        fun restoreIfPreviouslyGranted(context: Context) {
            try {
                val prefs = context.getSharedPreferences("remote_display", Context.MODE_PRIVATE)
                if (!prefs.getBoolean("screen_capture_granted", false)) return
                if (!prefs.getBoolean(PREF_AUTO_RESTORE, true)) {
                    Log.i(TAG, "system capture was granted before, but a previous restore on this panel " +
                        "raised a visible dialog — not retrying. The dashboard reports capture_mode so an " +
                        "operator can restore it deliberately.")
                    return
                }
                if (!com.remotedisplay.player.admin.STPolicy(context).isDeviceOwner()) {
                    Log.i(TAG, "system capture was granted before but this panel is not device-owned; " +
                        "not raising a consent dialog over live content — the dashboard will show capture_mode=view")
                    return
                }
                // ⚠️ NOT via requestPermission(): it clears pendingLive, so a restore landing while
                // a live publish is being set up would route that grant to the screenshot service
                // and the publish would never start. A restore is the lowest-priority request here —
                // if live video is already asking, leave it alone and let its grant stand.
                if (pendingLive != null) {
                    Log.i(TAG, "a live-video publish is already requesting consent; leaving it to that grant")
                    return
                }
                Log.i(TAG, "attempting a silent re-arm of system capture after restart")
                context.startActivity(Intent(context, ScreenCapturePermissionActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    putExtra(EXTRA_PROBE, true)
                })
            } catch (e: Throwable) {
                Log.w(TAG, "restoreIfPreviouslyGranted: ${e.message}")
            }
        }

        fun requestPermission(context: Context) {
            pendingLive = null
            val intent = Intent(context, ScreenCapturePermissionActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        }

        /**
         * #go2rtc — request MediaProjection consent for the LIVE-VIDEO sender (routes the grant to
         * LiveVideoService, not the screenshot MediaProjectionService). If consent was already
         * granted this session, reuse it and skip the dialog — a signage device grants once.
         */
        data class LiveParams(val serverUrl: String, val deviceId: String, val deviceToken: String, val iceJson: String)
        @Volatile var pendingLive: LiveParams? = null
            private set

        fun requestForLive(context: Context, serverUrl: String, deviceId: String, deviceToken: String, iceJson: String) {
            // ALWAYS request a fresh consent token. A MediaProjection permission result is SINGLE-USE
            // — getMediaProjection() consumes it, so a cached token cannot start a second capture
            // (re-publishing would fail). On a device-owner/signage panel this is dialog-free
            // (PROJECT_MEDIA is auto-allowed), so a fresh grant each publish is cheap and correct.
            pendingLive = LiveParams(serverUrl, deviceId, deviceToken, iceJson)
            val intent = Intent(context, ScreenCapturePermissionActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        }
    }

    /** Whether THIS launch is an automatic restore. Read from the intent, never from shared state. */
    private var isProbe = false
    /** Whether THIS request got its result. ⚠️ NOT Companion.hasPermission, which is sticky across
     *  the whole process: after any earlier grant it reads true forever, so the probe would decide a
     *  dialog it can see on screen had already been answered and leave it parked — the exact failure
     *  the probe exists to prevent. */
    private var resultArrived = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isProbe = intent?.getBooleanExtra(EXTRA_PROBE, false) == true
        val mediaProjectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mediaProjectionManager.createScreenCaptureIntent(), REQUEST_CODE)
        // Only arms for an automatic restore; an operator-initiated request is left to run normally.
        armSilentGrantProbe()
    }

    /**
     * ⚠️ A DEVICE OWNER DOES NOT GUARANTEE A SILENT GRANT. That assumption was wrong and was caught
     * on an emulator: a device-owned panel still raised "Start recording or casting with
     * RemoteDisplay?" and left it sitting over the player with nobody to tap it. Whether
     * PROJECT_MEDIA is auto-allowed is an OEM/build decision, not something isDeviceOwner() implies.
     *
     * So an automatic restore is a PROBE, not a command: if the result has not arrived within
     * SILENT_GRANT_WINDOW_MS a dialog is on screen, so we withdraw it and record that this panel
     * cannot restore silently. It never asks again; the dashboard reports capture_mode instead and
     * an operator restores it deliberately. Cost is one brief dialog, once, per panel.
     *
     * An operator-initiated request (the dashboard button) is NOT a probe and is left alone — the
     * dialog is expected there, and someone is looking at the panel.
     */
    private fun armSilentGrantProbe() {
        if (!isProbe) return
        window.decorView.postDelayed({
            if (!isFinishing && !resultArrived) {
                Log.w(TAG, "silent re-arm did not complete within ${SILENT_GRANT_WINDOW_MS}ms — a consent " +
                    "dialog is on screen. Withdrawing it and disabling automatic restore on this panel.")
                getSharedPreferences("remote_display", MODE_PRIVATE)
                    .edit().putBoolean(PREF_AUTO_RESTORE, false).apply()
                // ⚠️ finish() alone is NOT enough and was verified not to be: the consent dialog is
                // systemui's own activity, started for a result INTO OUR TASK, so finishing this
                // activity leaves the dialog sitting on top of the player exactly as before.
                // finishActivity(requestCode) is the call that ends a child started for a result.
                finishActivity(REQUEST_CODE)
                finish()
            }
        }, SILENT_GRANT_WINDOW_MS)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_CODE) {
            // Before any branch: the probe asks "did THIS request get an answer", and a denial is
            // an answer. Recording it only on success is what left the old flag armed forever.
            resultArrived = true
            if (resultCode == RESULT_OK && data != null) {
                Log.i(TAG, "MediaProjection permission granted, starting via service")

                // Store the result so the service can create the projection
                Companion.resultCode = resultCode
                Companion.resultData = data?.clone() as? Intent
                Companion.hasPermission = true

                // #5 / #go2rtc: hand the consent to the right mediaProjection foreground service.
                // It must enter the foreground with the mediaProjection FGS type BEFORE
                // getMediaProjection() on Android 14+ - an Activity can't do that here.
                val live = pendingLive
                if (live != null) {
                    pendingLive = null
                    LiveVideoService.start(this, resultCode, data.clone() as Intent,
                        live.serverUrl, live.deviceId, live.deviceToken, live.iceJson)
                } else {
                    MediaProjectionService.start(this, resultCode, data)
                }

                getSharedPreferences("remote_display", MODE_PRIVATE).edit()
                    .putBoolean("screen_capture_granted", true)
                    // A result that arrived inside the probe window means this panel grants silently,
                    // so keep automatic restore on. Outside it, the probe has already turned it off.
                    .apply()
            } else {
                Log.w(TAG, "MediaProjection permission denied")
            }
        }
        finish()
    }
}
