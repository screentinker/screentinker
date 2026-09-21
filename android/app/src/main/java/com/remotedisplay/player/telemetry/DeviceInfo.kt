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
import com.remotedisplay.player.data.ServerConfig
import com.remotedisplay.player.service.OtaThrottle
import java.security.MessageDigest
import org.json.JSONObject

class DeviceInfo(private val context: Context) {

    /*
     * ⚠️ ONE ServerConfig FOR THE LIFE OF THIS OBJECT. #406.
     *
     * Constructing it is not cheap: the constructor opens BOTH preference stores to decide which
     * one holds the pairing (#312), and the encrypted one is an EncryptedSharedPreferences, i.e. a
     * Keystore/Tink round trip. getDeviceInfo() built two of them per call, and it is called from
     * deviceInfoPayload() on register, re-register AND the 60 s heartbeat — all posted to the main
     * looper. On an RK3566/OP-TEE board, whose Keystore is unreliable, Tink's "wait and retry" on
     * each failure was a visible stall on the thread that draws, roughly twice a minute forever.
     * Nothing in here changes during playback, so build it once. Same pattern as UpdateChecker.
     */
    private val serverConfig by lazy { ServerConfig(context) }

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
            // The screen's OWN address on the network. The server separately records the PUBLIC
            // address it sees the connection from; showing only that had customers reading their
            // ISP's address as their screen's IP. Needs no permission — read straight off the
            // interfaces, so it works on Ethernet panels too, not just Wi-Fi.
            put("local_ip", getLocalIp() ?: JSONObject.NULL)
            // Both stacks, not one: getLocalIp() filters to Inet4Address, so a v6-only panel
            // reported NOTHING and the dashboard showed a dash for a screen that had a perfectly
            // good address. A dual-stack panel now shows both.
            put("local_ip6", getLocalIp6() ?: JSONObject.NULL)
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
            // #139 Phase 2: report OTA backoff state (alongside app_version) so the dashboard can
            // flag screens stuck in manual-update-required. Read from the persisted throttle state.
            val cfg = serverConfig
            val ota = OtaThrottle.State(cfg.otaTargetVersion, cfg.otaAttempts, cfg.otaLastAttemptAt, cfg.otaBackoffReported)
            put("ota_status", OtaThrottle.statusFor(ota, System.currentTimeMillis()))
            put("ota_target_version", cfg.otaTargetVersion)
            put("ota_attempts", cfg.otaAttempts)
            // #161: privilege tier so the dashboard can show provisioning guidance + gate Tier-2
            // controls. 0 unprivileged / 1 device-admin / 2 owner-or-delegated-install.
            try {
                val policy = com.remotedisplay.player.admin.STPolicy(context)
                put("tier", policy.tier())
                put("device_owner", policy.isDeviceOwner())
                put("can_install_silently", policy.canInstallSilently())
                put("foreign_device_owner", policy.hasForeignDeviceOwner())
            } catch (_: Throwable) { put("tier", 0) }
            // #160 Track-A capability flags (NO device-owner dependency) — let the dashboard gate the
            // no-privilege system controls and show the operator exactly what's grantable per panel.
            try {
                put("can_write_settings", Settings.System.canWrite(context))
                put("overlay_granted", Settings.canDrawOverlays(context))
                put("accessibility_enabled", isAccessibilityEnabled())
                // #160: current values so the dashboard sliders REFLECT reality instead of resetting
                // to a default — "remember" what they're set to across dashboard reloads. Reading these
                // needs no WRITE_SETTINGS (only writing does).
                put("media_volume", getMediaVolumeFraction())
                put("system_brightness", getSystemBrightnessFraction())
                put("screen_off_timeout_ms", getScreenOffTimeout())
                put("window_brightness", serverConfig.windowBrightness)   // -1 = follow system
            } catch (_: Throwable) { /* leave flags absent -> dashboard treats as false */ }
        }
    }

    /** #160: current STREAM_MUSIC volume as a 0..1 fraction (for the dashboard volume slider). */
    private fun getMediaVolumeFraction(): Double = try {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        val max = am.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC)
        if (max > 0) am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC).toDouble() / max else 0.0
    } catch (_: Throwable) { 0.0 }

    /** #160: current system brightness as a 0..1 fraction (read-only; no permission needed). */
    private fun getSystemBrightnessFraction(): Double = try {
        val v = Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS, -1)
        if (v >= 0) v / 255.0 else 0.0
    } catch (_: Throwable) { 0.0 }

    /** #160: current screen-off timeout in ms (read-only). */
    private fun getScreenOffTimeout(): Int = try {
        Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, 0)
    } catch (_: Throwable) { 0 }

    /**
     * #160: is OUR accessibility service currently enabled (drives remote-control availability).
     * Internal rather than private because the capability declaration asks the same question, and
     * a second copy of this check would drift from the telemetry the dashboard shows beside it.
     */
    internal fun isAccessibilityEnabled(): Boolean = try {
        val am = context.getSystemService(Context.ACCESSIBILITY_SERVICE)
            as android.view.accessibility.AccessibilityManager
        val mine = android.content.ComponentName(context,
            com.remotedisplay.player.service.PowerAccessibilityService::class.java)
        am.getEnabledAccessibilityServiceList(
            android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK
        ).any { it.resolveInfo.serviceInfo.let { si -> android.content.ComponentName(si.packageName, si.name) == mine } }
    } catch (_: Throwable) { false }

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

    /**
     * The connected Wi-Fi network name, or a value saying WHY we do not have it.
     *
     * Android 8.1+ hides the SSID from apps without location permission, returning the literal
     * "<unknown ssid>". We report "Unknown" for that, which reads as a fault in the player — a
     * customer reasonably assumed it needed device-owner access. It needs LOCATION, which this app
     * deliberately does not require: a signage player asking for location to display a network name
     * is a poor trade. It can be granted from the setup screen if someone wants the field filled in.
     *
     * So: "permission" when we are not allowed to know, null when there is genuinely no Wi-Fi (an
     * Ethernet panel), and the name otherwise. The dashboard can then say something true.
     */
    @Suppress("DEPRECATION")
    private fun getWifiSSID(): String? {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val raw = wm.connectionInfo?.ssid?.replace("\"", "")
            when {
                raw.isNullOrEmpty() -> null
                // What the platform hands back when location is missing or switched off.
                raw.equals("<unknown ssid>", ignoreCase = true) || raw == "0x" -> "permission"
                else -> raw
            }
        } catch (e: Exception) {
            null
        }
    }

    /** First non-loopback IPv4 on any up interface (Wi-Fi or Ethernet). No permission needed. */
    private fun getLocalIp(): String? = try {
        var found: String? = null
        val ifaces = java.net.NetworkInterface.getNetworkInterfaces()
        while (ifaces != null && ifaces.hasMoreElements() && found == null) {
            val iface = ifaces.nextElement()
            if (!iface.isUp || iface.isLoopback) continue
            val addrs = iface.inetAddresses
            while (addrs.hasMoreElements()) {
                val addr = addrs.nextElement()
                if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) { found = addr.hostAddress; break }
            }
        }
        found
    } catch (e: Throwable) { null }

    /**
     * The panel's own IPv6 address, reported alongside the v4 one rather than instead of it —
     * a dual-stack screen has both and an operator may need either.
     *
     * Deliberately NOT link-local (fe80::/10). Every interface has one, they are the addresses
     * most likely to be enumerated first, and none of them can be dialled without also knowing
     * the zone index — so putting one in the dashboard would fill the field with a string that
     * cannot be pasted anywhere useful and hide the address that can. A global or unique-local
     * address is the one someone reaching the panel on site actually needs.
     *
     * The scope check also drops multicast and the unspecified address; what survives is a
     * routable unicast address. `hostAddress` can carry a %iface suffix on some builds, so it is
     * trimmed — the field is for humans and for pasting into a browser.
     */
    private fun getLocalIp6(): String? = try {
        var found: String? = null
        val ifaces = java.net.NetworkInterface.getNetworkInterfaces()
        while (ifaces != null && ifaces.hasMoreElements() && found == null) {
            val iface = ifaces.nextElement()
            if (!iface.isUp || iface.isLoopback) continue
            val addrs = iface.inetAddresses
            while (addrs.hasMoreElements()) {
                val addr = addrs.nextElement()
                if (addr is java.net.Inet6Address &&
                    !addr.isLoopbackAddress && !addr.isLinkLocalAddress &&
                    !addr.isAnyLocalAddress && !addr.isMulticastAddress
                ) {
                    found = addr.hostAddress?.substringBefore('%')
                    break
                }
            }
        }
        found
    } catch (e: Throwable) { null }

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

    fun getAppVersion(): String {
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
