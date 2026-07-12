package com.remotedisplay.player.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.remotedisplay.player.remote.ScreenshotCapture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

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

    private val screenshotExecutor by lazy { Executors.newSingleThreadExecutor() }

    /**
     * #161 "see everything": capture the WHOLE display (system UI + whatever is foreground), base64
     * JPEG, with NO MediaProjection consent dialog — via the AccessibilityService screenshot API
     * (needs canTakeScreenshot in the config + the service enabled; API 30+). Returns null when
     * unavailable (older OS, rate-limited, or failure) so the caller falls back to app-content capture.
     * Blocks up to 2s for the async result (called from the 1fps background stream loop).
     */
    fun captureFullScreen(quality: Int = 40): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return try {
            var out: String? = null
            val latch = CountDownLatch(1)
            takeScreenshot(Display.DEFAULT_DISPLAY, screenshotExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    try {
                        val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        result.hardwareBuffer.close()
                        if (hw != null) {
                            // wrapHardwareBuffer yields a HARDWARE bitmap; copy to software so it can compress.
                            val soft = hw.copy(Bitmap.Config.ARGB_8888, false)
                            hw.recycle()
                            if (soft != null) out = ScreenshotCapture.encode(soft, quality)
                        }
                    } catch (e: Throwable) { Log.w(TAG, "takeScreenshot decode: ${e.message}") }
                    latch.countDown()
                }
                override fun onFailure(errorCode: Int) {
                    Log.w(TAG, "takeScreenshot failed: $errorCode"); latch.countDown()
                }
            })
            latch.await(2, TimeUnit.SECONDS)
            out
        } catch (e: Throwable) { Log.w(TAG, "captureFullScreen: ${e.message}"); null }
    }

    private var lastConfirm = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        // Auto-confirm the system app-update dialog so OTA updates apply unattended
        // on kiosk screens (no one is there to tap "Update"). Scoped to the package
        // installer only, so this never touches anything else.
        if (!pkg.contains("packageinstaller", ignoreCase = true)) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return
        autoConfirmInstall()
    }

    private fun autoConfirmInstall() {
        val now = System.currentTimeMillis()
        if (now - lastConfirm < 1500) return // debounce repeated content events
        val root = rootInActiveWindow ?: return
        // Positive button by resource id first (locale-independent), then by label.
        val ids = listOf(
            "com.google.android.packageinstaller:id/ok_button",
            "com.android.packageinstaller:id/ok_button",
            "android:id/button1"
        )
        for (id in ids) {
            for (n in root.findAccessibilityNodeInfosByViewId(id)) {
                if (clickButton(n)) { lastConfirm = now; Log.i(TAG, "Auto-confirmed install via $id"); return }
            }
        }
        for (label in listOf("Update", "Install", "Reinstall", "Continue")) {
            for (n in root.findAccessibilityNodeInfosByText(label)) {
                if (clickButton(n)) { lastConfirm = now; Log.i(TAG, "Auto-confirmed install via '$label'"); return }
            }
        }
    }

    // Click the node or its nearest clickable+enabled ancestor (the button).
    private fun clickButton(node: AccessibilityNodeInfo?): Boolean {
        var cur = node
        var depth = 0
        while (cur != null && depth < 4) {
            if (cur.isClickable && cur.isEnabled) return cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            cur = cur.parent
            depth++
        }
        return false
    }

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
