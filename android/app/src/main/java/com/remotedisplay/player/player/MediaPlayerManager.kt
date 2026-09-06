package com.remotedisplay.player.player

import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.graphics.drawable.BitmapDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
    /*
     * #333: a video that FAILED (playback error, wedged decoder), as opposed to one that finished.
     * Kept apart from onVideoComplete because the two are gated differently downstream: a
     * follower / group member ignores a completion (the sync owns the index) but must recover
     * from a fault. Defaults to onVideoComplete for callers that never sync (zones).
     */
    private val onVideoFault: () -> Unit = onVideoComplete,
    private val onImageError: (() -> Unit)? = null,
    // feat/transition-engine: the full-screen GL overlay that plays a from->to wipe. Null = no
    // transitions (every render hard-cuts, exactly as before).
    private val transitionView: TransitionGLView? = null
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var exoPlayer: ExoPlayer? = null
    private var currentType: MediaType = MediaType.NONE
    // The URL the widget WebView currently has loaded, so re-showing the same widget can be a
    // no-op. Cleared whenever anything else takes the surface (see clearWidgetUrl callers).
    private var currentWidgetUrl: String? = null
    // Wall mode: followers must stay muted even as the leader's sync switches them
    // to a new (possibly unmuted) item, so the mute has to survive each playVideo.
    private var wallMute = false
    /*
     * ⚠️ Base audio while a TRIGGER overlay covers the screen. Separate from wallMute because the
     * two are different facts with different lifetimes — a wall follower is silent permanently, a
     * base playlist is silent for the duration of an alarm — and OR-ing them at each use site is
     * what makes both survive a playVideo. The web player learned this as `baseAudioSuppressed`:
     * a per-element write is undone by the next item mount, so the flag has to be consulted where
     * the volume is DECIDED, not applied once when the trigger fires.
     */
    private var triggerMute = false
    // #group-sync loop state, tracked so it can be applied to a freshly-swapped double-buffer player.
    private var videoLooping = false
    // #group-sync double buffer: a second ExoPlayer that pre-opens/pre-buffers the NEXT clip so the
    // boundary switch is a warm swap (~100-300ms) instead of a cold prepare (~1-2s black hold). Only
    // engaged when preloadVideo() is called ahead of a boundary (group sync); the wall/solo paths are
    // untouched (they never preload, so playVideo takes the normal cold path).
    private var preloadPlayer: ExoPlayer? = null
    // #333: which clip is parked, and whether the parked player may be promoted. See PreloadSlot.
    private val preloadSlot = PreloadSlot()
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
            // fired. A playback error is a FAULT (#333): the solo path still advances past it
            // (mirrors the web/.wgt onerror -> advance), a follower re-mounts instead.
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                if (player === exoPlayer) {
                    Log.e("MediaPlayerManager", "Playback error (${error.errorCodeName}) — recovering: ${error.message}")
                    onVideoFault()
                    return
                }
                /*
                 * #333: the PARKED player failed — typically DECODER_INIT_FAILED / resources
                 * reclaimed, because the preload is the one moment this app asks a TV SoC for a
                 * second hardware decoder. This used to be dropped on the floor, and the boundary
                 * then promoted the dead player (see PreloadSlot). Forget the file so the
                 * boundary takes the cold path, and let go of whatever the failed prepare holds.
                 */
                Log.w("MediaPlayerManager", "Preload failed (${error.errorCodeName}) — next boundary takes the cold path: ${error.message}")
                preloadSlot.fail()
                try { player.clearMediaItems() } catch (_: Throwable) {}
            }

            /*
             * #298: the ONLY trustworthy signal that the decoder is putting real pixels on the
             * surface. Everything before this point can be an uninitialised buffer, so the still
             * frame stays over the top until this fires.
             */
            override fun onRenderedFirstFrame() {
                if (player === exoPlayer) clearSwitchCover()
            }
        })
    }

    private fun setupExoPlayer() {
        /*
         * ⚠️ #298, THE GREEN SCREEN. This line used to be the whole story, with the comment "hold
         * the last frame instead of flashing black during a reset/prepare". Turning the shutter off
         * does stop the black flash — but it does NOT hold the last frame. It uncovers the video
         * surface, and with surface_type=texture_view the buffer behind it during a decoder
         * reconfiguration is whatever the SoC left there: on several TV chipsets that is
         * uninitialised YUV, which paints SOLID GREEN. That is exactly the report — TVs only, at
         * the switch to the next video, unaffected by re-encoding the file, gone on a loop restart
         * (no reconfiguration). The freeze-frame is now painted explicitly by coverSwitchGap()
         * into the ImageView above this surface, so the promise in the old comment is actually
         * kept, and the shutter is re-armed for the case where no frame could be captured.
         */
        try { playerView.setKeepContentOnPlayerReset(true) } catch (e: Throwable) {}
        exoPlayer = buildPlayer().also { playerView.player = it }
    }

    // ---------------------------------------------------------------- #298: cover the switch gap

    /** Generation that owns the cover, so a mount of something else cannot have it pulled away. */
    private var coverGeneration: Long = -1L

    private val clearCoverTimeout = Runnable { clearSwitchCover() }

    /**
     * Paint the frame that is on screen NOW into the ImageView (which the layout stacks above the
     * PlayerView) and leave it there until the decoder renders its first real frame.
     *
     * Must be called before currentType is changed, since captureCurrentFrame() reads it to decide
     * where the pixels come from.
     */
    /*
     * ⚠️ ONE REUSED, HALF-SIZE BITMAP. The obvious implementation calls captureCurrentFrame(), which
     * allocates a fresh full-resolution bitmap — ~8MB on a 1080p panel and ~33MB on a 4K one, every
     * single video switch. Transitions can afford that because they are opt-in and occasional; this
     * runs on every mount, on the memory-constrained TV sticks that are already the ones failing.
     * Half resolution is invisible behind a ~200ms gap, and reusing the buffer means the steady
     * state allocates nothing at all.
     */
    private var coverBitmap: Bitmap? = null

    private fun captureCoverFrame(): Bitmap? = try {
        val tv = playerView.videoSurfaceView as? TextureView
        if (tv == null || !tv.isAvailable || tv.width <= 0 || tv.height <= 0) null
        else {
            val w = (tv.width / 2).coerceAtLeast(1)
            val h = (tv.height / 2).coerceAtLeast(1)
            val reuse = coverBitmap
            val target = if (reuse != null && !reuse.isRecycled && reuse.width == w && reuse.height == h) reuse
                else Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { coverBitmap = it }
            tv.getBitmap(target)
        }
    } catch (e: Throwable) { null }

    private fun coverSwitchGap(generation: Long) {
        /*
         * Coming from an IMAGE there is nothing to capture: the ImageView is already showing the
         * right pixels. Leaving it visible is both the correct still and free.
         */
        if (currentType == MediaType.IMAGE && imageView.drawable != null) {
            coverGeneration = generation
            mainHandler.removeCallbacks(clearCoverTimeout)
            mainHandler.postDelayed(clearCoverTimeout, COVER_MAX_MS)
            return
        }
        val frame = if (currentType == MediaType.VIDEO) captureCoverFrame() else null
        if (frame == null) {
            /*
             * ⚠️ NOTHING TO HOLD, SO GO BACK TO BLACK. With no still to cover it, leaving the
             * shutter off is what shows the green buffer. A brief black hold is the lesser fault,
             * and it is what every build before the shutter was disabled did.
             */
            try { playerView.setKeepContentOnPlayerReset(false) } catch (e: Throwable) {}
            return
        }
        coverGeneration = generation
        imageView.setImageBitmap(frame)
        imageView.visibility = android.view.View.VISIBLE
        try { playerView.setKeepContentOnPlayerReset(true) } catch (e: Throwable) {}
        /*
         * A decoder that never renders would otherwise leave the still up forever, so the video
         * plays inaudibly behind a photo. The stall watchdog below eventually advances, but the
         * cover must not outlive a couple of seconds of gap regardless.
         */
        mainHandler.removeCallbacks(clearCoverTimeout)
        mainHandler.postDelayed(clearCoverTimeout, COVER_MAX_MS)
    }

    private fun clearSwitchCover() {
        if (coverGeneration != mountGeneration) return   // something else owns the ImageView now
        coverGeneration = -1L
        mainHandler.removeCallbacks(clearCoverTimeout)
        if (currentType != MediaType.VIDEO) return       // an image mount already took it over
        imageView.visibility = android.view.View.GONE
        /*
         * Deliberately NOT setImageBitmap(null): the drawable may be the reused cover buffer, and
         * it may equally be the bitmap an image mount still owns. Hiding the view is enough, and
         * dropping the reference is what would force the next capture to allocate again.
         */
    }

    // -------------------------------------------------------------- #297: the wedged-decoder poll

    /*
     * ⚠️ THE FREEZE HAS NO EVENT. A video advances on STATE_ENDED or on a playback error; a decoder
     * that wedges reports neither, so "playback freezes, only restarting the app helps". The same
     * shape as the stranded-decode freeze documented at mountGeneration below — the difference is
     * that one had a signal to guard and this one has to be observed.
     */
    private val stall = PlaybackStall()

    private val stallTick = object : Runnable {
        override fun run() {
            val p = exoPlayer
            if (p != null && currentType == MediaType.VIDEO) {
                val wedged = try {
                    stall.tick(SystemClock.elapsedRealtime(), p.playbackState, p.playWhenReady, p.currentPosition)
                } catch (e: Throwable) { false }
                if (wedged) {
                    Log.w("MediaPlayerManager", "Playback stalled with no error or end — recovering")
                    resetPlayersAfterWedge()
                    onVideoFault()
                }
            } else {
                stall.reset()
            }
            mainHandler.postDelayed(this, STALL_POLL_MS)
        }
    }

    private companion object {
        const val STALL_POLL_MS = 2_000L
        const val COVER_MAX_MS = 2_500L
    }

    /*
     * #333: a wedged decoder is in an unknown state, and on the Xiaomi P1s the wedge was CAUSED by
     * the second decoder the double buffer asked for. "Restart the app" is what recovered it in the
     * field, and the part of a restart that matters is fresh players — so build one. Both players
     * go: the parked one because it is the extra decoder, the active one because reusing a wedged
     * codec is what a plain re-prepare would do. The preload slot is cleared with it, so the
     * re-mount that follows (onVideoFault -> replay) takes the cold path on a player that owns the
     * decoder outright.
     */
    private fun resetPlayersAfterWedge() {
        preloadPlayer?.let { p -> try { p.release() } catch (_: Throwable) {} }
        preloadPlayer = null
        preloadSlot.clear()
        exoPlayer?.let { p -> try { p.release() } catch (_: Throwable) {} }
        exoPlayer = buildPlayer().also { playerView.player = it }
        stall.reset()
    }

    /*
     * ⚠️ STARTED HERE, NOT FROM setupExoPlayer(). setupExoPlayer() runs from the init block at the
     * top of the class, and Kotlin initialises properties in declaration order — stallTick is
     * declared above but assigned after that init runs, so posting it from there hands the Handler
     * a null Runnable and the player crashes on construction. That is the same shape as the boot
     * TDZ that shipped in 1.9.32 and threw on every start, so it gets its own init block, below
     * everything it touches.
     */
    init {
        mainHandler.postDelayed(stallTick, STALL_POLL_MS)
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
        // #326: THE STAGE'S OWN BOX, NOT THE DEVICE'S.
        //
        // MainActivity rotates rootView for a portrait screen and TRANSPOSES its layout params
        // (lp.width = h, lp.height = w) before setting rotation. A View's rotation does not change
        // its layout bounds, so on a portrait panel the stage is laid out 1080x1920 while
        // displayMetrics still reports 1920x1080 — each the other's transpose. Fitting both bitmaps
        // to displayMetrics therefore played every wipe at the wrong aspect and snapped back when
        // the plain mount took over, which is the same fault #315 fixed in the web player.
        //
        // transitionView is added to that same rootView with MATCH_PARENT in both axes, so its own
        // measured size IS the stage box. Zero means it has not been laid out yet, and the existing
        // guard below turns that into a hard cut rather than a wipe fitted to nothing.
        val w = view.width; val h = view.height
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
        mountGeneration++
        stopYoutubeIfPlaying()
        currentType = MediaType.IMAGE
        currentWidgetUrl = null   // surface reused - a later widget show must reload
        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.VISIBLE
        youtubeWebView?.visibility = android.view.View.GONE
        exoPlayer?.stop()
        try { imageView.setImageBitmap(bitmap) }
        catch (e: Throwable) { Log.e("MediaPlayerManager", "setImageBitmap failed: ${e.message}"); onImageError?.invoke() }
    }

    /**
     * Stop a YouTube embed that is being switched away from.
     *
     * Hiding the WebView does NOT stop it — visibility is not playback state, so the video kept
     * running behind the next item and its audio carried on over the top. Reported after YouTube
     * items started advancing at all (before that they never ended, so nothing ever switched away
     * from one and this could not surface): "even when the picture is there the sound from the
     * video continues playing".
     *
     * Blanking is what stop() already does, and it is safe here because playYoutube always reloads
     * the embed from scratch anyway. Guarded on the OUTGOING type so it must be called before
     * currentType is reassigned, and so it never blanks a widget that is being reused.
     */
    private fun stopYoutubeIfPlaying() {
        if (currentType != MediaType.YOUTUBE) return
        youtubeWebView?.loadUrl("about:blank")
    }

    fun playYoutube(embedUrl: String, durationSec: Int = 0, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Playing YouTube: $embedUrl (muted=$muted)")
        mountGeneration++
        currentType = MediaType.YOUTUBE
        currentWidgetUrl = null   // surface reused - a later widget show must reload
        youtubeMuted = muted || wallMute || triggerMute

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
        postYoutubeCommand(if (muted) "mute" else "unMute")
    }

    /** Send one IFrame-API command to the embed. Main thread only (WebView access). */
    private fun postYoutubeCommand(func: String) {
        val js = "(function(){try{var f=document.querySelector('iframe');" +
            "if(f&&f.contentWindow){f.contentWindow.postMessage(" +
            "JSON.stringify({event:'command',func:'$func',args:[]}),'*');}}catch(e){}})()"
        youtubeWebView?.let { wv -> wv.post { try { wv.evaluateJavascript(js, null) } catch (_: Throwable) {} } }
    }

    /**
     * The app is going to the background. Stop making noise.
     *
     * A WebView keeps running when its Activity stops — nothing in the lifecycle pauses it — so a
     * YouTube embed carried on playing with the app closed and the audio kept coming out of the
     * panel: "I closed the app and I can still hear the sound... I force stop the app and then open
     * again." A signage player that is not on screen must be silent.
     *
     * Pause rather than blank, so returning to the foreground resumes in place instead of
     * restarting the clip. pauseTimers() is process-wide, which is fine here (one WebView) and is
     * what actually stops the embed's own scripted playback.
     */
    fun onAppBackgrounded() {
        if (currentType == MediaType.YOUTUBE) postYoutubeCommand("pauseVideo")
        youtubeWebView?.let { wv -> wv.post { try { wv.onPause(); wv.pauseTimers() } catch (_: Throwable) {} } }
        exoPlayer?.pause()
    }

    /** Back in the foreground: undo onAppBackgrounded. */
    fun onAppForegrounded() {
        youtubeWebView?.let { wv -> wv.post { try { wv.resumeTimers(); wv.onResume() } catch (_: Throwable) {} } }
        if (currentType == MediaType.YOUTUBE) postYoutubeCommand("playVideo")
        if (currentType == MediaType.VIDEO) exoPlayer?.play()
    }

    // Fullscreen widget render (single-zone / "fullscreen" layouts). Reuses the
    // full-screen WebView; ZoneManager handles widgets in multi-zone layouts.
    fun showWidget(url: String) {
        // A solo-widget playlist re-shows the SAME item every duration_sec, and a playlist refresh
        // re-issues the current item too. Re-navigating the WebView for a URL it already has is a
        // visible flash, and it destroys widget state - a half-typed directory search, scroll
        // position, anything the viewer was doing. Widgets refresh their own data client-side
        // (directory-search polls the board's data.json every 30s), so the reload buys nothing.
        // Make the show idempotent: same URL + widget already on screen => leave it running.
        if (currentType == MediaType.WIDGET && url == currentWidgetUrl && youtubeWebView != null) {
            Log.i("MediaPlayerManager", "Widget already showing, not reloading: $url")
            youtubeWebView?.visibility = android.view.View.VISIBLE
            return
        }
        Log.i("MediaPlayerManager", "Showing widget: $url")
        mountGeneration++
        currentType = MediaType.WIDGET
        currentWidgetUrl = url

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "Widget")
            loadUrl(url)
        }
    }

    /**
     * Show a flattened HTML bundle from a string rather than a URL.
     *
     * ⚠️ loadDataWithBaseURL WITH A NULL BASE URL, DELIBERATELY. A null base gives the document an
     * OPAQUE origin, so operator-uploaded bundle scripts cannot reach this app's WebView storage or
     * issue same-origin requests against the ScreenTinker server — the same isolation the web
     * player gets from `sandbox="allow-scripts"`. Passing the server URL as the base would be the
     * obvious way to "make relative paths work" and would hand a bundle the server's origin; there
     * are no relative paths left to fix, because the server already inlined everything.
     *
     * Idempotent on [key] for the reason showWidget is idempotent on its URL: a solo-item playlist
     * re-shows the same item every duration_sec, and re-loading a running document restarts any
     * animation or state it was holding.
     */
    fun showBundle(html: String, key: String) {
        if (currentType == MediaType.WIDGET && key == currentWidgetUrl && youtubeWebView != null) {
            Log.i("MediaPlayerManager", "Bundle already showing, not reloading: $key")
            youtubeWebView?.visibility = android.view.View.VISIBLE
            return
        }
        Log.i("MediaPlayerManager", "Showing HTML bundle: $key (${html.length} chars)")
        mountGeneration++
        currentType = MediaType.WIDGET
        currentWidgetUrl = key

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "Bundle")
            loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
        }
    }

    fun playVideoFromUrl(url: String, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Streaming video from URL: $url (muted=$muted)")
        mountGeneration++
        stopYoutubeIfPlaying()
        currentType = MediaType.VIDEO
        currentWidgetUrl = null   // surface reused - a later widget show must reload

        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.apply {
            volume = if (muted || wallMute || triggerMute) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            prepare()
            playWhenReady = true
        }
    }

    /**
     * Bumped by every request to put something on screen. An async decode captures it and drops its
     * result if the value has moved on — the same drop-if-replaced token PipOverlay.loadImageInto
     * already carries.
     *
     * Without it a slow remote image (ImageLoader allows 10s connect + 30s read, against a slot
     * that is usually 10s) finished long after the playlist had advanced and mounted itself over
     * whatever was playing. If that was a video, the mount also called exoPlayer.stop(), which
     * lands in STATE_IDLE — and the advance listener only fires onVideoComplete on STATE_ENDED or a
     * playback error, so no advance was ever scheduled and the playlist stopped for good. The 60s
     * refresh could not rescue it either: the playlist signature was unchanged, so the update
     * returned early.
     */
    private var mountGeneration: Long = 0L

    fun showImageFromUrl(url: String, transition: TransitionSpec? = null) {
        Log.i("MediaPlayerManager", "Loading remote image: $url")
        // Capture the outgoing frame NOW, on the main thread, before the decode thread swaps it out.
        val from = if (transition != null) captureCurrentFrame() else null
        val myGeneration = ++mountGeneration
        Thread {
            val bitmap = ImageLoader.decodeUrl(url, ImageLoader.screenWidth(context), ImageLoader.screenHeight(context))
            mainHandler.post {
                // Something else has been asked for since this decode started — including the
                // error branch, whose onImageError posts next() and would otherwise cut short
                // whatever is now playing.
                if (myGeneration != mountGeneration) {
                    Log.i("MediaPlayerManager", "Dropping stale image decode: $url")
                    return@post
                }
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
        if (preloadSlot.isParked(file.absolutePath)) return
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
        preloadSlot.park(file.absolutePath)
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
        val myGeneration = ++mountGeneration
        // #298: grab the outgoing frame BEFORE currentType moves — captureCurrentFrame() reads it.
        coverSwitchGap(myGeneration)
        stall.reset()             // a new item starts its own stall clock
        stopYoutubeIfPlaying()
        currentType = MediaType.VIDEO
        currentWidgetUrl = null   // surface reused - a later widget show must reload

        // Show player. The ImageView stays up as the freeze-frame if coverSwitchGap took it, and is
        // hidden again by onRenderedFirstFrame.
        playerView.visibility = android.view.View.VISIBLE
        if (coverGeneration != myGeneration) imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        // Warm swap: if this exact file was preloaded, promote the parked player instead of a cold
        // prepare — the container is already open/buffered so the first frame renders near-instantly.
        val pp = preloadPlayer
        val claim = if (pp == null) PreloadSlot.Claim.COLD
                    else preloadSlot.claim(file.absolutePath, playerIsIdle = pp.playbackState == Player.STATE_IDLE)
        if (pp != null && claim != PreloadSlot.Claim.COLD) {
            Log.i("MediaPlayerManager", "Playing video (warm swap${if (claim == PreloadSlot.Claim.WARM_NEEDS_PREPARE) ", re-preparing" else ""}): ${file.name}")
            val old = exoPlayer
            exoPlayer = pp
            preloadPlayer = old
            pp.apply {
                volume = if (muted || wallMute || triggerMute) 0f else 1f
                repeatMode = if (videoLooping) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                // #333: a parked player that is still IDLE was never prepared (or lost its
                // prepare); playWhenReady alone would leave it sitting on 0:00 forever.
                if (claim == PreloadSlot.Claim.WARM_NEEDS_PREPARE) prepare()
                playWhenReady = true
            }
            playerView.player = pp
            // Park the previous active player as the new preload slot (idle until the next preloadVideo).
            old?.apply { playWhenReady = false; clearMediaItems() }
            return
        }

        Log.i("MediaPlayerManager", "Playing video: ${file.absolutePath} (muted=$muted)")
        exoPlayer?.apply {
            volume = if (muted || wallMute || triggerMute) 0f else 1f
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
        stall.reset()
        exoPlayer?.stop()
        imageView.setImageBitmap(null)
        youtubeWebView?.loadUrl("about:blank")
        youtubeWebView?.visibility = android.view.View.GONE
        currentType = MediaType.NONE
        currentWidgetUrl = null   // surface reused - a later widget show must reload
    }

    fun release() {
        coverBitmap = null
        mainHandler.removeCallbacks(stallTick)
        mainHandler.removeCallbacks(clearCoverTimeout)
        exoPlayer?.release()
        exoPlayer = null
        preloadPlayer?.release()
        preloadPlayer = null
        preloadSlot.clear()
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
     * Silence the BASE playlist while a trigger overlay covers the screen, and restore it after.
     *
     * ⚠️ Restoring re-derives from the flags rather than forcing 1f: an item an operator muted, or
     * a wall follower, must stay silent when the alarm clears. Forcing full volume here would be a
     * fifth rule that immediately disagreed with the four already in force.
     */
    fun setTriggerMute(mute: Boolean) {
        if (triggerMute == mute) return
        triggerMute = mute
        exoPlayer?.volume = if (mute || wallMute) 0f else 1f
        setYoutubeMuted(youtubeMuted || mute)
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
