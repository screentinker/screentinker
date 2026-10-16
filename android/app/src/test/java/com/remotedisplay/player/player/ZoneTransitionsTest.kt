package com.remotedisplay.player.player

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure half of zone transitions (ZoneTransitions.kt): which item's transition a zone plays,
 * the effect pick, the bounds, what wipes / crossfades / cuts, and the concurrency + cancel rules.
 * The GL half (ZoneTransitionEngine) needs a device; these hold the decisions it acts on.
 */
class ZoneTransitionsTest {

    private val spec = TransitionSpec(listOf(TransitionEffect("CRTCollapse", mapOf("lineHold" to 0.2f))), 800)

    private fun decide(
        s: TransitionSpec? = spec, prev: Int = 0, next: Int = 1,
        from: ZoneFace = ZoneFace.IMAGE, to: ZoneTarget = ZoneTarget.IMAGE,
        glUsable: Boolean = true, glFree: Boolean = true, viewFree: Boolean = true, shader: Boolean = true
    ) = ZoneTransitionPolicy.decide(s, prev, next, from, to, glUsable, glFree, viewFree, shader)

    // ---------------------------------------------------------------- which item's transition applies

    @Test fun `the item moved INTO carries the transition - none means a cut`() {
        assertEquals(ZoneTxMode.SHADER, decide())
        assertEquals(ZoneTxMode.CUT, decide(s = null))
        assertEquals(ZoneTxMode.CUT, decide(s = TransitionSpec(emptyList(), 800)))
    }

    @Test fun `a zone's first paint after a render cuts - nothing to wipe from`() {
        assertEquals(ZoneTxMode.CUT, decide(prev = -1, next = 0))
    }

    @Test fun `a zone re-showing the same item never transitions into itself`() {
        // One playable item left (the rest dayparted out) is re-shown every dwell.
        assertEquals(ZoneTxMode.CUT, decide(prev = 2, next = 2))
    }

    @Test fun `wrapping from the last item back to the first still transitions`() {
        assertEquals(ZoneTxMode.SHADER, decide(prev = 3, next = 0))
    }

    @Test fun `the per-item transition parses off a zone assignment as the server sends it`() {
        val a = JSONObject("""{"zone_id":"z1","mime_type":"image/png","transition":
            {"effects":[{"shader":"Wipe","params":{"angle":1.5}},{"shader":"VanEck","params":{}}],"durationMs":600}}""")
        val t = Transitions.parse(a.optJSONObject("transition"))
        assertNotNull(t)
        assertEquals(2, t!!.effects.size)
        assertEquals(600, t.durationMs)
        assertNull(Transitions.parse(JSONObject("""{"zone_id":"z1"}""").optJSONObject("transition")))
    }

    // ---------------------------------------------------------------- media combinations

    @Test fun `image and local video wipe in both directions`() {
        for (f in listOf(ZoneFace.IMAGE, ZoneFace.VIDEO))
            for (t in listOf(ZoneTarget.IMAGE, ZoneTarget.VIDEO_FILE))
                assertEquals("$f -> $t", ZoneTxMode.SHADER, decide(from = f, to = t))
    }

    @Test fun `out of a widget, a live input or an empty zone cuts`() {
        for (f in listOf(ZoneFace.WEB, ZoneFace.LIVE, ZoneFace.NONE))
            assertEquals("$f", ZoneTxMode.CUT, decide(from = f))
    }

    @Test fun `into a stream, a widget, YouTube, a live input or a hold cuts`() {
        for (t in listOf(ZoneTarget.VIDEO_STREAM, ZoneTarget.WEB, ZoneTarget.LIVE, ZoneTarget.HOLD, ZoneTarget.NONE))
            assertEquals("$t", ZoneTxMode.CUT, decide(to = t))
    }

