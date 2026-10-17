package com.remotedisplay.player.player

import android.content.Context
import android.graphics.SurfaceTexture
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/**
 * A fisheye camera drawn as a normal view: ExoPlayer decodes into this view's SurfaceTexture, and
 * every frame (and every move of the view) is re-projected by the fragment shader below, which is
 * Fisheye.project per pixel. The view fills its own size: zoom is the horizontal field of view and the
 * vertical one follows the screen's shape, so a 16:9 screen shows a 16:9 view with no bars.
 *
 * ⚠️ NOT a media3 video effect. ExoPlayer.setVideoEffects (media3 1.2.1) drew the first frame of a live
 * RTSP camera and then stalled: frames kept decoding but never left the effect pipeline. Owning the
 * SurfaceTexture and the GL thread is what 360° players do, and it does not depend on media3's
 * experimental frame-processing path.
 *
 * Threads: GL calls on the GLSurfaceView thread only. [onSurfaceReady] is called on the main thread
 * with the Surface to give ExoPlayer; [view] is read on the GL thread every draw.
 */
class FisheyeGlView(context: Context) : GLSurfaceView(context) {
    @Volatile var view: Fisheye.View? = null
        set(value) { field = value; requestRender() }

    /** Called (main thread) with the decoder's output surface once GL is up; null when it is gone. */
    var onSurfaceReady: ((Surface?) -> Unit)? = null
    var surface: Surface? = null
        private set

    private val renderer = Renderer()

    init {
        setEGLContextClientVersion(2)
        setRenderer(renderer)
        renderMode = RENDERMODE_WHEN_DIRTY
        preserveEGLContextOnPause = true
    }

    /** Redraw now: the view was steered. A new decoded frame redraws by itself. */
    fun redraw() = requestRender()

