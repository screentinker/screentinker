package com.remotedisplay.player.telemetry

import java.io.File

/**
 * The SoC temperature for telemetry.temperature_c, read from the kernel's thermal zones.
 *
 * The server already stores temperature_c and the dashboard already shows it (BrightSign sends it);
 * the Android player simply never did. Nothing here needs a permission: /sys/class/thermal is
 * world-readable on the panels we have seen. Where it is not, or there is no sensor at all, the
 * answer is null and the key is left out, which the server records as "this hardware has no
 * thermometer" (see telemetry-temperature.test.js).
 *
 * ⚠️ PICK THE ZONE BY NAME, NOT BY INDEX. thermal_zone0 is usually the SoC, but not always, and the
 * zone list carries entries that are not a chip temperature at all. On a Rockchip RK3566 panel
 * (Android 11, vendor BSP derived from the RK3566 EVB) the zones are:
 *
 *     soc-thermal   45000   <- the one we want
 *     gpu-thermal   40000
 *     test_battery   2000   <- a placeholder from the reference BSP; the panel has no battery
 *
 * Taking "the first zone" works on that board by luck; taking "the hottest" or an average would
 * also work by luck. A name match on soc/cpu is what is actually meant, with zone order only as a
 * fallback, and anything battery-like or implausible is never reported.
 *
 * The selection is a pure function over (type, raw) pairs so it is testable on the JVM without a
 * device; read() is the only part that touches the filesystem.
 */
internal object SocTemperature {

    data class Zone(val type: String, val raw: Long)

    private const val THERMAL_DIR = "/sys/class/thermal"

    // Zone names that are a chip temperature, in order of preference. Matched case-insensitively
    // as substrings, so "soc-thermal", "soc_thermal", "cpu-thermal", "cpu0-thermal" all qualify.
    private val PREFERRED = listOf("soc", "cpu")

    // Zone names that are never the chip: batteries, chargers and BSP placeholders.
    private val EXCLUDED = listOf("battery", "charger", "bms", "test")

    // A reading outside this window is a broken or placeholder sensor, not a temperature.
    private const val MIN_C = 1.0
    private const val MAX_C = 150.0

    /** Degrees C with one decimal, or null when the device has no usable chip sensor. */
    fun read(dir: File = File(THERMAL_DIR)): Double? = try {
        val zones = dir.listFiles { f -> f.name.startsWith("thermal_zone") }
            ?.sortedBy { it.name.removePrefix("thermal_zone").toIntOrNull() ?: Int.MAX_VALUE }
            ?.mapNotNull { z ->
                try {
                    val type = File(z, "type").readText().trim()
                    val raw = File(z, "temp").readText().trim().toLong()
                    Zone(type, raw)
                } catch (_: Throwable) { null }   // unreadable zone: skip it, keep the others
            }
            ?: emptyList()
        select(zones)
    } catch (_: Throwable) { null }

    /** The pure decision. Zones are in kernel order (thermal_zone0 first). */
    fun select(zones: List<Zone>): Double? {
        val usable = zones
            .filter { z -> EXCLUDED.none { z.type.contains(it, ignoreCase = true) } }
            .mapNotNull { z -> toCelsius(z.raw)?.let { z.type to it } }
        for (want in PREFERRED) {
            usable.firstOrNull { it.first.contains(want, ignoreCase = true) }?.let { return it.second }
        }
        return usable.firstOrNull()?.second
    }

    /**
     * The thermal sysfs ABI is millidegrees, but a few vendor drivers report whole degrees. Values
     * of 1000 and above are millidegrees; anything else is taken as degrees. Out of range -> null.
     */
    fun toCelsius(raw: Long): Double? {
        val c = if (raw >= 1000 || raw <= -1000) raw / 1000.0 else raw.toDouble()
        if (c.isNaN() || c < MIN_C || c > MAX_C) return null
        return Math.round(c * 10) / 10.0
    }
}
