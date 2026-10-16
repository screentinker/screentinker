package com.remotedisplay.player.player

import org.json.JSONObject

/**
 * #649: an HTML bundle can ask the player to skip it:
 *
 *     parent.postMessage({ type: 'screentinker:skip', reason: 'offline' }, '*')
 *
 * CONTRACT: the same rules as server/lib/bundle-skip.js (web, Tizen) and the native player's
 * logic/bundle_skip.py, all held to shared/bundle-skip-vectors.json (BundleSkipVectorsTest here).
 *
 * The Android player mounts a bundle as the WebView's TOP-LEVEL document (loadDataWithBaseURL with a
 * null base: an opaque origin), not in an iframe, so the bundle's `parent` is its own window and its
 * message lands on itself. [inject] puts a tiny listener at the start of the document that forwards
 * a skip to the [BRIDGE] JavaScript interface, and only when:
 *  - the message's source is the bundle's own window (a frame the bundle embeds is ignored), and
 *  - it carries this mount's random [token] — the interface is visible to every frame of every page
 *    the WebView loads, so the native side honours a call only with the token of the bundle that is
 *    on screen now (MediaPlayerManager). A replaced bundle, a widget, or an embedded frame cannot
 *    know it. The listener removes its own script element so the token is not left in the DOM.
 */
object BundleSkip {
    const val MESSAGE_TYPE = "screentinker:skip"
    const val REASON_MAX = 64
    const val MIN_RUN_MS = 1000L
    const val BRIDGE = "STBundleSkip"

    /** Is this (parsed JSON) message a skip request at all. Who sent it is checked elsewhere. */
    fun isSkipMessage(data: Any?): Boolean = data is JSONObject && data.opt("type") == MESSAGE_TYPE

    // JavaScript's \s, so a reason is trimmed and collapsed exactly as the JS players do it.
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]")
    private val JS_SPACE = Regex("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]+")

    /** The optional reason as one short printable line, or null. See lib/bundle-skip.js. */
    fun sanitizeReason(raw: Any?): String? {
        if (raw !is String) return null
        var s = JS_SPACE.replace(CONTROL.replace(raw, " "), " ").trim { JS_SPACE.matches(it.toString()) }
        if (s.isEmpty()) return null
        if (s.codePointCount(0, s.length) > REASON_MAX) s = s.substring(0, s.offsetByCodePoints(0, REASON_MAX))
        return s
    }

    /**
     * The anti-spin rule, one per rotation. [decide] answers "skip" (honoured) or why not: "sync" (a
     * shared clock), "alone" (nothing else to move on to) or "repeat" (already skipped since an item
     * last ran to its normal end). [ended] is called when an item leaves the screen any other way;
     * a run under [minRunMs] does not end the pass.
     */
    class Guard(private val minRunMs: Long = MIN_RUN_MS) {
        private val skipped = HashSet<String>()
        fun decide(key: String, canAdvance: Boolean, syncDriven: Boolean): String {
            if (syncDriven) return "sync"
            if (!canAdvance) return "alone"
            if (!skipped.add(key)) return "repeat"
            return "skip"
        }
        fun ended(ranMs: Long) { if (ranMs >= minRunMs) skipped.clear() }
        fun reset() = skipped.clear()
        val size: Int get() = skipped.size
    }

    /**
     * Which bundle may call the bridge: the one mounted last, and only while that mount is still on
     * screen. [mount] issues a fresh random token for a mount generation; [accepts] is true only for
     * that token under that same generation, so a replaced bundle (old token, or a later generation)
     * and anything that never saw a token are refused.
     */
    class MountToken(private val newToken: () -> String) {
        private var token: String? = null
        private var generation = Long.MIN_VALUE
        fun mount(gen: Long): String { val t = newToken(); token = t; generation = gen; return t }
        fun accepts(t: String?, gen: Long): Boolean = t != null && t == token && gen == generation
    }

    /** The human half of a refusal, for the device log. */
    fun ignoredText(why: String): String = when (why) {
        "sync" -> "this screen is on a shared clock (wall or synced group)"
        "alone" -> "there is nothing else to play"
        "repeat" -> "it already skipped this pass, so it plays its duration"
        else -> why
    }

    /** The listener that runs first in the bundle document. [token] must be [A-Za-z0-9]. */
    fun bridgeScript(token: String): String {
        require(token.matches(Regex("[A-Za-z0-9]{1,64}"))) { "token" }
        return "<script>(function(){var s=document.currentScript;try{if(s&&s.parentNode)s.parentNode.removeChild(s)}catch(x){}" +
            "var t='$token';window.addEventListener('message',function(e){try{var d=e.data;" +
            "if(e.source!==window||!d||typeof d!=='object'||d.type!=='$MESSAGE_TYPE')return;" +
            "var b=window.$BRIDGE;if(b)b.skip(t,typeof d.reason==='string'?d.reason.slice(0,256):'')}catch(x){}});})();</script>"
    }

    private val HEAD = Regex("<head(\\s[^>]*)?>", RegexOption.IGNORE_CASE)
    private val HTML = Regex("<html(\\s[^>]*)?>", RegexOption.IGNORE_CASE)
    private val DOCTYPE = Regex("^\\s*<!doctype[^>]*>", RegexOption.IGNORE_CASE)

    /**
     * [html] with [bridgeScript] as the first thing the parser runs: right after <head>, else after
     * <html>, else after the doctype, else at the very start. Never BEFORE a doctype — anything
     * there drops the document into quirks mode and changes how the bundle lays out.
     */
    fun inject(html: String, token: String): String {
        val script = bridgeScript(token)
        for (re in listOf(HEAD, HTML, DOCTYPE)) {
            val m = re.find(html) ?: continue
            return html.substring(0, m.range.last + 1) + script + html.substring(m.range.last + 1)
        }
        return script + html
    }
}