    private inner class Renderer : GLSurfaceView.Renderer, SurfaceTexture.OnFrameAvailableListener {
        private var program = 0
        private var oesTex = 0
        private var st: SurfaceTexture? = null
        private val texMatrix = FloatArray(16)
        private var width = 1
        private var height = 1
        private var imageW = 0
        private var imageH = 0
        private val quad: FloatBuffer = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
            put(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)); position(0)
        }

        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            program = link(VERTEX, FRAGMENT)
            val ids = IntArray(1)
            GLES20.glGenTextures(1, ids, 0)
            oesTex = ids[0]
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            val tex = SurfaceTexture(oesTex).also { it.setOnFrameAvailableListener(this) }
            st = tex
            val s = Surface(tex)
            post {
                surface?.release()
                surface = s
                onSurfaceReady?.invoke(s)
            }
        }

        override fun onSurfaceChanged(gl: GL10?, w: Int, h: Int) {
            width = w.coerceAtLeast(1); height = h.coerceAtLeast(1)
            GLES20.glViewport(0, 0, width, height)
        }

        override fun onFrameAvailable(t: SurfaceTexture?) = requestRender()

        /** The decoded picture's size, for the lens circle's shape (main thread, from the player). */
        fun setImageSize(w: Int, h: Int) { imageW = w; imageH = h }

        override fun onDrawFrame(gl: GL10?) {
            val tex = st ?: return
            try { tex.updateTexImage() } catch (e: Exception) { Log.w("FisheyeGlView", "updateTexImage: ${e.message}"); return }
            tex.getTransformMatrix(texMatrix)
            val v = view
            GLES20.glClearColor(0f, 0f, 0f, 1f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            if (v == null || program == 0) return
            val f = v.current
            val b = Fisheye.basis(f)
            val tx = kotlin.math.tan(Math.toRadians(f.zoom) / 2)
            val ty = tx * height / width
            val aspect = if (imageW > 0 && imageH > 0) imageW.toDouble() / imageH else 1.0
            GLES20.glUseProgram(program)
            fun u(name: String) = GLES20.glGetUniformLocation(program, name)
            GLES20.glUniform3f(u("uDir"), b.d[0].toFloat(), b.d[1].toFloat(), b.d[2].toFloat())
            GLES20.glUniform3f(u("uRight"), b.right[0].toFloat(), b.right[1].toFloat(), b.right[2].toFloat())
            GLES20.glUniform3f(u("uUp"), b.up[0].toFloat(), b.up[1].toFloat(), b.up[2].toFloat())
            GLES20.glUniform2f(u("uTan"), tx.toFloat(), ty.toFloat())
            GLES20.glUniform1f(u("uLensHalf"), (Math.toRadians(f.lensFov) / 2).toFloat())
            GLES20.glUniform1f(u("uRot"), Math.toRadians(f.rotation).toFloat())
            GLES20.glUniform2f(u("uCenter"), f.cx.toFloat(), f.cy.toFloat())
            GLES20.glUniform2f(u("uRadius"), (f.r / aspect).toFloat(), f.r.toFloat())
            GLES20.glUniformMatrix4fv(u("uTexMatrix"), 1, false, texMatrix, 0)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
            GLES20.glUniform1i(u("uTex"), 0)
            val pos = GLES20.glGetAttribLocation(program, "aPos")
            GLES20.glEnableVertexAttribArray(pos)
            GLES20.glVertexAttribPointer(pos, 2, GLES20.GL_FLOAT, false, 0, quad)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            GLES20.glDisableVertexAttribArray(pos)
        }

        fun release() {
            st?.release(); st = null
        }

        private fun link(vs: String, fs: String): Int {
            fun compile(type: Int, src: String): Int {
                val s = GLES20.glCreateShader(type)
                GLES20.glShaderSource(s, src)
                GLES20.glCompileShader(s)
                val ok = IntArray(1)
                GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
                if (ok[0] == 0) { Log.e("FisheyeGlView", "shader: ${GLES20.glGetShaderInfoLog(s)}"); GLES20.glDeleteShader(s); return 0 }
                return s
            }
            val v = compile(GLES20.GL_VERTEX_SHADER, vs)
            val f = compile(GLES20.GL_FRAGMENT_SHADER, fs)
            if (v == 0 || f == 0) return 0
            val p = GLES20.glCreateProgram()
            GLES20.glAttachShader(p, v); GLES20.glAttachShader(p, f)
            GLES20.glLinkProgram(p)
            val ok = IntArray(1)
            GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
            if (ok[0] == 0) { Log.e("FisheyeGlView", "link: ${GLES20.glGetProgramInfoLog(p)}"); return 0 }
            return p
        }
    }

    fun setImageSize(w: Int, h: Int) { renderer.setImageSize(w, h); requestRender() }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        queueEvent { renderer.release() }
        surface?.release(); surface = null
    }

    private companion object {
        const val VERTEX = """
attribute vec2 aPos;
varying vec2 vPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vPos = aPos;
}
"""
        // vPos is the output point (-1..1, y up). The decoded picture is an external texture whose
        // coordinates come through the SurfaceTexture's matrix; an image v measured downward is 1 - v.
        const val FRAGMENT = """
#extension GL_OES_EGL_image_external : require
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform samplerExternalOES uTex;
uniform mat4 uTexMatrix;
uniform vec3 uDir;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec2 uTan;
uniform float uLensHalf;
uniform float uRot;
uniform vec2 uCenter;
uniform vec2 uRadius;
varying vec2 vPos;
void main() {
  vec3 ray = normalize(uDir + vPos.x * uTan.x * uRight + vPos.y * uTan.y * uUp);
  float theta = acos(clamp(ray.z, -1.0, 1.0));
  if (theta > uLensHalf) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float phi = atan(ray.y, ray.x) + uRot;
  float rho = theta / uLensHalf;
  vec2 uv = uCenter + uRadius * rho * vec2(cos(phi), sin(phi));
  vec4 st = uTexMatrix * vec4(uv.x, 1.0 - uv.y, 0.0, 1.0);
  gl_FragColor = texture2D(uTex, st.xy);
}
"""
    }
}
