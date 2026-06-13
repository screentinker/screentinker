package com.remotedisplay.player.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON") {

            Log.i("BootReceiver", "Boot completed (action=$action), launching ScreenTinker")
            // #96: boot + post-update relaunch share one cascade (overlay-direct -> FSI/
            // tap-to-resume). See Relauncher.
            Relauncher.relaunch(context, Relauncher.BOOT)
        }
    }
}
