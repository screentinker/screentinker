package com.remotedisplay.player.data

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Reclaims media nothing references any more.
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR. content_cache had no eviction at all. Removing an item from a
 * playlist, or deleting it from the library, left its file on the panel forever: the only delete
 * path was the `device:content-delete` handler, and the server never emits that event. On a Fire TV
 * Stick (~2.5 GB free) a year of playlist edits fills the disk, and then every NEW download fails —
 * the panel keeps playing old content and never picks up the new. Reported from a fork that had
 * already hit it in the field.
 *
 * So the player decides for itself, from the payload it was just given. That is also the only
 * design that works offline: an event would be missed by every screen that was down when it fired.
 *
 * WHAT COUNTS AS REFERENCED: every `content_id` anywhere in the payload, found by walking the whole
 * document rather than the fields this file happens to know about. Assignments, zone assignments,
 * trigger items and the standby image all carry one, and a future field that also needs media will
 * be kept without anyone remembering to update this. Over-keeping costs disk; under-keeping costs a
 * black screen on the next offline period, so the walk errs wide.
 *
 * WHEN AN UNREFERENCED FILE GOES:
 *  - after [graceMs] (7 days) of continuously not being referenced. A dayparted schedule swaps the
 *    whole playlist twice a day, and the payload only carries the CURRENT one — deleting on sight
 *    would re-download the evening playlist every evening, over the links least able to afford it,
 *    and leave nothing to play if the WAN is down at the switch.
 *  - immediately, when free space is low. Then a full disk is the problem in front of us, and the
 *    re-download a schedule might cost later is the cheaper of the two failures.
 *
 * The "unreferenced since" times live in one small file in the cache dir (dot-prefixed, so
 * ContentCache's "<id>." prefix lookups can never match it). Losing it only restarts the clock.
 *
 * No Android dependency beyond Log, so the policy is tested against a temp dir (CacheJanitorTest).
 */
class CacheJanitor(
    private val dir: File,
    private val now: () -> Long = System::currentTimeMillis,
    private val freeBytes: () -> Long = { dir.usableSpace },
    private val totalBytes: () -> Long = { dir.totalSpace },
    private val graceMs: Long = GRACE_MS
) {
    data class Result(val deletedIds: Set<String>, val freedBytes: Long, val lowSpace: Boolean)

    /**
     * True when free space is below max(10% of the volume, 500 MB). The floor is what matters on a
     * stick with an 8 GB volume, the percentage on a box with a large one.
     */
    fun isLowSpace(): Boolean {
        val free = freeBytes()
        val total = totalBytes()
        if (free <= 0L && total <= 0L) return false     // unknown: never treat as an emergency
        return free < maxOf(total / 10, LOW_SPACE_FLOOR)
    }

    /**
     * Delete everything not in [keep] whose grace has run out (or at once when space is low).
     * [keep] must be the COMPLETE referenced set; an empty set is refused outright, because "the
     * payload had nothing in it" is not evidence that nothing is needed (see MainActivity).
     */
    @Synchronized
    fun sweep(keep: Set<String>): Result {
        if (keep.isEmpty()) return Result(emptySet(), 0L, false)
        val files = dir.listFiles()?.filter { it.isFile && !it.name.startsWith(".") } ?: return Result(emptySet(), 0L, false)
        val byId = files.groupBy { idOf(it.name) }.filterKeys { it.isNotEmpty() }
        val t = now()
        val low = isLowSpace()
        val since = readState()
        val nextState = HashMap<String, Long>()
        val deleted = HashSet<String>()
        var freed = 0L
        for ((id, group) in byId) {
            if (id in keep) continue
            val first = since[id] ?: t
            if (low || t - first >= graceMs) {
                for (f in group) { val len = f.length(); if (f.delete()) freed += len }
                deleted.add(id)
            } else {
                nextState[id] = first
            }
        }
        writeState(nextState)
        if (deleted.isNotEmpty()) {
            Log.i("CacheJanitor", "reclaimed ${deleted.size} unreferenced item(s), ${freed / 1024} KB${if (low) " (low space)" else ""}")
        }
        return Result(deleted, freed, low)
    }

    private val stateFile get() = File(dir, STATE_NAME)

    private fun readState(): Map<String, Long> = try {
        if (!stateFile.exists()) emptyMap()
        else stateFile.readLines().mapNotNull { line ->
            val parts = line.trim().split(' ')
            val ms = parts.getOrNull(1)?.toLongOrNull()
            if (parts.size == 2 && parts[0].isNotEmpty() && ms != null) parts[0] to ms else null
        }.toMap()
    } catch (_: Exception) { emptyMap() }

    private fun writeState(state: Map<String, Long>) {
        try {
            if (state.isEmpty()) { stateFile.delete(); return }
            val tmp = File(dir, "$STATE_NAME.tmp")
            tmp.writeText(state.entries.joinToString("\n") { "${it.key} ${it.value}" })
            if (!tmp.renameTo(stateFile)) { stateFile.delete(); tmp.renameTo(stateFile) }
        } catch (_: Exception) { /* losing the clock only delays a reclaim */ }
    }

    companion object {
        const val GRACE_MS = 7L * 24 * 60 * 60 * 1000
        const val LOW_SPACE_FLOOR = 500L * 1024 * 1024
        private const val STATE_NAME = ".unreferenced"

        /** "<id>.<ext>", "<id>.<ext>.part", "<id>.<ext>.part.tag", "<id>.<ext>.rev" -> "<id>". */
        internal fun idOf(name: String): String = name.substringBefore('.')

        /** Every non-empty `content_id` anywhere in [payload]. */
        fun referencedIds(payload: JSONObject): Set<String> {
            val out = HashSet<String>()
            walk(payload, out, 0)
            return out
        }

        private fun walk(node: Any?, out: MutableSet<String>, depth: Int) {
            if (depth > 32) return
            when (node) {
                is JSONObject -> {
                    val keys = node.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val v = node.opt(k)
                        if (k == "content_id" && v is String && v.isNotEmpty() && v != "null") out.add(v)
                        else walk(v, out, depth + 1)
                    }
                }
                is JSONArray -> for (i in 0 until node.length()) walk(node.opt(i), out, depth + 1)
            }
        }
    }
}
