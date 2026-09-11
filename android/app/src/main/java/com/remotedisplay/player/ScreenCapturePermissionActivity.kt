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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mediaProjectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mediaProjectionManager.createScreenCaptureIntent(), REQUEST_CODE)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_CODE) {
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

                getSharedPreferences("remote_display", MODE_PRIVATE)
                    .edit().putBoolean("screen_capture_granted", true).apply()
            } else {
                Log.w(TAG, "MediaProjection permission denied")
            }
        }
        finish()
    }
}
