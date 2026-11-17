package com.remotedisplay.player.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** GHSA-rvxj 7.7: one worker, a bounded queue, and overflow is dropped rather than spawning threads. */
class KeyInjectQueueTest {
    @Test fun `runs keys in order on a single worker`() {
        val q = KeyInjectQueue(maxPending = 8)
        val seen = Collections.synchronizedList(mutableListOf<Int>())
        val threads = Collections.synchronizedSet(mutableSetOf<String>())
        val done = CountDownLatch(5)
        for (i in 1..5) assertTrue(q.submit { seen.add(i); threads.add(Thread.currentThread().name); done.countDown() })
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertEquals(listOf(1, 2, 3, 4, 5), seen)
        assertEquals(1, threads.size)
        q.shutdown()
    }

    @Test fun `a full queue drops instead of growing`() {
        val q = KeyInjectQueue(maxPending = 2)
        val gate = CountDownLatch(1)
        val started = CountDownLatch(1)
        assertTrue(q.submit { started.countDown(); gate.await(5, TimeUnit.SECONDS) })   // occupies the worker
        assertTrue(started.await(5, TimeUnit.SECONDS))
        assertTrue(q.submit { })
        assertTrue(q.submit { })
        assertFalse("third waiting key must be dropped", q.submit { })
        gate.countDown()
        q.shutdown()
    }
}
