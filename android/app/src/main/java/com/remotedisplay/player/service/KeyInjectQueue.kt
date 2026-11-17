package com.remotedisplay.player.service

import android.util.Log
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * GHSA-rvxj 7.7: shell `input keyevent` runs on ONE worker with a short queue, never a thread per key.
 *
 * ⚠️ WHY. Each remote key used to start a new Thread that forked an `input` process and waited on it.
 * A held-down key or a scripted flood from the dashboard (the server forwards every event) became
 * hundreds of threads and child processes on a panel with a few hundred MB of RAM. Keys are still
 * applied in order, one at a time; past [MAX_PENDING] waiting keys new ones are DROPPED, which for
 * remote control is the right failure: a stale key landing seconds later is worse than a missed one.
 */
class KeyInjectQueue(maxPending: Int = MAX_PENDING) {
    private val executor = ThreadPoolExecutor(
        1, 1, 30L, TimeUnit.SECONDS, ArrayBlockingQueue(maxPending),
        { r -> Thread(r, "key-inject").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy()
    ).apply { allowCoreThreadTimeOut(true) }

    @Volatile private var dropped = 0

    /** Queue [task]; false when it was dropped because [maxPending] keys are already waiting. */
    fun submit(task: () -> Unit): Boolean = try {
        executor.execute {
            try { task() } catch (e: Throwable) { Log.w(TAG, "key task: ${e.message}") }
        }
        if (dropped > 0) { Log.w(TAG, "dropped $dropped key(s) while the queue was full"); dropped = 0 }
        true
    } catch (e: RejectedExecutionException) {
        dropped++
        false
    }

    fun shutdown() { executor.shutdownNow() }

    companion object {
        const val MAX_PENDING = 16
        private const val TAG = "KeyInjectQueue"
        /** The one the player uses; process-wide so the service and the accessibility path share it. */
        val shared by lazy { KeyInjectQueue() }
    }
}
