package com.remotedisplay.player.remote

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
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
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SoftwareVideoDecoderFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.TimeUnit

/**
 * #go2rtc — the Android live-video PUBLISHER: the OS-level counterpart of the web player's
 * getUserMedia/canvas self-capture, and the ROBUST path for real signage.
 *
 * MediaProjection captures the whole screen at the OS level, so unlike the web player this needs no
 * browser, no gesture per frame, and is NOT defeated by a browser's resistFingerprinting. Consent
 * to MediaProjection is still required once (the system dialog, or a device-owner auto-grant); this
 * class is handed the granted result Intent and drives the WebRTC sender from there.
 *
 * SIGNALING — WebSocket + trickle ICE, matching go2rtc's own web client. We first tried one-shot
 * WHIP-over-HTTP (offer with candidates inline -> single answer). It failed on real libwebrtc: the
 * answer's inline candidates were applied while the JsepTransport was still being created and were
 * silently dropped ("JsepTransport doesn't exist"), so the peer never learned go2rtc's candidates
 * and never connected — even though a browser pulling the SAME stream through the SAME go2rtc+TURN
 * rig worked, proving the fault was ours, not the network. go2rtc's answer over its WS API instead
 * carries NO inline candidates and trickles them afterwards, which lands cleanly. So:
 *   1. build a sendonly PeerConnection whose only track is the screen capture,
 *   2. createOffer, setLocalDescription, and open a WebSocket to the device-authenticated route
 *        ws(s)://<server>/api/devices/:id/live/publish/ws?token=<device_token>
 *      which proxies to go2rtc's  /api/ws?dst=<stream>  (server never exposes go2rtc's url/token),
 *   3. send {type:"webrtc/offer", value:<sdp>}; receive {type:"webrtc/answer", value:<sdp>} ->
 *      setRemoteDescription; trickle both ways with {type:"webrtc/candidate", value:<candidate>}.
 *
 * Fail-soft like every other capture path: any failure logs and stops; nothing here can interrupt
 * playback (MediaProjection reads the framebuffer, it does not touch the player's surfaces).
 *
 * ⚠️ Requires the io.getstream:stream-webrtc-android AAR (org.webrtc.*). Build + flash to verify;
 * it cannot be compiled or exercised in the server sandbox.
 */
