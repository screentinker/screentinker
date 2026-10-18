package com.remotedisplay.player.util

/**
 * Pieces of a widget render URL that more than one renderer needs.
 */
object WidgetUrls {
    /**
     * A meeting-room display's panel capability as a URL FRAGMENT (`#panel=...`), or "" when there
     * is none. The server issues it to this screen only, over its authenticated socket; it lets the
     * page book the room. A fragment is never sent to a server, so it stays out of access logs and
     * cache keys, and it keeps the URL stable, so the same-URL WebView reuse still holds.
     */
    fun panelFragment(token: String?): String {
        if (token.isNullOrEmpty()) return ""
        return "#panel=" + java.net.URLEncoder.encode(token, "UTF-8")
    }

    /**
     * #660 "Transparent background" on a playlist item: the query flag that asks the server for the
     * see-through page (server lib/backgrounds.js), or "". Goes before any fragment.
     */
    fun transparentParam(on: Boolean): String = if (on) "&transparent=1" else ""

    /** The style the server adds for that flag, byte for byte; for a bundle played from the cache. */
    const val TRANSPARENT_CSS = "<style id=\"st-transparent\">html,body,.stage{background:transparent!important;background-color:transparent!important}</style>"

    /** A cached bundle document drawn see-through, as the server would send it with the flag. */
    fun forceTransparent(html: String): String {
        val at = html.indexOf("</head>", ignoreCase = true)
        return if (at >= 0) html.substring(0, at) + TRANSPARENT_CSS + html.substring(at) else TRANSPARENT_CSS + html
    }
}
