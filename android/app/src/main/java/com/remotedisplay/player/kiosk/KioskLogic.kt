package com.remotedisplay.player.kiosk

import org.json.JSONObject

/*
 * Walk-up interactive web pages (#473): the pure parts, kept free of Android types so they are
 * unit-tested on the JVM (see KioskLogicTest). KioskSession is the Android glue around them.
 *
 * The model: an interactive webpage item plays like any other until someone touches it. The first
 * touch starts a SESSION: the playlist holds on the item, and the session lives until the visitor
 * stops touching it. After idleTimeout of no activity a "Still there?" countdown shows; if nobody
 * taps within warnSec the session RESETS — the start page reloads in a fresh WebView with all web
 * storage wiped — and the playlist moves on.
 */

/** Per-item settings, read from the webpage widget's config. */
data class KioskConfig(
    val url: String,
    val idleTimeoutSec: Int,
    val warnSec: Int,
    /** Hosts the visitor may navigate to (top-level only). Always includes the start URL's host. */
    val allowedDomains: List<String>,
    /** Optional: below this Chromium major the page is not attempted and a clear card is shown. */
    val minWebView: Int?,
) {
    companion object {
        const val DEFAULT_IDLE_SEC = 60
        const val DEFAULT_WARN_SEC = 10

        /**
         * Null unless this is a webpage widget with `interactive: true` and a usable http(s) URL.
         * Anything else keeps today's passive behaviour, which is the whole point of the switch:
         * existing screens change nothing.
         */
        fun parse(widgetType: String?, widgetConfig: String?): KioskConfig? {
            if (widgetType != "webpage" || widgetConfig.isNullOrBlank()) return null
            val o = try { JSONObject(widgetConfig) } catch (_: Exception) { return null }
            if (!o.optBoolean("interactive", false)) return null
            val url = o.optString("url", "").trim()
            val host = KioskNav.hostOf(url) ?: return null
            val idle = o.optInt("idle_timeout_sec", DEFAULT_IDLE_SEC).coerceIn(15, 3600)
            val warn = o.optInt("idle_warning_sec", DEFAULT_WARN_SEC).coerceIn(0, 60)
            val domains = mutableListOf(host)
            val raw = o.opt("allowed_domains")
            val list: List<String> = when (raw) {
                is org.json.JSONArray -> (0 until raw.length()).map { raw.optString(it, "") }
                is String -> raw.split(',', '\n', ' ')
                else -> emptyList()
            }
            for (d in list) {
                val n = KioskNav.normalizeDomain(d) ?: continue
                if (n !in domains) domains.add(n)
            }
            val minWv = if (o.has("min_webview")) o.optInt("min_webview", 0).takeIf { it > 0 } else null
            return KioskConfig(url, idle, warn, domains, minWv)
        }
    }
}

/** Top-level navigation policy. Subresources (CDN images, scripts) are never filtered. */
object KioskNav {
    fun hostOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val m = Regex("^(https?)://([^/?#:@]+)(:\\d+)?(?:[/?#]|$)", RegexOption.IGNORE_CASE).find(url.trim()) ?: return null
        return m.groupValues[2].lowercase().trimEnd('.').ifEmpty { null }
    }

    /** "https://www.shop.example/x" or ".shop.example" or "Shop.Example" -> "shop.example"-style host. */
    fun normalizeDomain(raw: String): String? {
        var s = raw.trim().lowercase()
        if (s.isEmpty()) return null
        if (s.startsWith("http://") || s.startsWith("https://")) s = hostOf(s) ?: return null
        s = s.trimStart('.').trimStart('*').trimStart('.').trimEnd('.', '/')
        if (s.isEmpty() || !Regex("^[a-z0-9.-]+$").matches(s) || !s.contains('.')) return null
        return s
    }

    /**
     * May the page navigate the top-level frame here? http(s) only — that alone keeps out intent:,
     * market:, tel:, mailto:, file: and javascript: — and the host must be an allowed domain or one
     * of its subdomains. about:blank is the WebView's own reset, never a visitor navigation.
     */
    fun isAllowed(url: String?, allowed: List<String>): Boolean {
        if (url == null) return false
        if (url == "about:blank") return true
        val host = hostOf(url) ?: return false
        return allowed.any { d -> host == d || host.endsWith(".$d") }
    }
}

/** Chromium major version from a WebView user agent, e.g. "Chrome/83.0.4103.106" -> 83. */
object WebViewVersion {
    fun chromeMajor(userAgent: String?): Int? =
        userAgent?.let { Regex("Chrome/(\\d+)\\.").find(it)?.groupValues?.get(1)?.toIntOrNull() }

    fun tooOld(userAgent: String?, min: Int?): Boolean {
        if (min == null) return false
        val v = chromeMajor(userAgent) ?: return false   // unknown: try the page rather than refuse it
        return v < min
    }
}

/**
 * Session clock. Driven by explicit timestamps so it is testable without a Looper:
 *   onTouch(now)     — a visitor touched the page (starts a session if none)
 *   keepAlive(now)   — media is playing in the page; counts as activity, but never STARTS a session
 *   tick(now)        — poll; returns what the UI should do now
 */
class KioskIdle(private val idleMs: Long, private val warnMs: Long) {
    enum class Phase { PASSIVE, ACTIVE, WARNING }

    sealed class Action {
        object None : Action()
        /** First touch: hold the playlist on this item. */
        object Started : Action()
        /** Show (or update) the countdown. */
        data class Warn(val secondsLeft: Int) : Action()
        /** The visitor came back during the countdown: hide it. */
        object Resumed : Action()
        /** Nobody came back: wipe, reload, release the playlist. */
        object Reset : Action()
    }

    var phase: Phase = Phase.PASSIVE
        private set
    private var lastActivity = 0L

    val inSession: Boolean get() = phase != Phase.PASSIVE

    fun onTouch(now: Long): Action {
        lastActivity = now
        return when (phase) {
            Phase.PASSIVE -> { phase = Phase.ACTIVE; Action.Started }
            Phase.WARNING -> { phase = Phase.ACTIVE; Action.Resumed }
            Phase.ACTIVE -> Action.None
        }
    }

    fun keepAlive(now: Long): Action {
        if (phase == Phase.PASSIVE) return Action.None
        lastActivity = now
        if (phase == Phase.WARNING) { phase = Phase.ACTIVE; return Action.Resumed }
        return Action.None
    }

    fun tick(now: Long): Action {
        if (phase == Phase.PASSIVE) return Action.None
        val idle = now - lastActivity
        if (idle >= idleMs + warnMs) { phase = Phase.PASSIVE; return Action.Reset }
        if (idle >= idleMs) {
            phase = Phase.WARNING
            val left = ((idleMs + warnMs - idle + 999) / 1000).toInt().coerceAtLeast(1)
            return Action.Warn(left)
        }
        return Action.None
    }

    /** End the session without a countdown (item changed, crash, failed load). */
    fun end() { phase = Phase.PASSIVE }
}
