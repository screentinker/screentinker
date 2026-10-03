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
                        // Place the frame through the SAME transform chain the hierarchy was drawn
                        // with, rather than an axis-aligned rect at getLocationInWindow().
                        //
                        // #236 gave a video-wall panel a mounting rotation, which puts a real
                        // rotation on an ancestor of this TextureView. An axis-aligned rect cannot
                        // express that, so the frame was pasted un-rotated at a position that fell
                        // outside the capture bitmap entirely — and what the dashboard received was
                        // the plain black that view.draw() leaves wherever a TextureView is, i.e. a
                        // panel that looks dead while it is happily playing. Verified on the
                        // emulator: at rotation 90 every remote screenshot of a video came back
                        // #010101 with zero variance, while rotation 0 was correct.
                        val m = matrixTo(tv, view)
                        // The surface bitmap is not required to match the view's size.
                        if (tvBitmap.width > 0 && tvBitmap.height > 0) {
                            m.preScale(tv.width.toFloat() / tvBitmap.width, tv.height.toFloat() / tvBitmap.height)
                        }
                        canvas.drawBitmap(tvBitmap, m, null)
                        tvBitmap.recycle()
                        Log.d("ScreenshotCapture", "Composited TextureView ${tv.width}x${tv.height} via $m")
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

    private fun encodeBitmap(bitmap: Bitmap, quality: Int): String = encode(bitmap, quality)

    companion object {
        /**
         * Degrees every outgoing screenshot is turned so the dashboard sees the native-landscape
         * framebuffer it models (TransitionGeometry.screenshotUprightDeg). 0 on every landscape
         * panel. MainActivity.applyOrientation owns it; the three capture paths (view-draw,
         * MediaProjection, accessibility) all encode through [encode], so it is applied once, here.
         */
        @Volatile var uprightDeg: Int = 0

        // Downscale to max width 960 + JPEG + base64. Shared by the view-capture path, the
        // MediaProjection path (ScreenCaptureService) and the #161 accessibility full-screen path
        // (PowerAccessibilityService.takeScreenshot). Recycles inputs.
        fun encode(bitmap: Bitmap, quality: Int): String {
            val deg = uprightDeg
            val upright = if (deg == 0) bitmap else {
                val m = android.graphics.Matrix().apply { postRotate(deg.toFloat()) }
                val r = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
                if (r !== bitmap) bitmap.recycle()
                r
            }
            val toEncode = if (upright.width > 960) {
                val scale = 960f / upright.width
                val h = (upright.height * scale).toInt()
                val scaled = Bitmap.createScaledBitmap(upright, 960, h, true)
                if (scaled !== upright) upright.recycle()
                scaled
            } else {
                upright
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
    }

    /**
     * The matrix mapping [view]'s own coordinates into [ancestor]'s, by walking up the parent chain
     * and concatenating each step the way the framework does when it draws a child: the child's own
     * matrix (rotation/scale/translation about its pivot) followed by its layout offset.
     *
     * Stops at [ancestor], or at the top of the View chain if it is never reached — a partial chain
     * still places the frame better than ignoring the transform completely.
     */
    private fun matrixTo(view: View, ancestor: View): android.graphics.Matrix {
        val out = android.graphics.Matrix()
        var v: View = view
        while (true) {
            val local = android.graphics.Matrix(v.matrix)     // translationX/Y + rotation about pivot
            local.postTranslate(v.left.toFloat(), v.top.toFloat())
            out.postConcat(local)                             // out = local * out  (child-first)
            val parent = v.parent
            if (parent !is View || parent === ancestor) break
            v = parent
        }
        return out
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
