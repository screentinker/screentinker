package com.remotedisplay.player

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.util.Log
import com.remotedisplay.player.service.ScreenCaptureService

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

                // Tell the service to start the projection
                ScreenCaptureService.startProjection(this, resultCode, data)

                getSharedPreferences("remote_display", MODE_PRIVATE)
                    .edit().putBoolean("screen_capture_granted", true).apply()
            } else {
                Log.w(TAG, "MediaProjection permission denied")
            }
        }
        finish()
    }
}
