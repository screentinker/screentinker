package com.remotedisplay.player.player

import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.graphics.drawable.BitmapDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.TextureView
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.remotedisplay.player.util.ImageLoader
import java.io.File

class MediaPlayerManager(
    private val context: Context,
    private val playerView: PlayerView,
    private val imageView: ImageView,
    private val youtubeWebView: WebView? = null,
    private val onVideoComplete: () -> Unit,
    private val onImageError: (() -> Unit)? = null,
    // feat/transition-engine: the full-screen GL overlay that plays a from->to wipe. Null = no
    // transitions (every render hard-cuts, exactly as before).
    private val transitionView: TransitionGLView? = null
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var exoPlayer: ExoPlayer? = null
    private var currentType: MediaType = MediaType.NONE
    // Wall mode: followers must stay muted even as the leader's sync switches them
    // to a new (possibly unmuted) item, so the mute has to survive each playVideo.
    private var wallMute = false
    // #group-sync loop state, tracked so it can be applied to a freshly-swapped double-buffer player.
    private var videoLooping = false
    // #group-sync double buffer: a second ExoPlayer that pre-opens/pre-buffers the NEXT clip so the
    // boundary switch is a warm swap (~100-300ms) instead of a cold prepare (~1-2s black hold). Only
    // engaged when preloadVideo() is called ahead of a boundary (group sync); the wall/solo paths are
    // untouched (they never preload, so playVideo takes the normal cold path).
    private var preloadPlayer: ExoPlayer? = null
    private var preloadedFile: File? = null
    // Throwaway offscreen surface for the preload player: it forces the preload clip to decode frame 0
    // and populate its video size BEFORE the swap, so PlayerView doesn't reset the aspect to "fill"
    // (a one-frame landscape stretch) while it waits for the new player's first video-size report.
    private var warmTexture: SurfaceTexture? = null
    private var warmSurface: Surface? = null

    enum class MediaType { NONE, VIDEO, IMAGE, YOUTUBE, WIDGET }

    init {
        setupExoPlayer()
    }

    // Build a player with the shared end/error listener so BOTH the active and the preload player
    // advance/self-heal identically once either is the visible one.
    private fun buildPlayer(): ExoPlayer = ExoPlayer.Builder(context).build().also { player ->
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                // Only the ACTIVE (view-attached) player drives advance; ignore the preload player's
                // own state changes (it's parked with playWhenReady=false and never ENDs while parked).
                if (playbackState == Player.STATE_ENDED && player === exoPlayer) onVideoComplete()
            }
            // Root-2: a corrupt/undecodable video used to freeze the playlist forever — only
            // STATE_ENDED advanced, and an error goes to STATE_IDLE, so onVideoComplete never
            // fired. Treat a playback error like a completion so the loop moves on instead of
            // wedging on the broken item (mirrors the web/.wgt onerror -> advance).
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                Log.e("MediaPlayerManager", "Playback error (${error.errorCodeName}) — advancing: ${error.message}")
                if (player === exoPlayer) onVideoComplete()
            }
        })
    }

    private fun setupExoPlayer() {
        // Hold the last frame instead of flashing black during a reset/prepare — turns any residual
        // switch gap into a brief freeze-frame rather than a black hold.
        try { playerView.setKeepContentOnPlayerReset(true) } catch (e: Throwable) {}
        exoPlayer = buildPlayer().also { playerView.player = it }
    }

    // #129: remembered so the live device:mute-changed toggle knows YouTube's current
    // state and the IFrame API bridge can flip it without reloading the embed.
    private var youtubeMuted = false

    // ---- feat/transition-engine: GL wipe helpers. Every failure path returns false/null so the caller
    // hard-cuts (never a blank frame). Solo fullscreen only — suppressed for wall followers and group/
    // loop sync (they own their own frame timing). ----
    private fun transitionsActive(): Boolean = transitionView != null && !wallMute && !videoLooping

    // The frame on screen now, as a bitmap, for the wipe's `from`. Image -> the ImageView bitmap; video
    // -> the ExoPlayer TextureView's current frame. Null (youtube/widget/none/unavailable) -> hard cut.
    private fun captureCurrentFrame(): Bitmap? = try {
        when (currentType) {
            MediaType.IMAGE -> (imageView.drawable as? BitmapDrawable)?.bitmap
            MediaType.VIDEO -> (playerView.videoSurfaceView as? TextureView)?.let { tv ->
                if (tv.isAvailable && tv.width > 0 && tv.height > 0) tv.bitmap else null
            }
            else -> null
        }
    } catch (e: Throwable) { null }

    // Pick one effect at random (variety) and resolve its wrapped fragment source + params. Null if the
    // shader isn't in assets -> hard cut.
    private fun pickEffect(spec: TransitionSpec): Pair<String, Map<String, Float>>? {
        if (spec.effects.isEmpty()) return null
        val idx = (Math.random() * spec.effects.size).toInt().coerceIn(0, spec.effects.size - 1)
        val e = spec.effects[idx]
        val src = TransitionGlsl.loadSource(context.assets, e.shader) ?: return null
        return TransitionGlsl.fragmentFor(src) to e.params
    }

    // Run a from->to wipe, then `swap` (the plain mount) on completion. Returns false if it can't start
    // (the caller must then swap immediately). `swap` is the SAME plain mount the no-transition path uses.
    private fun runWipe(toBitmap: Bitmap, spec: TransitionSpec?, from: Bitmap?, swap: () -> Unit): Boolean {
        val view = transitionView
        if (view == null || spec == null || from == null || !transitionsActive()) return false
        val picked = pickEffect(spec) ?: return false
        val w = ImageLoader.screenWidth(context); val h = ImageLoader.screenHeight(context)
        if (w <= 0 || h <= 0) return false
        val fromFit: Bitmap; val toFit: Bitmap
        try { fromFit = fitTransitionBitmap(from, w, h); toFit = fitTransitionBitmap(toBitmap, w, h) }
        catch (e: Throwable) { Log.w("MediaPlayerManager", "wipe fit failed: ${e.message}"); return false }
        view.play(fromFit, toFit, picked.first, picked.second, spec.durationMs) { swap() }
        return true
    }

    // Extract a local video's first frame as a bitmap (the wipe's `to` for image->video / video->video).
    // Blocking — call off the main thread. Null on any failure -> hard cut.
    private fun extractFirstFrame(path: String): Bitmap? {
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(path)
            r.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } catch (e: Throwable) { Log.w("MediaPlayerManager", "first-frame extract failed: ${e.message}"); null }
        finally { try { r.release() } catch (_: Throwable) {} }
    }

    // Plain image mount (visibility flip + set bitmap). Shared by the transition-done swap and the
    // no-transition hard cut.
    private fun mountImageBitmap(bitmap: Bitmap) {
        currentType = MediaType.IMAGE
        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.VISIBLE
        youtubeWebView?.visibility = android.view.View.GONE
        exoPlayer?.stop()
        try { imageView.setImageBitmap(bitmap) }
        catch (e: Throwable) { Log.e("MediaPlayerManager", "setImageBitmap failed: ${e.message}"); onImageError?.invoke() }
    }

    fun playYoutube(embedUrl: String, durationSec: Int = 0, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Playing YouTube: $embedUrl (muted=$muted)")
        currentType = MediaType.YOUTUBE
        youtubeMuted = muted || wallMute

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "YouTube")
            setBackgroundColor(android.graphics.Color.BLACK)
            // Load via an embed wrapper with a valid youtube.com origin (Error 153 fix).
            // #129: initial mute comes from the per-item flag (no longer hardcoded).
            val html = com.remotedisplay.player.util.WebViewSupport.youtubeEmbedHtml(embedUrl, youtubeMuted)
            if (html != null) loadDataWithBaseURL(com.remotedisplay.player.util.WebViewSupport.EMBED_BASE, html, "text/html", "UTF-8", null)
            else loadUrl(embedUrl)
        }
    }

    // #129: live mute for the YouTube embed via the IFrame API postMessage bridge
    // (enablejsapi=1 is set on the embed). Avoids a full reload of the player, which
    // would restart the video and flicker. Main thread only (WebView access).
    private fun setYoutubeMuted(muted: Boolean) {
        youtubeMuted = muted
        val func = if (muted) "mute" else "unMute"
        val js = "(function(){try{var f=document.querySelector('iframe');" +
            "if(f&&f.contentWindow){f.contentWindow.postMessage(" +
            "JSON.stringify({event:'command',func:'$func',args:[]}),'*');}}catch(e){}})()"
        youtubeWebView?.let { wv -> wv.post { try { wv.evaluateJavascript(js, null) } catch (_: Throwable) {} } }
    }

    // Fullscreen widget render (single-zone / "fullscreen" layouts). Reuses the
    // full-screen WebView; ZoneManager handles widgets in multi-zone layouts.
    fun showWidget(url: String) {
        Log.i("MediaPlayerManager", "Showing widget: $url")
        currentType = MediaType.WIDGET

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "Widget")
            loadUrl(url)
        }
    }

    fun playVideoFromUrl(url: String, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Streaming video from URL: $url (muted=$muted)")
        currentType = MediaType.VIDEO

        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.apply {
            volume = if (muted || wallMute) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            prepare()
            playWhenReady = true
        }
    }

    fun showImageFromUrl(url: String, transition: TransitionSpec? = null) {
        Log.i("MediaPlayerManager", "Loading remote image: $url")
        // Capture the outgoing frame NOW, on the main thread, before the decode thread swaps it out.
        val from = if (transition != null) captureCurrentFrame() else null
        Thread {
            val bitmap = ImageLoader.decodeUrl(url, ImageLoader.screenWidth(context), ImageLoader.screenHeight(context))
            mainHandler.post {
                if (bitmap == null) {
                    Log.w("MediaPlayerManager", "Skipping unloadable remote image: $url")
                    onImageError?.invoke(); return@post
                }
                if (!runWipe(bitmap, transition, from) { mountImageBitmap(bitmap) }) mountImageBitmap(bitmap)
            }
        }.start()
    }

    /**
     * #group-sync double buffer: pre-open/pre-buffer the NEXT clip on the parked second player so the
     * upcoming boundary switch (playVideo of the same file) is a warm swap instead of a cold prepare.
     * Cheap to call every tick — it no-ops if this file is already the preloaded one. Main thread only.
     */
    fun preloadVideo(file: File) {
        if (preloadedFile?.absolutePath == file.absolutePath) return
        val p = preloadPlayer ?: buildPlayer().also { preloadPlayer = it }
        if (warmSurface == null) { warmTexture = SurfaceTexture(0).apply { setDefaultBufferSize(16, 16) }; warmSurface = Surface(warmTexture) }
        p.apply {
            setVideoSurface(warmSurface)                  // decode frame 0 offscreen -> video size known pre-swap
            volume = 0f                                   // silent while parked; real volume set on swap
            repeatMode = if (videoLooping) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            playWhenReady = false                         // buffer/parse/decode-frame-0 now, don't start
            prepare()
        }
        preloadedFile = file
        Log.i("MediaPlayerManager", "Preloaded next video: ${file.name}")
    }

    fun playVideo(file: File, muted: Boolean = false, transition: TransitionSpec? = null) {
        // image->video / video->video wipe: extract the incoming clip's first frame OFF the main thread,
        // wipe from the outgoing frame into it, then warm-mount the real video (which starts from frame 0,
        // matching the wipe's `to`). Any failure hard-cuts to the plain mount. Local files only — remote
        // streams (playVideoFromUrl) keep the plain path.
        if (transition != null && transitionsActive()) {
            val from = captureCurrentFrame()
            if (from != null) {
                Thread {
                    val toBmp = extractFirstFrame(file.absolutePath)
                    mainHandler.post {
                        if (toBmp != null && runWipe(toBmp, transition, from) { mountVideo(file, muted) }) return@post
                        mountVideo(file, muted)
                    }
                }.start()
                return
            }
        }
        mountVideo(file, muted)
    }

    private fun mountVideo(file: File, muted: Boolean = false) {
        currentType = MediaType.VIDEO

        // Show player, hide image
        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        // Warm swap: if this exact file was preloaded, promote the parked player instead of a cold
        // prepare — the container is already open/buffered so the first frame renders near-instantly.
        val pp = preloadPlayer
        if (pp != null && preloadedFile?.absolutePath == file.absolutePath) {
            Log.i("MediaPlayerManager", "Playing video (warm swap): ${file.name}")
            val old = exoPlayer
            exoPlayer = pp
            preloadPlayer = old
            preloadedFile = null
            pp.apply {
                volume = if (muted || wallMute) 0f else 1f
                repeatMode = if (videoLooping) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                playWhenReady = true
            }
            playerView.player = pp
            // Park the previous active player as the new preload slot (idle until the next preloadVideo).
            old?.apply { playWhenReady = false; clearMediaItems() }
            return
        }

        Log.i("MediaPlayerManager", "Playing video: ${file.absolutePath} (muted=$muted)")
        exoPlayer?.apply {
            volume = if (muted || wallMute) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            prepare()
            playWhenReady = true
        }
    }

    fun showImage(file: File, transition: TransitionSpec? = null) {
        Log.i("MediaPlayerManager", "Showing image: ${file.absolutePath}")
        val bitmap = ImageLoader.decodeFile(file, ImageLoader.screenWidth(context), ImageLoader.screenHeight(context))
        if (bitmap == null) {
            Log.w("MediaPlayerManager", "Skipping unloadable image: ${file.name}")
            onImageError?.invoke()
            return
        }
        // Capture the outgoing frame (image or the video's TextureView) BEFORE the swap; decode above
        // doesn't touch the views, so it still reflects what's on screen. Wipe into the image, else hard cut.
        val from = if (transition != null) captureCurrentFrame() else null
        if (!runWipe(bitmap, transition, from) { mountImageBitmap(bitmap) }) mountImageBitmap(bitmap)
    }

    fun stop() {
        exoPlayer?.stop()
        imageView.setImageBitmap(null)
        youtubeWebView?.loadUrl("about:blank")
        youtubeWebView?.visibility = android.view.View.GONE
        currentType = MediaType.NONE
    }

    fun release() {
        exoPlayer?.release()
        exoPlayer = null
        preloadPlayer?.release()
        preloadPlayer = null
        preloadedFile = null
        warmSurface?.release(); warmSurface = null
        warmTexture?.release(); warmTexture = null
    }

    fun isPlayingVideo(): Boolean = currentType == MediaType.VIDEO && (exoPlayer?.isPlaying == true)

    // #129: live per-item mute. Applies a dashboard mute toggle to the CURRENTLY playing
    // item in real time (decoupled from a playlist reload). Native video -> ExoPlayer
    // volume; YouTube -> the IFrame API mute()/unMute() bridge (setYoutubeMuted), which
    // previously this method ignored so YouTube could never be un/muted live. Images/
    // widgets are silent. Persistence across the next play comes from the playlist
    // payload's per-item `muted` (honored in playVideo/playYoutube). Main thread only.
    fun setVideoMuted(muted: Boolean) {
        when (currentType) {
            MediaType.VIDEO -> exoPlayer?.volume = if (muted) 0f else 1f
            MediaType.YOUTUBE -> setYoutubeMuted(muted)   // #129: was a no-op for YouTube
            else -> {}
        }
    }

    // ---- Video-wall (wall:sync) accessors. All must be called on the main thread. ----

    /** Current video position in ms (0 when no video). */
    fun currentPositionMs(): Long = exoPlayer?.currentPosition ?: 0L

    /** Video duration in ms, or -1 when unknown/unprepared. */
    fun durationMs(): Long {
        val d = exoPlayer?.duration ?: C.TIME_UNSET
        return if (d == C.TIME_UNSET) -1L else d
    }

    /** Exact (frame-accurate) seek for the follower drift controller's hard-seek path. */
    fun seekExact(positionMs: Long) {
        exoPlayer?.apply {
            setSeekParameters(SeekParameters.EXACT)
            seekTo(positionMs)
        }
    }

    /** Playback rate — followers nudge ±3% to converge on the leader's clock. */
    fun setSpeed(rate: Float) { exoPlayer?.setPlaybackSpeed(rate) }

    /**
     * Wall follower mute. Persists across item switches (the leader's sync can move a
     * follower to an unmuted item, and N copies of the same audio out of phase flange),
     * and enforces the mute on whatever is playing right now.
     */
    fun setWallMute(mute: Boolean) {
        wallMute = mute
        if (mute) exoPlayer?.volume = 0f
    }

    /**
     * Loop the current video for wall followers so they never freeze on the last frame
     * if the leader's next index sync is slightly late; the leader plays through normally.
     */
    fun setVideoLooping(loop: Boolean) {
        videoLooping = loop
        exoPlayer?.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        preloadPlayer?.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }

    /**
     * In wall mode the content fills its slice (object-fit:fill parity with the web/Tizen
     * players); restore the default fit on exit.
     */
    fun setWallMode(enabled: Boolean) {
        playerView.resizeMode =
            if (enabled) AspectRatioFrameLayout.RESIZE_MODE_FILL else AspectRatioFrameLayout.RESIZE_MODE_FIT
        imageView.scaleType =
            if (enabled) ImageView.ScaleType.FIT_XY else ImageView.ScaleType.FIT_CENTER
    }
}
