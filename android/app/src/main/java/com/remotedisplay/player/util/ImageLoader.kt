package com.remotedisplay.player.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URL

/**
 * Safe bitmap loader. Reads dimensions first via inJustDecodeBounds, then decodes
 * with an inSampleSize that scales the image down towards the box it is shown in (see
 * calcSampleSize). A 4K source image on a 1080p screen ends up as 1920x1080, not
 * 3840x2160 — keeps the bitmap under ~8 MB instead of ~33 MB.
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
            // #170: honor EXIF orientation (read from the file; JPEGs from phones carry it).
            val orientation = try {
                ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (e: Throwable) { ExifInterface.ORIENTATION_NORMAL }
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sampleFor(bounds, orientation, maxW, maxH)
            }
            val bmp = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
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

    // ExifInterface(InputStream) is API 24. Android 6 (API 23) only has the file-path constructor, so
    // below N the bytes go through a temp file in the app cache (java.io.tmpdir on Android); the
    // orientation is read the same way and the file is removed at once. Any failure reads as NORMAL.
    private fun exifOrientation(bytes: ByteArray): Int = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } else {
            val tmp = File.createTempFile("exif", ".img")
            try {
                tmp.writeBytes(bytes)
                ExifInterface(tmp.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } finally { tmp.delete() }
        }
    } catch (e: Throwable) { ExifInterface.ORIENTATION_NORMAL }

    private fun decodeBytes(bytes: ByteArray, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            // #170: honor EXIF orientation for remote images too.
            val orientation = exifOrientation(bytes)
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sampleFor(bounds, orientation, maxW, maxH)
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
            applyExifOrientation(bmp, orientation)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM decoding ${bytes.size} bytes: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to decode ${bytes.size} bytes: ${e.message}")
            null
        }
    }

    /*
     * ⚠️ THE DECODE MUST STAY AT LEAST AS LARGE AS THE BOX IT IS SHOWN IN.
     *
     * inSampleSize only steps in powers of two, so the question is where to stop. This used to
     * keep halving until the image was SMALLER than the box in both directions, which decoded an
     * image just above screen size at half resolution and left the ImageView to stretch it back up:
     * a 1280x720 still on a 1024x600 panel was decoded at 640x360 and shown 1.6x enlarged - soft
     * text and edges on exactly the HD assets people make for these panels. COVER fit made it
     * worse, because a bitmap that no longer covers the box has to be enlarged further still.
     *
     * Stop instead at the last step that is still >= the box in BOTH directions. The ImageView then
     * only ever scales DOWN, with filtering.
     *
     * ⚠️ "Under 2x the box per axis" only holds when the image has the box's shape. A panorama or a
     * tall strip stays at full size under the rule above (20000x800 on 1024x600: neither half covers
     * the box), so MAX_DECODE_PIXELS and MAX_DECODE_SIDE are the memory and GPU-texture floor under
     * it: past them we keep halving even if the result ends up below the box. A slightly soft
     * panorama beats an OOM or a bitmap too large to upload, which draws as nothing at all.
     */
    internal fun calcSampleSize(srcW: Int, srcH: Int, maxW: Int, maxH: Int): Int {
        if (srcW <= 0 || srcH <= 0) return 1
        var sample = 1
        if (maxW > 0 && maxH > 0) {
            while (srcW / (sample * 2) >= maxW && srcH / (sample * 2) >= maxH) sample *= 2
        }
        while (srcW.toLong() / sample * (srcH / sample) > MAX_DECODE_PIXELS ||
            maxOf(srcW, srcH) / sample > MAX_DECODE_SIDE) sample *= 2
        return sample
    }

    // 12 MP = 48 MB as ARGB_8888 (a 4K frame is 8.3 MP). 4096 px per side is the texture limit that
    // every GPU we ship on supports; a bitmap past the device's limit is silently not drawn.
    internal const val MAX_DECODE_PIXELS = 12_000_000L
    internal const val MAX_DECODE_SIDE = 4096

    // Rotating 90/270 degrees swaps the axes, so the sample size has to be chosen against the image
    // as it will be SHOWN: a "rotate 90" phone photo is 4032x3024 in pixels but portrait on screen.
    private fun swapsAxes(orientation: Int) = orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
        orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
        orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
        orientation == ExifInterface.ORIENTATION_TRANSVERSE

    private fun sampleFor(bounds: BitmapFactory.Options, orientation: Int, maxW: Int, maxH: Int): Int =
        if (swapsAxes(orientation)) calcSampleSize(bounds.outHeight, bounds.outWidth, maxW, maxH)
        else calcSampleSize(bounds.outWidth, bounds.outHeight, maxW, maxH)

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