    @Test fun `target kinds - only a cached local clip counts as a video file`() {
        val k = ZoneTransitionPolicy::targetKind
        assertEquals(ZoneTarget.IMAGE, k("image/jpeg", null, null, true))
        assertEquals(ZoneTarget.IMAGE, k("image/png", null, "https://x/y.png", false))   // remote image: decoded off-thread
        assertEquals(ZoneTarget.VIDEO_FILE, k("video/mp4", null, null, true))
        assertEquals(ZoneTarget.VIDEO_STREAM, k("video/mp4", null, null, false))          // uncached: streamed from the server
        assertEquals(ZoneTarget.VIDEO_STREAM, k("video/mp4", null, "https://x/a.mp4", true))
        assertEquals(ZoneTarget.VIDEO_STREAM, k("video/hls", null, "https://x/a.m3u8", false))
        assertEquals(ZoneTarget.VIDEO_STREAM, k("video/rtsp", null, "rtsp://cam", false))
        assertEquals(ZoneTarget.WEB, k("video/youtube", null, "https://youtu.be/x", false))
        assertEquals(ZoneTarget.WEB, k("", "clock", null, false))
        assertEquals(ZoneTarget.WEB, k(ItemTiming.BUNDLE_MIME, null, null, true))
        assertEquals(ZoneTarget.LIVE, k(LiveInput.MIME, null, "hdmi://1", false))
        assertEquals(ZoneTarget.HOLD, k(Hold.MIME, null, "hold://freeze", false))
        assertEquals(ZoneTarget.NONE, k("application/pdf", null, null, true))
    }

    // ---------------------------------------------------------------- fallbacks

    @Test fun `a missing shader crossfades on GL instead of cutting (native parity)`() {
        assertEquals(ZoneTxMode.GL_CROSSFADE, decide(shader = false))
    }

    @Test fun `no free GL slot degrades to the view crossfade, never a stall`() {
        assertEquals(ZoneTxMode.VIEW_CROSSFADE, decide(glFree = false))
        assertEquals(ZoneTxMode.VIEW_CROSSFADE, decide(glUsable = false))
        assertEquals(ZoneTxMode.VIEW_CROSSFADE, decide(glUsable = false, shader = false))
    }

    @Test fun `with every slot taken the zone cuts`() {
        assertEquals(ZoneTxMode.CUT, decide(glFree = false, viewFree = false))
    }

    @Test fun `the crossfade fallback is a complete fragment on the shared preamble`() {
        val f = TransitionGlsl.CROSSFADE
        assertTrue(f.startsWith(TransitionGlsl.PREAMBLE))
        assertTrue(f.contains("vec4 transition(vec2 uv)"))
        assertTrue(f.endsWith(TransitionGlsl.EPILOGUE))
    }

    // ---------------------------------------------------------------- effect pick + bounds

    @Test fun `effect pick is uniform over the effects and never out of range`() {
        assertEquals(0, Transitions.pickIndex(3, 0.0))
        assertEquals(1, Transitions.pickIndex(3, 0.34))
        assertEquals(2, Transitions.pickIndex(3, 0.99))
        assertEquals(2, Transitions.pickIndex(3, 1.0))      // r == 1 clamps
        assertEquals(0, Transitions.pickIndex(3, -0.5))
        assertEquals(0, Transitions.pickIndex(3, Double.NaN))
        assertEquals(0, Transitions.pickIndex(1, 0.7))
        assertEquals(-1, Transitions.pickIndex(0, 0.5))
        val two = TransitionSpec(listOf(TransitionEffect("A", emptyMap()), TransitionEffect("B", emptyMap())), 800)
        assertEquals("A", Transitions.pick(two, 0.2)!!.shader)
        assertEquals("B", Transitions.pick(two, 0.8)!!.shader)
        assertNull(Transitions.pick(TransitionSpec(emptyList(), 800), 0.5))
    }

    @Test fun `every effect gets picked over many advances`() {
        val seen = HashSet<Int>()
        val rnd = java.util.Random(42)
        repeat(200) { seen.add(Transitions.pickIndex(4, rnd.nextDouble())) }
        assertEquals(setOf(0, 1, 2, 3), seen)
    }

