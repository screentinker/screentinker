package com.remotedisplay.player.audience

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import org.json.JSONObject

/*
 * Audience counting on the Android player: the server's `audience` payload block in, counts out.
 *
 * The SERVER decides (server/lib/audience.js). This class only follows: `audience` null or absent
 * means OFF — camera closed, indicator hidden, counting flushed — on every payload, so a screen that
 * missed the switch-off still stops on its next one. The camera runs only while the player is on
 * screen (onStart..onStop), and never without the CAMERA permission.
 */

/** The queue, persisted. Written here, sent by WebSocketService. Counts only — see AudienceAggregator. */
object AudienceLog {
    private const val PREFS = "screentinker"
    private const val KEY = "audience_queue"
    private val lock = Any()

    private fun load(ctx: Context): AudienceQueue =
        AudienceQueue.fromJson(try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) } catch (_: Throwable) { null })

    private fun save(ctx: Context, q: AudienceQueue) {
        try { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, q.toJson()).apply() } catch (_: Throwable) {}
    }

    fun add(ctx: Context, bs: List<AudienceBucket>) { if (bs.isNotEmpty()) synchronized(lock) { val q = load(ctx); q.addAll(bs); save(ctx, q) } }
    fun peek(ctx: Context): List<AudienceBucket> = synchronized(lock) { load(ctx).peek() }
    fun ack(ctx: Context, ids: Collection<String>) = synchronized(lock) { val q = load(ctx); q.ack(ids); save(ctx, q) }

    /**
     * The next counting-run number, 1-9999 then round again (0 is what a player before segments
     * sent). Persisted, and written synchronously, so a run after an app restart inside the same
     * minute gets a new number too.
     */
    fun nextSegment(ctx: Context): Int = synchronized(lock) {
        try {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val next = p.getInt(SEGMENT_KEY, 0) % 9999 + 1
            p.edit().putInt(SEGMENT_KEY, next).commit()
            next
        } catch (_: Throwable) { ((System.currentTimeMillis() / 1000) % 9999 + 1).toInt() }
    }
    private const val SEGMENT_KEY = "audience_segment"
}

