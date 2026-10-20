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
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * 3.0 screen share — the native Android RECEIVER (docs/screen-share.md). The counterpart of the web
 * player's /player/screen-share.js, speaking the same protocol byte for byte (ScreenShareProtocol):
 *
 *   WS /api/devices/:id/screen-share/ws  ->  {type:auth, device_token, session_id}
 *   <- {type:ready}                       ->  {type:webrtc/offer} (recvonly video + audio)
 *   <- {type:webrtc/answer}  <-> {type:webrtc/candidate} (trickled)  -> {type:state, value:playing}
 *   <- {type:ended, reason}
 *
 * The media is peer to peer from the sharer's browser; the server only relays the signalling. Video
 * goes to the window through [ScreenShareBus]; audio plays through the JavaAudioDeviceModule (no mic:
 * nothing is ever sent).
 *
 * Lifecycle rules are Talk's (AudioTalker), learned from a native SIGSEGV: every create/dispose runs
 * on the single [ctl] thread, never on a WebRTC callback thread, and the window detaches its renderer
 * BEFORE the PeerConnection is disposed. Unlike Talk there are no retries: a share that fails ends,
 * the sharer is told why, and the playlist — which never stopped underneath — is simply visible again.
 *
 * Several presenters at once: ScreenShareController holds up to four of these, one per session.
 * Each keeps its OWN factory, audio device module and EGL context, exactly as a lone share did —
 * the least invasive way to run several (nothing shared to reference-count, and one session's
 * teardown can never pull a native object out from under another). The cost is up to four decoders,
 * EGL contexts and AudioTracks at once. Only one is heard: [setAudioEnabled] disables the others'
 * remote audio track (libwebrtc then plays it at volume 0).
 */
