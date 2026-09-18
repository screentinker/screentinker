package com.remotedisplay.player.remote

import kotlin.math.abs

/**
 * The directional pick for the remote D-pad: from the current focus box, choose the geometrically
 * nearest target in the pressed direction, preferring straight-ahead over diagonal.
 *
 * Pure (plain int centres) so it is unit-tested; PowerAccessibilityService.pressDpad feeds it the
 * on-screen node bounds. A press only ever moves to a node that genuinely lies in that direction,
 * so "down" can't jump upward and the highlight walks the list in order.
 */
object DpadGeometry {
    const val UP = 0
    const val DOWN = 1
    const val LEFT = 2
    const val RIGHT = 3

    /** [candidates] are `intArrayOf(centreX, centreY)`. Returns the winning index, or -1 if nothing
     *  lies in [dir] of the origin. */
    fun pick(fromCx: Int, fromCy: Int, candidates: List<IntArray>, dir: Int): Int {
        var best = -1
        var bestScore = Long.MAX_VALUE
        for (i in candidates.indices) {
            val dx = (candidates[i][0] - fromCx).toLong()
            val dy = (candidates[i][1] - fromCy).toLong()
            val adx = abs(dx)
            val ady = abs(dy)
            val inDir = when (dir) {
                DOWN -> dy > 0 && ady >= adx
                UP -> dy < 0 && ady >= adx
                RIGHT -> dx > 0 && adx >= ady
                LEFT -> dx < 0 && adx >= ady
                else -> false
            }
            if (!inDir) continue
            val vertical = dir == DOWN || dir == UP
            val primary = if (vertical) ady else adx
            val lateral = if (vertical) adx else ady
            val score = primary + lateral * 2 // prefer straight-ahead over diagonal
            if (score in 1 until bestScore) { bestScore = score; best = i }
        }
        return best
    }
}
