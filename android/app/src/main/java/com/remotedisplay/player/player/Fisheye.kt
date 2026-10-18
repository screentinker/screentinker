package com.remotedisplay.player.player

import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * A fisheye (360°) camera shown as a normal 16:9 view ("digital PTZ").
 *
 * The same maths as server/lib/fisheye.js (the definition; read its header) and the native player's
 * logic/fisheye.py, held together by shared/fisheye-vectors.json. [basis] gives the view's three
 * directions, which FisheyeGlView hands to its fragment shader; [project] is that shader written out
 * on the CPU, so the unit tests can hold it to the vectors.
 *
 * ⚠️ The picture is always upright: "up" comes from the mount, never from the image, and tilt is
 * clamped so the view cannot swing over the top and flip.
 */
object Fisheye {
    const val OUTPUT_ASPECT = 16f / 9f
    const val ZOOM_MIN = 20.0
    const val ZOOM_MAX = 120.0
    private val MOUNTS = setOf("ceiling", "floor", "wall")

    data class Settings(
        val mount: String = "ceiling",
        val lensFov: Double = 180.0,
        val rotation: Double = 0.0,
        val cx: Double = 0.5,
        val cy: Double = 0.5,
        val r: Double = 0.5,
        val pan: Double = 0.0,
        val tilt: Double = 55.0,
        val zoom: Double = 80.0,
        val touch: Boolean = false,
    )

    data class Basis(val d: DoubleArray, val right: DoubleArray, val up: DoubleArray)

    /** An item's `fisheye` object, normalized like the server does; null when absent or not an object. */
    fun parse(o: JSONObject?): Settings? {
        if (o == null) return null
        fun num(k: String, d: Double): Double {
            val v = o.opt(k)
            val n = when (v) {
                is Number -> v.toDouble()
                is String -> v.trim().toDoubleOrNull()
                else -> null
            }
            return if (n != null && n.isFinite()) n else d
        }
        val mount = o.optString("mount").takeIf { it in MOUNTS } ?: "ceiling"
        val lens = num("lens_fov", 180.0).coerceIn(90.0, 240.0)
        val base = Settings(
            mount = mount, lensFov = lens,
            rotation = wrap180(num("rotation", 0.0)),
            cx = num("cx", 0.5).coerceIn(0.0, 1.0),
            cy = num("cy", 0.5).coerceIn(0.0, 1.0),
            r = num("r", 0.5).coerceIn(0.05, 1.5),
            touch = when (val t = o.opt("touch")) { is Boolean -> t; is Number -> t.toInt() == 1; is String -> t == "1" || t == "true"; else -> false },
        )
        return withView(base, num("pan", 0.0), num("tilt", if (mount == "wall") 0.0 else 55.0), num("zoom", 80.0))
    }

    fun tiltRange(mount: String, lensFov: Double): ClosedFloatingPointRange<Double> {
        val half = lensFov / 2
        return if (mount == "wall") -min(85.0, half)..min(85.0, half) else 0.0..min(half, 120.0)
    }

    /** [f] pointed at pan / tilt / zoom, each clamped to what the mount and lens allow. */
    fun withView(f: Settings, pan: Double, tilt: Double, zoom: Double): Settings {
        val p = if (f.mount == "wall") pan.coerceIn(-f.lensFov / 2, f.lensFov / 2) else wrap180(pan)
        return f.copy(pan = p, tilt = tilt.coerceIn(tiltRange(f.mount, f.lensFov)), zoom = zoom.coerceIn(ZOOM_MIN, ZOOM_MAX))
    }

    fun wrap180(a: Double): Double {
        val x = ((a + 180) % 360 + 360) % 360 - 180
        return if (x == -180.0) 180.0 else x
    }

    private fun rad(d: Double) = d * PI / 180