class ScreenShareReceiver(
    private val appContext: Context,
    private val serverUrl: String,
    private val deviceId: String,
    private val deviceToken: String,
    val start: ScreenShareProtocol.Start,
    /** Called once, on the main thread, after everything is torn down. */
    private val onEnded: (String) -> Unit,
) {
    private val tag = "ScreenShare"
    private val main = Handler(Looper.getMainLooper())
    private val ctl = Executors.newSingleThreadExecutor { r -> Thread(r, "screen-share-ctl") }
    private val wsClient = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()

    private var factory: PeerConnectionFactory? = null
    private var adm: JavaAudioDeviceModule? = null
    private var eglBase: EglBase? = null
    private var pc: PeerConnection? = null
    private var ws: WebSocket? = null
    private var videoTrack: VideoTrack? = null
    private var audioTrack: AudioTrack? = null   // ctl only
    // Whether this presenter's sound may play. Off until the controller decides (it does on every
    // start, end and layout), so a newcomer is never briefly heard over the one that should be.
    @Volatile private var audioWanted = false
    private val pendingLocal = ArrayList<String>()
    @Volatile private var wsReady = false
    @Volatile private var ended = false
    @Volatile private var playing = false

    private val maxTimer = Runnable { stop("max_duration") }
    private val connectTimer = Runnable { if (!playing) { report("failed"); stop("timeout") } }

    // The first decoded frame is what "playing" means — the same moment the web receiver's <video>
    // fires 'playing'. One flag, no removeSink from inside onFrame (that would re-enter libwebrtc).
    private val firstFrame = object : VideoSink {
        override fun onFrame(frame: VideoFrame?) {
            if (playing || ended) return
            playing = true
            main.removeCallbacks(connectTimer)
            report("playing")
            Log.i(tag, "playing (${start.sessionId})")
        }
    }

    private fun submit(block: () -> Unit) {
        try { if (!ctl.isShutdown) ctl.execute(block) } catch (_: RejectedExecutionException) {}
    }

    val sessionId: String get() = start.sessionId

    /**
     * Play (true) or silence (false) this presenter's sound. Any thread, any time: before the track
     * has arrived it is remembered and applied when it does (onTrack); after stop() the ctl executor
     * is shut down, so nothing can touch a disposed track.
     */
    fun setAudioEnabled(on: Boolean) {
        if (audioWanted == on) return
        audioWanted = on
        submit {
            if (ended) return@submit
            try { audioTrack?.setEnabled(audioWanted) } catch (_: Throwable) {}
        }
    }

    fun begin() {
        ScreenShareBus.start(start)
        main.postDelayed(maxTimer, ScreenShareProtocol.maxDurationMs(start.maxSeconds))
        main.postDelayed(connectTimer, ScreenShareProtocol.CONNECT_TIMEOUT_MS)
        submit {
            if (ended) return@submit
            try {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions()
                )
                // Playout only: with no local audio track the module never opens the microphone.
                val module = JavaAudioDeviceModule.builder(appContext).createAudioDeviceModule().also { adm = it }
                val egl = EglBase.create().also { eglBase = it }
                val f = PeerConnectionFactory.builder()
                    .setAudioDeviceModule(module)
                    .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                    .createPeerConnectionFactory().also { factory = it }
                val cfg = PeerConnection.RTCConfiguration(AudioTalker.parseIceServers(start.iceServers)).apply {
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                }
                val conn = f.createPeerConnection(cfg, Observer()) ?: throw IllegalStateException("createPeerConnection returned null")
                pc = conn
                val recv = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)
                conn.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, recv)
                conn.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, recv)
                openSignalling()
            } catch (t: Throwable) {
                Log.e(tag, "start failed: ${t.message}", t)
                report("unsupported")
                stop("unsupported")
            }
        }
    }

    private fun openSignalling() {
        val url = ScreenShareProtocol.wsUrl(serverUrl, deviceId)
        ws = wsClient.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (ended) { try { webSocket.close(1000, null) } catch (_: Throwable) {}; return }
                // The token is in the first MESSAGE, never the URL (access logs).
                webSocket.send(ScreenShareProtocol.authMessage(deviceToken, start.sessionId))
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                when (val m = ScreenShareProtocol.parseIncoming(text)) {
                    is ScreenShareProtocol.Incoming.Ready -> submit { offer() }
                    is ScreenShareProtocol.Incoming.Answer -> submit {
                        pc?.setRemoteDescription(Sdp("setRemoteDescription") { report("failed"); stop("answer_failed") },
                            SessionDescription(SessionDescription.Type.ANSWER, m.sdp))
                    }
                    is ScreenShareProtocol.Incoming.Candidate -> submit {
                        try { pc?.addIceCandidate(IceCandidate(m.mid ?: "", m.mline, m.candidate)) } catch (_: Throwable) {}
                    }
                    is ScreenShareProtocol.Incoming.Ended -> stop(m.reason)
                    else -> {}
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(tag, "signalling failed: ${t.message}")
                stop("signalling_failed")
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { stop("signalling_closed") }
        })
    }

    // On ctl.
    private fun offer() {
        val conn = pc ?: return
        conn.createOffer(Sdp("createOffer", onCreated = { sdp ->
            submit {
                if (ended || pc !== conn) return@submit
                conn.setLocalDescription(Sdp("setLocalDescription", onSet = set@{
                    val sock = ws ?: return@set
                    synchronized(pendingLocal) {
                        sock.send(ScreenShareProtocol.offerMessage(sdp.description))
                        wsReady = true
                        for (c in pendingLocal) sock.send(c)
                        pendingLocal.clear()
                    }
                }) { report("failed"); stop("offer_failed") }, sdp)
            }
        }) { report("failed"); stop("offer_failed") }, MediaConstraints())
    }

    private fun report(state: String) {
        try { if (!ended || state == "disconnected") ws?.send(ScreenShareProtocol.stateMessage(state)) } catch (_: Throwable) {}
    }

    /** End the share (idempotent, any thread). */
    fun stop(reason: String) {
        if (ended) return
        ended = true
        main.removeCallbacks(maxTimer)
        main.removeCallbacks(connectTimer)
        Log.i(tag, "stopping: $reason")
        submit {
            // 1. The window lets go of the track (wait for it: see ScreenShareBus.end).
            val detached = CountDownLatch(1)
            ScreenShareBus.end(start.sessionId) { detached.countDown() }
            try { detached.await(2, TimeUnit.SECONDS) } catch (_: Throwable) {}
            // 2. Tell the relay, then close our leg.
            try { ws?.send(ScreenShareProtocol.stateMessage("disconnected")) } catch (_: Throwable) {}
            try { ws?.close(1000, "stop") } catch (_: Throwable) {}
            // 3. Native objects, in the order AudioTalker uses.
            try { videoTrack?.removeSink(firstFrame) } catch (_: Throwable) {}
            audioTrack = null   // owned by the PeerConnection: disposed with it below
            try { pc?.close(); pc?.dispose() } catch (_: Throwable) {}
            try { factory?.dispose() } catch (_: Throwable) {}
            try { adm?.release() } catch (_: Throwable) {}
            try { eglBase?.release() } catch (_: Throwable) {}
            pc = null; ws = null; videoTrack = null; factory = null; adm = null; eglBase = null
            main.post { try { onEnded(reason) } catch (_: Throwable) {} }
        }
        ctl.shutdown()
    }

    private inner class Observer : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate?) {
            val c = candidate ?: return
            val msg = ScreenShareProtocol.candidateMessage(c.sdp, c.sdpMid, c.sdpMLineIndex)
            synchronized(pendingLocal) {
                val sock = ws
                if (wsReady && sock != null) sock.send(msg) else pendingLocal.add(msg)
            }
        }
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            if (newState == PeerConnection.PeerConnectionState.CONNECTED) report("connected")
            // Never dispose from a callback thread: stop() hops to ctl.
            if (newState == PeerConnection.PeerConnectionState.FAILED) { report("failed"); stop("connection_failed") }
        }
        override fun onTrack(transceiver: RtpTransceiver?) {
            val t = transceiver?.receiver?.track()
            if (t is VideoTrack && !ended) {
                submit {
                    if (ended) return@submit
                    videoTrack = t
                    try { t.addSink(firstFrame) } catch (_: Throwable) {}
                    eglBase?.eglBaseContext?.let { ScreenShareBus.track(start.sessionId, t, it) }
                }
            }
            // Audio: the JavaAudioDeviceModule plays a received track by itself — unless it is
            // disabled, which is how every presenter but the one whose sound plays is kept silent.
            if (t is AudioTrack && !ended) {
                submit {
                    if (ended) return@submit
                    audioTrack = t
                    try { t.setEnabled(audioWanted) } catch (_: Throwable) {}
                }
            }
        }
        override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
        override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
        override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
        override fun onIceConnectionReceivingChange(p0: Boolean) {}
        override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
        override fun onAddStream(p0: MediaStream?) {}
        override fun onRemoveStream(p0: MediaStream?) {}
        override fun onDataChannel(p0: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
    }

    private inner class Sdp(
        private val op: String,
        private val onCreated: ((SessionDescription) -> Unit)? = null,
        private val onSet: (() -> Unit)? = null,
        private val onFail: () -> Unit,
    ) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) { onCreated?.invoke(sdp) }
        override fun onSetSuccess() { onSet?.invoke() }
        override fun onCreateFailure(error: String?) { Log.e(tag, "$op failed: $error"); onFail() }
        override fun onSetFailure(error: String?) { Log.e(tag, "$op failed: $error"); onFail() }
    }
}