    @Test fun `duration is bounded 150 to 3000 ms, default 800`() {
        fun d(json: String) = Transitions.parse(JSONObject(json))!!.durationMs
        assertEquals(150, d("""{"effects":[{"shader":"A"}],"durationMs":1}"""))
        assertEquals(3000, d("""{"effects":[{"shader":"A"}],"durationMs":99999}"""))
        assertEquals(800, d("""{"effects":[{"shader":"A"}]}"""))
        assertEquals(Transitions.MIN_MS, 150); assertEquals(Transitions.MAX_MS, 3000)
    }

    // ---------------------------------------------------------------- geometry

    @Test fun `texture is the zone box downscaled to a 960 long edge`() {
        assertEquals(960 to 540, ZoneTransitionFit.textureSize(1920, 1080))
        assertEquals(540 to 960, ZoneTransitionFit.textureSize(1080, 1920))      // portrait zone
        assertEquals(960 to 120, ZoneTransitionFit.textureSize(1920, 240))       // ticker strip keeps its aspect
        assertEquals(640 to 360, ZoneTransitionFit.textureSize(640, 360))        // small zones are not upscaled
        assertEquals(1 to 960, ZoneTransitionFit.textureSize(1, 3000))           // never collapses to 0
        assertEquals(0 to 0, ZoneTransitionFit.textureSize(0, 500))
    }

    @Test fun `fit modes match the zone's views`() {
        // 200x100 picture into a 100x100 box
        assertArrayEquals(floatArrayOf(0f, 25f, 100f, 75f), ZoneTransitionFit.destRect(200, 100, 100, 100, "contain"), 0.001f)
        assertArrayEquals(floatArrayOf(-50f, 0f, 150f, 100f), ZoneTransitionFit.destRect(200, 100, 100, 100, "cover"), 0.001f)
        assertArrayEquals(floatArrayOf(0f, 0f, 100f, 100f), ZoneTransitionFit.destRect(200, 100, 100, 100, "fill"), 0.001f)
        // unknown / empty fit = cover (the zone default)
        assertArrayEquals(ZoneTransitionFit.destRect(200, 100, 100, 100, "cover"), ZoneTransitionFit.destRect(200, 100, 100, 100, null), 0.001f)
        assertEquals("contain", ZoneTransitionPolicy.imageFit("contain", "cover"))
        assertEquals("fill", ZoneTransitionPolicy.imageFit("", "fill"))
        assertEquals("cover", ZoneTransitionPolicy.imageFit(null, null))
        assertEquals("cover", ZoneTransitionPolicy.imageFit("weird", "contain"))
    }

    @Test fun `fitting into the downscaled texture is the zone framing scaled`() {
        // A 1920x1080 zone showing a 4:3 picture with contain: framing at 960x540 is exactly half.
        val full = ZoneTransitionFit.destRect(1600, 1200, 1920, 1080, "contain")
        val (tw, th) = ZoneTransitionFit.textureSize(1920, 1080)
        val tex = ZoneTransitionFit.destRect(1600, 1200, tw, th, "contain")
        for (i in 0..3) assertEquals(full[i] / 2f, tex[i], 0.01f)
    }

    // ---------------------------------------------------------------- concurrency + cancel

    @Test fun `GL wipes are capped, the overflow is told to crossfade`() {
        val b = ZoneTransitionBook(maxGl = 2, maxViewFades = 1)
        assertNotNull(b.acquire("a", 1, gl = true))
        assertNotNull(b.acquire("b", 1, gl = true))
        assertFalse(b.glSlotFree("c"))
        assertNull(b.acquire("c", 1, gl = true))
        assertEquals(ZoneTxMode.VIEW_CROSSFADE, decide(glFree = b.glSlotFree("c"), viewFree = b.viewSlotFree("c")))
        assertNotNull(b.acquire("c", 1, gl = false))
        assertEquals(ZoneTxMode.CUT, decide(glFree = b.glSlotFree("d"), viewFree = b.viewSlotFree("d")))
        assertEquals(2, b.glActive); assertEquals(1, b.viewActive)
    }

