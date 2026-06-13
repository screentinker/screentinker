package com.remotedisplay.player.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * #96: fires after the player updates itself via the OTA. When the app installs a new APK of
 * its own package, the system sends ACTION_MY_PACKAGE_REPLACED to the freshly-installed app
 * (in a new process). Without this, PACKAGE_REPLACED kills the old process and nothing brings
 * MainActivity back - the screen drops to the launcher, which is the 1.9.0 fleet bug.
 *
 * Relaunch through the exact same cascade as boot (see [Relauncher]).
 */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            Log.i("PackageReplaced", "App updated (MY_PACKAGE_REPLACED) - relaunching")
            Relauncher.relaunch(context, Relauncher.UPDATE)
        }
    }
}
