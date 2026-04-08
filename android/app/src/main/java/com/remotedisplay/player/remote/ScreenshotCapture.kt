package com.remotedisplay.player.remote

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ScreenshotCapture {

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Capture the entire view hierarchy including video content.
     * Thread-safe: marshals to main thread if needed.
     */
    fun captureView(view: View, quality: Int = 40): String? {
        return if (Looper.myLooper() == Looper.getMainLooper()) {
            captureOnMainThread(view, quality)
        } else {
            val latch = CountDownLatch(1)
            var result: String? = null
            mainHandler.post {
                result = captureOnMainThread(view, quality)
                latch.countDown()
            }
            latch.await(3, TimeUnit.SECONDS)
            result
        }
    }

    /**
     * Must be called on main thread.
     * Draws the view hierarchy + composites TextureView bitmap for video.
     */
    private fun captureOnMainThread(view: View, quality: Int): String? {
        return try {
            val w = view.width
            val h = view.height
            if (w <= 0 || h <= 0) {
                Log.w("ScreenshotCapture", "View has no size: ${w}x${h}")
                return null
            }

            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)

            // First draw the view hierarchy (gets UI elements, images, overlays)
            // Note: view.draw() renders TextureView areas as black since video
            // is in a separate hardware surface
            view.draw(canvas)

            // Then composite TextureView content (video) ON TOP
            // This replaces the black areas where video should be
            val textureViews = mutableListOf<TextureView>()
            findAllTextureViews(view, textureViews)
            for (tv in textureViews) {
                if (tv.isAvailable && tv.visibility == View.VISIBLE) {
                    val tvBitmap = tv.bitmap
                    if (tvBitmap != null) {
                        val loc = IntArray(2)
                        tv.getLocationInWindow(loc)
                        val rootLoc = IntArray(2)
                        view.getLocationInWindow(rootLoc)
                        val x = (loc[0] - rootLoc[0]).toFloat()
                        val y = (loc[1] - rootLoc[1]).toFloat()
                        val destRect = Rect(x.toInt(), y.toInt(), x.toInt() + tv.width, y.toInt() + tv.height)
                        canvas.drawBitmap(tvBitmap, null, destRect, null)
                        tvBitmap.recycle()
                        Log.d("ScreenshotCapture", "Composited TextureView at ($x,$y) size=${tv.width}x${tv.height}")
                    }
                }
            }

            Log.i("ScreenshotCapture", "Composite capture: ${w}x${h}, ${textureViews.size} TextureView(s)")
            encodeBitmap(bitmap, quality)
        } catch (e: Exception) {
            Log.e("ScreenshotCapture", "Capture failed: ${e.message}", e)
            null
        }
    }

    private fun encodeBitmap(bitmap: Bitmap, quality: Int): String {
        val toEncode = if (bitmap.width > 960) {
            val scale = 960f / bitmap.width
            val h = (bitmap.height * scale).toInt()
            val scaled = Bitmap.createScaledBitmap(bitmap, 960, h, true)
            if (scaled !== bitmap) bitmap.recycle()
            scaled
        } else {
            bitmap
        }
        val stream = ByteArrayOutputStream()
        toEncode.compress(Bitmap.CompressFormat.JPEG, quality, stream)
        val w = toEncode.width
        val h = toEncode.height
        toEncode.recycle()
        val result = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        Log.i("ScreenshotCapture", "Encoded ${w}x${h}, size=${result.length} chars")
        return result
    }

    private fun findAllTextureViews(view: View, result: MutableList<TextureView>) {
        if (view is TextureView) {
            result.add(view)
            return
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                findAllTextureViews(view.getChildAt(i), result)
            }
        }
    }
}