class LiveVideoPublisher(
    private val appContext: Context,
    private val serverUrl: String,
    private val deviceId: String,
    private val deviceToken: String,
) {
    private val tag = "LiveVideoPublisher"
    // Long-lived client for the signaling WebSocket: NO call timeout (that would kill the socket),
    // a ping keeps it open through NATs/proxies.
    private val wsClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var eglBase: EglBase? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var ws: WebSocket? = null
    @Volatile private var wsOpen = false
    @Volatile private var live = false
    @Volatile private var stopped = false
    private val main = Handler(Looper.getMainLooper())
    // Local candidates produced before the WS is open; flushed on open. Guarded by `this`.
    private val pendingLocal = ArrayList<IceCandidate>()

    val isLive: Boolean get() = live

    /**
     * Start publishing. [projectionResultData] is the Intent returned from the MediaProjection
     * consent flow (ScreenCapturePermissionActivity). [iceServers] are STUN/TURN URLs from the
     * server's live descriptor (a plain STUN is fine on a LAN). [width]/[height]/[fps] cap the
     * capture; go2rtc/WebRTC will downscale as the link allows.
     */
    @Synchronized
    fun start(
        projectionResultData: Intent,
        iceServers: List<PeerConnection.IceServer>,
        width: Int = 1280,
        height: Int = 720,
        fps: Int = 15,
    ) {
        if (live) { Log.i(tag, "already live; ignoring duplicate start"); return }
        stopped = false
        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                    .createInitializationOptions()
            )
            val egl = EglBase.create().also { eglBase = it }
            val encoderFactory = DefaultVideoEncoderFactory(egl.eglBaseContext, true, true)
            val decoderFactory = SoftwareVideoDecoderFactory()   // publisher never decodes; keep it light
            val f = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .createPeerConnectionFactory()
                .also { factory = it }

            // MediaProjection -> screen video track. The callback fires if the system revokes
            // projection (e.g. the user hits "Stop"); we tear down cleanly rather than send black.
            val cap = ScreenCapturerAndroid(projectionResultData, object : MediaProjection.Callback() {
                override fun onStop() { Log.i(tag, "MediaProjection stopped by system"); stop() }
            }).also { capturer = it }

            val src = f.createVideoSource(cap.isScreencast).also { videoSource = it }
            val helper = SurfaceTextureHelper.create("st-live-capture", egl.eglBaseContext).also { surfaceHelper = it }
            cap.initialize(helper, appContext, src.capturerObserver)
            cap.startCapture(width, height, fps)
            val track = f.createVideoTrack("st_screen", src).also { videoTrack = it }

            val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                // Trickle ICE: gather continually and ship each candidate over the WS as it appears.
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }
            val pc = f.createPeerConnection(rtcConfig, PcObserver()) ?: run {
                Log.e(tag, "createPeerConnection returned null"); stop(); return
            }
            peer = pc
            Log.i(tag, "ICE servers: " + iceServers.size)
            // Sendonly: the panel only publishes; it never wants media back.
            pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY))

            createOfferAndSignal(pc)
        } catch (t: Throwable) {
            Log.e(tag, "start failed: ${t.message}", t)
            stop()
        }
    }

    private fun createOfferAndSignal(pc: PeerConnection) {
        val constraints = MediaConstraints()
        pc.createOffer(object : SimpleSdpObserver("createOffer") {
            override fun onCreateSuccess(sdp: SessionDescription) {
                pc.setLocalDescription(object : SimpleSdpObserver("setLocalDescription") {
                    override fun onSetSuccess() {
                        // Trickle: open the WS and send the offer NOW (candidate-less); candidates
                        // follow over the socket as gathering produces them.
                        openSignaling(pc, sdp.description)
                    }
                }, sdp)
            }
        }, constraints)
    }

    @Synchronized
    private fun openSignaling(pc: PeerConnection, offerSdp: String) {
        if (stopped || peer !== pc) return
        val base = serverUrl.trimEnd('/')
        val url = "$base/api/devices/" + enc(deviceId) + "/live/publish/ws?token=" + enc(deviceToken)
        val req = Request.Builder().url(url).build()
        ws = wsClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(this@LiveVideoPublisher) {
                    if (stopped) { try { webSocket.close(1000, null) } catch (_: Throwable) {}; return }
                    wsOpen = true
                    Log.i(tag, "signaling WS open -> sending offer")
                    webSocket.send(msg("webrtc/offer", offerSdp))
                    // Flush any candidates that were gathered before the socket opened.
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
                            if (ans.isNullOrBlank()) { Log.w(tag, "empty answer"); return }
                            main.post { applyAnswer(pc, ans) }
                        }
                        "webrtc/candidate" -> {
                            val cand = o.optString("value")
                            if (!cand.isNullOrBlank()) main.post {
                                if (!stopped && peer === pc) {
                                    try { pc.addIceCandidate(IceCandidate("0", 0, cand)) } catch (t: Throwable) { Log.w(tag, "addIceCandidate failed: ${t.message}") }
                                }
                            }
                        }
                        "error" -> { Log.w(tag, "go2rtc error: ${o.optString("value")}"); stop() }
                        else -> { /* ignore other go2rtc chatter */ }
                    }
                } catch (t: Throwable) { Log.w(tag, "bad signaling message: ${t.message}") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(tag, "signaling WS failure: ${t.message} (http ${response?.code})"); stop()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(tag, "signaling WS closed ($code $reason)")
                // A close after we are live is go2rtc dropping signaling; media may keep flowing over
                // the already-negotiated transport, so do NOT tear down a live session here.
                if (!live) stop()
            }
        })
    }

    private fun applyAnswer(pc: PeerConnection, answerSdp: String) {
        if (stopped || peer !== pc) return
        pc.setRemoteDescription(object : SimpleSdpObserver("setRemoteDescription") {
            override fun onSetSuccess() { live = true; Log.i(tag, "publishing live (answer applied; candidates trickling)") }
            override fun onSetFailure(error: String?) { Log.e(tag, "setRemote failed: $error"); stop() }
        }, SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
    }

    @Synchronized
    fun stop() {
        if (stopped) return
        stopped = true
        live = false
        wsOpen = false
        pendingLocal.clear()
        try { ws?.close(1000, "stop") } catch (_: Throwable) {}
        try { capturer?.stopCapture() } catch (_: Throwable) {}
        try { videoTrack?.dispose() } catch (_: Throwable) {}
        try { videoSource?.dispose() } catch (_: Throwable) {}
        try { capturer?.dispose() } catch (_: Throwable) {}
        try { surfaceHelper?.dispose() } catch (_: Throwable) {}
        try { peer?.close(); peer?.dispose() } catch (_: Throwable) {}
        try { factory?.dispose() } catch (_: Throwable) {}
        try { eglBase?.release() } catch (_: Throwable) {}
        ws = null
        capturer = null; videoTrack = null; videoSource = null; surfaceHelper = null
        peer = null; factory = null; eglBase = null
        Log.i(tag, "stopped")
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
    private fun msg(type: String, value: String) = JSONObject().put("type", type).put("value", value).toString()

    private inner class PcObserver : PeerConnection.Observer {
        // Trickle: ship each local candidate over the WS as it is gathered (queue until WS open).
        override fun onIceCandidate(candidate: IceCandidate?) {
            val c = candidate ?: return
            synchronized(this@LiveVideoPublisher) {
                val sock = ws
                if (wsOpen && sock != null) sock.send(msg("webrtc/candidate", c.sdp))
                else pendingLocal.add(c)
            }
        }
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            Log.i(tag, "ICE connection state: $state")
            if (state == PeerConnection.IceConnectionState.FAILED ||
                state == PeerConnection.IceConnectionState.CLOSED) { Log.w(tag, "ICE $state"); stop() }
        }
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            Log.i(tag, "peer connection state: $newState")
        }
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
        override fun onIceConnectionReceivingChange(p0: Boolean) {}
        override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
        override fun onAddStream(p0: org.webrtc.MediaStream?) {}
        override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
        override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(p0: org.webrtc.RtpReceiver?, p1: Array<out org.webrtc.MediaStream>?) {}
        override fun onTrack(transceiver: RtpTransceiver?) {}
    }

    private open class SimpleSdpObserver(private val op: String) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { Log.e("LiveVideoPublisher", "$op create failed: $error") }
        override fun onSetFailure(error: String?) { Log.e("LiveVideoPublisher", "$op set failed: $error") }
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