    @Test fun `a zone's own running transition does not count against its replacement`() {
        val b = ZoneTransitionBook(maxGl = 1)
        val (t1, prev1) = b.acquire("a", 1, gl = true)!!
        assertNull(prev1)
        assertTrue(b.glSlotFree("a"))
        val (t2, prev2) = b.acquire("a", 2, gl = true)!!
        assertSame(t1, prev2)                    // handed back so the caller cancels it
        assertFalse(b.isLive(t1, 2))
        assertTrue(b.isLive(t2, 2))
        assertEquals(1, b.glActive)
    }

    @Test fun `a generation change kills the transition's callbacks`() {
        val b = ZoneTransitionBook(maxGl = 4)
        val (t, _) = b.acquire("a", 7, gl = true)!!
        assertTrue(b.isLive(t, 7))
        assertFalse(b.isLive(t, 8))              // the zone advanced / re-rendered
        assertFalse(b.isLive(t, null))           // the zone is gone
    }

    @Test fun `cancel on layout change frees every slot and leaves no live ticket`() {
        val b = ZoneTransitionBook(maxGl = 2)
        val ts = listOf("a", "b").map { b.acquire(it, 1, gl = true)!!.first } + b.acquire("c", 1, gl = false)!!.first
        assertEquals(3, b.cancelAll().size)
        for (t in ts) assertFalse(b.isLive(t, 1))
        assertEquals(0, b.glActive); assertEquals(0, b.viewActive)
        assertNotNull(b.acquire("d", 2, gl = true))
    }

    @Test fun `a stale ticket's release never frees the newer transition`() {
        val b = ZoneTransitionBook(maxGl = 1)
        val (old, _) = b.acquire("a", 1, gl = true)!!
        val (cur, _) = b.acquire("a", 2, gl = true)!!
        assertFalse(b.release(old))
        assertSame(cur, b.current("a"))
        assertTrue(b.release(cur))
        assertFalse(b.release(cur))              // idempotent
        assertNull(b.current("a"))
    }

    @Test fun `weak hardware gets two GL wipes, the rest four`() {
        assertEquals(2, ZoneTransitionPolicy.maxConcurrentGl(lowRam = true, totalMemBytes = 4L shl 30))
        assertEquals(2, ZoneTransitionPolicy.maxConcurrentGl(lowRam = false, totalMemBytes = 1_500L * 1024 * 1024))   // Fire TV Stick 4K
        assertEquals(4, ZoneTransitionPolicy.maxConcurrentGl(lowRam = false, totalMemBytes = 4L shl 30))
        assertEquals(4, ZoneTransitionPolicy.maxConcurrentGl(lowRam = false, totalMemBytes = 0))                     // unknown: not penalised
    }

    @Test fun `the wipe counts inside the item's dwell, as on the native player`() {
        assertEquals(6_000L, ZoneTransitionPolicy.dwellAfterTransition(6_000L, 0L, 50_000L))          // no transition
        assertEquals(4_500L, ZoneTransitionPolicy.dwellAfterTransition(6_000L, 10_000L, 11_500L))     // 1.5 s wipe
        assertEquals(3_000L, ZoneTransitionPolicy.dwellAfterTransition(6_000L, 10_000L, 15_000L))     // floor: half
        assertEquals(6_000L, ZoneTransitionPolicy.dwellAfterTransition(6_000L, 10_000L, 9_000L))      // clock oddity
    }

    @Test fun `deadlines are short enough not to stall a zone's clock`() {
        assertTrue(ZoneTransitionPolicy.START_DEADLINE_MS <= 1_500)
        assertTrue(ZoneTransitionPolicy.PREP_DEADLINE_MS <= 3_000)
        assertTrue(ZoneTransitionPolicy.VIDEO_FIRST_FRAME_CAP_MS <= 3_000)
    }
}
