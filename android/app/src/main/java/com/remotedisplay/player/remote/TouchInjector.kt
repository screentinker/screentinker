package com.remotedisplay.player.remote

import android.util.Log
import android.view.View

class TouchInjector {

    /**
     * Injects a tap at normalized coordinates (0.0 to 1.0) using shell `input tap`.
     * Works system-wide - can interact with system dialogs, other apps, etc.
     */
    fun injectTap(view: View, normalizedX: Float, normalizedY: Float) {
        val metrics = view.context.resources.displayMetrics
        val screenW = metrics.widthPixels
        val screenH = metrics.heightPixels
        val x = (normalizedX * screenW).toInt()
        val y = (normalizedY * screenH).toInt()
        Log.i("TouchInjector", "Tap at ($x, $y) from normalized ($normalizedX, $normalizedY) screen=${screenW}x${screenH}")
        Thread {
            try {
                Runtime.getRuntime().exec(arrayOf("input", "tap", "$x", "$y")).waitFor()
            } catch (e: Exception) {
                Log.e("TouchInjector", "Tap injection failed: ${e.message}")
            }
        }.start()
    }

    fun injectDown(view: View, normalizedX: Float, normalizedY: Float) {
        val metrics = view.context.resources.displayMetrics
        val x = (normalizedX * metrics.widthPixels).toInt()
        val y = (normalizedY * metrics.heightPixels).toInt()
        Thread {
            try {
                Runtime.getRuntime().exec(arrayOf("input", "swipe", "$x", "$y", "$x", "$y", "2000")).waitFor()
            } catch (e: Exception) {
                Log.e("TouchInjector", "Touch down failed: ${e.message}")
            }
        }.start()
    }

    fun injectMove(view: View, normalizedX: Float, normalizedY: Float) {
        // Shell input doesn't support continuous move well - swipe is the closest
    }

    fun injectUp(view: View, normalizedX: Float, normalizedY: Float) {
        // Shell input tap is atomic - up is handled by tap/swipe completion
    }
}
