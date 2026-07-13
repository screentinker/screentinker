package com.remotedisplay.player.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URL

/**
 * Safe bitmap loader. Reads dimensions first via inJustDecodeBounds, then decodes
 * with an inSampleSize that scales the image down to the device's screen resolution.
 * A 4K source image on a 1080p screen ends up as 1920x1080, not 3840x2160 — keeps
 * the bitmap under ~8 MB instead of ~33 MB.
 *
 * #170: BitmapFactory ignores EXIF orientation, so a portrait photo (landscape pixels
 * tagged "rotate 90") would render sideways. We apply the EXIF rotation after decode.
 * (The server-side ingest fix corrects stored dimensions + the thumbnail; this is the
 * companion so the panel itself draws the photo upright — videos are already handled by
 * ExoPlayer's rotation matrix.)
 *
 * All exceptions, including OutOfMemoryError, return null so the caller can skip the
 * item rather than crashing the whole app.
 */
object ImageLoader {
    private const val TAG = "ImageLoader"

    fun screenWidth(ctx: Context): Int = ctx.resources.displayMetrics.widthPixels
    fun screenHeight(ctx: Context): Int = ctx.resources.displayMetrics.heightPixels

    fun decodeFile(file: File, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                Log.w(TAG, "Invalid image dimensions for ${file.name}")
                return null
            }
            val opts = BitmapFactory.Options().apply {
                inSampleSize = calcSampleSize(bounds.outWidth, bounds.outHeight, maxW, maxH)
            }
            val bmp = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
            // #170: honor EXIF orientation (read from the file; JPEGs from phones carry it).
            val orientation = try {
                ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (e: Throwable) { ExifInterface.ORIENTATION_NORMAL }
            applyExifOrientation(bmp, orientation)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM decoding ${file.name}: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to decode ${file.name}: ${e.message}")
            null
        }
    }

    fun decodeUrl(url: String, maxW: Int, maxH: Int): Bitmap? {
        // Reject anything that isn't HTTP/HTTPS. URL.openConnection() otherwise
        // happily handles file://, jar:, ftp:, etc. — which would let a server-supplied
        // remote_url read local files off the device or talk to internal services.
        val scheme = try { URL(url).protocol?.lowercase() } catch (_: Throwable) { null }
        if (scheme != "http" && scheme != "https") {
            Log.w(TAG, "Rejecting non-http(s) URL scheme: $scheme")
            return null
        }
        return try {
            val bytes = URL(url).openConnection().apply {
                connectTimeout = 10_000
                readTimeout = 30_000
            }.getInputStream().use { it.readBytes() }
            decodeBytes(bytes, maxW, maxH)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM downloading $url: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to download $url: ${e.message}")
            null
        }
    }

    private fun decodeBytes(bytes: ByteArray, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            val opts = BitmapFactory.Options().apply {
                inSampleSize = calcSampleSize(bounds.outWidth, bounds.outHeight, maxW, maxH)
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
            // #170: honor EXIF orientation for remote images too (ExifInterface(stream) is API 24+).
            val orientation = try {
                ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (e: Throwable) { ExifInterface.ORIENTATION_NORMAL }
            applyExifOrientation(bmp, orientation)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM decoding ${bytes.size} bytes: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to decode ${bytes.size} bytes: ${e.message}")
            null
        }
    }

    private fun calcSampleSize(srcW: Int, srcH: Int, maxW: Int, maxH: Int): Int {
        if (maxW <= 0 || maxH <= 0) return 1
        var sample = 1
        while (srcW / sample > maxW || srcH / sample > maxH) sample *= 2
        return sample
    }

    // #170: rotate/flip a just-decoded bitmap per its EXIF orientation so portrait photos
    // render upright. Returns the input unchanged for NORMAL/UNDEFINED (no allocation), and
    // recycles the source once a transformed copy is made. Falls back to the source on OOM
    // rather than crashing — a sideways image beats a dead player.
    private fun applyExifOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.setRotate(270f); m.postScale(-1f, 1f) }
            else -> return bitmap // NORMAL, UNDEFINED, or unknown -> leave as-is
        }
        return try {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
            if (rotated != bitmap) bitmap.recycle()
            rotated
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM applying EXIF orientation $orientation: ${e.message}")
            bitmap
        }
    }
}
