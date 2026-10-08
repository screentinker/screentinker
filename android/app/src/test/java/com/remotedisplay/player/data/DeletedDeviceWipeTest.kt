package com.remotedisplay.player.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class DeletedDeviceWipeTest {

    @Test fun onlyTheExplicitDeleteCounts() {
        assertTrue(DeletedDeviceWipe.isDeletion(JSONObject().put("reason", "deleted")))
        // not_found is also a restored-backup / unreplicated-edge answer: never wipe on it
        assertFalse(DeletedDeviceWipe.isDeletion(JSONObject().put("reason", "not_found")))
        assertFalse(DeletedDeviceWipe.isDeletion(JSONObject()))
        assertFalse(DeletedDeviceWipe.isDeletion(null))
        assertFalse(DeletedDeviceWipe.isDeletion("deleted"))
    }

    @Test fun wipesBothCachesButKeepsTheDirectories() {
        val root = Files.createTempDirectory("wipe").toFile()
        val dirs = DeletedDeviceWipe.dirsUnder(root)
        dirs.forEach { it.mkdirs() }
        val media = dirs[0]; val bundles = dirs[1]
        File(media, "a1.mp4").writeText("x")
        File(media, "b2.jpg.part").writeText("x")
        File(media, "b2.jpg.part.tag").writeText("etag")
        File(media, ".unreferenced").writeText("c3 1")
        File(bundles, "d4.7.html").writeText("<p>")
        val other = File(root, "keep.txt").apply { writeText("not a cache") }

        assertEquals(5, DeletedDeviceWipe.wipe(dirs))
        assertTrue(media.isDirectory && media.listFiles()!!.isEmpty())
        assertTrue(bundles.isDirectory && bundles.listFiles()!!.isEmpty())
        assertTrue(other.exists())
        root.deleteRecursively()
    }

    @Test fun triggerMediaSurvivesTheWipe() {
        val root = Files.createTempDirectory("wipe").toFile()
        val dirs = DeletedDeviceWipe.dirsUnder(root)
        dirs.forEach { it.mkdirs() }
        val media = dirs[0]
        File(media, "play1.mp4").writeText("x")
        File(media, "trig1.mp4").writeText("x")
        File(media, "trig1.mp4.rev").writeText("3")
        File(media, "trig2.png.part").writeText("x")      // a trigger download still in flight
        File(dirs[1], "trig3.1.html").writeText("<p>")    // a trigger's bundle render

        assertEquals(1, DeletedDeviceWipe.wipe(dirs, setOf("trig1", "trig2", "trig3")))
        assertEquals(setOf("trig1.mp4", "trig1.mp4.rev", "trig2.png.part"), media.list()!!.toSet())
        assertEquals(setOf("trig3.1.html"), dirs[1].list()!!.toSet())
        root.deleteRecursively()
    }

    @Test fun triggerIdsComeFromTheTriggersArrayOnly() {
        val payload = JSONObject()
            .put("assignments", org.json.JSONArray().put(JSONObject().put("content_id", "play1")))
            .put("triggers", org.json.JSONArray().put(JSONObject()
                .put("id", "t1")
                .put("items", org.json.JSONArray()
                    .put(JSONObject().put("content_id", "trig1"))
                    .put(JSONObject().put("content_id", "trig2")))))
        assertEquals(setOf("trig1", "trig2"), DeletedDeviceWipe.triggerContentIds(payload.toString()))
        assertEquals(setOf("trig1", "trig2"), DeletedDeviceWipe.triggerContentIds(payload.getJSONArray("triggers")))
        assertEquals(emptySet<String>(), DeletedDeviceWipe.triggerContentIds(""))
        assertEquals(emptySet<String>(), DeletedDeviceWipe.triggerContentIds("not json"))
        assertEquals(emptySet<String>(), DeletedDeviceWipe.triggerContentIds(null as org.json.JSONArray?))
    }

    @Test fun missingDirectoriesAreNotAnError() {
        val root = Files.createTempDirectory("wipe").toFile()
        assertEquals(0, DeletedDeviceWipe.wipe(DeletedDeviceWipe.dirsUnder(root)))
        root.deleteRecursively()
    }
}
