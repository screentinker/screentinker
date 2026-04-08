package com.remotedisplay.player.service

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.io.ByteArrayOutputStream

/**
 * Manages MediaProjection for system-wide screenshot capture.
 * Works even when our app is in the background.
 */
object ScreenCaptureService {
    private const val TAG = "ScreenCapture"

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null

    val isReady: Boolean get() = mediaProjection != null && imageReader != null

    /**
     * Start the projection from a context that has a foreground service running.
     */
    fun startProjection(context: Context, resultCode: Int, data: Intent) {
        stop()

        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = manager.getMediaProjection(resultCode, data)
        if (projection == null) {
            Log.e(TAG, "Failed to get MediaProjection")
            return
        }

        mediaProjection = projection

        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)

        val captureWidth = 960
        val captureHeight = (metrics.heightPixels * (960f / metrics.widthPixels)).toInt()
        val density = metrics.densityDpi

        imageReader = ImageReader.newInstance(captureWidth, captureHeight, PixelFormat.RGBA_8888, 4)

        virtualDisplay = projection.createVirtualDisplay(
            "ScreenTinker",
            captureWidth, captureHeight, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader!!.surface, null, null
        )

        projection.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                Log.i(TAG, "MediaProjection stopped by system")
                cleanup()
            }
        }, null)

        Log.i(TAG, "MediaProjection started: ${captureWidth}x${captureHeight}")
    }

    /**
     * Capture current screen as base64 JPEG.
     */
    @Synchronized
    fun captureScreen(quality: Int = 40): String? {
        val reader = imageReader ?: return null

        var image: android.media.Image? = null
        return try {
            image = reader.acquireLatestImage() ?: return null
            val plane = image.planes[0]
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * image.width
            val imgWidth = image.width
            val imgHeight = image.height

            val bitmapWidth = imgWidth + rowPadding / pixelStride
            val bitmap = Bitmap.createBitmap(bitmapWidth, imgHeight, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(buffer)
            image.close()
            image = null

            // Crop to actual width (remove row padding)
            val cropped = if (bitmapWidth > imgWidth) {
                val c = Bitmap.createBitmap(bitmap, 0, 0, imgWidth, imgHeight)
                bitmap.recycle()
                c
            } else bitmap

            val stream = ByteArrayOutputStream()
            cropped.compress(Bitmap.CompressFormat.JPEG, quality, stream)
            cropped.recycle()

            Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.e(TAG, "Capture failed: ${e.message}")
            null
        } finally {
            try { image?.close() } catch (_: Exception) {}
        }
    }

    private fun cleanup() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
    }

    fun stop() {
        cleanup()
        try { mediaProjection?.stop() } catch (_: Exception) {}
        mediaProjection = null
    }
}
