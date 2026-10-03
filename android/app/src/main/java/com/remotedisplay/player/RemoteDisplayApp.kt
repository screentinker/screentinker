package com.remotedisplay.player

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class RemoteDisplayApp : Application() {

    companion object {
        const val CHANNEL_ID = "remote_display_service"
        const val CHANNEL_NAME = "ScreenTinker Service"
        // Separate HIGH-importance channel for the boot full-screen-intent launch.
        // A full-screen intent is only honored from a high-importance channel.
        const val BOOT_CHANNEL_ID = "remote_display_boot"
        // LOW-importance channel for the transient "ScreenTinker updated" prompt when the display is
        // already relaunching itself — quiet, no heads-up banner over signage. (Channel importance,
        // not per-notification priority, decides heads-up on Android 8+.) The loud BOOT channel is
        // used only for the genuine fail-loud "tap to resume" case.
        const val RELAUNCH_QUIET_CHANNEL_ID = "remote_display_relaunch_quiet"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        installCrashExitSignal()
    }

    // Exit-signal contract v1 — 'crashed'. A global uncaught-exception handler fires a BEST-EFFORT
    // blocking last-gasp to the server, then delegates to the previous default handler so the crash
    // still propagates and the process dies normally. Runs on the crashing thread (already dying), so
    // the short blocking POST is acceptable. BEST-EFFORT: a native/OOM kill runs no JVM handler ->
    // nothing is sent -> the server infers 'silent'. Honesty: only ever emits 'crashed' here.
    private fun installCrashExitSignal() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val detail = (throwable.javaClass.simpleName + ": " + (throwable.message ?: "")).trim()
                com.remotedisplay.player.service.ExitSignal.send(this, "crashed", detail)
            } catch (t: Throwable) { /* never mask the original crash */ }
            prev?.uncaughtException(thread, throwable)   // chain -> normal crash reporting + process death
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    description = "ScreenTinker background service"
                    setShowBadge(false)
                }
            )
            manager.createNotificationChannel(
                NotificationChannel(BOOT_CHANNEL_ID, "ScreenTinker Startup", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Launches the display on boot"
                    setShowBadge(false)
                }
            )
            manager.createNotificationChannel(
                NotificationChannel(RELAUNCH_QUIET_CHANNEL_ID, "ScreenTinker Update", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Brief notice while the display resumes after an update"
                    setShowBadge(false)
                }
            )
        }
    }
}
