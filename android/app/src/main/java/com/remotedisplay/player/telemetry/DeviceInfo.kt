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
        }
    }

    fun getDeviceInfo(): JSONObject {
        val display = getDisplayMetrics()
        return JSONObject().apply {
            put("android_version", Build.VERSION.RELEASE)
            put("app_version", getAppVersion())
            put("screen_width", display.widthPixels)
            put("screen_height", display.heightPixels)
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

    private fun getDisplayMetrics(): DisplayMetrics {
        val dm = DisplayMetrics()
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(dm)
        return dm
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
