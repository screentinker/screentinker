package com.remotedisplay.player.remote

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * #talk — the device half of the two-way voice intercom.
 *
 * Counterpart of the dashboard's push-to-talk. Two-way audio rides two one-directional Opus streams
 * through go2rtc (go2rtc streams are single-producer, so a call needs one each way):
 *   downlink: operator mic -> this device's speaker  — this device SUBSCRIBES (recvonly)
 *   uplink:   this device's mic -> operator speaker  — this device PUBLISHES (sendonly)
 * Both legs use the same WebSocket + trickle-ICE signaling as [LiveVideoPublisher] (native libwebrtc
 * drops go2rtc's inline HTTP candidates), through the device-authenticated proxy routes
 *   .../api/devices/:id/talk/subscribe/ws   (src = downlink)
 *   .../api/devices/:id/talk/publish/ws     (dst = uplink)
 *
 * A single [PeerConnectionFactory] with a [JavaAudioDeviceModule] serves both legs: the ADM captures
 * the mic for the uplink track and plays the downlink audio out of the speaker automatically, with
 * hardware echo-cancellation so the operator does not hear themselves back. No MediaProjection — just
 * RECORD_AUDIO.
 *
 * Lifecycle rules that this class is careful about (a native SIGSEGV taught them):
 *  - ALL create/dispose runs on a single [ctl] thread, never on a WebRTC callback thread. Disposing
 *    a PeerConnection from inside its own Observer crashes libwebrtc, so callbacks only POST to ctl.
 *  - A single leg failing does NOT tear down the call. Intercom is a mutual-subscribe race (each side
 *    subscribes to the other's stream), so a subscribe can legitimately fail until the far side's
 *    producer exists — each leg RETRIES with backoff. Only an external stop() tears everything down.
 *  - The uplink (our producer) starts first so the operator's subscribe has something to attach to.
 *
 * ⚠️ Requires the io.getstream:stream-webrtc-android AAR (org.webrtc.*). Build + flash to verify.
 */
class AudioTalker(
    private val appContext: Context,
    private val serverUrl: String,
    private val deviceId: String,
    private val deviceToken: String,
) {
    private val tag = "AudioTalker"
    private val wsClient = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    // Every factory/PC/track create + dispose is serialized here, off the WebRTC threads.
    private val ctl = Executors.newSingleThreadExecutor { r -> Thread(r, "talk-audio-ctl") }

    // Run a lifecycle task on ctl, tolerating a shutdown ctl: a leg's delayed retry can fire after
    // stop() has shut the executor down, and an un-guarded execute would throw
    // RejectedExecutionException on the main thread (a real crash we hit). Swallow it — stop() has
    // already torn everything down.
    private fun submit(block: () -> Unit) {
        try { if (!ctl.isShutdown) ctl.execute(block) } catch (_: RejectedExecutionException) {}
    }

    private var factory: PeerConnectionFactory? = null
    private var adm: JavaAudioDeviceModule? = null
    private var eglBase: EglBase? = null   // #talk video: shared with the renderer in MainActivity
    private var micSource: AudioSource? = null
    private var micTrack: AudioTrack? = null
    private var downlink: Leg? = null
    private var uplink: Leg? = null
    @Volatile private var stopped = false
    @Volatile private var active = false

    val isActive: Boolean get() = active

    /**
     * Duplex (per-device) talk: [listenScope] null. Broadcast (one-way PA) listen: pass a
     * scope [kind]/[id] and only the downlink runs (no mic, no uplink) — the device just plays the
     * shared group/workspace channel.
     */
    fun start(iceServers: List<PeerConnection.IceServer>, listenScopeKind: String? = null, listenScopeId: String? = null, duplex: Boolean = true) {
        submit {
            if (active || stopped) return@submit
            val listen = listenScopeKind != null && listenScopeId != null
            try {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions()
                )
                val module = JavaAudioDeviceModule.builder(appContext)
                    .setUseHardwareAcousticEchoCanceler(true)
                    .setUseHardwareNoiseSuppressor(true)
                    .createAudioDeviceModule().also { adm = it }
                // #talk video: an EglBase + hardware/software video decoder so a subscribe leg can
                // decode the operator's webcam. The renderer in MainActivity shares this EglBase.
                val egl = EglBase.create().also { eglBase = it }
                val f = PeerConnectionFactory.builder()
                    .setAudioDeviceModule(module)
                    .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                    .createPeerConnectionFactory()
                    .also { factory = it }

                if (listen) {
                    // Listen-only broadcast: subscribe the shared channel and play it. No mic.
                    val q = "&scopeKind=" + enc(listenScopeKind!!) + "&scopeId=" + enc(listenScopeId!!)
                    downlink = Leg("talk/listen", RtpTransceiver.RtpTransceiverDirection.RECV_ONLY, null, iceServers, q).also { it.start() }
                    active = true
                    Log.i(tag, "talk started (broadcast listen $listenScopeKind:$listenScopeId)")
                } else {
                    // Per-device: the downlink (play the operator + show webcam) always runs. The
                    // uplink (our mic -> operator) only for a 2-way call; one-way needs no mic.
                    if (duplex) {
                        val src = f.createAudioSource(MediaConstraints()).also { micSource = it }
                        val track = f.createAudioTrack("talk_mic", src).also { micTrack = it }
                        uplink = Leg("talk/publish", RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, track, iceServers).also { it.start() }
                    }
                    downlink = Leg("talk/subscribe", RtpTransceiver.RtpTransceiverDirection.RECV_ONLY, null, iceServers).also { it.start() }
                    active = true
                    Log.i(tag, "talk started (per-device ${if (duplex) "two-way" else "one-way"})")
                }
            } catch (t: Throwable) {
                Log.e(tag, "start failed: ${t.message}", t)
                teardown()
            }
        }
    }

    fun stop() {
        if (stopped) return
        stopped = true
        active = false
        submit { teardown() }
        ctl.shutdown()
    }

    // Runs only on ctl. Disposes in a crash-safe order: legs' PeerConnections first, then the mic,
    // then the factory, then the audio module.
    private fun teardown() {
        try { TalkVideoBus.publish(null, null) } catch (_: Throwable) {}   // clear the fullscreen renderer
        try { downlink?.dispose() } catch (_: Throwable) {}
        try { uplink?.dispose() } catch (_: Throwable) {}
        try { micTrack?.dispose() } catch (_: Throwable) {}
        try { micSource?.dispose() } catch (_: Throwable) {}
        try { factory?.dispose() } catch (_: Throwable) {}
        try { adm?.release() } catch (_: Throwable) {}
        try { eglBase?.release() } catch (_: Throwable) {}
        downlink = null; uplink = null; micTrack = null; micSource = null; factory = null; adm = null; eglBase = null
        Log.i(tag, "talk stopped")
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
    private fun msg(type: String, value: String) = JSONObject().put("type", type).put("value", value).toString()

    /**
     * One WebRTC audio direction: a PeerConnection plus its WebSocket trickle signaling to the given
     * proxy [path]. [track] is the mic for the sendonly (uplink) leg, null for the recvonly
     * (downlink) leg — whose received audio the ADM plays automatically. Retries on failure because
     * a subscribe can precede the far side's producer.
     */
    private inner class Leg(
        private val path: String,
        private val direction: RtpTransceiver.RtpTransceiverDirection,
        private val track: AudioTrack?,
        private val iceServers: List<PeerConnection.IceServer>,
        private val extraQuery: String = "",   // appended to the WS URL (broadcast scope params)
    ) {
        private val maxAttempts = 6
        private val backoffMs = longArrayOf(1000, 1500, 2000, 2500, 3000)
        private var attempt = 0
        private var pc: PeerConnection? = null
        private var ws: WebSocket? = null
        @Volatile private var wsOpen = false
        @Volatile private var connected = false
        @Volatile private var disposed = false
        private val pendingLocal = ArrayList<IceCandidate>()

        // Always called on ctl.
        fun start() {
            if (disposed || stopped) return
            attempt++
            val f = factory ?: return
            val cfg = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }
            val conn = f.createPeerConnection(cfg, Observer()) ?: run { Log.e(tag, "[$path] createPeerConnection null"); return retryLater() }
            pc = conn
            val init = RtpTransceiver.RtpTransceiverInit(direction)
            if (track != null) {
                conn.addTransceiver(track, init)   // sendonly mic
            } else {
                // recvonly: audio always, plus video so the operator's webcam (optional) is received.
                conn.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, init)
                conn.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, init)
            }
            conn.createOffer(object : SimpleSdp("[$path] createOffer") {
                override fun onCreateSuccess(sdp: SessionDescription) {
                    conn.setLocalDescription(object : SimpleSdp("[$path] setLocalDescription") {
                        override fun onSetSuccess() { openSignaling(conn, sdp.description) }
                    }, sdp)
                }
            }, MediaConstraints())
        }

        // Close the current PC/WS (on ctl) but keep the leg alive for a retry.
        private fun closeAttempt() {
            wsOpen = false
            synchronized(this) { pendingLocal.clear() }
            try { ws?.close(1000, "retry") } catch (_: Throwable) {}
            val old = pc
            pc = null; ws = null
            try { old?.close(); old?.dispose() } catch (_: Throwable) {}
        }

        // Reschedule a fresh attempt on ctl after a backoff, unless we are connected/disposed/out of
        // attempts. Called from callback threads, so it hops to ctl.
        private fun retryLater() {
            if (connected || disposed || stopped) return
            submit {
                if (connected || disposed || stopped) return@submit
                closeAttempt()
                if (attempt >= maxAttempts) { Log.w(tag, "[$path] giving up after $attempt attempts"); return@submit }
                val delay = backoffMs[(attempt - 1).coerceIn(0, backoffMs.size - 1)]
                main.postDelayed({ submit { if (!connected && !disposed && !stopped) start() } }, delay)
            }
        }

        private fun openSignaling(conn: PeerConnection, offerSdp: String) {
            if (disposed || stopped || pc !== conn) return
            val base = serverUrl.trimEnd('/')
            val url = "$base/api/devices/" + enc(deviceId) + "/" + path + "/ws?token=" + enc(deviceToken) + extraQuery
            ws = wsClient.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    synchronized(this@Leg) {
                        if (disposed || stopped || pc !== conn) { try { webSocket.close(1000, null) } catch (_: Throwable) {}; return }
                        wsOpen = true
                        webSocket.send(msg("webrtc/offer", offerSdp))
                        for (c in pendingLocal) webSocket.send(msg("webrtc/candidate", c.sdp))
                        pendingLocal.clear()
                    }
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val o = JSONObject(text)
                        when (o.optString("type")) {
                            "webrtc/answer" -> {
                                val ans = o.optString("value")
                                if (!ans.isNullOrBlank()) submit {
                                    if (!disposed && !stopped && pc === conn) conn.setRemoteDescription(
                                        object : SimpleSdp("[$path] setRemoteDescription") {}, SessionDescription(SessionDescription.Type.ANSWER, ans))
                                }
                            }
                            "webrtc/candidate" -> {
                                val cand = o.optString("value")
                                if (!cand.isNullOrBlank()) submit {
                                    if (!disposed && !stopped && pc === conn) try { conn.addIceCandidate(IceCandidate("0", 0, cand)) } catch (_: Throwable) {}
                                }
                            }
                            // go2rtc rejects a subscribe with no producer yet ("unsupported url") — expected in the
                            // mutual-subscribe race; retry until the far side is publishing.
                            "error" -> { Log.i(tag, "[$path] go2rtc: ${o.optString("value")} (attempt $attempt) — retrying"); retryLater() }
                        }
                    } catch (t: Throwable) { Log.w(tag, "[$path] bad signaling message: ${t.message}") }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (pc === conn) { Log.w(tag, "[$path] WS failure: ${t.message} — retrying"); retryLater() }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (!connected && pc === conn) retryLater()
                }
            })
        }

        // Permanent teardown of this leg (call site: AudioTalker.teardown on ctl).
        fun dispose() {
            disposed = true
            wsOpen = false
            synchronized(this) { pendingLocal.clear() }
            try { ws?.close(1000, "stop") } catch (_: Throwable) {}
            val old = pc
            pc = null; ws = null
            try { old?.close(); old?.dispose() } catch (_: Throwable) {}
        }

        private inner class Observer : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                val c = candidate ?: return
                synchronized(this@Leg) {
                    val sock = ws
                    if (wsOpen && sock != null) sock.send(msg("webrtc/candidate", c.sdp)) else pendingLocal.add(c)
                }
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                when (newState) {
                    PeerConnection.PeerConnectionState.CONNECTED -> { connected = true; Log.i(tag, "[$path] connected") }
                    // A drop after we were connected, or a failure while connecting: retry (never
                    // dispose from here — that is what crashed libwebrtc).
                    PeerConnection.PeerConnectionState.FAILED -> { Log.w(tag, "[$path] pc FAILED — retrying"); connected = false; retryLater() }
                    else -> {}
                }
            }
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: org.webrtc.MediaStream?) {}
            override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
            override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(p0: org.webrtc.RtpReceiver?, p1: Array<out org.webrtc.MediaStream>?) {}
            override fun onTrack(transceiver: RtpTransceiver?) {
                // #talk video: hand a received webcam track to MainActivity to render fullscreen.
                val t = transceiver?.receiver?.track()
                if (t is VideoTrack && !disposed && !stopped) {
                    try { TalkVideoBus.publish(t, eglBase?.eglBaseContext) } catch (_: Throwable) {}
                }
            }
        }
    }

    private open class SimpleSdp(private val op: String) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { Log.e("AudioTalker", "$op create failed: $error") }
        override fun onSetFailure(error: String?) { Log.e("AudioTalker", "$op set failed: $error") }
    }

    companion object {
        /** Parse the descriptor's ICE server list (JSON [{urls, username?, credential?}]) to WebRTC. */
        fun parseIceServers(arr: JSONArray?): List<PeerConnection.IceServer> {
            val out = ArrayList<PeerConnection.IceServer>()
            if (arr == null) return out
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val urls = o.opt("urls")
                val urlList = when (urls) {
                    is String -> listOf(urls)
                    is JSONArray -> (0 until urls.length()).mapNotNull { urls.optString(it, null) }
                    else -> emptyList()
                }
                if (urlList.isEmpty()) continue
                val b = PeerConnection.IceServer.builder(urlList)
                o.optString("username", "").takeIf { it.isNotEmpty() }?.let { b.setUsername(it) }
                o.optString("credential", "").takeIf { it.isNotEmpty() }?.let { b.setPassword(it) }
                out.add(b.createIceServer())
            }
            return out
        }
    }
}
