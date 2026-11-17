package com.remotedisplay.player.util

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/** GHSA-rvxj 7.2: a remote image is read through a byte cap and an overall deadline. */
class ImageLoaderBoundedReadTest {
    private val never = Long.MAX_VALUE

    /** An endless response, the case readBytes() used to buffer until the heap ran out. */
    private class Endless : InputStream() {
        var served = 0L
        override fun read(): Int { served++; return 0x41 }
        override fun read(b: ByteArray, off: Int, len: Int): Int { java.util.Arrays.fill(b, off, off + len, 0x41); served += len; return len }
    }

    @Test fun `small body is returned whole`() {
        val data = ByteArray(5000) { it.toByte() }
        assertArrayEquals(data, ImageLoader.readBounded(ByteArrayInputStream(data), -1, 10_000, never) { 0L })
        assertArrayEquals(data, ImageLoader.readBounded(ByteArrayInputStream(data), 5000, 5000, never) { 0L })
    }

    @Test fun `declared Content-Length over the cap is refused before reading`() {
        val src = Endless()
        try { ImageLoader.readBounded(src, 10_001, 10_000, never) { 0L }; fail() } catch (e: IOException) { }
        assertEquals(0L, src.served)
    }

    @Test fun `endless body stops just past the cap`() {
        val src = Endless()
        try { ImageLoader.readBounded(src, -1, 100_000, never) { 0L }; fail() } catch (e: IOException) { }
        assertTrue("read ${src.served}", src.served <= 100_000 + 16 * 1024)
    }

    @Test fun `a lying Content-Length does not lift the cap`() {
        val src = Endless()
        try { ImageLoader.readBounded(src, 10, 50_000, never) { 0L }; fail() } catch (e: IOException) { }
    }

    @Test fun `a trickle that outlives the deadline is cut off`() {
        var clock = 0L
        val trickle = object : InputStream() {
            override fun read(): Int { clock += 1000; return 1 }
            override fun read(b: ByteArray, off: Int, len: Int): Int { clock += 1000; b[off] = 1; return 1 }
        }
        try { ImageLoader.readBounded(trickle, -1, 1_000_000, 30_000L) { clock }; fail() } catch (e: IOException) { }
        assertTrue(clock <= 32_000L)
    }

    @Test fun `the production cap is well above any real still`() {
        assertTrue(ImageLoader.MAX_REMOTE_IMAGE_BYTES >= 32 * 1024 * 1024)
    }
}
