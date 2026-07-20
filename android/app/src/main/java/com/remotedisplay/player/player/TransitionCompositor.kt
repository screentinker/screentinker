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
    fun loadSource(assets: AssetManager, shaderId: String): String? = try {
        assets.open("transitions/$shaderId.glsl").bufferedReader().use { it.readText() }
    } catch (e: Throwable) { Log.w("TransitionGL", "shader '$shaderId' not found in assets: ${e.message}"); null }
}

// Fit a source bitmap into a w×h frame with object-fit:contain letterboxing (matches the static
// ImageView/PlayerView framing), AND flip it vertically — GLES2 has no UNPACK_FLIP_Y_WEBGL, so the flip
// here replicates exactly what the web renderer's upload() does, keeping the shader uv convention (and
// therefore the transition geometry) identical across platforms. Returns an ARGB_8888 bitmap.
fun fitTransitionBitmap(src: Bitmap, w: Int, h: Int): Bitmap {
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val c = Canvas(out)
    c.drawColor(android.graphics.Color.BLACK)
    val iw = src.width.toFloat(); val ih = src.height.toFloat()
    if (iw > 0f && ih > 0f) {
        val s = minOf(w / iw, h / ih)         // contain
        val dw = iw * s; val dh = ih * s
        val m = Matrix()
        m.postScale(s, s)
        m.postTranslate((w - dw) / 2f, (h - dh) / 2f)
        m.postScale(1f, -1f, w / 2f, h / 2f)  // vertical flip == UNPACK_FLIP_Y_WEBGL
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

    init {
        setEGLContextClientVersion(2)
        setEGLConfigChooser(8, 8, 8, 8, 0, 0)  // alpha channel -> translucent surface
        holder.setFormat(PixelFormat.TRANSLUCENT)
        setZOrderOnTop(true)                    // above the content views while a wipe is in flight
        setRenderer(renderer)
        renderMode = RENDERMODE_WHEN_DIRTY
        visibility = GONE
    }

    /** Main-thread entry: run a wipe. If the runtime can't start it, onDone still fires (hard cut). */
    fun play(from: Bitmap, to: Bitmap, fragmentSrc: String, params: Map<String, Float>, durationMs: Int, onDone: () -> Unit) {
        val job = Job(from, to, fragmentSrc, params, durationMs.coerceAtLeast(1)) {
            // wrap so the view is hidden + parked on the main thread right when the swap happens
            visibility = GONE
            renderMode = RENDERMODE_WHEN_DIRTY
            onDone()
        }
        incoming = job
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
            // a context (re)create drops any active job's GL objects — abandon it, the caller already
            // swapped or will on the next advance; never leave the overlay stuck visible.
            active?.let { finishOnMain(it) }
            active = null; program = 0; texFrom = 0; texTo = 0
        }

        override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) { vw = width; vh = height; GLES20.glViewport(0, 0, width, height) }

        override fun onDrawFrame(gl: GL10?) {
            incoming?.let { j -> incoming = null; active?.let { finishOnMain(it) }; setup(j) } // pick up a new request
            val j = active
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            if (j == null) return
            if (j.failed) { finish(j); return }
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

        // Release GL objects, then run the job's onDone on the main thread (the content swap happens there).
        private fun finish(j: Job) {
            active = null
            releaseGl()
            finishOnMain(j)
        }

        private fun finishOnMain(j: Job) { post { j.onDone() } } // View.post -> main thread; guarded once by active handoff

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
