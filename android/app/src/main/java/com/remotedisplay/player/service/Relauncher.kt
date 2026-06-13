package com.remotedisplay.player.service

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import com.remotedisplay.player.MainActivity
import com.remotedisplay.player.RemoteDisplayApp

/**
 * Brings the player back to the foreground after a trigger (device boot or a self-update).
 * Shared by [BootReceiver] and [PackageReplacedReceiver] so both relaunch through the SAME
 * cascade (#96).
 *
 * A BroadcastReceiver runs in the background, and Android 10+ blocks a bare startActivity
 * from the background. The cascade, most-reliable first:
 *
 *   1. Overlay-direct startActivity — legal on EVERY version IF SYSTEM_ALERT_WINDOW is
 *      granted (the documented background-activity-launch exemption). Covers MAXHUB
 *      (elevated), any properly-onboarded device, and Fire OS 7 (Android 9, no restriction).
 *   2. Notification — on Android <14 a full-screen intent AUTO-LAUNCHES the activity (covers
 *      FireOS, which is Android 9–11); on 14+, where USE_FULL_SCREEN_INTENT is auto-revoked,
 *      it degrades to a VISIBLE, tappable "tap to resume" prompt. That is the requirement
 *      (a) fail-loud path: human-recoverable, never a silent dark screen. The server sees
 *      the device's next check-in — or its absence — via the #96 update logging.
 *
 * The only device class with no path here is vanilla Android 14+ with neither the overlay
 * granted nor the app set as home launcher — for those it stops at the visible prompt.
 */
object Relauncher {
    private const val TAG = "Relauncher"
    const val UPDATE = "update"
    const val BOOT = "boot"

    fun relaunch(context: Context, reason: String) {
        // Keep the WS foreground service alive (it drives playback + reconnect).
        try {
            val svc = Intent(context, WebSocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
            else context.startService(svc)
            Log.i(TAG, "[$reason] WebSocket service started")
        } catch (e: Exception) {
            Log.e(TAG, "[$reason] Failed to start service: ${e.message}")
        }

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        // 1. Overlay-direct: the most reliable bg-launch path when the overlay is granted.
        var launched = false
        if (Settings.canDrawOverlays(context)) {
            try {
                context.startActivity(launchIntent)
                launched = true
                Log.i(TAG, "[$reason] Direct launch (overlay permission)")
            } catch (e: Exception) {
                Log.e(TAG, "[$reason] Direct launch failed: ${e.message}")
            }
        }

        // 2. Notification: <14 full-screen-intent auto-launch; 14+/no-overlay the visible
        //    tap-to-resume prompt. Posted even if (1) launched, so a 14+ device that could
        //    not auto-launch always has a tappable way back (fail loud, never dark).
        postRelaunchNotification(context, launchIntent, reason, launched)
    }

    private fun postRelaunchNotification(context: Context, launchIntent: Intent, reason: String, alreadyLaunched: Boolean) {
        try {
            val pi = PendingIntent.getActivity(
                context, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val isUpdate = reason == UPDATE
            val builder = NotificationCompat.Builder(context, RemoteDisplayApp.BOOT_CHANNEL_ID)
                .setContentTitle(if (isUpdate) "ScreenTinker updated" else "ScreenTinker")
                .setContentText(if (isUpdate) "Tap to resume the display" else "Starting display...")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setContentIntent(pi)              // tap -> launch (the path on 14+ where FSI is revoked)
                .setFullScreenIntent(pi, true)     // <14: auto-launch
                .setAutoCancel(true)
            // Fail-loud: if we could not auto-launch (14+, no overlay), keep the prompt
            // sticky until the operator taps it to resume.
            if (isUpdate && !alreadyLaunched) builder.setOngoing(true)

            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(999, builder.build())
            Log.i(TAG, "[$reason] Relaunch notification posted (fullScreenIntent + tappable, ongoing=${isUpdate && !alreadyLaunched})")
        } catch (e: Exception) {
            Log.e(TAG, "[$reason] Notification failed: ${e.message}")
            if (!alreadyLaunched) {
                // last-ditch: try a direct launch even though bg-launch may be blocked.
                try { context.startActivity(launchIntent) } catch (e2: Exception) { Log.e(TAG, "[$reason] Last-ditch launch failed: ${e2.message}") }
            }
        }
    }
}
