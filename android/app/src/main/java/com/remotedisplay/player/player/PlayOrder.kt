package com.remotedisplay.player.player

import kotlin.random.Random

/**
 * Sequential / shuffle / weighted next-index. Port of server/lib/play-order.js.
 * Shuffle uses a no-repeat bag; weighted avoids the item just played when another exists.
 * Unknown mode fails open to sequential.
 */
object PlayOrder {
    data class State(var bag: MutableList<Int> = mutableListOf(), var bagKey: String = "")

    fun weightOf(item: PlaylistItem): Int {
        val w = item.weight
        return if (w < 1) 1 else w.coerceAtMost(1000)
    }

    fun nextIndex(
        items: List<PlaylistItem>,
        from: Int,
        allows: (PlaylistItem) -> Boolean,
        mode: String?,
        state: State,
        rnd: () -> Double = { Random.nextDouble() }
    ): Int {
        return try {
            when (mode) {
                "shuffle" -> nextShuffle(items, from, allows, state, rnd)
                "weighted" -> nextWeighted(items, from, allows, rnd)
                else -> sequential(items, from, allows)
            }
        } catch (_: Throwable) {
            sequential(items, from, allows)
        }
    }

    fun firstIndex(items: List<PlaylistItem>, allows: (PlaylistItem) -> Boolean, mode: String?, state: State): Int =
        nextIndex(items, -1, allows, mode, state)

    private fun sequential(items: List<PlaylistItem>, from: Int, allows: (PlaylistItem) -> Boolean): Int {
        if (items.isEmpty()) return -1
        val start = if (from >= 0) from else -1
        for (k in 1..items.size) {
            val idx = (start + k) % items.size
            if (allows(items[idx])) return idx
        }
        return -1
    }

    private fun eligible(items: List<PlaylistItem>, allows: (PlaylistItem) -> Boolean): List<Int> =
        items.indices.filter { allows(items[it]) }

    private fun nextShuffle(
        items: List<PlaylistItem>, from: Int, allows: (PlaylistItem) -> Boolean, state: State, rnd: () -> Double
    ): Int {
        val el = eligible(items, allows)
        if (el.isEmpty()) return -1
        val key = el.sorted().joinToString(",")
        if (state.bag.isEmpty() || state.bagKey != key) {
            state.bag = makeBag(el, from, rnd)
            state.bagKey = key
        }
        while (state.bag.isNotEmpty() && state.bag.first() !in el) state.bag.removeAt(0)
        if (state.bag.isEmpty()) {
            state.bag = makeBag(el, from, rnd)
            state.bagKey = key
        }
        return state.bag.removeAt(0)
    }

    // A full bag holds EVERY eligible index once (nothing under-played over a cycle),
    // shuffled. To avoid an immediate repeat across the bag boundary, if the first
    // draw would be the item just played and another can lead, swap it deeper.
    private fun makeBag(el: List<Int>, from: Int, rnd: () -> Double): MutableList<Int> {
        val bag = el.toMutableList()
        shuffle(bag, rnd)
        if (bag.size > 1 && bag[0] == from) {
            val j = 1 + (rnd() * (bag.size - 1)).toInt().coerceIn(0, bag.size - 2)
            val t = bag[0]; bag[0] = bag[j]; bag[j] = t
        }
        return bag
    }

    private fun nextWeighted(
        items: List<PlaylistItem>, from: Int, allows: (PlaylistItem) -> Boolean, rnd: () -> Double
    ): Int {
        val el = eligible(items, allows)
        if (el.isEmpty()) return -1
        val pool = if (el.size > 1) el.filter { it != from } else el
        val weights = pool.map { weightOf(items[it]) }
        val total = weights.sum()
        if (total <= 0) return pool.first()
        var r = rnd() * total
        for (i in pool.indices) {
            r -= weights[i]
            if (r <= 0) return pool[i]
        }
        return pool.last()
    }

    private fun shuffle(arr: MutableList<Int>, rnd: () -> Double) {
        for (i in arr.size - 1 downTo 1) {
            val j = (rnd() * (i + 1)).toInt().coerceIn(0, i)
            val t = arr[i]; arr[i] = arr[j]; arr[j] = t
        }
    }
}
