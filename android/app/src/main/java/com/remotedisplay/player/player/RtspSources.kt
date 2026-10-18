package com.remotedisplay.player.player

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import java.net.InetAddress
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.SocketFactory
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * The one place an RTSP camera becomes an ExoPlayer source: full screen (MediaPlayerManager), zones
 * (ZoneManager) and wall zones (WallZoneRenderer) all build it here.
 *
 * Always TCP-interleaved, so it works through NAT and on cameras that refuse UDP. rtsps:// (RTSP over
 * TLS, UniFi Protect's default share link) is the same session on a TLS socket: media3 opens its
 * control connection through the factory's SocketFactory, and with TCP interleaving the video rides
 * that connection, so wrapping the socket is the whole of RTSPS. No extra library.
 *
 * ⚠️ The certificate is CHECKED (the system's trusted authorities, plus the host name) unless the
 * item says tls_self_signed, which the operator ticks for a camera whose certificate is self-signed.
 * That still encrypts; it only stops checking who is on the other end, for that camera alone.
 */
object RtspSources {
    fun create(url: String, selfSigned: Boolean): RtspMediaSource {
        val factory = RtspMediaSource.Factory().setForceUseRtpTcp(true)
        // Every connection, plain or TLS, goes through RtspOpusFix: media3 cannot play standard RTP
        // Opus on its own, and one Opus track takes the whole stream down (UniFi offers Opus beside AAC).
        val target = if (RtspUrl.isRtsps(url)) {
            factory.setSocketFactory(OpusFixSocketFactory(TlsSocketFactory(selfSigned)))
            RtspUrl.withoutSrtp(RtspUrl.withDefaultPort(url))
        } else {
            factory.setSocketFactory(OpusFixSocketFactory(SocketFactory.getDefault()))
            url
        }
        return factory.createMediaSource(MediaItem.fromUri(Uri.parse(target)))
    }

    /** Wraps each socket [inner] makes in RtspOpusFix.FixingSocket. */
    private class OpusFixSocketFactory(private val inner: SocketFactory) : SocketFactory() {
        private fun wrap(s: Socket): Socket = RtspOpusFix.FixingSocket(s)
        override fun createSocket(): Socket = inner.createSocket()
        override fun createSocket(host: String, port: Int): Socket = wrap(inner.createSocket(host, port))
        override fun createSocket(host: String, port: Int, local: InetAddress?, localPort: Int): Socket =
            wrap(inner.createSocket(host, port, local, localPort))
        override fun createSocket(host: InetAddress, port: Int): Socket = wrap(inner.createSocket(host, port))
        override fun createSocket(address: InetAddress, port: Int, local: InetAddress?, localPort: Int): Socket =
            wrap(inner.createSocket(address, port, local, localPort))
    }

    /**
     * Opens TLS sockets for media3's RTSP client. media3 calls createSocket(host, port); the other
     * overloads are here because SocketFactory declares them.
     */
    private class TlsSocketFactory(private val selfSigned: Boolean) : SocketFactory() {
        private val tls: SSLSocketFactory = if (selfSigned) {
            SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(AcceptAny), SecureRandom()) }.socketFactory
        } else SSLSocketFactory.getDefault() as SSLSocketFactory

        private fun checked(s: Socket, host: String): Socket {
            val ssl = s as SSLSocket
            ssl.startHandshake()
            if (!selfSigned && !HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.session)) {
                try { ssl.close() } catch (_: Throwable) {}
                throw SSLHandshakeException("camera certificate does not match $host")
            }
            return ssl
        }

        override fun createSocket(): Socket = tls.createSocket()
        override fun createSocket(host: String, port: Int): Socket = checked(tls.createSocket(host, port), host)
        override fun createSocket(host: String, port: Int, local: InetAddress?, localPort: Int): Socket =
            checked(tls.createSocket(host, port, local, localPort), host)
        override fun createSocket(host: InetAddress, port: Int): Socket =
            checked(tls.createSocket(host, port), host.hostAddress ?: host.hostName)
        override fun createSocket(address: InetAddress, port: Int, local: InetAddress?, localPort: Int): Socket =
            checked(tls.createSocket(address, port, local, localPort), address.hostAddress ?: address.hostName)
    }

    /** Only for an item the operator marked tls_self_signed. */
    @Suppress("CustomX509TrustManager", "TrustAllX509TrustManager")
    private object AcceptAny : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}

/** String rules for camera URLs, kept free of Android types so they run as JVM unit tests. */
object RtspUrl {
    /** RTSPS's registered port. media3 assumes 554 (plain RTSP) when a URL has none. */
    const val RTSPS_DEFAULT_PORT = 322

    fun isRtsps(url: String?): Boolean = url != null && url.trim().startsWith("rtsps://", ignoreCase = true)

    /** rtsps://host/x becomes rtsps://host:322/x; a URL that names its port is returned as it is. */
    fun withDefaultPort(url: String): String {
        val schemeEnd = url.indexOf("://")
        if (schemeEnd < 0) return url
        val start = schemeEnd + 3
        val pathAt = url.indexOfAny(charArrayOf('/', '?', '#'), start).let { if (it < 0) url.length else it }
        val authority = url.substring(start, pathAt)
        val hostPort = authority.substringAfterLast('@')
        val hasPort = if (hostPort.startsWith("[")) hostPort.substringAfter("]").startsWith(":")
                      else hostPort.contains(':')
        if (hasPort) return url
        return url.substring(0, pathAt) + ":" + RTSPS_DEFAULT_PORT + url.substring(pathAt)
    }

    /**
     * The URL without UniFi's `enableSrtp` query parameter. With it, the camera encrypts every RTP
     * payload with SRTP (the SDP carries a=crypto keys), and media3 has no SRTP: each track's reader
     * got ciphertext and failed (HEVC "decoding failed", AAC and Opus parse errors). Over rtsps the
     * RTP rides the TLS connection anyway, so SRTP inside it protects nothing more. Only applied to
     * rtsps: on plain rtsp it would be the only encryption.
     */
    fun withoutSrtp(url: String): String {
        val q = url.indexOf('?')
        if (q < 0) return url
        val hash = url.indexOf('#', q).let { if (it < 0) url.length else it }
        val kept = url.substring(q + 1, hash).split('&')
            .filter { it.isNotEmpty() && !it.substringBefore('=').equals("enableSrtp", ignoreCase = true) }
        return url.substring(0, q) + (if (kept.isEmpty()) "" else "?" + kept.joinToString("&")) + url.substring(hash)
    }

    /**
     * The URL with any password or share token replaced, for logs. rtsp://user:pass@cam ->
     * rtsp://user:***@cam, and the token of a UniFi share link (rtsps://nvr:7441/<token>) becomes
     * three stars: the token opens the stream on its own. Same token rule as the server's
     * isSecretPathSegment.
     */
    fun redact(url: String?): String {
        if (url == null) return "null"
        return url.replace(Regex("""^(\w+://[^/@:]*):[^/@]*@"""), "$1:***@")
            .replace(PATH_TOKEN, "***")
    }

    private val PATH_TOKEN = Regex("""(?<=/)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{16,}(?=[/?#]|$)""")
}
