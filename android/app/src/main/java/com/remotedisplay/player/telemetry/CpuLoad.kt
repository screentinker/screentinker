package com.remotedisplay.player.telemetry

import java.io.File

/**
 * #474: whole-device CPU load from /proc/stat, as (busy delta) / (total delta) between two
 * heartbeats.
 *
 * The old cpu_usage was the app's own JVM heap fill (used / max), shown on the dashboard as CPU: a
 * panel pinned by software video decoding could read low and a busy heap could read as high CPU.
 *
 * ⚠️ /proc/stat is SELinux-restricted for apps on Android 8+ on most builds, so on many panels there
 * is no reading at all. Then sample() returns null and the key is left OUT of the heartbeat; the
 * server already stores a missing cpu_usage as null, which the dashboard shows as a dash. Never fall
 * back to a different metric under the same name.
 */
class CpuLoad(private val read: () -> String? = {
    try { File("/proc/stat").bufferedReader().use { it.readLine() } } catch (_: Throwable) { null }
}) {
    private var prev: Ticks? = null

    internal data class Ticks(val busy: Long, val total: Long)

    /** Percent busy since the previous call, or null (first call, unreadable, or no ticks elapsed). */
    @Synchronized
    fun sample(): Double? {
        val cur = parse(read()) ?: return null
        val last = prev
        prev = cur
        if (last == null) return null
        val total = cur.total - last.total
        val busy = cur.busy - last.busy
        if (total <= 0 || busy < 0) return null
        return (busy.toDouble() / total * 100.0).coerceIn(0.0, 100.0)
    }

    companion object {
        /** The aggregate "cpu  user nice system idle iowait irq softirq steal ..." line. */
        internal fun parse(line: String?): Ticks? {
            if (line == null) return null
            val f = line.trim().split(Regex("\\s+"))
            if (f.size < 5 || f[0] != "cpu") return null
            val n = f.drop(1).take(8).map { it.toLongOrNull() ?: return null }
            // guest/guest_nice (fields 9-10) are already counted inside user/nice
            val idle = n[3] + n.getOrElse(4) { 0L } // idle + iowait
            val total = n.sum()
            return Ticks(total - idle, total)
        }
    }
}
