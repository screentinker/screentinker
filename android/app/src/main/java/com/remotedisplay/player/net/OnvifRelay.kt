package com.remotedisplay.player.net

import android.util.Log
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.MulticastSocket
import java.net.Proxy
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * This screen as the ONVIF bridge for cameras on its own network.
 *
 * The hosted server cannot reach a customer's 192.168.x.x; the screen is standing on it. The
 * server keeps ALL the ONVIF logic (server/lib/onvif/soap.js, camera.js) and asks the screen, over
 * the `onvif_relay` command, to do exactly one of three things on the LAN and hand back the bytes:
 *
 *   probe  send the fixed WS-Discovery Probe (multicast, or one host's :3702) and collect replies;
 *   soap   POST a SOAP envelope to a private-network http(s) address;
 *   get    GET a snapshot image from a private-network http(s) address.
 *
 * The answer goes back as `device:onvif-result` (server/lib/onvif/relay.js, handleResult).
 *
 * ⚠️ THE LIMITS HERE ARE THE POINT, AND THEY ARE ENFORCED HERE, NOT TRUSTED FROM THE SERVER. The
 * server applies the same rules, but a screen must never become a general web proxy for whoever
 * controls (or impersonates) its server: private destinations only, every resolved address
 * checked and then pinned, no redirects, fixed request headers, hard size caps, short timeouts,
 * and at most [MAX_IN_FLIGHT] operations at once. Unlike [DeviceHttp] (an operator's own request
 * to the PLC next door, where public addresses are allowed) this door only ever leads to a camera.
 */
object OnvifRelay {

    private const val TAG = "OnvifRelay"

    /** A SOAP request we send. ONVIF envelopes are a few KiB; 64 KiB is generous. */
    const val MAX_SOAP_REQUEST_BYTES = 64 * 1024
    /** A SOAP reply we read. GetProfiles on a 16-channel NVR is the large case, well under this. */
    const val MAX_SOAP_REPLY_BYTES = 1024 * 1024
    /** A snapshot, the same ceiling as a screenshot (server MAX_SNAPSHOT_BYTES). */
    const val MAX_IMAGE_BYTES = 2 * 1024 * 1024
    const val MAX_PROBE_REPLIES = 64
    const val MAX_PROBE_DATAGRAM = 64 * 1024

    const val DEFAULT_HTTP_TIMEOUT_MS = 8_000L
    const val MAX_HTTP_TIMEOUT_MS = 15_000L
    const val DEFAULT_PROBE_TIMEOUT_MS = 3_000L
    const val MAX_PROBE_TIMEOUT_MS = 10_000L

    /**
     * ⚠️ A 5th concurrent operation is refused with `busy`, not queued. Each one can hold a socket
     * for up to 15 s; a server (or a loop on it) that fires dozens must not be able to pile worker
     * threads and sockets onto a panel whose job is playing signage.
     */
    const val MAX_IN_FLIGHT = 4
    private val inFlight = AtomicInteger(0)

    const val DISCOVERY_ADDR = "239.255.255.250"
    const val DISCOVERY_PORT = 3702

    /** The request headers that are passed through. Everything else the server sends is dropped. */
    private val PASS_HEADERS = setOf("content-type", "authorization")

    // ─── The request ────────────────────────────────────────────────────────────────────────

    /** A validated payload. Built only by [parse]. */
    data class Op(
        val id: String,
        val op: String,              // probe | soap | get
        val timeoutMs: Long,
        val url: HttpUrl?,           // soap / get
        val body: String,            // soap
        val headers: Map<String, String>,
        val host: String?            // probe, optional
    )

    sealed class Parsed {
        data class Ok(val op: Op) : Parsed()
        data class Bad(val id: String, val error: String) : Parsed()
    }

    /**
     * Validate a payload against the contract and this player's own limits. Pure: no network, no
     * DNS — the private-address check on the destination happens after this, at resolve time.
     */
    fun parse(payload: JSONObject?): Parsed {
        val id = payload?.optString("id", "") ?: ""
        if (payload == null || id.isBlank()) return Parsed.Bad(id, "bad-request")
        val op = payload.optString("op", "")
        if (op !in setOf("probe", "soap", "get")) return Parsed.Bad(id, "bad-op")

        // A missing or junk timeout is the default; anything larger is cut to the cap.
        val raw = payload.optLong("timeout_ms", 0L)
        val timeout = if (op == "probe") {
            (if (raw > 0) raw else DEFAULT_PROBE_TIMEOUT_MS).coerceIn(500L, MAX_PROBE_TIMEOUT_MS)
        } else {
            (if (raw > 0) raw else DEFAULT_HTTP_TIMEOUT_MS).coerceIn(500L, MAX_HTTP_TIMEOUT_MS)
        }

        if (op == "probe") {
            val host = payload.optString("host", "").trim().ifEmpty { null }
            return Parsed.Ok(Op(id, op, timeout, null, "", emptyMap(), host))
        }

        val url = parseUrl(payload.optString("url", "")) ?: return Parsed.Bad(id, "bad-url")
        val body = if (op == "soap") payload.optString("body", "") else ""
        if (body.toByteArray(Charsets.UTF_8).size > MAX_SOAP_REQUEST_BYTES) return Parsed.Bad(id, "body-too-large")
        return Parsed.Ok(Op(id, op, timeout, url, body, filterHeaders(payload.optJSONObject("headers")), null))
    }

    /** http/https only. Any other scheme (file:, content:, ftp:) is not a URL to us. */
    fun parseUrl(raw: String?): HttpUrl? {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null
        val scheme = s.substringBefore(':', "").lowercase()
        if (scheme != "http" && scheme != "https") return null
        return s.toHttpUrlOrNull()
    }

    /**
     * Keep only `content-type` and `authorization` (any case), with their names lowercased.
     *
     * ⚠️ An allowlist, not a denylist: Host, Cookie, X-Forwarded-For, Connection, Transfer-Encoding
     * and whatever comes next are all things a relay should not let someone else set. A value
     * with CR or LF is dropped — it could only be an attempt to inject a second header.
     */
    fun filterHeaders(h: JSONObject?): Map<String, String> {
        if (h == null) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (k in h.keys()) {
            val name = k.lowercase()
            if (name !in PASS_HEADERS) continue
            val v = h.opt(k) as? String ?: continue
            if (v.isEmpty() || v.contains('\r') || v.contains('\n')) continue
            out[name] = v
        }
        return out
    }

    // ─── Private addresses ──────────────────────────────────────────────────────────────────

    /**
     * Is [a] on a private network: 10/8, 172.16/12, 192.168/16, 169.254/16 (not .169.254), 100.64/10 (CGNAT,
     * also Tailscale), fc00::/7 (ULA), fe80::/10 (link-local)?
     *
     * Everything else is refused, and explicitly so for loopback (127/8, ::1 — the panel's own
     * services, e.g. the local REST API, are not a camera), 0.0.0.0/::, multicast and every public
     * address. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is judged as the IPv4 it carries, so
     * ::ffff:127.0.0.1 is loopback and ::ffff:8.8.8.8 is public.
     */
    fun isPrivate(a: InetAddress): Boolean {
        val b = a.address
        if (a is Inet4Address || b.size == 4) return isPrivateV4(b)
        if (b.size != 16) return false
        // ::ffff:a.b.c.d — Java usually hands these back as Inet4Address already; the bytes are
        // checked anyway in case an Inet6Address with a mapped payload reaches here.
        if ((0 until 10).all { b[it].toInt() == 0 } && b[10].toInt() == -1 && b[11].toInt() == -1) {
            return isPrivateV4(b.copyOfRange(12, 16))
        }
        val b0 = b[0].toInt() and 0xff
        val b1 = b[1].toInt() and 0xff
        if ((b0 and 0xfe) == 0xfc) return true                     // fc00::/7
        if (b0 == 0xfe && (b1 and 0xc0) == 0x80) return true       // fe80::/10
        return false
    }

    private fun isPrivateV4(b: ByteArray): Boolean {
        val o0 = b[0].toInt() and 0xff
        val o1 = b[1].toInt() and 0xff
        return when {
            o0 == 10 -> true
            o0 == 172 && o1 in 16..31 -> true
            o0 == 192 && o1 == 168 -> true
            // Link-local (cameras with no DHCP use it), EXCEPT 169.254.169.254: the cloud metadata
            // address, refused everywhere else in the app (DeviceHttp) and no camera's.
            o0 == 169 && o1 == 254 -> !((b[2].toInt() and 0xff) == 169 && (b[3].toInt() and 0xff) == 254)
            o0 == 100 && o1 in 64..127 -> true
            else -> false
        }
    }

    /**
     * Resolve [host] and return its addresses only if EVERY one is private, else null.
     *
     * "Every", not "any": a name answering with one LAN and one public address must not be a way
     * to reach the public one. The list returned is then PINNED into the connection (see
     * [httpClient]) so the address checked is the address connected to — no second lookup that a
     * hostile resolver could answer differently (DNS rebinding).
     */
    fun resolvePrivate(
        host: String,
        resolve: (String) -> List<InetAddress> = { InetAddress.getAllByName(it).toList() }
    ): List<InetAddress>? {
        val addrs = try { resolve(host.trim('[', ']')) } catch (e: Throwable) { return null }
        if (addrs.isEmpty() || !addrs.all { isPrivate(it) }) return null
        return addrs
    }

    // ─── Running it ─────────────────────────────────────────────────────────────────────────

    /**
     * Run one relay operation and build the reply (without `device_id`, which the caller adds).
     * BLOCKING — call it off the main thread. Never throws: every path, including a refusal,
     * `busy` and an unexpected exception, returns exactly one reply, because silence on the server
     * is a 10-second "the screen did not answer" instead of a reason.
     *
     * @param multicastLock acquires the Wi-Fi multicast lock for the duration of a probe and
     *        returns its release; null where there is no Wi-Fi (or in tests).
     */
    fun perform(payload: JSONObject?, multicastLock: (() -> (() -> Unit))? = null): JSONObject {
        val idForErrors = payload?.optString("id", "") ?: ""
        if (inFlight.incrementAndGet() > MAX_IN_FLIGHT) {
            inFlight.decrementAndGet()
            return error(idForErrors, "busy")
        }
        try {
            val op = when (val p = parse(payload)) {
                is Parsed.Bad -> return error(p.id, p.error)
                is Parsed.Ok -> p.op
            }
            return when (op.op) {
                "probe" -> probe(op, multicastLock)
                else -> http(op)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "relay failed: ${e.message}")
            return error(idForErrors, shortMessage(e))
        } finally {
            inFlight.decrementAndGet()
        }
    }

    fun error(id: String, message: String): JSONObject =
        JSONObject().put("id", id).put("ok", false).put("error", message)

    private fun shortMessage(e: Throwable): String = when (e) {
        is SocketTimeoutException -> "timeout"
        is java.io.InterruptedIOException -> "timeout"
        else -> (e.message ?: e.javaClass.simpleName).take(200)
    }

    private fun http(op: Op): JSONObject {
        val url = op.url ?: return error(op.id, "bad-url")
        val vetted = resolvePrivate(url.host) ?: return error(op.id, "not-private")

        val builder = Request.Builder().url(url)
        for ((k, v) in op.headers) builder.header(k, v)
        if (op.op == "soap") {
            // The body's media type travels in the passed-through Content-Type header; null here so
            // OkHttp does not add a second one of its own.
            builder.post(op.body.toByteArray(Charsets.UTF_8).toRequestBody(null))
            if (!op.headers.containsKey("content-type")) builder.header("content-type", "application/soap+xml; charset=utf-8")
        } else {
            builder.get()
        }

        return try {
            httpClient(url, vetted, op.timeoutMs).newCall(builder.build()).execute().use { resp ->
                if (op.op == "soap") soapReply(op.id, resp) else getReply(op.id, resp)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "${op.op} failed: ${e.message}")
            error(op.id, shortMessage(e))
        }
    }

    /** Any status is a reply: the server needs the 401 challenge and the SOAP fault bodies. */
    private fun soapReply(id: String, resp: Response): JSONObject {
        val bytes = readUpTo(resp.body?.byteStream(), MAX_SOAP_REPLY_BYTES) ?: return error(id, "too-large")
        return baseReply(id, resp).put("body", String(bytes, Charsets.UTF_8))
    }

    private fun getReply(id: String, resp: Response): JSONObject {
        val out = baseReply(id, resp)
        // Only a 200 is worth reading; a 401 or 404 is reported by its status alone.
        if (resp.code != 200) return out
        val bytes = readUpTo(resp.body?.byteStream(), MAX_IMAGE_BYTES) ?: return error(id, "too-large")
        val type = resp.header("Content-Type")?.trim()?.lowercase() ?: ""
        // Some cameras serve a JPEG as text/plain or application/octet-stream: trust the magic too.
        if (type.startsWith("image/") || isJpeg(bytes)) {
            out.put("body_b64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        }
        return out
    }

    fun isJpeg(b: ByteArray): Boolean =
        b.size >= 3 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte() && b[2] == 0xFF.toByte()

    private fun baseReply(id: String, resp: Response): JSONObject {
        val headers = JSONObject()
        val challenges = resp.headers("WWW-Authenticate")
        when (challenges.size) {
            0 -> {}
            // A camera offering Digest AND Basic sends two headers; both go back, as a list.
            1 -> headers.put("www-authenticate", challenges[0])
            else -> headers.put("www-authenticate", JSONArray(challenges.take(4)))
        }
        resp.header("Content-Type")?.let { headers.put("content-type", it) }
        return JSONObject()
            .put("id", id)
            .put("ok", resp.code in 200..299)
            .put("status", resp.code)
            .put("headers", headers)
    }

    /**
     * Read the whole stream if it is at most [cap] bytes, else null.
     *
     * ⚠️ A read limit, not a Content-Length check (same reasoning as [DeviceHttp.MAX_BODY_BYTES]):
     * a broken or hostile endpoint can declare anything. Unlike DeviceHttp this does not truncate —
     * half a SOAP reply or half a JPEG is useless, so over the cap is an error (`too-large`).
     */
    fun readUpTo(stream: InputStream?, cap: Int): ByteArray? {
        if (stream == null) return ByteArray(0)
        val out = java.io.ByteArrayOutputStream(minOf(cap, 64 * 1024))
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = stream.read(buf)
            if (n < 0) break
            total += n
            if (total > cap) return null
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /**
     * An OkHttp client for ONE relay request: pinned DNS, no redirects, no proxy, and no
     * certificate verification.
     *
     * ⚠️ NO CERTIFICATE VERIFICATION, AND ONLY HERE. Cameras on a LAN serve https with a
     * self-signed certificate (or one for a name nobody can resolve); verifying it would make
     * every https camera unreachable. That is acceptable for THIS relay only because the
     * destination has already been checked to be a private address and is pinned; the client is
     * built per request and never shared with the rest of the app, which keeps normal TLS.
     *
     * ⚠️ Proxy.NO_PROXY: through a configured HTTP proxy the PROXY would resolve and connect, and
     * the pinned address would be decoration.
     */
    private fun httpClient(url: HttpUrl, vetted: List<InetAddress>, timeoutMs: Long): OkHttpClient {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustAll), SecureRandom()) }
        return OkHttpClient.Builder()
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            // A 3xx is returned as its status. Following it would be a second destination nobody
            // checked — the oldest way round an address rule.
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .proxy(Proxy.NO_PROXY)
            .dns(object : Dns {
                // Only the checked host is answerable at all; anything else is refused rather than
                // looked up.
                override fun lookup(hostname: String): List<InetAddress> =
                    if (hostname.equals(url.host, ignoreCase = true)) vetted
                    else throw java.net.UnknownHostException("not-private")
            })
            .sslSocketFactory(ssl.socketFactory, trustAll)
            .hostnameVerifier { _, _ -> true }
            .build()
    }

    // ─── WS-Discovery ───────────────────────────────────────────────────────────────────────

    /**
     * The Probe, byte for byte the server's probeMessage() (server/lib/onvif/soap.js): same
     * namespaces, same element order, so a capture from either side looks the same and a camera
     * that answers the server's probe answers this one.
     */
    fun probeMessage(messageId: String = "uuid:${java.util.UUID.randomUUID()}"): String =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:a=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\">" +
            "<s:Header><a:Action s:mustUnderstand=\"1\">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>" +
            "<a:MessageID>${xmlEscape(messageId)}</a:MessageID>" +
            "<a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>" +
            "<a:To s:mustUnderstand=\"1\">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header>" +
            "<s:Body><Probe xmlns=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\"><Types xmlns:dn=\"http://www.onvif.org/ver10/network/wsdl\">dn:NetworkVideoTransmitter</Types></Probe></s:Body></s:Envelope>"

    private fun xmlEscape(v: String): String = buildString {
        for (c in v) append(
            when (c) {
                '<' -> "&lt;"; '>' -> "&gt;"; '&' -> "&amp;"; '\'' -> "&apos;"; '"' -> "&quot;"
                else -> c.toString()
            }
        )
    }

    /**
     * Send the Probe twice, 300 ms apart (UDP is lossy and many cameras answer the second one more
     * reliably), and collect every reply until the deadline. An empty list is a valid answer: no
     * cameras answered.
     */
    private fun probe(op: Op, multicastLock: (() -> (() -> Unit))?): JSONObject {
        val target: InetAddress = if (op.host != null) {
            // A unicast probe is held to the same rule as soap/get: a private address, every one.
            (resolvePrivate(op.host) ?: return error(op.id, "not-private")).first()
        } else {
            InetAddress.getByName(DISCOVERY_ADDR)
        }

        val release = try { multicastLock?.invoke() } catch (e: Throwable) {
            Log.w(TAG, "multicast lock: ${e.message}"); null
        }
        val replies = JSONArray()
        try {
            MulticastSocket(0).use { sock ->
                // TTL 1: a discovery probe never leaves this subnet.
                if (target.isMulticastAddress) sock.timeToLive = 1
                val msg = probeMessage().toByteArray(Charsets.UTF_8)
                val packet = DatagramPacket(msg, msg.size, target, DISCOVERY_PORT)
                val start = System.currentTimeMillis()
                val deadline = start + op.timeoutMs
                val secondAt = start + 300
                var secondSent = false
                sock.send(packet)
                val buf = ByteArray(MAX_PROBE_DATAGRAM + 1)
                while (replies.length() < MAX_PROBE_REPLIES) {
                    val now = System.currentTimeMillis()
                    if (now >= deadline) break
                    if (!secondSent && now >= secondAt) { sock.send(packet); secondSent = true }
                    val wakeAt = if (secondSent) deadline else minOf(deadline, secondAt)
                    sock.soTimeout = maxOf(1L, wakeAt - now).toInt()
                    val dp = DatagramPacket(buf, buf.size)
                    try { sock.receive(dp) } catch (e: SocketTimeoutException) { continue }
                    if (dp.length > MAX_PROBE_DATAGRAM) continue
                    replies.put(JSONObject()
                        .put("from", dp.address?.hostAddress ?: "")
                        .put("xml", String(dp.data, dp.offset, dp.length, Charsets.UTF_8)))
                }
            }
        } finally {
            try { release?.invoke() } catch (e: Throwable) { /* already released */ }
        }
        return JSONObject().put("id", op.id).put("ok", true).put("replies", replies)
    }
}
