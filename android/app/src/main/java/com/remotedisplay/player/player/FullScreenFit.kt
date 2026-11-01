package com.remotedisplay.player.player

/**
 * #769 — how a full-screen (no layout) image or video is framed.
 *
 * The playlist item's fit_mode used to be ignored here: the views were fixed at fit-center in the
 * layout XML, so "Stretch" letterboxed anyway and only a layout zone honoured it. The rules match
 * the web player's soloFit(): the item's own fit, contain when unset, and a wall always fills
 * (every member must map the source onto the stage the same way).
 *
 * Pure (no android.*) so the mapping is unit-tested; MediaPlayerManager turns the token into a
 * ScaleType / resize mode.
 */
object FullScreenFit {
    const val CONTAIN = "contain"
    const val COVER = "cover"
    const val FILL = "fill"

    /** The server sends contain/cover/fill; accept the dashboard's labels too. Anything else: contain. */
    fun normalize(v: String?): String = when (v?.trim()?.lowercase()) {
        "fill", "stretch" -> FILL
        "cover", "crop" -> COVER
        else -> CONTAIN
    }

    fun effective(itemFit: String?, wallMode: Boolean): String = if (wallMode) FILL else normalize(itemFit)

    /** x/y scale that frames an iw×ih source in a w×h box the way [fit] does. */
    fun scales(iw: Float, ih: Float, w: Float, h: Float, fit: String): Pair<Float, Float> {
        if (iw <= 0f || ih <= 0f) return 1f to 1f
        return when (fit) {
            FILL -> (w / iw) to (h / ih)
            COVER -> maxOf(w / iw, h / ih).let { it to it }
            else -> minOf(w / iw, h / ih).let { it to it }
        }
    }
}
