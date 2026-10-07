package com.remotedisplay.player.data

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * content_cache eviction (CacheJanitor). The defect: nothing ever deleted a cached file — the only
 * delete path was a device:content-delete event the server never sends — so a Fire TV Stick filled
 * up and every new download failed.
 */
class CacheJanitorTest {
    private lateinit var dir: File
    private var clock = 1_000_000L
    private var free = 10L * 1024 * 1024 * 1024
    private val total = 16L * 1024 * 1024 * 1024
    private lateinit var janitor: CacheJanitor

    @Before fun setUp() {
        dir = Files.createTempDirectory("janitor").toFile()
        janitor = CacheJanitor(dir, now = { clock }, freeBytes = { free }, totalBytes = { total })
    }
    @After fun tearDown() { dir.deleteRecursively() }

    private fun put(name: String, bytes: Int = 10) = File(dir, name).apply { writeBytes(ByteArray(bytes)) }

    @Test fun `every content_id in the payload is referenced, wherever it sits`() {
        val payload = JSONObject("""{
          "assignments":[{"content_id":"a"},{"content_id":null,"widget_id":"w"}],
          "default_content":{"content_id":"standby"},
          "triggers":[{"items":[{"content_id":"t1"}]}],
          "layout":{"zones":[{"id":"z"}]}
        }""")
        assertEquals(setOf("a", "standby", "t1"), CacheJanitor.referencedIds(payload))
    }

    @Test fun `an unreferenced file survives the grace period, then goes with its sidecars`() {
        put("keep.mp4"); put("keep.mp4.rev")
        put("gone.mp4"); put("gone.mp4.rev"); put("gone.mp4.part.tag")
        assertTrue(janitor.sweep(setOf("keep")).deletedIds.isEmpty())
        assertTrue(File(dir, "gone.mp4").exists())

        clock += CacheJanitor.GRACE_MS - 1
        assertTrue("still inside the grace", janitor.sweep(setOf("keep")).deletedIds.isEmpty())

        clock += 1
        val r = janitor.sweep(setOf("keep"))
        assertEquals(setOf("gone"), r.deletedIds)
        assertFalse(File(dir, "gone.mp4").exists()); assertFalse(File(dir, "gone.mp4.rev").exists()); assertFalse(File(dir, "gone.mp4.part.tag").exists())
        assertTrue(File(dir, "keep.mp4").exists()); assertTrue(File(dir, "keep.mp4.rev").exists())
    }

    @Test fun `referenced again resets the clock (a dayparted playlist coming back)`() {
        put("evening.mp4")
        janitor.sweep(setOf("morning"))                  // unreferenced from now
        clock += CacheJanitor.GRACE_MS / 2
        janitor.sweep(setOf("evening"))                  // back in use: forgotten
        clock += CacheJanitor.GRACE_MS / 2 + 1
        assertTrue(janitor.sweep(setOf("morning")).deletedIds.isEmpty())
        assertTrue(File(dir, "evening.mp4").exists())
    }

    @Test fun `low space reclaims unreferenced files at once`() {
        put("old.mp4", 100); put("live.mp4")
        free = 100L * 1024 * 1024                        // under the 500 MB floor
        val r = janitor.sweep(setOf("live"))
        assertTrue(r.lowSpace)
        assertEquals(setOf("old"), r.deletedIds)
        assertEquals(100L, r.freedBytes)
        assertTrue(File(dir, "live.mp4").exists())
    }

    @Test fun `an empty keep set never deletes anything`() {
        put("a.mp4"); free = 0L
        assertTrue(janitor.sweep(emptySet()).deletedIds.isEmpty())
        assertTrue(File(dir, "a.mp4").exists())
    }

    @Test fun `the janitor's own state file is not content and is never swept`() {
        put("x.mp4")
        janitor.sweep(setOf("y"))
        assertTrue(File(dir, ".unreferenced").exists())
        assertEquals("ContentCache's <id>. lookup cannot match it", "", CacheJanitor.idOf(".unreferenced"))
    }
}
