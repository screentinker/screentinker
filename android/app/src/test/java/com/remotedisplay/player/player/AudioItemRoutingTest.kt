package com.remotedisplay.player.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Uploaded audio items (MediaKind). They used to be skipped full screen ("Unrecognised item type
 * audio/mpeg") and to render nothing, forever, in a zone. They now route to the clip path, end on
 * STATE_ENDED (not a timer), and never wait on a first frame that an audio file cannot render.
 */
class AudioItemRoutingTest {

    private val uploadable = listOf("audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/flac")

    @Test fun `every uploadable audio type is audio and plays as a clip`() {
        for (m in uploadable) {
            assertTrue(m, MediaKind.isAudio(m))
            assertTrue(m, MediaKind.playsAsClip(m))
        }
    }

    @Test fun `video still plays as a clip, images and others do not, and none of them are audio`() {
        assertTrue(MediaKind.playsAsClip("video/mp4"))
        assertFalse(MediaKind.isAudio("video/mp4"))
        for (m in listOf("image/png", ItemTiming.BUNDLE_MIME, "application/x-nope", "", null)) {
            assertFalse("$m", MediaKind.playsAsClip(m))
            assertFalse("$m", MediaKind.isAudio(m))
        }
    }

    @Test fun `audio ends on its completion callback, not a timer (the clip rule)`() {
        for (m in uploadable) assertFalse(m, ItemTiming.endsOnTimer(m, isWidget = false))
    }

    @Test fun `a zone transition into audio cuts, so it never waits on a first frame`() {
        for (m in uploadable) {
            assertEquals(m, ZoneTarget.NONE, ZoneTransitionPolicy.targetKind(m, null, null, hasCachedFile = true))
            val spec = TransitionSpec(listOf(TransitionEffect("CRTCollapse", emptyMap())), 800)
            assertEquals(m, ZoneTxMode.CUT, ZoneTransitionPolicy.decide(spec, 0, 1, ZoneFace.IMAGE,
                ZoneTransitionPolicy.targetKind(m, null, null, true), true, true, true, true))
        }
        // And out of an audio zone (face NONE: nothing on screen to capture) it cuts too.
        val spec = TransitionSpec(listOf(TransitionEffect("CRTCollapse", emptyMap())), 800)
        assertEquals(ZoneTxMode.CUT, ZoneTransitionPolicy.decide(spec, 0, 1, ZoneFace.NONE, ZoneTarget.IMAGE, true, true, true, true))
    }

    @Test fun `the now-playing title is the filename without its extension`() {
        assertEquals("Lobby mix", MediaKind.audioTitle("Lobby mix.mp3"))
        assertEquals("track", MediaKind.audioTitle("track.FLAC"))
        assertEquals("a.b", MediaKind.audioTitle("a.b.m4a"))
        assertEquals("no extension", MediaKind.audioTitle("no extension"))
        assertEquals("", MediaKind.audioTitle(null))
    }

    // ---- wiring guards: the routing sites ask MediaKind (these are Android-bound, so read the source)

    private fun src(rel: String) = File("src/main/java/com/remotedisplay/player/$rel").readText()

    @Test fun `full screen routes audio to playAudio before the unrecognised-type skip`() {
        val s = src("MainActivity.kt")
        val play = s.indexOf("mediaPlayer.playAudio(file,")
        val skip = s.indexOf("Unrecognised item type")
        assertTrue("playFile has an audio branch", play > 0)
        assertTrue("the audio branch comes before the skip", play < skip)
        assertTrue("remote audio streams on the card", s.contains("mediaPlayer.playAudioFromUrl("))
        assertTrue("the group double buffer warms audio too", s.contains("MediaKind.playsAsClip(next.mimeType)"))
    }

    @Test fun `audio skips the first-frame cover full screen and shows the card`() {
        val s = src("player/MediaPlayerManager.kt")
        assertTrue(s.contains("if (audioCard == null) coverSwitchGap(myGeneration)"))
        assertTrue(s.contains("if (audioCard != null) showAudioCard(audioCard)"))
    }

    @Test fun `zones and wall zones play audio with no picture and no first-frame wait`() {
        val z = src("player/ZoneManager.kt")
        assertTrue(z.contains("MediaKind.playsAsClip(mimeType) ->"))
        assertTrue(z.contains("zoneFaces[zone.id] = if (isAudio) ZoneFace.NONE else ZoneFace.VIDEO"))
        val w = src("player/WallZoneRenderer.kt")
        assertTrue(w.contains("MediaKind.isAudio(mime) -> buildVideo("))
        assertTrue(w.contains("if (frozenAtEnd || audio) revealNow(m)"))
    }
}
