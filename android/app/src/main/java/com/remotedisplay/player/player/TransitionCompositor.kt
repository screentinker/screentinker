package com.remotedisplay.player.player

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PixelFormat
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.GLUtils
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

// feat/transition-engine — native GLES2 compositor (GL Transitions v1), the Android sibling of the web
// player's runGlWipe + shared/Transitions/renderer.js. It composites TWO frames (from -> to) across
// `progress` 0..1 using the SAME .glsl shaders and the SAME uniform contract as web/Tizen. Every failure
// path calls onDone immediately so the caller hard-cuts — never a blank frame.

// The GLSL wrap — MUST stay byte-identical to shared/Transitions/params.js (the shader sources assume
// exactly these names). uFrom holds the outgoing frame for the whole wipe, so there's never a blank seam.
object TransitionGlsl {
    const val PREAMBLE = "precision highp float;\n" +
        "varying vec2 vUv;\n" +
        "uniform sampler2D uFrom;\n" +
        "uniform sampler2D uTo;\n" +
        "uniform float progress;\n" +
        "uniform float ratio;\n" +
        "vec4 getFromColor(vec2 uv){ return texture2D(uFrom, uv); }\n" +
        "vec4 getToColor(vec2 uv){ return texture2D(uTo, uv); }\n"
    const val EPILOGUE = "\nvoid main(){ gl_FragColor = transition(vUv); }"
    const val VERTEX = "attribute vec2 aPos;\n" +
        "varying vec2 vUv;\n" +
        "void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }"

    fun fragmentFor(shaderSrc: String): String = PREAMBLE + "\n" + shaderSrc + "\n" + EPILOGUE

    // Load a shader's GLSL source by id from assets/transitions/<id>.glsl (copied from shared/Transitions
    // at build). Returns null if missing -> the caller hard-cuts (never a black frame).
    /*
     * #320: shaders an operator uploaded arrive with the playlist and live here, keyed by the same
     * ids the items reference. Checked BEFORE assets so an upload is found, and never instead of
     * them: a shipped shader cannot be shadowed because the server only ever sends ids prefixed
     * "custom-". Held in memory rather than written to disk because the payload re-sends them on
     * every reconnect, so there is no cache to invalidate and nothing to clean up.
     */
    private val uploaded = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun setUploadedShaders(map: Map<String, String>?) {
        uploaded.clear()
        if (map != null) for ((k, v) in map) if (k.startsWith("custom-")) uploaded[k] = v
    }

    fun loadSource(assets: AssetManager, shaderId: String): String? {
        uploaded[shaderId]?.let { return it }
        return try {
            assets.open("transitions/$shaderId.glsl").bufferedReader().use { it.readText() }
        } catch (e: Throwable) { Log.w("TransitionGL", "shader '$shaderId' not found in assets: ${e.message}"); null }
    }
}

/*
 * #344 — the wipe's geometry, pure and testable.
 *
 * The overlay draws its textures 1:1 across an UNROTATED, screen-sized GL surface (see the #344 note
 * in MainActivity: it lives on the window content root, not the rotated stage, because a SurfaceView
 * is not guaranteed to inherit an ancestor's rotation on every ROM). So the rotation the stage gets
 * for a portrait screen has to be baked into the bitmap instead of relied upon from the compositor.
 *
 * This object holds only the box arithmetic — no Android graphics — so it can be unit-tested on the
 * JVM (which the Android graphics path cannot). See TransitionGeometryTest.
 */
object TransitionGeometry {
    /** The box content is laid out in: the stage is transposed for a portrait (swap) screen. */
    fun stageBox(screenW: Int, screenH: Int, swap: Boolean): Pair<Int, Int> =
        if (swap) screenH to screenW else screenW to screenH

    /** true for the orientations MainActivity transposes the stage for (90 / 270). */
    fun swapForRotation(rotDeg: Int): Boolean = ((rotDeg % 360) + 360) % 360 == 90 || ((rotDeg % 360) + 360) % 360 == 270

    /**
     * The invariant the reporter asked for: the box the bitmaps were fitted to (once rotated) must
     * equal the surface they are drawn on. Rotating the stage box by 90/270 must give the screen box;
     * 0/180 leaves it. A mismatch means we fitted to the wrong thing and MUST hard-cut, not wipe.
     */
    fun rotatedStageMatchesScreen(stageW: Int, stageH: Int, screenW: Int, screenH: Int, rotDeg: Int): Boolean {
        if (stageW <= 0 || stageH <= 0 || screenW <= 0 || screenH <= 0) return false
        val (rw, rh) = if (swapForRotation(rotDeg)) stageH to stageW else stageW to stageH
        return rw == screenW && rh == screenH
    }
}

