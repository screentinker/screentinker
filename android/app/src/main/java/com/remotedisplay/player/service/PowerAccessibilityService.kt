package com.remotedisplay.player.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent

class PowerAccessibilityService : AccessibilityService() {

    companion object {
        var instance: PowerAccessibilityService? = null
        private const val TAG = "AccessibilityService"
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "Service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    // Global actions
    fun showPowerDialog() {
        Log.i(TAG, "Showing power dialog")
        performGlobalAction(GLOBAL_ACTION_POWER_DIALOG)
    }

    fun pressHome() {
        Log.i(TAG, "Home")
        performGlobalAction(GLOBAL_ACTION_HOME)
    }

    fun pressBack() {
        Log.i(TAG, "Back")
        performGlobalAction(GLOBAL_ACTION_BACK)
    }

    fun openRecents() {
        Log.i(TAG, "Recents")
        performGlobalAction(GLOBAL_ACTION_RECENTS)
    }

    fun openNotifications() {
        Log.i(TAG, "Notifications")
        performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
    }

    fun lockScreen() {
        Log.i(TAG, "Lock screen")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
        }
    }

    /**
     * Inject a tap at normalized coordinates (0.0-1.0) using dispatchGesture.
     * Works system-wide - can tap on system dialogs, other apps, etc.
     */
    fun injectTap(normalizedX: Float, normalizedY: Float) {
        val metrics = getScreenMetrics()
        val x = normalizedX * metrics.widthPixels
        val y = normalizedY * metrics.heightPixels
        Log.i(TAG, "Tap at (${x.toInt()}, ${y.toInt()}) screen=${metrics.widthPixels}x${metrics.heightPixels}")

        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 50)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(gesture, null, null)
    }

    /**
     * Inject a swipe gesture at normalized coordinates.
     */
    fun injectSwipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 300) {
        val metrics = getScreenMetrics()
        val sx = startX * metrics.widthPixels
        val sy = startY * metrics.heightPixels
        val ex = endX * metrics.widthPixels
        val ey = endY * metrics.heightPixels

        val path = Path().apply {
            moveTo(sx, sy)
            lineTo(ex, ey)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchGesture(gesture, null, null)
    }

    /**
     * Inject a key event via shell command. Falls back gracefully.
     */
    fun injectKey(keyCode: Int) {
        Log.i(TAG, "Key: $keyCode")
        Thread {
            try {
                Runtime.getRuntime().exec(arrayOf("input", "keyevent", "$keyCode")).waitFor()
            } catch (e: Exception) {
                Log.w(TAG, "Key inject failed: ${e.message}")
            }
        }.start()
    }

    private fun getScreenMetrics(): DisplayMetrics {
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        return metrics
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }
}
