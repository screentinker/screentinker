package com.remotedisplay.player.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.View
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
    /** dispatchGesture and GestureDescription are API 24. On Android 6 the caller falls back to
     *  in-app view dispatch (TouchInjector), which covers the player's own UI. */
    val canDispatchGestures: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N

    fun injectTap(normalizedX: Float, normalizedY: Float) {
        if (!canDispatchGestures) { Log.w(TAG, "injectTap: gesture dispatch needs API 24"); return }
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
        if (!canDispatchGestures) { Log.w(TAG, "injectSwipe: gesture dispatch needs API 24"); return }
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

    // ---- Remote D-pad, switch-access style: move a highlight overlay, tap to select ----
    //
    // ⚠️ WHY IT WORKS THIS WAY. Real key injection is impossible for a non-system app (INJECT_EVENTS is
    // signature-level, not held even by a device owner). Input focus (ACTION_FOCUS) is rejected in touch
    // mode, which is the state a tapped-into screen is in. Accessibility focus (ACTION_ACCESSIBILITY_FOCUS)
    // is refused by many OEM Settings rows (the clickable FrameLayout delegates focus to children) and its
    // highlight often does not render into a screenshot anyway. So the D-pad drives a cursor WE own: each
    // press moves it to the geometrically nearest interactable node and draws a highlight through a
    // TYPE_ACCESSIBILITY_OVERLAY window (which renders on top of every app AND into takeScreenshot, so the
    // operator sees it); select taps that node's centre via dispatchGesture — the one input primitive that
    // works. The cursor resets on a screen change so a stale highlight can never mislead or mis-tap.
    private var cursorRect: Rect? = null
    private var overlayView: View? = null
    private val uiHandler = Handler(Looper.getMainLooper())

    fun pressDpad(keycode: String): Boolean {
        val root = rootInActiveWindow ?: run { Log.w(TAG, "pressDpad: no active window"); return false }

        if (keycode == "KEYCODE_DPAD_CENTER" || keycode == "KEYCODE_ENTER") {
            val c = cursorRect ?: run { Log.w(TAG, "pressDpad: select with no cursor"); return false }
            val m = getScreenMetrics()
            injectTap(c.exactCenterX() / m.widthPixels, c.exactCenterY() / m.heightPixels)
            Log.i(TAG, "pressDpad select -> tap ${c.centerX()},${c.centerY()}")
            // Activating usually navigates to a new screen; drop the highlight so it does not linger at
            // a now-meaningless position, and so the next arrow re-seeds cleanly on whatever appears.
            uiHandler.post { hideCursor() }
            return true
        }

        val candidates = ArrayList<AccessibilityNodeInfo>()
        collectNavigable(root, candidates, 0)
        if (candidates.isEmpty()) { Log.w(TAG, "pressDpad: no navigable nodes on screen"); return false }

        val from = cursorRect ?: run {
            // No cursor yet: seed from the screen edge OPPOSITE the travel direction, so the first
            // press lands on the nearest element as if entering the screen from that edge.
            val m = getScreenMetrics()
            when (keycode) {
                "KEYCODE_DPAD_DOWN"  -> Rect(0, -1, m.widthPixels, 0)
                "KEYCODE_DPAD_UP"    -> Rect(0, m.heightPixels, m.widthPixels, m.heightPixels + 1)
                "KEYCODE_DPAD_RIGHT" -> Rect(-1, 0, 0, m.heightPixels)
                "KEYCODE_DPAD_LEFT"  -> Rect(m.widthPixels, 0, m.widthPixels + 1, m.heightPixels)
                else -> return false
            }
        }

        val next = pickInDirection(from, candidates, keycode)
            ?: run { Log.w(TAG, "pressDpad: nothing ${keycode.removePrefix("KEYCODE_DPAD_")} of cursor"); return false }
        val b = Rect(); next.getBoundsInScreen(b)
        cursorRect = b
        uiHandler.post { showCursor(b) }
        Log.i(TAG, "pressDpad ${keycode.removePrefix("KEYCODE_DPAD_")} -> ${b.centerX()},${b.centerY()}")
        return true
    }

    /** Draw or move the highlight overlay to [bounds]. Main thread only. */
    private fun showCursor(bounds: Rect) {
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val existing = overlayView
        if (existing == null) {
            val v = object : View(this) {
                private val stroke = Paint().apply {
                    style = Paint.Style.STROKE; strokeWidth = 6f
                    color = Color.parseColor("#2563EB"); isAntiAlias = true
                }
                private val fill = Paint().apply {
                    style = Paint.Style.FILL; color = Color.parseColor("#332563EB")
                }
                override fun onDraw(canvas: Canvas) {
                    val r = 4f
                    canvas.drawRect(r, r, width - r, height - r, fill)
                    canvas.drawRect(r, r, width - r, height - r, stroke)
                }
            }
            val lp = WindowManager.LayoutParams(
                bounds.width(), bounds.height(), bounds.left, bounds.top,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT
            ).apply { gravity = Gravity.TOP or Gravity.START }
            try { wm.addView(v, lp); overlayView = v } catch (e: Exception) { Log.w(TAG, "overlay add: ${e.message}") }
        } else {
            val lp = existing.layoutParams as WindowManager.LayoutParams
            lp.x = bounds.left; lp.y = bounds.top; lp.width = bounds.width(); lp.height = bounds.height()
            try { wm.updateViewLayout(existing, lp) } catch (e: Exception) { Log.w(TAG, "overlay move: ${e.message}") }
        }
    }

    /** Public: clear the D-pad highlight from any thread (e.g. when the remote session ends, so the
     *  blue box does not linger over the signage after the operator stops controlling). */
    fun clearDpadCursor() { uiHandler.post { hideCursor() } }

    /** Drop the cursor + highlight (e.g. when the screen changes under it). Main thread only. */
    private fun hideCursor() {
        cursorRect = null
        val v = overlayView ?: return
        overlayView = null
        try { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(v) } catch (_: Exception) {}
    }

    /** Collect visible, enabled, interactable nodes (with a real on-screen box) for directional nav. */
    private fun collectNavigable(node: AccessibilityNodeInfo?, out: ArrayList<AccessibilityNodeInfo>, depth: Int) {
        if (node == null || depth > 40) return
        if (node.isVisibleToUser && node.isEnabled && (node.isClickable || node.isFocusable)) {
            val r = Rect(); node.getBoundsInScreen(r)
            if (r.width() > 0 && r.height() > 0) out.add(node)
        }
        for (i in 0 until node.childCount) collectNavigable(node.getChild(i), out, depth + 1)
    }

    /** The geometrically nearest candidate in the pressed direction: closest along the travel axis,
     *  penalising lateral drift so a press moves to the visually-adjacent element. */
    private fun pickInDirection(from: Rect, candidates: List<AccessibilityNodeInfo>, keycode: String): AccessibilityNodeInfo? {
        val fcx = from.centerX(); val fcy = from.centerY()
        var best: AccessibilityNodeInfo? = null
        var bestScore = Long.MAX_VALUE
        val r = Rect()
        for (c in candidates) {
            c.getBoundsInScreen(r)
            val dx = r.centerX() - fcx; val dy = r.centerY() - fcy
            val adx = Math.abs(dx).toLong(); val ady = Math.abs(dy).toLong()
            val inDir = when (keycode) {
                "KEYCODE_DPAD_DOWN"  -> dy > 0 && ady >= adx
                "KEYCODE_DPAD_UP"    -> dy < 0 && ady >= adx
                "KEYCODE_DPAD_RIGHT" -> dx > 0 && adx >= ady
                "KEYCODE_DPAD_LEFT"  -> dx < 0 && adx >= ady
                else -> false
            }
            if (!inDir) continue
            val vertical = keycode == "KEYCODE_DPAD_DOWN" || keycode == "KEYCODE_DPAD_UP"
            val primary = if (vertical) ady else adx
            val lateral = if (vertical) adx else ady
            val score = primary + lateral * 2   // prefer straight-ahead over diagonal
            if (score in 1 until bestScore) { bestScore = score; best = c }
        }
        return best
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
        hideCursor()
        instance = null
        super.onDestroy()
    }
}
