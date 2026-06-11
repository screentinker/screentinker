package com.remotedisplay.player.player

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Drift guard (#74/#75): the Kotlin evaluator must agree with the SHARED contract
 * at shared/schedule-vectors.json - the SAME file the JS server, web player, and
 * Tizen player are held to. No snapshot is taken: the test task points
 * `scheduleVectors` at the single source (see app/build.gradle.kts), so any future
 * ScheduleEval.kt change that breaks a vector fails CI.
 */
class ScheduleEvalTest {

    @Test
    fun conformsToSharedVectors() {
        val path = System.getProperty("scheduleVectors")
            ?: error("scheduleVectors system property not set (configured in app/build.gradle.kts)")
        val vectors = JsonParser.parseString(File(path).readText()).asJsonObject.getAsJsonArray("vectors")

        val failures = StringBuilder()
        var count = 0
        for (el in vectors) {
            val v = el.asJsonObject
            val blocks = v.getAsJsonArray("blocks").map { b ->
                val o = b.asJsonObject
                ScheduleEval.Block(
                    days = o.getAsJsonArray("days").map { it.asInt }.toSet(),
                    start = o.get("start").asString,
                    end = o.get("end").asString,
                    startDate = o.get("start_date").let { if (it.isJsonNull) null else it.asString },
                    endDate = o.get("end_date").let { if (it.isJsonNull) null else it.asString }
                )
            }
            val utcMs = Instant.parse(v.get("utc_now").asString).toEpochMilli()
            val got = ScheduleEval.isItemActiveNow(blocks, utcMs, v.get("timezone").asString)
            val expected = v.get("expected").asBoolean
            count++
            if (got != expected) {
                failures.append("\n[${v.get("utc_now").asString} ${v.get("timezone").asString}] " +
                    "expected $expected got $got :: ${v.get("description").asString}")
            }
        }
        println("Kotlin JUnit schedule vectors: ${count - failures.count { it == '\n' }}/$count passed")
        assertEquals("schedule vectors failed:$failures", 0, failures.length)
    }
}
