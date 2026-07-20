package com.remotedisplay.player.player

import org.json.JSONObject

// feat/transition-engine (native Android port). The server normalizes a transition WIDGET into an
// opaque per-item `transition` object on the device payload — identical shape across web/Tizen/Android:
//
//     "transition": { "effects": [ { "shader": "CRTCollapse", "params": { "lineHold": 0.2, ... } } ],
//                     "durationMs": 800 }
//
// Params are already RESOLVED + CLAMPED server-side (every declared uniform present), so the player just
// uploads shader source + sets uniforms — no manifest/param schema needed on the device. A transition may
// carry SEVERAL effects; the compositor picks one at random per advance for variety.

data class TransitionEffect(val shader: String, val params: Map<String, Float>)

data class TransitionSpec(val effects: List<TransitionEffect>, val durationMs: Int) {
    // Stable, structural signature for the playlist change-fingerprint. A transition edit (shader, param,
    // or duration) MUST change this string, or a cached-playlist device silently ignores the update —
    // the exact bug that made transitions "never apply" on the web + Tizen players until the fingerprint
    // included the transition. Effects are order-significant; params sorted for determinism.
    fun sig(): String = effects.joinToString(",") { e ->
        e.shader + "(" + e.params.toSortedMap().entries.joinToString(";") { "${it.key}=${it.value}" } + ")"
    } + "@" + durationMs
}

object Transitions {
    private const val MIN_MS = 150
    private const val MAX_MS = 3000
    private const val DEFAULT_MS = 800

    // Parse the per-item `transition` object off an assignment. Tolerant + defensive: an absent/empty/
    // malformed object -> null (the renderer hard-cuts, never a black frame), mirroring the server's
    // "unknown shader -> no transition" contract. Duration is bounded even though the server clamps it.
    fun parse(obj: JSONObject?): TransitionSpec? {
        if (obj == null) return null
        val arr = obj.optJSONArray("effects") ?: return null
        val effects = ArrayList<TransitionEffect>(arr.length())
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            val shader = e.optString("shader", "")
            if (shader.isEmpty()) continue
            val params = HashMap<String, Float>()
            e.optJSONObject("params")?.let { p ->
                val keys = p.keys()
                while (keys.hasNext()) {
                    val k = keys.next() as? String ?: continue
                    val v = p.optDouble(k, Double.NaN)
                    if (!v.isNaN()) params[k] = v.toFloat()
                }
            }
            effects.add(TransitionEffect(shader, params))
        }
        if (effects.isEmpty()) return null
        var durationMs = obj.optInt("durationMs", DEFAULT_MS)
        durationMs = durationMs.coerceIn(MIN_MS, MAX_MS)
        return TransitionSpec(effects, durationMs)
    }
}