// Fit a source bitmap into a w×h frame with object-fit:contain letterboxing (matches the static
// ImageView/PlayerView framing), AND flip it vertically — GLES2 has no UNPACK_FLIP_Y_WEBGL, so the flip
// here replicates exactly what the web renderer's upload() does, keeping the shader uv convention (and
// therefore the transition geometry) identical across platforms. Returns an ARGB_8888 bitmap.
//
// Landscape (no rotation) keeps calling this directly; it is unchanged.
fun fitTransitionBitmap(src: Bitmap, w: Int, h: Int): Bitmap =
    fitTransitionBitmapRotated(src, w, h, w, h, 0f)

/*
 * #344 — fit into the STAGE box, then rotate the result into the SCREEN box, in one Matrix, onto a
 * screen-sized bitmap. The overlay surface is the unrotated screen, so baking the stage's rotation
 * into the texture here is what makes the wipe match the mounted (rotated) content on every ROM,
 * whether or not the composer would have rotated the surface for us.
 *
 * Order (postX appends): contain-fit in stage space -> recentre on origin -> rotate -> recentre in
 * the screen box -> vertical GL flip on the final texture. For rot=0 with stage==screen this reduces
 * to exactly the old contain+flip, so landscape is byte-identical.
 */
fun fitTransitionBitmapRotated(src: Bitmap, stageW: Int, stageH: Int, screenW: Int, screenH: Int, rotDeg: Float): Bitmap {
    val out = Bitmap.createBitmap(screenW, screenH, Bitmap.Config.ARGB_8888)
    val c = Canvas(out)
    c.drawColor(android.graphics.Color.BLACK)
    val iw = src.width.toFloat(); val ih = src.height.toFloat()
    if (iw > 0f && ih > 0f && stageW > 0 && stageH > 0) {
        val s = minOf(stageW / iw, stageH / ih)   // contain, in stage space
        val dw = iw * s; val dh = ih * s
        val m = Matrix()
        m.postScale(s, s)
        m.postTranslate((stageW - dw) / 2f, (stageH - dh) / 2f)   // placed in the stage box
        // rotate the stage box about its centre and drop it, centred, into the screen box
        m.postTranslate(-stageW / 2f, -stageH / 2f)
        m.postRotate(rotDeg)
        m.postTranslate(screenW / 2f, screenH / 2f)
        m.postScale(1f, -1f, screenW / 2f, screenH / 2f)          // vertical flip == UNPACK_FLIP_Y_WEBGL
        c.drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG))
    }
    return out
}

/**
 * Full-screen GLES2 overlay that plays one from->to wipe and then hides itself. Attached above the
 * image/video layers; translucent + z-order-on-top so the frame BEHIND it shows through until the first
 * opaque wipe frame paints (no black flash on show). GLSurfaceView manages EGL + the render thread.
 */
class TransitionGLView(context: Context) : GLSurfaceView(context) {

    // A single wipe request. onDone runs on the MAIN thread when the wipe completes OR fails (never-blank:
    // the caller swaps in the real content there). failed/startNs are GL-thread-only after pickup.
    private class Job(
        val from: Bitmap,
        val to: Bitmap,
        val fragmentSrc: String,
        val params: Map<String, Float>,
        val durationMs: Int,
        val onDone: () -> Unit
    ) { var startNs = 0L; var failed = false }

    private val renderer = TxRenderer()
    @Volatile private var incoming: Job? = null

    private companion object {
        // ~4 frames at 60Hz. How long the finished overlay lingers (showing the destination image)
        // before it is hidden, so the SurfaceFlinger hide can't beat the app's draw of the same image
        // underneath. Generous on purpose: a slow panel misses more vsyncs, and the wait costs
        // nothing visually because both layers hold identical pixels.
        const val PARK_DELAY_MS = 64L
    }

    init {
        setEGLContextClientVersion(2)
        setEGLConfigChooser(8, 8, 8, 8, 0, 0)  // alpha channel -> translucent surface
        holder.setFormat(PixelFormat.TRANSLUCENT)
        setZOrderOnTop(true)                    // above the content views while a wipe is in flight
        setRenderer(renderer)
        renderMode = RENDERMODE_WHEN_DIRTY
        visibility = GONE
    }

