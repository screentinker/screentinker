package com.remotedisplay.player.player

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.io.File

class MediaPlayerManager(
    private val context: Context,
    private val playerView: PlayerView,
    private val imageView: ImageView,
    private val youtubeWebView: WebView? = null,
    private val onVideoComplete: () -> Unit
) {
    private var exoPlayer: ExoPlayer? = null
    private var currentType: MediaType = MediaType.NONE

    enum class MediaType { NONE, VIDEO, IMAGE, YOUTUBE }

    init {
        setupExoPlayer()
    }

    private fun setupExoPlayer() {
        exoPlayer = ExoPlayer.Builder(context).build().also { player ->
            playerView.player = player
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (playbackState == Player.STATE_ENDED) {
                        onVideoComplete()
                    }
                }
            })
        }
    }

    fun playYoutube(embedUrl: String, durationSec: Int = 0) {
        Log.i("MediaPlayerManager", "Playing YouTube: $embedUrl")
        currentType = MediaType.YOUTUBE

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            setBackgroundColor(android.graphics.Color.BLACK)
            loadUrl(embedUrl)
        }
    }

    fun playVideoFromUrl(url: String, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Streaming video from URL: $url (muted=$muted)")
        currentType = MediaType.VIDEO

        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.apply {
            volume = if (muted) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            prepare()
            playWhenReady = true
        }
    }

    fun showImageFromUrl(url: String) {
        Log.i("MediaPlayerManager", "Loading remote image: $url")
        currentType = MediaType.IMAGE

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.VISIBLE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.stop()

        // Load image from URL in background
        Thread {
            try {
                val connection = java.net.URL(url).openConnection()
                connection.connectTimeout = 10000
                connection.readTimeout = 30000
                val input = connection.getInputStream()
                val bitmap = android.graphics.BitmapFactory.decodeStream(input)
                input.close()
                if (bitmap != null) {
                    imageView.post { imageView.setImageBitmap(bitmap) }
                }
            } catch (e: Exception) {
                Log.e("MediaPlayerManager", "Remote image load failed: ${e.message}")
            }
        }.start()
    }

    fun playVideo(file: File, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Playing video: ${file.absolutePath} (muted=$muted)")
        currentType = MediaType.VIDEO

        // Show player, hide image
        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.apply {
            volume = if (muted) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            prepare()
            playWhenReady = true
        }
    }

    fun showImage(file: File) {
        Log.i("MediaPlayerManager", "Showing image: ${file.absolutePath}")
        currentType = MediaType.IMAGE

        // Show image, hide player
        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.VISIBLE
        youtubeWebView?.visibility = android.view.View.GONE

        // Stop video if playing
        exoPlayer?.stop()

        // Load image
        try {
            val bitmap = android.graphics.BitmapFactory.decodeFile(file.absolutePath)
            if (bitmap != null) {
                imageView.setImageBitmap(bitmap)
            } else {
                Log.e("MediaPlayerManager", "Failed to decode image: ${file.absolutePath}")
            }
        } catch (e: Exception) {
            Log.e("MediaPlayerManager", "Error loading image: ${e.message}")
        }
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
    }

    fun isPlayingVideo(): Boolean = currentType == MediaType.VIDEO && (exoPlayer?.isPlaying == true)
}