class AudienceController(
    private val activity: Activity,
    private val overlayParent: () -> ViewGroup?,
    private val onBuckets: () -> Unit,              // there is something to send
) {
    private data class Config(val fps: Int, val minDwellMs: Long, val bucketSec: Int, val showIndicator: Boolean)

    private var config: Config? = null
    private var aggregator: AudienceAggregator? = null
    private var camera: AudienceCamera? = null
    private var indicator: ImageView? = null
    private var visible = false
    private var permissionAsked = false
    @Volatile private var item: ScreenItem = ScreenItem.NONE

    /** Every playlist payload. */
    fun onPayload(payload: JSONObject) {
        val a = payload.optJSONObject("audience")
        val next = if (a != null && a.optBoolean("enabled", false)) Config(
            fps = a.optInt("fps", 2).coerceIn(1, 5),
            minDwellMs = a.optLong("min_dwell_ms", 1000).coerceIn(500, 10_000),
            bucketSec = 60,
            showIndicator = a.optBoolean("show_indicator", true),
        ) else null
        if (next == config) return
        val restart = next == null || config == null || next.minDwellMs != config?.minDwellMs
        config = next
        if (next == null) { stopCounting(); return }
        if (restart) { stopCounting(); aggregator = AudienceAggregator(minDwellMs = next.minDwellMs, bucketSec = next.bucketSec).also { it.item = item } }
        camera?.setFps(next.fps)
        updateIndicator()
        if (visible) startCamera()
    }

    /** The item now on screen (from the proof-of-play hook). */
    fun setItem(kind: String, id: String?) {
        val it = if (id.isNullOrEmpty()) ScreenItem.NONE else ScreenItem(kind, id)
        item = it
        synchronized(this) { aggregator?.item = it }
    }

    fun onStart() { visible = true; if (config != null) startCamera() }

    fun onStop() { visible = false; stopCamera(flush = true) }

    fun onDestroy() { stopCounting() }

    fun onPermissionResult(granted: Boolean) { if (granted && visible && config != null) startCamera() }

    private fun hasPermission() = Build.VERSION.SDK_INT < 23 ||
        activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startCamera() {
        val cfg = config ?: return
        if (!hasPermission()) {
            // A device-owner screen can grant it silently where the platform allows (not every
            // Android version allows it for the camera); otherwise ask, once per run, on screen.
            val granted = try { com.remotedisplay.player.admin.STPolicy(activity).grantSelfPermission(Manifest.permission.CAMERA) } catch (_: Throwable) { false }
            if (!(granted && hasPermission())) {
                if (!permissionAsked && Build.VERSION.SDK_INT >= 23) {
                    permissionAsked = true
                    try { activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CODE) } catch (e: Throwable) { Log.w(TAG, "permission request: ${e.message}") }
                }
                return
            }
        }
        if (camera?.running == true) return
        if (aggregator == null) aggregator = AudienceAggregator(minDwellMs = cfg.minDwellMs, bucketSec = cfg.bucketSec).also { it.item = item }
        // Every camera start is a new counting run: its partial minute must not collide with the last one's.
        val seg = AudienceLog.nextSegment(activity.applicationContext)
        synchronized(this) { aggregator?.segment = seg }
        camera = AudienceCamera(activity.applicationContext,
            onFaces = { faces, now ->
                val done = synchronized(this) { aggregator?.onFrame(faces, now) } ?: emptyList()
                if (done.isNotEmpty()) { AudienceLog.add(activity.applicationContext, done); onBuckets() }
            },
            onError = { msg -> Log.w(TAG, "camera: $msg") },
        ).also { it.start(cfg.fps) }
        updateIndicator()
    }

    private fun stopCamera(flush: Boolean) {
        try { camera?.stop() } catch (_: Throwable) {}
        camera = null
        if (flush) {
            val left = synchronized(this) { aggregator?.flushAll(System.currentTimeMillis()) } ?: emptyList()
            if (left.isNotEmpty()) { AudienceLog.add(activity.applicationContext, left); onBuckets() }
        }
        updateIndicator()
    }

    private fun stopCounting() {
        stopCamera(flush = true)
        aggregator = null
        updateIndicator()
    }

    /** A small camera icon in the corner while counting, unless the org turned it off. */
    private fun updateIndicator() {
        activity.runOnUiThread {
            val show = config?.showIndicator == true && camera?.running == true
            val parent = overlayParent() ?: return@runOnUiThread
            if (show && indicator == null) {
                val px = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 28f, activity.resources.displayMetrics).toInt()
                val margin = px / 3
                indicator = ImageView(activity).apply {
                    setImageResource(android.R.drawable.ic_menu_camera)
                    alpha = 0.55f
                    contentDescription = "Audience counting is on"
                    layoutParams = FrameLayout.LayoutParams(px, px, Gravity.TOP or Gravity.END).apply { setMargins(margin, margin, margin, margin) }
                }
                try { parent.addView(indicator) } catch (e: Throwable) { Log.w(TAG, "indicator: ${e.message}"); indicator = null }
            } else if (!show && indicator != null) {
                try { (indicator?.parent as? ViewGroup)?.removeView(indicator) } catch (_: Throwable) {}
                indicator = null
            }
        }
    }

    companion object {
        private const val TAG = "Audience"
        const val REQUEST_CODE = 4711

        /** Can this device count at all? Declared as the 'audience.camera' capability. */
        fun deviceHasCamera(ctx: Context): Boolean = try {
            val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as? android.hardware.camera2.CameraManager
            ctx.packageManager.hasSystemFeature("android.hardware.camera.any") || (mgr?.cameraIdList?.isNotEmpty() == true)
        } catch (_: Throwable) { false }
    }
}
