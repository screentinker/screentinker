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
}
