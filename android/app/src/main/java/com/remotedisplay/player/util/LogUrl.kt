package com.remotedisplay.player.util

/**
 * A URL as it may appear in a log line: scheme + host + path, never the query, fragment or userinfo.
 *
 * ⚠️ WHY (GHSA-rvxj 13.2). WebView and image-load diagnostics go to DebugLog, and with remote debug on
 * DebugLog streams to every dashboard user in the workspace, read-only viewers included. PiP/web/widget
 * URLs routinely carry credentials in the query (?token=, ?key=, signed-URL signatures) or in userinfo
 * (https://user:pass@host). A viewer could read a secret they could never have sent. The path is kept
 * because "which page failed" is the whole point of the log; anything after ? or # is dropped.
 *
 * Pure string handling (no android.net.Uri / java.net.URI) so it never throws on a malformed URL and
 * is testable on the JVM.
 */
object LogUrl {
    private const val MAX = 200

    fun redact(url: String?): String {
        if (url == null) return "null"
        var s = url.trim()
        // data:/javascript:/blob: carry their payload inline; only the scheme is useful.
        val colon = s.indexOf(':')
        if (colon > 0) {
            val scheme = s.substring(0, colon).lowercase()
            if (scheme == "data" || scheme == "javascript" || scheme == "blob") return "$scheme:…"
        }
        val cut = s.indexOfAny(charArrayOf('?', '#'))
        val hadQuery = cut >= 0
        if (hadQuery) s = s.substring(0, cut)
        // Strip userinfo from the authority: scheme://user:pass@host/... -> scheme://host/...
        val sep = s.indexOf("://")
        if (sep >= 0) {
            val authStart = sep + 3
            val authEnd = s.indexOf('/', authStart).let { if (it < 0) s.length else it }
            val at = s.lastIndexOf('@', authEnd - 1)
            if (at >= authStart) s = s.substring(0, authStart) + s.substring(at + 1)
        }
        if (s.length > MAX) s = s.substring(0, MAX) + "…"
        return if (hadQuery) "$s?…" else s
    }
}
