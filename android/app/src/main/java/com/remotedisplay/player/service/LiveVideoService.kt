package com.remotedisplay.player.service

import android.app.Activity
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.remotedisplay.player.RemoteDisplayApp
import com.remotedisplay.player.remote.LiveVideoPublisher
import org.json.JSONArray
import org.webrtc.PeerConnection
import java.util.concurrent.Executors

/**
 * #go2rtc — foreground service that owns the live-video MediaProjection sender.
 *
 * Mirrors MediaProjectionService (screenshots): Android 14+ requires a running FGS of type
 * mediaProjection BEFORE the WebRTC ScreenCapturerAndroid may call getMediaProjection(), and an
 * Activity cannot enter that foreground state. Kept SEPARATE from MediaProjectionService so live
 * video and the screenshot path never share (and single-use-consume) the same projection token.
 *
 * Started by ScreenCapturePermissionActivity once the operator grants (or a device-owner
 * auto-grants) MediaProjection consent, carrying the consent result plus the device credentials and
 * the ICE servers from the live descriptor.
 */
class LiveVideoService : Service() {

    @Volatile private var publisher: LiveVideoPublisher? = null

    // Building and tearing down a WebRTC sender is heavy (PeerConnectionFactory init, screen capture
    // start, and — on teardown — native dispose that blocks until WebRTC's own threads drain). Doing
    // that inline in onStartCommand runs it on the MAIN thread, and under the dashboard's rapid
    // start->stop->start (it re-requests publish on every not_publishing, and reopening the tile
    // repeats it) the main thread blocks past the foreground-service deadline -> "Timeout executing
    // service" ANR. So all start/stop work runs on this single background thread, which also
    // serializes it: no two starts or a start racing a stop. onStartCommand only enters the
    // foreground (fast, must stay on main) and hands off.
    private val ctl = Executors.newSingleThreadExecutor { r -> Thread(r, "live-video-ctl") }

    companion object {
        private const val TAG = "LiveVideoService"
        private const val NOTIF_ID = 3
        private const val EXTRA_RESULT_CODE = "result_code"
        private const val EXTRA_RESULT_DATA = "result_data"
        private const val EXTRA_SERVER_URL = "server_url"
        private const val EXTRA_DEVICE_ID = "device_id"
        private const val EXTRA_DEVICE_TOKEN = "device_token"
        private const val EXTRA_ICE = "ice_servers"   // JSON array string
        const val ACTION_STOP = "com.remotedisplay.player.LIVE_STOP"

        fun start(context: Context, resultCode: Int, data: Intent, serverUrl: String,
                  deviceId: String, deviceToken: String, iceServersJson: String) {
            val intent = Intent(context, LiveVideoService::class.java).apply {
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
                putExtra(EXTRA_SERVER_URL, serverUrl)
                putExtra(EXTRA_DEVICE_ID, deviceId)
                putExtra(EXTRA_DEVICE_TOKEN, deviceToken)
                putExtra(EXTRA_ICE, iceServersJson)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, LiveVideoService::class.java).apply { action = ACTION_STOP })
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Tear down off the main thread; stop the foreground/service now. onDestroy also stops
            // the publisher, but stop() is idempotent so a double call is harmless.
            ctl.execute { try { publisher?.stop() } catch (_: Throwable) {}; publisher = null }
            stopSelf()
            return START_NOT_STICKY
        }

        // Enter the foreground with the mediaProjection type FIRST (Android 14+ requirement, and it
        // must happen on the main thread before we return). getMediaProjection() runs later on the
        // ctl thread, after this has registered the foreground state.
        startForegroundCompat()

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        @Suppress("DEPRECATION")
        val data: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else intent?.getParcelableExtra(EXTRA_RESULT_DATA)

        if (resultCode != Activity.RESULT_OK || data == null) {
            Log.e(TAG, "missing/invalid projection consent; stopping")
            stopSelf(); return START_NOT_STICKY
        }
        val serverUrl = intent?.getStringExtra(EXTRA_SERVER_URL).orEmpty()
        val deviceId = intent?.getStringExtra(EXTRA_DEVICE_ID).orEmpty()
        val deviceToken = intent?.getStringExtra(EXTRA_DEVICE_TOKEN).orEmpty()
        if (serverUrl.isEmpty() || deviceId.isEmpty() || deviceToken.isEmpty()) {
            Log.e(TAG, "missing device credentials; stopping"); stopSelf(); return START_NOT_STICKY
        }
        val ice = try { LiveVideoPublisher.parseIceServers(JSONArray(intent?.getStringExtra(EXTRA_ICE) ?: "[]")) }
                  catch (_: Throwable) { emptyList<PeerConnection.IceServer>() }

        // All the heavy lifting happens on the ctl thread; onStartCommand returns immediately.
        ctl.execute {
            try {
                val cur = publisher
                if (cur != null && cur.isLive) {
                    // Already publishing — a duplicate request (dashboard retry / tile reopened).
                    // Keep the live sender; drop this now-spent projection token rather than churn.
                    Log.i(TAG, "already live; ignoring duplicate start")
                    return@execute
                }
                cur?.stop()
                publisher = LiveVideoPublisher(applicationContext, serverUrl, deviceId, deviceToken).also {
                    it.start(data, ice)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "start failed: ${t.message}", t)
                try { publisher?.stop() } catch (_: Throwable) {}
                publisher = null
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startForegroundCompat() {
        val notif = NotificationCompat.Builder(this, RemoteDisplayApp.CHANNEL_ID)
            .setContentTitle("ScreenTinker")
            .setContentText("Live view active")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(NOTIF_ID, notif)
    }

    override fun onDestroy() {
        // Final teardown on the ctl thread (dispose can block), then let it drain and shut down.
        val p = publisher; publisher = null
        ctl.execute { try { p?.stop() } catch (_: Throwable) {} }
        ctl.shutdown()
        super.onDestroy()
    }
}
