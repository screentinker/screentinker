package com.remotedisplay.player.remote

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsReport
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
 * The wire contract is identical to the web player:
 *   1. build a sendonly PeerConnection whose only track is the screen capture,
 *   2. createOffer, gather ICE (non-trickle), POST the SDP to the device-authenticated route
 *        POST /api/devices/:id/live/publish?token=<device_token>
 *      which proxies to go2rtc's dst= endpoint,
 *   3. setRemoteDescription(answer).
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
    private val http = OkHttpClient.Builder()
        .callTimeout(8, TimeUnit.SECONDS)
        .build()

    private var factory: PeerConnectionFactory? = null
    private var peer: PeerConnection? = null
    private var eglBase: EglBase? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    @Volatile private var live = false
    @Volatile private var stopped = false
    @Volatile private var posted = false
    private val main = Handler(Looper.getMainLooper())
    private val iceGatherCapMs = 2500L   // non-trickle: publish after this even if gathering has not COMPLETEd

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
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
            }
            val pc = f.createPeerConnection(rtcConfig, PcObserver()) ?: run {
                Log.e(tag, "createPeerConnection returned null"); stop(); return
            }
            peer = pc
            // Sendonly: the panel only publishes; it never wants media back.
            pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY))

            createOfferAndPublish(pc)
        } catch (t: Throwable) {
            Log.e(tag, "start failed: ${t.message}", t)
            stop()
        }
    }

    private fun createOfferAndPublish(pc: PeerConnection) {
        val constraints = MediaConstraints()
        pc.createOffer(object : SimpleSdpObserver("createOffer") {
            override fun onCreateSuccess(sdp: SessionDescription) {
                pc.setLocalDescription(object : SimpleSdpObserver("setLocalDescription") {
                    override fun onSetSuccess() {
                        // Non-trickle: publish when gathering completes OR the cap elapses, whichever
                        // is first, so a slow/failing STUN (common behind NAT) never wedges publishing.
                        main.postDelayed({ postOfferAndAnswer() }, iceGatherCapMs)
                    }
                }, sdp)
            }
        }, constraints)
    }

    // Called once ICE gathering completes: the localDescription now carries the candidates, so we
    // POST the full offer to the device-authenticated publish route and apply the answer.
    @Synchronized
    private fun postOfferAndAnswer() {
        if (posted || stopped) return
        posted = true
        val pc = peer ?: return
        val offer = pc.localDescription ?: run { Log.e(tag, "no local description after gathering"); return }
        Thread {
            try {
                val base = serverUrl.trimEnd('/')
                val url = "$base/api/devices/" + java.net.URLEncoder.encode(deviceId, "UTF-8") +
                    "/live/publish?token=" + java.net.URLEncoder.encode(deviceToken, "UTF-8")
                val req = Request.Builder()
                    .url(url)
                    .post(offer.description.toRequestBody("application/sdp".toMediaType()))
                    .build()
                http.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) { Log.w(tag, "publish rejected: HTTP ${resp.code}"); stop(); return@Thread }
                    val answerSdp = resp.body?.string().orEmpty()
                    if (answerSdp.isBlank()) { Log.w(tag, "empty answer"); stop(); return@Thread }
                    pc.setRemoteDescription(object : SimpleSdpObserver("setRemoteDescription") {
                        override fun onSetSuccess() {
                            live = true; Log.i(tag, "publishing live")
                            // ⚠️ Feed go2rtc's ICE candidates via addIceCandidate, but DEFERRED. go2rtc
                            // returns a non-trickle WHIP answer with candidates inline; libwebrtc
                            // applies those (and even ones added synchronously in this callback) while
                            // the JsepTransport is still being created, and silently drops them
                            // ("JsepTransport doesn't exist"), so the peer ends up with no remote
                            // candidates and never connects. go2rtc's own web client dodges this by
                            // trickling over a websocket AFTER setup. We replicate that: post the
                            // candidates onto the loop so they land once the transport exists.
                            main.postDelayed({
                                if (stopped || peer !== pc) return@postDelayed
                                var added = 0
                                for (line in answerSdp.split("\n")) {
                                    val t = line.trim()
                                    if (t.startsWith("a=candidate:")) {
                                        try { pc.addIceCandidate(IceCandidate("0", 0, t.substring(2))); added++ } catch (_: Throwable) {}
                                    }
                                }
                                Log.i(tag, "re-added $added answer ICE candidate(s) [deferred]")
                            }, 800)
                            startStatsProbe(pc)
                        }
                        override fun onSetFailure(error: String?) { Log.e(tag, "setRemote failed: $error"); stop() }
                    }, SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
                }
            } catch (t: Throwable) {
                Log.e(tag, "publish exchange failed: ${t.message}", t)
                stop()
            }
        }.start()
    }

    // Definitive proof the encoder is producing and the transport is sending: poll outbound-rtp
    // (framesEncoded / bytesSent) and the selected ICE candidate pair. Independent of go2rtc.
    private var statsCount = 0
    private fun startStatsProbe(pc: PeerConnection) {
        statsCount = 0
        val poll = object : Runnable {
            override fun run() {
                if (stopped || peer !== pc) return
                pc.getStats { report: RTCStatsReport ->
                    var fe = 0L; var bs = 0L; var kind = ""
                    var pair = ""
                    for (st in report.statsMap.values) {
                        if (st.type == "outbound-rtp" && (st.members["kind"] == "video")) {
                            fe = (st.members["framesEncoded"] as? Number)?.toLong() ?: fe
                            bs = (st.members["bytesSent"] as? Number)?.toLong() ?: bs
                            kind = "video"
                        }
                        if (st.type == "candidate-pair" && (st.members["nominated"] == true || st.members["state"] == "succeeded")) {
                            pair = "state=" + st.members["state"] + " bytesSent=" + st.members["bytesSent"]
                        }
                    }
                    Log.i(tag, "STATS outbound-rtp[$kind] framesEncoded=$fe bytesSent=$bs | selectedPair{$pair}")
                }
                if (++statsCount < 6 && !stopped) main.postDelayed(this, 2000)
            }
        }
        main.postDelayed(poll, 2000)
    }

    @Synchronized
    fun stop() {
        if (stopped) return
        stopped = true
        live = false
        try { capturer?.stopCapture() } catch (_: Throwable) {}
        try { videoTrack?.dispose() } catch (_: Throwable) {}
        try { videoSource?.dispose() } catch (_: Throwable) {}
        try { capturer?.dispose() } catch (_: Throwable) {}
        try { surfaceHelper?.dispose() } catch (_: Throwable) {}
        try { peer?.close(); peer?.dispose() } catch (_: Throwable) {}
        try { factory?.dispose() } catch (_: Throwable) {}
        try { eglBase?.release() } catch (_: Throwable) {}
        capturer = null; videoTrack = null; videoSource = null; surfaceHelper = null
        peer = null; factory = null; eglBase = null
        Log.i(tag, "stopped")
    }

    private inner class PcObserver : PeerConnection.Observer {
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) postOfferAndAnswer()
        }
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            if (state == PeerConnection.IceConnectionState.FAILED ||
                state == PeerConnection.IceConnectionState.CLOSED) { Log.w(tag, "ICE $state"); stop() }
        }
        override fun onIceCandidate(candidate: IceCandidate?) { /* non-trickle: candidates ride the offer */ }
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
