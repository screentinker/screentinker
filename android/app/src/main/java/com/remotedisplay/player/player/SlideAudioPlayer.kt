package com.remotedisplay.player.player

import android.content.Context
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

/**
 * Slide audio: a voiceover that belongs to one item, and a music bed that outlives the advance.
 *
 * ⚠️ THE ONE RULE THAT CARRIES THE FEATURE. The bed is keyed on its TRACK ID, and a matching id is
 * left completely alone — not re-prepared, not restarted, not even re-set. A deck publishes the
 * same music id onto every one of its slides precisely so that branch is taken once, when the deck
 * starts. Comparing URLs instead would restart the music the first time somebody replaced the audio
 * file, because /api/content/:id/replace keeps the id and writes a new path.
 *
 * ⚠️ TWO PLAYERS, NOT ONE, AND NOT THE VIDEO ONE. MediaPlayerManager's ExoPlayer owns the surface
 * and is torn down on every item; these have no surface and a different lifetime, so they are their
 * own instances. Sharing would tie the bed's life to the video's, which is the bug being avoided.
 *
 * Mirrors applySlideAudio in server/player/index.html and PlaylistPlayer.applySlideAudio in
 * tizen/js/player.js — same fields, same precedence, same restart rule. Three copies is two too
 * many, but they are three different runtimes; keeping the RULE identical is what matters, so any
 * change here belongs in all three.
 */
class SlideAudioPlayer(private val context: Context) {

    private var vo: ExoPlayer? = null
    private var bed: ExoPlayer? = null
    private var bedTrackId: String? = null
    // The item's own volumes, kept so an unmute restores what was authored rather than full blast.
    private var voVolume = 1f
    private var bedVolume = 0.4f
    // Two independent silencers, kept apart so lifting one cannot un-silence the other: the item's
    // own verdict (item.muted / wall follower) and a transient overlay mute. Effective = either.
    private var itemMuted = false
    private var externalMuted = false
    private val silent: Boolean get() = itemMuted || externalMuted

    /**
     * Apply this item's audio.
     *
     * @param muted the caller's verdict, not a guess made here. Android's precedence is
     *   `item.muted || wallMute || triggerMute` (MediaPlayerManager mountVideo/playYoutube), and
     *   slide audio is subject to exactly the same three — a wall follower must not give a room the
     *   same voice from six panels a few milliseconds apart, and an operator who muted an item
     *   meant the item. Muting here still keeps the bed's IDENTITY so unmuting does not restart it.
     */
    fun apply(audio: SlideAudio?, muted: Boolean) {
        itemMuted = muted

        // ---- voiceover: this item's, and only this item's.
        releaseVo()
        val voUrl = audio?.voUrl
        if (voUrl != null) {
            try {
                voVolume = audio.voVolume
                vo = ExoPlayer.Builder(context).build().apply {
                    setMediaItem(MediaItem.fromUri(voUrl))
                    repeatMode = Player.REPEAT_MODE_OFF
                    volume = if (silent) 0f else audio.voVolume
                    prepare()
                    playWhenReady = true
                }
            } catch (t: Throwable) {
                Log.w(TAG, "voiceover failed to start: ${t.message}")
            }
        }

        // ---- bed: continuous while consecutive items name the same track.
        val musicId = audio?.musicId
        val musicUrl = audio?.musicUrl
        if (musicId == null || musicUrl == null) { releaseBed(); return }
        bedVolume = audio.musicVolume

        if (musicId != bedTrackId) {
            releaseBed()
            try {
                bed = ExoPlayer.Builder(context).build().apply {
                    setMediaItem(MediaItem.fromUri(musicUrl))
                    repeatMode = Player.REPEAT_MODE_ONE   // a bed loops; a voiceover does not
                    volume = if (silent) 0f else audio.musicVolume
                    prepare()
                    playWhenReady = true
                }
                bedTrackId = musicId
            } catch (t: Throwable) {
                Log.w(TAG, "music bed failed to start: ${t.message}")
                releaseBed()
            }
        } else {
            // Same track: volume only. Touching the media item here is audible as a stutter at
            // every slide change, which is exactly what a bed must never do.
            try { bed?.volume = if (silent) 0f else audio.musicVolume } catch (_: Throwable) {}
        }
    }

    /**
     * Silence (or restore) without tearing anything down — the trigger-overlay case, mirroring
     * MediaPlayerManager.setTriggerMute. Restoring re-derives from the item's own volumes rather
     * than forcing 1f, for the reason recorded there: an item the operator muted stays muted.
     */
    fun setMuted(muted: Boolean) {
        externalMuted = muted
        try { vo?.volume = if (silent) 0f else voVolume } catch (_: Throwable) {}
        try { bed?.volume = if (silent) 0f else bedVolume } catch (_: Throwable) {}
    }

    /** Teardown. Called when playback STOPS — never on an advance, or the bed would not be a bed. */
    fun stop() {
        releaseVo()
        releaseBed()
    }

    private fun releaseVo() {
        try { vo?.release() } catch (_: Throwable) {}
        vo = null
    }

    private fun releaseBed() {
        try { bed?.release() } catch (_: Throwable) {}
        bed = null
        bedTrackId = null
    }

    companion object { private const val TAG = "SlideAudio" }
}

/**
 * The audio block on a playlist item, as the server sends it.
 *
 * URLs arrive server-relative (`/uploads/content/...`) and are absolutised by the caller, which is
 * the only place that knows the server base — the same treatment every other media path gets.
 */
data class SlideAudio(
    val voUrl: String? = null,
    val voVolume: Float = 1f,
    val musicId: String? = null,
    val musicUrl: String? = null,
    val musicVolume: Float = 0.4f,
) {
    val isEmpty: Boolean get() = voUrl == null && musicId == null
}