    fun basis(f: Settings): Basis {
        val p = rad(f.pan)
        val t = rad(f.tilt)
        val d: DoubleArray
        var up: DoubleArray
        if (f.mount == "wall") {
            d = doubleArrayOf(sin(p) * cos(t), -sin(t), cos(p) * cos(t))
            up = doubleArrayOf(-sin(p) * sin(t), -cos(t), -cos(p) * sin(t))
        } else {
            d = doubleArrayOf(sin(t) * cos(p), sin(t) * sin(p), cos(t))
            up = doubleArrayOf(cos(t) * cos(p), cos(t) * sin(p), -sin(t))
            if (f.mount == "floor") up = doubleArrayOf(-up[0], -up[1], -up[2])
        }
        up = norm(up)
        return Basis(d, norm(cross(d, up)), up)
    }

    /** Where output (x, y) (-1..1, y up) samples the image: (u, v) 0..1 with v down, or null. */
    fun project(f: Settings, x: Double, y: Double, imageAspect: Double = 1.0): Pair<Double, Double>? {
        val b = basis(f)
        val tx = tan(rad(f.zoom) / 2)
        val ty = tx / OUTPUT_ASPECT
        val ray = norm(DoubleArray(3) { b.d[it] + x * tx * b.right[it] + y * ty * b.up[it] })
        val theta = acos(ray[2].coerceIn(-1.0, 1.0))
        val half = rad(f.lensFov) / 2
        if (theta > half) return null
        val phi = atan2(ray[1], ray[0]) + rad(f.rotation)
        val rho = theta / half
        return Pair(f.cx + f.r * rho * cos(phi) / imageAspect, f.cy + f.r * rho * sin(phi))
    }

    private fun cross(a: DoubleArray, b: DoubleArray) =
        doubleArrayOf(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

    private fun norm(a: DoubleArray): DoubleArray {
        val l = sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).takeIf { it > 0 } ?: 1.0
        return doubleArrayOf(a[0] / l, a[1] / l, a[2] / l)
    }

    /**
     * The view a screen is showing right now: starts at the item's saved settings, moved by the
     * camera_view command or by touch, read by FisheyeGlView on the GL thread every frame.
     */
    class View(saved: Settings, val contentId: String?) {
        /** The item's saved view; replaced when the operator saves a new one (resave). */
        @Volatile var saved: Settings = saved
            private set
        @Volatile var current: Settings = saved
            private set

        /** Called after every move, so the view on screen redraws at once (any thread). */
        @Volatile var onChange: (() -> Unit)? = null

        fun set(pan: Double?, tilt: Double?, zoom: Double?) {
            val c = current
            current = withView(c, pan ?: c.pan, tilt ?: c.tilt, zoom ?: c.zoom)
            onChange?.invoke()
        }

        fun reset() { current = saved; onChange?.invoke() }

        /** A newly saved view: the screen goes to it, as a reset would. */
        fun resave(s: Settings) { saved = s; reset() }

        /**
         * Touch: a drag of (dxFrac, dyFrac) of the view's width / height moves it by that share of
         * the field of view, so the picture follows the finger (y is screen-down), and a pinch of
         * [scale] narrows or widens it. Dragging right turns the view left; dragging down looks up.
         */
        fun drag(dxFrac: Double, dyFrac: Double) {
            val c = current
            val hFov = c.zoom
            val vFov = 2 * Math.toDegrees(kotlin.math.atan(tan(rad(c.zoom) / 2) / OUTPUT_ASPECT))
            // The floor mount's frame is mirrored relative to the ceiling one (up toward the axis).
            val panSign = if (c.mount == "floor") 1.0 else -1.0
            val tiltSign = if (c.mount == "floor") -1.0 else 1.0
            set(c.pan + panSign * dxFrac * hFov, c.tilt + tiltSign * dyFrac * vFov, null)
        }

        fun pinch(scale: Double) {
            if (scale <= 0 || abs(scale - 1) < 1e-6) return
            set(null, null, current.zoom / max(0.2, min(5.0, scale)))
        }
    }
}
