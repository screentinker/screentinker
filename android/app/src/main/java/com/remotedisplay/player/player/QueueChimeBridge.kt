package com.remotedisplay.player.player

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import com.remotedisplay.player.util.DebugLog

/**
 * The [QueueChime.BRIDGE] JavaScript interface on a widget's WebView (full screen in
 * MediaPlayerManager, in a zone in ZoneManager). The rules are in [QueueChime].
 *
 * ⚠️ THE INTERFACE IS VISIBLE TO EVERY PAGE THE WEBVIEW LOADS. The full-screen WebView is shared with
 * YouTube and HTML bundles, so [allowed] is asked on the main thread at the moment of the call and
 * must check what is on screen NOW: a widget render page, still mounted, on a screen that may be
 * heard. Anything else is refused. The worst a page that slips through can do is one short chime,
 * at most once per 3 s.
 *
 * Plays as MEDIA (USAGE_MEDIA), like the rest of the content, so the device's media volume and the
 * remote volume control apply to it, and it never rings as a notification or a call.
 */
class QueueChimeBridge(
    private val where: String,
    private val allowed: () -> Boolean,
    private val gate: QueueChime.Gate = SHARED_GATE,
) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun chime(volume: String?) {
        val v = QueueChime.volume(volume)
        main.post {
            try {
                if (!allowed()) { DebugLog.i(TAG, "chime refused ($where): muted, not a queue widget on screen, or the screen must stay silent (wall follower, alarm, call)"); return@post }
                if (!(v > 0f)) return@post
                if (!gate.admit()) return@post
                play(v)
            } catch (t: Throwable) {
                DebugLog.e(TAG, "chime failed ($where): ${t.message}")
            }
        }
    }

    private fun play(volume: Float) {
        val pcm = QueueChime.synth(volume)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build())
            .setAudioFormat(AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(QueueChime.SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .build()
        track.write(pcm, 0, pcm.size)
        track.play()
        DebugLog.i(TAG, "chime ($where) at ${(volume * 100).toInt()}%")
        // MODE_STATIC plays once and stops at the end of the buffer; release after it has finished.
        val ms = pcm.size * 1000L / QueueChime.SAMPLE_RATE + 250
        main.postDelayed({ try { track.release() } catch (_: Throwable) {} }, ms)
    }

    companion object {
        private const val TAG = "QueueChime"
        /** One gate for the whole player: two widgets showing the same queue still chime once. */
        val SHARED_GATE = QueueChime.Gate()
    }
}
