package com.remotedisplay.player.telemetry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SocTemperatureTest {

    private fun z(type: String, raw: Long) = SocTemperature.Zone(type, raw)

    @Test fun `RK3566 panel - soc-thermal wins, gpu and the fake battery are ignored`() {
        val zones = listOf(z("soc-thermal", 45000), z("gpu-thermal", 40000), z("test_battery", 2000))
        assertEquals(45.0, SocTemperature.select(zones)!!, 0.0)
    }

    @Test fun `name beats position - soc is chosen even when it is not zone0`() {
        val zones = listOf(z("gpu-thermal", 40000), z("soc-thermal", 52300))
        assertEquals(52.3, SocTemperature.select(zones)!!, 0.0)
    }

    @Test fun `cpu is accepted when there is no soc zone`() {
        val zones = listOf(z("gpu-thermal", 40000), z("cpu0-thermal", 61000))
        assertEquals(61.0, SocTemperature.select(zones)!!, 0.0)
    }

    @Test fun `no named zone - falls back to the first usable one`() {
        val zones = listOf(z("test_battery", 2000), z("thermal-zone-x", 48000), z("other", 30000))
        assertEquals(48.0, SocTemperature.select(zones)!!, 0.0)
    }

    @Test fun `only battery-like zones - no reading`() {
        assertNull(SocTemperature.select(listOf(z("battery", 30000), z("test_battery", 2000))))
    }

    @Test fun `no zones - no reading`() {
        assertNull(SocTemperature.select(emptyList()))
    }

    @Test fun `implausible values are dropped, not reported`() {
        assertNull(SocTemperature.select(listOf(z("soc-thermal", 0))))
        assertNull(SocTemperature.select(listOf(z("soc-thermal", -40000))))
        assertNull(SocTemperature.select(listOf(z("soc-thermal", 255000))))
    }

    @Test fun `a broken soc zone does not hide a good cpu zone`() {
        val zones = listOf(z("soc-thermal", 999999), z("cpu-thermal", 47000))
        assertEquals(47.0, SocTemperature.select(zones)!!, 0.0)
    }

    @Test fun `whole-degree drivers are understood`() {
        assertEquals(45.0, SocTemperature.toCelsius(45)!!, 0.0)
        assertEquals(45.1, SocTemperature.toCelsius(45123)!!, 0.0)
    }

    @Test fun `read walks a sysfs-shaped directory in numeric zone order`() {
        val root = Files.createTempDirectory("thermal").toFile()
        try {
            fun zone(n: Int, type: String, temp: String) {
                val d = File(root, "thermal_zone$n").apply { mkdirs() }
                File(d, "type").writeText("$type\n")
                File(d, "temp").writeText("$temp\n")
            }
            zone(10, "gpu-thermal", "40000")
            zone(2, "test_battery", "2000")
            zone(1, "soc-thermal", "45000")
            File(root, "cooling_device0").mkdirs()          // not a zone, must be ignored
            File(root, "thermal_zone3").mkdirs()            // zone with no files, must be skipped
            assertEquals(45.0, SocTemperature.read(root)!!, 0.0)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun `read on a missing directory is null, not an exception`() {
        assertNull(SocTemperature.read(File("/nonexistent/thermal")))
    }
}