    /** Main-thread entry: run a wipe. If the runtime can't start it, onDone still fires (hard cut).
     *  onDone is the RAW content swap — the overlay's visibility/render-mode are owned by the renderer
     *  (parkIfIdle), NOT by this callback, so a superseded wipe's late onDone can't hide the overlay out
     *  from under a newer wipe that's already in flight (that was a playlist-wedge bug). */
    fun play(from: Bitmap, to: Bitmap, fragmentSrc: String, params: Map<String, Float>, durationMs: Int, onDone: () -> Unit) {
        incoming = Job(from, to, fragmentSrc, params, durationMs.coerceAtLeast(1), onDone)
        visibility = VISIBLE
        renderMode = RENDERMODE_CONTINUOUSLY
        requestRender()
    }

    private inner class TxRenderer : Renderer {
        private var vShader = 0
        private var program = 0
        private var texFrom = 0
        private var texTo = 0
        private var uFrom = 0; private var uTo = 0; private var uProgress = 0; private var uRatio = 0
        private val uParam = HashMap<String, Int>()
        private var vw = 1; private var vh = 1
        private var active: Job? = null
        private val quad: FloatBuffer = ByteBuffer
            .allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
            .apply { put(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)); position(0) }

        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            GLES20.glClearColor(0f, 0f, 0f, 0f)  // transparent: content behind shows through pre-wipe
            vShader = compile(GLES20.GL_VERTEX_SHADER, TransitionGlsl.VERTEX)
            // a context (re)create drops any active job's GL objects — abandon it (hard-cut to its target),
            // and park if nothing new is queued so the overlay never sticks visible.
            active?.let { swapOnMain(it) }
            active = null; program = 0; texFrom = 0; texTo = 0
            parkIfIdle()
        }

        override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) { vw = width; vh = height; GLES20.glViewport(0, 0, width, height) }

        override fun onDrawFrame(gl: GL10?) {
            incoming?.let { j -> incoming = null; active?.let { supersede(it) }; setup(j) } // pick up a new request
            val j = active
            // Clear ONLY when a frame is actually going to be drawn over it. Clearing
            // unconditionally painted the overlay black on every frame where there was nothing to
            // draw — and the overlay is still VISIBLE at that moment, because finish() only POSTS
            // the hide to the main thread. That was the one-or-two frame blank seen after each
            // wipe, and the same flash on the failed/hard-cut path.
            if (j == null) return
            if (j.failed) { finish(j); return }
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            if (j.startNs == 0L) j.startNs = System.nanoTime()
            val p = ((System.nanoTime() - j.startNs).toFloat() / (j.durationMs * 1_000_000f)).coerceIn(0f, 1f)
            draw(j, p)
            if (p >= 1f) finish(j)
        }

        // Compile + link the program and upload both frames as textures. Any failure -> job.failed
        // (onDrawFrame then finishes it -> onDone hard-cuts). Never throws out of here.
        private fun setup(j: Job) {
            active = j
            try {
                val frag = compile(GLES20.GL_FRAGMENT_SHADER, j.fragmentSrc)
                val prog = GLES20.glCreateProgram()
                GLES20.glAttachShader(prog, vShader)
                GLES20.glAttachShader(prog, frag)
                GLES20.glBindAttribLocation(prog, 0, "aPos")
                GLES20.glLinkProgram(prog)
                val ok = IntArray(1); GLES20.glGetProgramiv(prog, GLES20.GL_LINK_STATUS, ok, 0)
                GLES20.glDeleteShader(frag)
                if (ok[0] == 0) { val log = GLES20.glGetProgramInfoLog(prog); GLES20.glDeleteProgram(prog); throw RuntimeException("link: $log") }
                program = prog
                uFrom = GLES20.glGetUniformLocation(prog, "uFrom")
                uTo = GLES20.glGetUniformLocation(prog, "uTo")
                uProgress = GLES20.glGetUniformLocation(prog, "progress")
                uRatio = GLES20.glGetUniformLocation(prog, "ratio")
                uParam.clear()
                for (name in j.params.keys) uParam[name] = GLES20.glGetUniformLocation(prog, name)
                texFrom = uploadTexture(j.from)
                texTo = uploadTexture(j.to)
                // pixels now live in the GL textures — free the (full-screen ARGB) fit bitmaps promptly
                // rather than waiting on GC, which matters on a long-lived signage device.
                try { j.from.recycle(); j.to.recycle() } catch (_: Throwable) {}
            } catch (e: Throwable) {
                Log.w("TransitionGL", "wipe setup failed, hard-cutting: ${e.message}")
                j.failed = true
            }
        }

        private fun draw(j: Job, p: Float) {
            GLES20.glUseProgram(program)
            GLES20.glViewport(0, 0, vw, vh)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0); GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texFrom); GLES20.glUniform1i(uFrom, 0)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE1); GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texTo); GLES20.glUniform1i(uTo, 1)
            GLES20.glUniform1f(uProgress, p)
            GLES20.glUniform1f(uRatio, vw.toFloat() / maxOf(1, vh))
            for ((name, v) in j.params) { val loc = uParam[name] ?: -1; if (loc >= 0) GLES20.glUniform1f(loc, v) }
            GLES20.glEnableVertexAttribArray(0)
            quad.position(0)
            GLES20.glVertexAttribPointer(0, 2, GLES20.GL_FLOAT, false, 0, quad)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            GLES20.glDisableVertexAttribArray(0)
        }

        // Wipe completed (or failed): release its GL, run the content swap on the main thread, then park
        // the overlay IF no newer wipe is queued.
        private fun finish(j: Job) {
            active = null
            // Stop the render loop HERE, on the GL thread, rather than waiting for parkIfIdle() to
            // run on the main thread. The front buffer currently holds the wipe's last frame — which
            // is the destination image — so leaving it untouched and visible is seamless while the
            // real content is mounted underneath. Any frame drawn in that gap is a regression:
            // there is nothing left to draw, so it can only be an empty one.
            renderMode = RENDERMODE_WHEN_DIRTY
            releaseGl()
            swapOnMain(j)
            parkIfIdle()
        }

        // Superseded by a newer wipe (advance fired mid-wipe): release THIS wipe's GL (else its program +
        // both textures leak) and run its content swap, but do NOT park — the new wipe keeps the overlay
        // visible + rendering. setup(new) runs immediately after and rebuilds the GL objects.
        private fun supersede(old: Job) {
            releaseGl()
            swapOnMain(old)
        }

        private fun swapOnMain(j: Job) { post { j.onDone() } } // View.post -> main thread (the content swap)

        // Hide the overlay + stop the render loop, but ONLY if nothing new is queued. `incoming` is
        // @Volatile and mutated only on the main thread (play), the same thread this posted block runs on,
        // so a newer play() either already set incoming (we skip park) or runs after (it re-shows) —
        // race-free, and never leaves a new wipe hidden.
        private fun parkIfIdle() {
            post {
                if (incoming != null) return@post
                // The overlay is currently showing the wipe's FINAL frame, which is the same picture
                // that was just mounted underneath it. Hiding is therefore free to wait — and it must.
                //
                // This is a SurfaceView with setZOrderOnTop(true): its visibility change is applied by
                // SurfaceFlinger in a transaction that is NOT synchronised with the app drawing the
                // ImageView's new bitmap. Hiding in the same message-loop turn as the swap can land a
                // vsync EARLIER than that draw, uncovering the previous photo for one frame. Holding
                // the overlay (identical pixels) for a few frames removes the race outright; there is
                // nothing to see during the wait because both layers show the same image.
                postDelayed({
                    if (incoming == null) { visibility = GONE; renderMode = RENDERMODE_WHEN_DIRTY }
                }, PARK_DELAY_MS)
            }
        }

        private fun releaseGl() {
            if (texFrom != 0) { GLES20.glDeleteTextures(1, intArrayOf(texFrom), 0); texFrom = 0 }
            if (texTo != 0) { GLES20.glDeleteTextures(1, intArrayOf(texTo), 0); texTo = 0 }
            if (program != 0) { GLES20.glDeleteProgram(program); program = 0 }
        }

        private fun uploadTexture(bmp: Bitmap): Int {
            val ids = IntArray(1); GLES20.glGenTextures(1, ids, 0)
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ids[0])
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0)
            return ids[0]
        }

        private fun compile(type: Int, src: String): Int {
            val s = GLES20.glCreateShader(type)
            GLES20.glShaderSource(s, src)
            GLES20.glCompileShader(s)
            val ok = IntArray(1); GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
            if (ok[0] == 0) { val log = GLES20.glGetShaderInfoLog(s); GLES20.glDeleteShader(s); throw RuntimeException("compile: $log") }
            return s
        }
    }
}
