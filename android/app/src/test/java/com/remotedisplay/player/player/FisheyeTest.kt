package com.remotedisplay.player.player

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Android fisheye maths must match server/lib/fisheye.js through shared/fisheye-vectors.json. */
class FisheyeTest {
    private val vectors: JSONObject by lazy {
        var dir: File? = File("").absoluteFile
        while (dir != null && !File(dir, "shared/fisheye-vectors.json").exists()) dir = dir.parentFile
        JSONObject(File(dir!!, "shared/fisheye-vectors.json").readText())
    }

    private fun settings(o: JSONObject) = Fisheye.Settings(
        mount = o.getString("mount"), lensFov = o.getDouble("lens_fov"), rotation = o.getDouble("rotation"),
        cx = o.getDouble("cx"), cy = o.getDouble("cy"), r = o.getDouble("r"),
        pan = o.getDouble("pan"), tilt = o.getDouble("tilt"), zoom = o.getDouble("zoom"), touch = o.getBoolean("touch"),
    )

    @Test fun `every projection matches the server`() {
        val cases = vectors.getJSONArray("project")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = Fisheye.project(settings(c.getJSONObject("normalized")), c.getDouble("x"), c.getDouble("y"), c.getDouble("image_aspect"))
            if (c.isNull("uv")) { assertNull("case $i", got); continue }
            val uv = c.getJSONArray("uv")
            assertNotNull("case $i", got)
            assertEquals("case $i u", uv.getDouble(0), got!!.first, 1e-6)
            assertEquals("case $i v", uv.getDouble(1), got.second, 1e-6)
        }
    }

    @Test fun `settings are normalized like the server`() {
        val cases = vectors.getJSONArray("normalize")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals("case $i", settings(c.getJSONObject("output")), Fisheye.parse(c.getJSONObject("input")))
        }
    }

    @Test fun `steering is clamped, touch follows the finger, and reset returns to the saved view`() {
        val v = Fisheye.View(Fisheye.parse(JSONObject("""{"pan":10,"tilt":50,"zoom":80,"touch":true}"""))!!, "c1")
        v.set(null, 500.0, 500.0)
        assertEquals(90.0, v.current.tilt, 1e-9)        // the lens edge of a 180° lens
        assertEquals(Fisheye.ZOOM_MAX, v.current.zoom, 1e-9)
        v.reset()
        v.drag(0.25, 0.0)                               // finger right a quarter of the screen
        assertEquals(10.0 - 0.25 * 80, v.current.pan, 1e-9)
        v.pinch(2.0)
        assertEquals(40.0, v.current.zoom, 1e-9)
        v.reset()
        assertEquals(10.0, v.current.pan, 1e-9)
        assertTrue(v.saved.touch)
    }
}
