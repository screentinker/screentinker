package com.remotedisplay.player.player

/*
 * Uploaded AUDIO files (MP3, M4A, Ogg, WAV, FLAC: audio/mpeg, audio/mp4, audio/ogg, audio/wav,
 * audio/flac). Uploads have always accepted them, but every routing site here only knew image/ and
 * video/, so full screen an audio item fell into "Unrecognised item type ... skipping" and in a zone
 * it matched nothing and showed an empty region.
 *
 * Audio now plays exactly like a clip (the same ExoPlayer path, so the same per-item mute, live
 * mute, wall-follower and trigger mutes, error -> skip, advance on STATE_ENDED, and loop for a
 * single-item playlist). What differs is the picture: there is none. Full screen it sits on a simple
 * "now playing" card (AudioCard); in a zone it shows nothing. Parity with the web player (1902ba2a).
 *
 * ⚠️ AN AUDIO FILE NEVER RENDERS A FIRST FRAME. Anything gated on onRenderedFirstFrame (the #298
 * switch cover, a zone transition's reveal, a wall zone's buffered swap) must not wait on it for an
 * audio item; each such site checks [isAudio] and does not.
 */
object MediaKind {
    fun isAudio(mime: String?): Boolean = mime != null && mime.startsWith("audio/")

    /**
     * Played through an ExoPlayer like a clip: a video/ mime or an uploaded audio file. Callers have
     * already routed the special video/ mimes (youtube, hls, rtsp, hdmi-in) before asking this.
     */
    fun playsAsClip(mime: String?): Boolean = mime != null && (mime.startsWith("video/") || isAudio(mime))

    /** The name the now-playing card shows: the filename without its extension (web player rule). */
    fun audioTitle(filename: String?): String =
        (filename ?: "").replace(Regex("\\.[a-z0-9]{2,4}$", RegexOption.IGNORE_CASE), "")
}
