package com.remotedisplay.player.telemetry

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.WindowManager
import java.security.MessageDigest
import org.json.JSONObject

class DeviceInfo(private val context: Context) {

    fun getTelemetry(): JSONObject {
        return JSONObject().apply {
            put("battery_level", getBatteryLevel())
            put("battery_charging", isBatteryCharging())
            put("storage_free_mb", getStorageFreeMB())
            put("storage_total_mb", getStorageTotalMB())
            put("ram_free_mb", getRamFreeMB())
            put("ram_total_mb", getRamTotalMB())
            put("cpu_usage", getCpuUsage())
            put("wifi_ssid", getWifiSSID())
            put("wifi_rssi", getWifiRSSI())
            put("uptime_seconds", getUptimeSeconds())
            // #74/#75: OS timezone + UTC clock (effective-tz resolution + dashboard skew indicator)
            put("timezone", java.util.TimeZone.getDefault().id)
            put("device_utc", System.currentTimeMillis())
        }
    }

    fun getDeviceInfo(): JSONObject {
        // Report BOTH: screen_* = the HDMI/panel OUTPUT resolution (Display.Mode), render_* =
        // the UI render surface (getRealMetrics). On TV boxes that render at 720p and upscale
        // to a 1080p signal these differ — surfacing both explains the discrepancy (#134).
        val (outW, outH) = getOutputResolution()
        val (renW, renH) = renderSurfaceSize()
        return JSONObject().apply {
            put("android_version", Build.VERSION.RELEASE)
            put("app_version", getAppVersion())
            put("screen_width", outW)
            put("screen_height", outH)
            put("render_width", renW)
            put("render_height", renH)
        }
    }

    private fun getBatteryLevel(): Int {
        // Use broadcast intent method - more reliable on Android TV / Rockchip devices
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (intent != null) {
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            if (level >= 0 && scale > 0) return (level * 100 / scale)
        }
        // Fallback to BatteryManager API
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    private fun isBatteryCharging(): Boolean {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun getStorageFreeMB(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.availableBytes / (1024 * 1024)
    }

    private fun getStorageTotalMB(): Long {
        val stat = StatFs(Environment.getDataDirectory().path)
        return stat.totalBytes / (1024 * 1024)
    }

    private fun getRamFreeMB(): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.availMem / (1024 * 1024)
    }

    private fun getRamTotalMB(): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        return memInfo.totalMem / (1024 * 1024)
    }

    private fun getCpuUsage(): Double {
        // Simple estimation - in production you'd read /proc/stat
        return try {
            val runtime = Runtime.getRuntime()
            val usedMem = runtime.totalMemory() - runtime.freeMemory()
            val maxMem = runtime.maxMemory()
            (usedMem.toDouble() / maxMem.toDouble()) * 100.0
        } catch (e: Exception) {
            0.0
        }
    }

    @Suppress("DEPRECATION")
    private fun getWifiSSID(): String {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val info = wm.connectionInfo
            info.ssid?.replace("\"", "") ?: "Unknown"
        } catch (e: Exception) {
            "Unknown"
        }
    }

    @Suppress("DEPRECATION")
    private fun getWifiRSSI(): Int {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wm.connectionInfo.rssi
        } catch (e: Exception) {
            0
        }
    }

    private fun getUptimeSeconds(): Long {
        return SystemClock.elapsedRealtime() / 1000
    }

    /**
     * The display's actual OUTPUT resolution — the HDMI / panel signal — taken from the
     * active [android.view.Display.Mode]. This is deliberately NOT getRealMetrics(): many
     * Android TV boxes/sticks (and TV-OS builds like YaOS) render the UI into a lower
     * surface — commonly 1280x720 — and let the hardware scaler upscale it to a 1920x1080
     * (or 4K) HDMI signal. getRealMetrics() reports that 720p RENDER SURFACE, so a panel
     * receiving a real 1080p signal was being reported as 720p. Display.Mode.physicalWidth/
     * Height reports the true output mode (orientation-independent — the panel doesn't rotate
     * when we software-rotate the stage). Falls back to the render surface if no mode is
     * available. (#134 follow-up: "device reports 720p while the monitor shows a 1080 signal".)
     */
    private fun getOutputResolution(): Pair<Int, Int> {
        return try {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            @Suppress("DEPRECATION")
            val mode = wm.defaultDisplay?.mode
            val pw = mode?.physicalWidth ?: 0
            val ph = mode?.physicalHeight ?: 0
            if (pw > 0 && ph > 0) pw to ph else renderSurfaceSize()
        } catch (e: Throwable) {
            renderSurfaceSize()
        }
    }

    /** Fallback: the UI render-surface size (getRealMetrics). May be < the output mode. */
    private fun renderSurfaceSize(): Pair<Int, Int> {
        val dm = DisplayMetrics()
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(dm)
        return dm.widthPixels to dm.heightPixels
    }

    private fun getAppVersion(): String {
        return try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }

    @Suppress("DEPRECATION", "HardwareIds")
    fun getFingerprint(): String {
        // Create a hardware fingerprint that survives app reinstalls
        val parts = listOf(
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "",
            Build.BOARD,
            Build.BRAND,
            Build.DEVICE,
            Build.HARDWARE,
            Build.MANUFACTURER,
            Build.MODEL,
            Build.PRODUCT,
            try { Build.SERIAL } catch (e: Exception) { "unknown" },
            Build.DISPLAY,
        )
        val raw = parts.joinToString("|")
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}
