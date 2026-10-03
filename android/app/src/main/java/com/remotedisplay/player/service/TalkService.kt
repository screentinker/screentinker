package com.remotedisplay.player.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.remotedisplay.player.RemoteDisplayApp
import com.remotedisplay.player.remote.AudioTalker
import org.json.JSONArray
import org.webrtc.PeerConnection
import java.util.concurrent.Executors

/**
 * #talk — foreground service that owns the two-way voice intercom sender/receiver.
 *
 * microphone FGS type (not mediaProjection): the intercom records the mic in the background on
 * Android 14+, and plays the operator's audio out of the speaker. No projection consent is involved
 * — just the RECORD_AUDIO runtime permission. Kept separate from LiveVideoService so a talk session
 * and a live-video session are independent (either, both, or neither can be up).
 *
 * Like LiveVideoService, all start/stop work runs on a single background thread so onStartCommand
 * never blocks the main thread past the foreground-service deadline (the ANR that bit live video).
 */
class TalkService : Service() {

    @Volatile private var talker: AudioTalker? = null
    private val ctl = Executors.newSingleThreadExecutor { r -> Thread(r, "talk-ctl") }

    companion object {
        private const val TAG = "TalkService"
        private const val NOTIF_ID = 4
        private const val EXTRA_SERVER_URL = "server_url"
        private const val EXTRA_DEVICE_ID = "device_id"
        private const val EXTRA_DEVICE_TOKEN = "device_token"
        private const val EXTRA_ICE = "ice_servers"
        private const val EXTRA_SCOPE_KIND = "scope_kind"   // set for a broadcast listen ("group"/"workspace")
        private const val EXTRA_SCOPE_ID = "scope_id"
        private const val EXTRA_DUPLEX = "duplex"            // 2-way (send our mic) vs one-way (listen only)
        const val ACTION_STOP = "com.remotedisplay.player.TALK_STOP"

        fun start(context: Context, serverUrl: String, deviceId: String, deviceToken: String, iceServersJson: String,
                  scopeKind: String? = null, scopeId: String? = null, duplex: Boolean = true) {
            val intent = Intent(context, TalkService::class.java).apply {
                putExtra(EXTRA_SERVER_URL, serverUrl)
                putExtra(EXTRA_DEVICE_ID, deviceId)
                putExtra(EXTRA_DEVICE_TOKEN, deviceToken)
                putExtra(EXTRA_ICE, iceServersJson)
                putExtra(EXTRA_DUPLEX, duplex)
                if (scopeKind != null && scopeId != null) { putExtra(EXTRA_SCOPE_KIND, scopeKind); putExtra(EXTRA_SCOPE_ID, scopeId) }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, TalkService::class.java).apply { action = ACTION_STOP })
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            ctl.execute { try { talker?.stop() } catch (_: Throwable) {}; talker = null }
            // stopSelf(startId), not stopSelf(): if a newer start command has already arrived, this
            // stop must NOT tear the service down under it (the start/stop race that otherwise let a
            // stale stop's onDestroy kill a fresh talker).
            stopSelf(startId)
            return START_NOT_STICKY
        }

        startForegroundCompat()

        val serverUrl = intent?.getStringExtra(EXTRA_SERVER_URL).orEmpty()
        val deviceId = intent?.getStringExtra(EXTRA_DEVICE_ID).orEmpty()
        val deviceToken = intent?.getStringExtra(EXTRA_DEVICE_TOKEN).orEmpty()
        if (serverUrl.isEmpty() || deviceId.isEmpty() || deviceToken.isEmpty()) {
            Log.e(TAG, "missing device credentials; stopping"); stopSelf(startId); return START_NOT_STICKY
        }
        val ice = try { AudioTalker.parseIceServers(JSONArray(intent?.getStringExtra(EXTRA_ICE) ?: "[]")) }
                  catch (_: Throwable) { emptyList<PeerConnection.IceServer>() }
        val scopeKind = intent?.getStringExtra(EXTRA_SCOPE_KIND)
        val scopeId = intent?.getStringExtra(EXTRA_SCOPE_ID)
        val duplex = intent?.getBooleanExtra(EXTRA_DUPLEX, true) ?: true

        ctl.execute {
            try {
                val cur = talker
                if (cur != null && cur.isActive) { Log.i(TAG, "already active; ignoring duplicate start"); return@execute }
                cur?.stop()
                talker = AudioTalker(applicationContext, serverUrl, deviceId, deviceToken).also { it.start(ice, scopeKind, scopeId, duplex) }
            } catch (t: Throwable) {
                Log.e(TAG, "start failed: ${t.message}", t)
                try { talker?.stop() } catch (_: Throwable) {}
                talker = null
                stopSelf(startId)
            }
        }
        return START_STICKY
    }

    private fun startForegroundCompat() {
        val notif = NotificationCompat.Builder(this, RemoteDisplayApp.CHANNEL_ID)
            .setContentTitle("ScreenTinker")
            .setContentText("Intercom active")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        else startForeground(NOTIF_ID, notif)
    }

    override fun onDestroy() {
        val t = talker; talker = null
        ctl.execute { try { t?.stop() } catch (_: Throwable) {} }
        ctl.shutdown()
        super.onDestroy()
    }
}
