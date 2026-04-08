package com.remotedisplay.player.service

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import android.app.NotificationManager
import com.remotedisplay.player.MainActivity
import com.remotedisplay.player.RemoteDisplayApp

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON") {

            Log.i("BootReceiver", "Boot completed (action=$action), launching ScreenTinker")

            // Start the foreground service
            try {
                val serviceIntent = Intent(context, WebSocketService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
                Log.i("BootReceiver", "WebSocket service started")
            } catch (e: Exception) {
                Log.e("BootReceiver", "Failed to start service: ${e.message}")
            }

            // Use a full-screen intent to launch the activity (bypasses Android 12+ restrictions)
            try {
                val launchIntent = Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }

                val pendingIntent = PendingIntent.getActivity(
                    context, 0, launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                val notification = NotificationCompat.Builder(context, RemoteDisplayApp.CHANNEL_ID)
                    .setContentTitle("ScreenTinker")
                    .setContentText("Starting display...")
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setFullScreenIntent(pendingIntent, true)
                    .setAutoCancel(true)
                    .build()

                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(999, notification)

                Log.i("BootReceiver", "Full-screen intent notification sent")
            } catch (e: Exception) {
                Log.e("BootReceiver", "Failed to launch via notification: ${e.message}")
                // Fallback: try direct launch
                try {
                    val launchIntent = Intent(context, MainActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    }
                    context.startActivity(launchIntent)
                } catch (e2: Exception) {
                    Log.e("BootReceiver", "Direct launch also failed: ${e2.message}")
                }
            }
        }
    }
}
