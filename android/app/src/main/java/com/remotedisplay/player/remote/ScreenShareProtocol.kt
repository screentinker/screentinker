package com.remotedisplay.player.remote

import org.json.JSONArray
import org.json.JSONObject

/**
 * 3.0 screen share (docs/screen-share.md) — the WIRE half of the Android receiver, with no Android
 * or WebRTC types in it so the JVM unit tests (ScreenShareProtocolTest) can hold it to the same
 * contract the web player's receiver (server/lib/screen-share-player.js) and the server relay
 * (server/lib/screen-share.js) speak.
 *
 * The screen's leg is a plain WebSocket, /api/devices/:id/screen-share/ws. The device_token goes in
 * the FIRST message, never in the URL (so it is not in any access log), the screen OFFERS recvonly
 * video+audio, and SDP/candidates use go2rtc's {type:'webrtc/…', value} shape.
 */
object ScreenShareProtocol {
    /** Nothing playing this long after start: give up rather than hold a black screen (web: 45 s). */
    const val CONNECT_TIMEOUT_MS = 45_000L
    /** Presenters on one screen at once (remote.screen_share_tiles; web: MAX_TILES). */
    const val MAX_TILES = 4
    /** The black frame round each tile when more than one is visible (web: border 2px solid #000). */
    const val TILE_BORDER_PX = 2
    private const val MAX_NAME = 40
    private val SESSION_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val QR_DATA_URL = Regex("^data:image/png;base64,([A-Za-z0-9+/=]+)$")
    // C0/C1 controls, zero-width and bidi overrides — the same set the server strips (cleanName).
    private val UNSAFE = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]")

    /** device:screenshare-start, validated. */
    data class Start(
        val sessionId: String,
        val sharedBy: String,
        val guest: Boolean,
        val maxSeconds: Int,
        val iceServers: JSONArray,
        /** The presenter shares sound. Informational: the layout event says whose sound plays. */
        val audio: Boolean = false,
    )

    fun parseStart(o: JSONObject?): Start? {
        if (o == null) return null
        val id = o.opt("session_id") as? String ?: return null
        if (!SESSION_ID.matches(id)) return null
        val by = o.opt("shared_by") as? String ?: ""
        return Start(
            sessionId = id,
            sharedBy = cleanName(by),
            guest = o.optBoolean("guest", false),
            maxSeconds = o.optInt("max_seconds", 3600),
            iceServers = o.optJSONArray("ice_servers") ?: JSONArray(),
            audio = o.opt("audio") == true,
        )
    }

    /** The server already cleans the name; this is the belt to its braces (it goes on a TV). */
    fun cleanName(raw: String?): String =
        (raw ?: "").replace(UNSAFE, " ").replace(Regex("\\s+"), " ").trim().take(MAX_NAME)

    /** The local backstop for the server's time limit: clamp(60 s, 8 h) plus 5 s of grace. */
    fun maxDurationMs(maxSeconds: Int): Long =
        maxSeconds.coerceIn(60, 8 * 3600).toLong() * 1000L + 5000L

    /** http(s)://host/base -> ws(s)://host/base/api/devices/<id>/screen-share/ws */
    fun wsUrl(serverUrl: String, deviceId: String): String {
        val base = serverUrl.trim().trimEnd('/')
        val ws = when {
            base.startsWith("https://", ignoreCase = true) -> "wss://" + base.substring(8)
            base.startsWith("http://", ignoreCase = true) -> "ws://" + base.substring(7)
            else -> base
        }
        return ws + "/api/devices/" + java.net.URLEncoder.encode(deviceId, "UTF-8") + "/screen-share/ws"
    }

    fun authMessage(deviceToken: String, sessionId: String): String =
        JSONObject().put("type", "auth").put("device_token", deviceToken).put("session_id", sessionId).toString()

    fun offerMessage(sdp: String): String = JSONObject().put("type", "webrtc/offer").put("value", sdp).toString()

    fun candidateMessage(candidate: String, mid: String?, mline: Int?): String {
        val o = JSONObject().put("type", "webrtc/candidate").put("value", candidate)
        if (!mid.isNullOrEmpty()) o.put("mid", mid)
        if (mline != null && mline >= 0) o.put("mline", mline)
        return o.toString()
    }

    /** States the relay accepts from a screen (server DEVICE_STATES). */
    val STATES = setOf("connecting", "connected", "playing", "failed", "disconnected", "unsupported")

    fun stateMessage(value: String): String {
        require(value in STATES) { "unknown state $value" }
        return JSONObject().put("type", "state").put("value", value).toString()
    }

    sealed class Incoming {
        object Ready : Incoming()
        data class Answer(val sdp: String) : Incoming()
        /** [mid] wins when present; otherwise [mline] (default 0), exactly as the web receiver does. */
        data class Candidate(val candidate: String, val mid: String?, val mline: Int) : Incoming()
        data class Ended(val reason: String) : Incoming()
        object Ignored : Incoming()
    }

    fun parseIncoming(text: String?): Incoming {
        val o = try { JSONObject(text ?: return Incoming.Ignored) } catch (_: Throwable) { return Incoming.Ignored }
        return when (o.optString("type")) {
            "ready" -> Incoming.Ready
            "webrtc/answer" -> (o.opt("value") as? String)?.takeIf { it.startsWith("v=0") }?.let { Incoming.Answer(it) } ?: Incoming.Ignored
            "webrtc/candidate" -> {
                val c = o.opt("value") as? String
                if (c.isNullOrEmpty()) Incoming.Ignored
                else Incoming.Candidate(c, o.opt("mid") as? String, (o.opt("mline") as? Number)?.toInt()?.takeIf { it >= 0 } ?: 0)
            }
            "ended" -> Incoming.Ended(o.optString("reason").ifEmpty { "ended" })
            else -> Incoming.Ignored
        }
    }

    /** A stop for session [stopId] ends [currentId]; no id means "whatever is on screen". */
    fun stopApplies(currentId: String?, stopId: String?): Boolean =
        currentId != null && (stopId.isNullOrEmpty() || stopId == currentId)

    /*
     * ------------------------------------------------------------ several presenters at once
     *
     * The same rules as the web receiver's rects() / visibleIds() / audioId(), on plain session-id
     * lists (oldest first), so the controller (sound), the overlay (tiles) and the capture agree.
     */

    /**
     * device:screenshare-layout {spotlight, audio, count}, in THIS screen's session ids: [spotlight]
     * fills the screen (null: tiles; the others stay connected, hidden), [audio] is the one session
     * whose sound plays. Anything malformed is "no preference" — the same as the web's typeof checks.
     */
    data class Layout(val spotlight: String?, val audio: String?, val count: Int) {
        companion object { val NONE = Layout(null, null, 0) }
    }

    fun parseLayout(o: JSONObject?): Layout {
        if (o == null) return Layout.NONE
        fun id(key: String) = (o.opt(key) as? String)?.takeIf { SESSION_ID.matches(it) }
        val count = (o.opt("count") as? Number)?.toInt()?.coerceAtLeast(0) ?: 0
        return Layout(id("spotlight"), id("audio"), count)
    }

    /** A tile, in fractions of the overlay: left, top, width, height. */
    data class Rect(val x: Float, val y: Float, val w: Float, val h: Float)

    /**
     * Tile rectangles for [n] visible tiles: 1 full; 2 side by side, or stacked when the screen is
     * taller than wide ([portrait]); 3-4 a 2x2 grid (three: the third centred underneath).
     */
    fun rects(n: Int, portrait: Boolean): List<Rect> = when {
        n <= 1 -> listOf(Rect(0f, 0f, 1f, 1f))
        n == 2 -> if (portrait) listOf(Rect(0f, 0f, 1f, 0.5f), Rect(0f, 0.5f, 1f, 0.5f))
                  else listOf(Rect(0f, 0f, 0.5f, 1f), Rect(0.5f, 0f, 0.5f, 1f))
        n == 3 -> listOf(Rect(0f, 0f, 0.5f, 0.5f), Rect(0.5f, 0f, 0.5f, 0.5f), Rect(0.25f, 0.5f, 0.5f, 0.5f))
        else -> listOf(Rect(0f, 0f, 0.5f, 0.5f), Rect(0.5f, 0f, 0.5f, 0.5f), Rect(0f, 0.5f, 0.5f, 0.5f), Rect(0.5f, 0.5f, 0.5f, 0.5f))
    }

    /** What is on screen: only the spotlighted session when it is one of ours, else the oldest MAX_TILES. */
    fun visibleIds(order: List<String>, layout: Layout): List<String> {
        val spot = layout.spotlight
        return if (spot != null && spot in order) listOf(spot) else order.take(MAX_TILES)
    }

    /** Whose sound plays: the server's choice when it names one of ours, else the newest session. */
    fun audioId(order: List<String>, layout: Layout): String? {
        val a = layout.audio
        return if (a != null && a in order) a else order.lastOrNull()
    }

    /**
     * The sessions to end (reason "replaced") so one more fits: the OLDEST, never more than MAX_TILES
     * on screen. The server never sends a fifth; this is the backstop, as in the web receiver.
     */
    fun toReplace(order: List<String>): List<String> = order.take(maxOf(0, order.size - MAX_TILES + 1))

    /** The frame round each tile: none for a lone tile (exactly as a single share always looked). */
    fun tileBorderPx(visible: Int): Int = if (visible > 1) TILE_BORDER_PX else 0

    /** "{name}" substitution, the same as the web receiver's fmt(). */
    fun fmt(template: String, name: String): String = template.replace("{name}", name)

    fun badgeText(sharedByTemplate: String, guestWord: String, sharedBy: String, guest: Boolean): String =
        fmt(sharedByTemplate, sharedBy) + if (guest) " · $guestWord" else ""

    /** device:screenshare-code. Null = hide the corner badge. */
    data class Code(val code: String, val shownUrl: String, val qrPngBase64: String?)

    fun parseCode(o: JSONObject?): Code? {
        val code = o?.opt("code") as? String ?: return null
        if (code.isBlank() || code.length > 32) return null
        // Only a data: PNG from our own server is used as the QR; anything else is ignored.
        val qr = (o.opt("qr") as? String)?.let { QR_DATA_URL.matchEntire(it)?.groupValues?.get(1) }
        val url = (o.opt("url") as? String)?.takeIf { it.isNotBlank() } ?: "/share"
        return Code(code, url.replace(Regex("^https?://", RegexOption.IGNORE_CASE), ""), qr)
    }

    /** The largest [vw]x[vh] box that fits [pw]x[ph] (object-fit: contain), for the share's letterbox. */
    fun fit(pw: Int, ph: Int, vw: Int, vh: Int): Pair<Int, Int> {
        if (pw <= 0 || ph <= 0 || vw <= 0 || vh <= 0) return Pair(pw, ph)
        return if (vw.toLong() * ph >= vh.toLong() * pw) Pair(pw, (pw.toLong() * vh / vw).toInt())
        else Pair((ph.toLong() * vw / vh).toInt(), ph)
    }
}
