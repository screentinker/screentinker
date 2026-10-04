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
    /** v2: keep the sites' cookie-consent choice across resets (see [CookieKeep]). */
    val keepConsent: Boolean = false,
    /** v2: extra cookie names (or `prefix*`) to keep, on top of the built-in consent list. */
    val keepCookieNames: List<String> = emptyList(),
    /** v2: a button back to the start page, shown once the visitor has left it. */
    val homeButton: Boolean = true,
    /** v2: the widget's existing Zoom %, as a layout zoom (the page sees a smaller viewport). */
    val zoomPct: Int = 100,
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
            val names: List<String> = when (val n = o.opt("keep_cookie_names")) {
                is org.json.JSONArray -> (0 until n.length()).map { n.optString(it, "") }
                is String -> n.split(',', '\n', ' ')
                else -> emptyList()
            }.map { it.trim() }.filter { CookieKeep.validPattern(it) }.distinct().take(50)
            return KioskConfig(
                url, idle, warn, domains, minWv,
                keepConsent = o.optBoolean("keep_consent", false),
                keepCookieNames = names,
                homeButton = o.optBoolean("home_button", true),
                zoomPct = o.optInt("zoom", 100).let { if (it <= 0) 100 else it.coerceIn(25, 400) },
            )
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

/**
 * v2 "keep the cookie-consent choice". On reset everything is wiped as before EXCEPT the consent
 * cookies of the allowed sites, which are read just before the wipe and written back after it.
 *
 * ⚠️ BY NAME, NEVER "ALL COOKIES OF THE ALLOWED DOMAIN". The allowed domain is also where a visitor
 * logs in and fills a basket; keeping its cookies wholesale would hand the next visitor the last
 * one's account, which is the thing the wipe exists to prevent. Only names known to belong to a
 * consent tool (plus the operator's own list) survive.
 *
 * Android's CookieManager only returns `name=value` pairs, so the restored cookie is set on the host
 * it was read from (Domain=host, Path=/) with a fresh Max-Age. That is enough for a consent check.
 */
object CookieKeep {
    /** Consent tools seen in the wild. Exact names, or a prefix ending in `*`. */
    val BUILT_IN: List<String> = listOf(
        "CookieConsent", "CookieConsentBulkSetting-*",               // Cookiebot
        "OptanonConsent", "OptanonAlertBoxClosed",                    // OneTrust
        "euconsent-v2", "euconsent", "addtl_consent", "__cmpcc*",     // IAB TCF
        "cookieyes-consent", "CookieLawInfoConsent", "cookielawinfo-checkbox-*", "viewed_cookie_policy",
        "cmplz_*", "complianz_*",                                     // Complianz
        "borlabs-cookie", "BorlabsCookie",                            // Borlabs
        "_iub_cs-*",                                                  // iubenda
        "didomi_token",                                               // Didomi (+ euconsent-v2)
        "cookieconsent_status", "cookieconsent_*",                    // Osano / cookieconsent.js
        "moove_gdpr_popup", "gdpr_consent*", "cookie_consent*", "cookie-consent*", "cookies_accepted",
        "klaro", "axeptio_cookies", "axeptio_authorized_vendors", "axeptio_all_vendors",
        "tarteaucitron", "CONSENT", "SOCS",                           // Google's own
        "consentUUID", "consentDate", "_cookie_consent*",
    ).distinct()

    fun validPattern(p: String): Boolean = Regex("^[A-Za-z0-9_.-]+[*]?\$").matches(p) && p != "*"

    fun matches(name: String, patterns: List<String>): Boolean = patterns.any { p ->
        if (p.endsWith("*")) name.startsWith(p.dropLast(1)) else name == p
    }

    /** `a=1; b=2` (CookieManager.getCookie) -> the pairs whose name is kept. */
    fun select(cookieHeader: String?, patterns: List<String>): List<Pair<String, String>> {
        if (cookieHeader.isNullOrBlank() || patterns.isEmpty()) return emptyList()
        return cookieHeader.split(';').mapNotNull { part ->
            val i = part.indexOf('=')
            if (i <= 0) return@mapNotNull null
            val name = part.substring(0, i).trim()
            val value = part.substring(i + 1).trim()
            if (name.isEmpty() || !matches(name, patterns)) null else name to value
        }.distinctBy { it.first }
    }

    /**
     * The Set-Cookie string written back after the wipe. Domain= so a choice made on www.shop.example
     * still applies on shop.example's other hosts, as the consent tool's own cookie normally does.
     */
    fun restoreHeader(name: String, value: String, domain: String): String =
        "$name=$value; Domain=$domain; Path=/; Max-Age=$MAX_AGE_SEC"

    const val MAX_AGE_SEC = 180 * 86400
}

/**
 * v2 load-error reporting: one dashboard incident per (reason, host) per window, so a site that is
 * down does not write an incident every time the playlist comes round to it.
 */
class ErrorThrottle(private val windowMs: Long = 15 * 60_000L) {
    private val last = HashMap<String, Long>()
    fun shouldReport(reason: String, url: String?, now: Long): Boolean {
        val key = reason + "|" + (KioskNav.hostOf(url) ?: "")
        val prev = last[key]
        if (prev != null && now - prev < windowMs) return false
        last[key] = now
        if (last.size > 64) last.entries.removeAll { now - it.value >= windowMs }
        return true
    }
}

/** Is [current] still the start page? Fragment and a trailing slash don't count as leaving it. */
fun isStartPage(current: String?, start: String): Boolean {
    fun norm(u: String) = u.substringBefore('#').trimEnd('/').lowercase()
    return current == null || current == "about:blank" || norm(current) == norm(start)
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
    /** The last touch or media keep-alive: where a session's ENGAGED time ends. */
    val lastActivityAt: Long get() = lastActivity

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
