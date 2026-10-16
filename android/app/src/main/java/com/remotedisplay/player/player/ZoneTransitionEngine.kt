package com.remotedisplay.player.player

import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.TextureView

/*
 * GL wipes for layout zones: the GL half of ZoneTransitions.kt.
 *
 * WHY NOT ONE TransitionGLView PER ZONE. That overlay is a GLSurfaceView: its own EGL context and
 * render thread each, and setZOrderOnTop puts it above EVERY view — so a zone's wipe would cover a
 * higher zone (a logo over the main zone) — and #344 showed a SurfaceView does not reliably follow
 * the rotated stage, which is why the full-screen path bakes the rotation into its bitmaps. Four of
 * those on a Fire TV Stick would be four contexts and four threads for what is usually a few
 * hundred milliseconds of drawing.
 *
 * So zones share ONE GL thread and ONE EGL context, and each zone wipe draws into its own
 * TextureView. A TextureView is an ordinary view: it sits in the zone's slot in the rotated stage,
 * takes the stage's rotation and the zones' z-order like any other zone view, and needs nothing
 * baked in. The program, uniform contract and texture path are TransitionCompositor's (WipeGl), so
 * every shader means the same thing in a zone as it does full screen.
 *
 * Every failure path reports onFailed and the caller cuts — the view is transparent until its first
 * frame, so the zone's outgoing picture is what shows until then. Never a black frame.
 */
class ZoneTransitionEngine {

    /** Callbacks, always on the main thread. The caller checks its own ticket before acting. */
    interface Listener {
        fun onFirstFrame()
        fun onFinished()
        fun onFailed(reason: String)
    }

    /** One wipe. [view] is what the caller places over the zone; cancel() is idempotent. */
    inner class Handle internal constructor(val view: TextureView, internal val job: Job) {
        fun cancel() {
            job.cancelled = true
            val h = glHandler
            if (h != null) h.post { cancelJob(job) } else job.freeBitmaps()   // no thread yet: nothing uploaded
        }
    }

    internal class Job(
        val from: Bitmap,
        val to: Bitmap,
        val fragmentSrc: String,
        val fallbackSrc: String,
        val params: Map<String, Float>,
        val durationMs: Int,
        val texW: Int,
        val texH: Int,
        val listener: Listener
    ) {
        @Volatile var cancelled = false
        // GL-thread only below.
        var st: SurfaceTexture? = null
        var surface: EGLSurface = EGL14.EGL_NO_SURFACE
        val wipe = WipeGl()
        var started = false
        var startNs = 0L
        var firstFrameSent = false
        var done = false
        private var bitmapsFreed = false
        private val releasedSts = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<SurfaceTexture, Boolean>())
        /** Release a SurfaceTexture once, whichever thread gets there first (GL thread, or main after shutdown). */
        fun releaseSt(st: SurfaceTexture) {
            synchronized(releasedSts) { if (!releasedSts.add(st)) return }
            try { st.release() } catch (_: Throwable) {}
        }
        fun freeBitmaps() {
            if (bitmapsFreed) return
            bitmapsFreed = true
            try { from.recycle(); to.recycle() } catch (_: Throwable) {}
        }
    }

    private val main = Handler(Looper.getMainLooper())

    /** False once EGL could not be brought up on this device: zones then use the view crossfade. */
    @Volatile var usable: Boolean = true
        private set

    private var thread: HandlerThread? = null
    @Volatile private var glHandler: Handler? = null

    // ---- GL-thread state ----
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var config: EGLConfig? = null
    private var ctx: EGLContext = EGL14.EGL_NO_CONTEXT
    private var pbuffer: EGLSurface = EGL14.EGL_NO_SURFACE
    private var vShader = 0
    private val jobs = ArrayList<Job>()
    @Volatile private var frameScheduled = false
    /*
     * Linked programs by fragment source, shared by every zone (and across advances): zones on one
     * layout usually carry the same few shaders, and a compile is the one GL step that visibly
     * stalls a cheap Mali. Bounded LRU; an evicted program is deleted.
     */
    private val programs = object : LinkedHashMap<String, Int>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?): Boolean {
            if (size <= PROGRAM_CACHE) return false
            eldest?.value?.let { if (it != 0) GLES20.glDeleteProgram(it) }
            return true
        }
    }
    // Sources that failed to compile/link here: not retried every advance on this GPU.
    private val badSources = HashSet<String>()

    private companion object {
        const val TAG = "ZoneTxGL"
        const val PROGRAM_CACHE = 6
    }

    /**
     * Start a wipe. The engine OWNS [from] and [to] from here (recycled once uploaded, or on
     * cancel). [fromFrame]/[toFrame] are already fitted to a [texW]x[texH] box and flipped for GL
     * (fitZoneTransitionBitmap). Main thread. The caller adds [Handle.view] over the zone.
     */
    fun start(
        context: android.content.Context,
        from: Bitmap, to: Bitmap,
        fragmentSrc: String, params: Map<String, Float>, durationMs: Int,
        texW: Int, texH: Int,
        listener: Listener
    ): Handle {
        val job = Job(from, to, fragmentSrc, TransitionGlsl.CROSSFADE, params, durationMs.coerceAtLeast(1),
            texW.coerceAtLeast(1), texH.coerceAtLeast(1), listener)
        val tv = TextureView(context)
        tv.isOpaque = false   // transparent until the first frame: the zone's outgoing picture shows through
        tv.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
                // Render at the downscaled texture size; the view scales it up to the zone box.
                try { st.setDefaultBufferSize(job.texW, job.texH) } catch (_: Throwable) {}
                val h = ensureThread()
                h.post { attach(job, st) }
            }
            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
                // TextureView resets the buffer to its own size on a resize; keep ours.
                try { st.setDefaultBufferSize(job.texW, job.texH) } catch (_: Throwable) {}
            }
            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                // false: WE release the SurfaceTexture, on the GL thread, after its EGL surface is gone
                // — releasing it here while that thread may be mid-swap into it is a native crash.
                val h = glHandler
                if (h != null) h.post { detach(job, st) } else job.releaseSt(st)
                return false
            }
            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
        }
        return Handle(tv, job)
    }

    /**
     * Free the GL context and every job (layout teardown). Main thread.
     *
     * ⚠️ The THREAD is kept (an idle HandlerThread costs nothing): every GL field here is confined to
     * that one thread for the engine's whole life. Quitting it and starting a new one on the next
     * wipe let the old thread's teardown run concurrently with the new thread's setup on the same
     * fields — and setupZones() calls cleanup() on every layout. It also stranded a pending
     * Choreographer frame, so frameScheduled stayed true and no zone wipe ever drew again after a
     * layout change (seen on the emulator: every wipe sat out its start deadline and cut).
     */
    fun shutdown() {
        val h = glHandler ?: return
        h.post {
            try { Choreographer.getInstance().removeFrameCallback(frameCallback) } catch (_: Throwable) {}
            frameScheduled = false
            for (j in jobs.toList()) { releaseJobGl(j); j.freeBitmaps(); destroySurface(j) }
            jobs.clear()
            teardownEgl()
        }
    }

    /** shutdown() and end the GL thread (the owner is being destroyed). Main thread. */
    fun release() {
        shutdown()
        val t = thread
        glHandler?.post { t?.quitSafely() }
        glHandler = null; thread = null
    }

    // ------------------------------------------------------------------------------------ GL thread

    private fun ensureThread(): Handler {
        glHandler?.let { return it }
        val t = HandlerThread("ZoneTransitionGL").also { it.start() }
        val h = Handler(t.looper)
        thread = t; glHandler = h
        return h
    }

    private fun ensureEgl(): Boolean {
        if (ctx != EGL14.EGL_NO_CONTEXT) return true
        if (!usable) return false
        try {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            if (display == EGL14.EGL_NO_DISPLAY) throw RuntimeException("no display")
            val ver = IntArray(2)
            if (!EGL14.eglInitialize(display, ver, 0, ver, 1)) throw RuntimeException("eglInitialize")
            val attrs = intArrayOf(
                EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_NONE)
            val cfgs = arrayOfNulls<EGLConfig>(1); val n = IntArray(1)
            if (!EGL14.eglChooseConfig(display, attrs, 0, cfgs, 0, 1, n, 0) || n[0] <= 0) throw RuntimeException("eglChooseConfig")
            config = cfgs[0]
            ctx = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT,
                intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
            if (ctx == EGL14.EGL_NO_CONTEXT) throw RuntimeException("eglCreateContext")
            pbuffer = EGL14.eglCreatePbufferSurface(display, config, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
            if (pbuffer == EGL14.EGL_NO_SURFACE) throw RuntimeException("pbuffer")
            if (!EGL14.eglMakeCurrent(display, pbuffer, pbuffer, ctx)) throw RuntimeException("makeCurrent")
            vShader = WipeGl.compile(GLES20.GL_VERTEX_SHADER, TransitionGlsl.VERTEX)
            GLES20.glClearColor(0f, 0f, 0f, 0f)
            return true
        } catch (e: Throwable) {
            Log.w(TAG, "EGL unavailable, zones fall back to the view crossfade: ${e.message}")
            usable = false
            teardownEgl()
            return false
        }
    }

    private fun teardownEgl() {
        if (display == EGL14.EGL_NO_DISPLAY) return
        try {
            if (ctx != EGL14.EGL_NO_CONTEXT) {
                EGL14.eglMakeCurrent(display, pbuffer, pbuffer, ctx)
                for (p in programs.values) if (p != 0) GLES20.glDeleteProgram(p)
                if (vShader != 0) GLES20.glDeleteShader(vShader)
            }
        } catch (_: Throwable) {}
        programs.clear(); vShader = 0
        try {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            if (pbuffer != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, pbuffer)
            if (ctx != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, ctx)
        } catch (_: Throwable) {}
        // ⚠️ Never eglTerminate: the default display is process-wide, and terminating it would take
        // the full-screen TransitionGLView's context (and the WebViews' GPU process link) with it.
        pbuffer = EGL14.EGL_NO_SURFACE; ctx = EGL14.EGL_NO_CONTEXT; display = EGL14.EGL_NO_DISPLAY
    }

    private fun attach(job: Job, st: SurfaceTexture) {
        if (job.cancelled || job.done) { job.releaseSt(st); return }
        if (!ensureEgl()) { job.releaseSt(st); fail(job, "egl"); return }
        val s = try {
            EGL14.eglCreateWindowSurface(display, config, st, intArrayOf(EGL14.EGL_NONE), 0)
        } catch (e: Throwable) { EGL14.EGL_NO_SURFACE }
        if (s == null || s == EGL14.EGL_NO_SURFACE) { job.releaseSt(st); fail(job, "window surface"); return }
        job.st = st; job.surface = s
        if (EGL14.eglMakeCurrent(display, s, s, ctx)) EGL14.eglSwapInterval(display, 0)   // never block one zone on another's vsync
        if (!jobs.contains(job)) jobs.add(job)
        scheduleFrame()
    }

    private fun detach(job: Job, st: SurfaceTexture) {
        releaseJobGl(job)
        job.freeBitmaps()
        destroySurface(job)
        jobs.remove(job)
        job.releaseSt(st)   // no-op when it was the job's own (destroySurface released it)
    }

    private fun destroySurface(job: Job) {
        if (job.surface != EGL14.EGL_NO_SURFACE && display != EGL14.EGL_NO_DISPLAY) {
            try {
                EGL14.eglMakeCurrent(display, pbuffer, pbuffer, ctx)
                EGL14.eglDestroySurface(display, job.surface)
            } catch (_: Throwable) {}
        }
        job.surface = EGL14.EGL_NO_SURFACE
        job.st?.let { job.releaseSt(it) }
        job.st = null
    }

    private fun cancelJob(job: Job) {
        job.done = true
        releaseJobGl(job)
        job.freeBitmaps()
        // The EGL surface goes when the caller removes the view (detach); a job whose view never got
        // a surface has nothing more to free.
        if (job.surface == EGL14.EGL_NO_SURFACE) jobs.remove(job)
    }

    private fun releaseJobGl(job: Job) {
        if (ctx == EGL14.EGL_NO_CONTEXT) { job.wipe.forget(); return }
        try { EGL14.eglMakeCurrent(display, pbuffer, pbuffer, ctx); job.wipe.release() } catch (_: Throwable) { job.wipe.forget() }
    }

    private fun fail(job: Job, reason: String) {
        if (job.done) return
        job.done = true
        releaseJobGl(job)
        job.freeBitmaps()
        Log.w(TAG, "zone wipe failed ($reason) — cutting")
        main.post { job.listener.onFailed(reason) }
    }

    private fun program(src: String): Int {
        programs[src]?.let { return it }
        if (src in badSources) return 0
        return try {
            WipeGl.link(vShader, src).also { programs[src] = it }
        } catch (e: Throwable) {
            Log.w(TAG, "shader rejected by this GPU: ${e.message}")
            if (badSources.size < 32) badSources.add(src)
            0
        }
    }

    private fun scheduleFrame() {
        if (frameScheduled) return
        frameScheduled = true
        Choreographer.getInstance().postFrameCallback(frameCallback)
    }

    private val frameCallback = Choreographer.FrameCallback {
        frameScheduled = false
        drawFrame()
    }

    private fun drawFrame() {
        var more = false
        for (j in jobs.toList()) {
            if (j.cancelled) { if (!j.done) cancelJob(j); continue }
            if (j.done || j.surface == EGL14.EGL_NO_SURFACE) continue
            if (!EGL14.eglMakeCurrent(display, j.surface, j.surface, ctx)) { fail(j, "makeCurrent"); continue }
            if (!j.started) {
                // Item shader, else the built-in crossfade (the native player's fallback), else cut.
                var prog = program(j.fragmentSrc)
                if (prog == 0) prog = program(j.fallbackSrc)
                if (prog == 0) { fail(j, "no program"); continue }
                try {
                    j.wipe.useProgram(prog, j.params.keys, owned = false)
                    j.wipe.upload(j.from, j.to)
                } catch (e: Throwable) { fail(j, "upload: ${e.message}"); continue }
                j.freeBitmaps()   // pixels live in the textures now
                j.started = true
                j.startNs = System.nanoTime()
            }
            val wh = IntArray(1); val hh = IntArray(1)
            EGL14.eglQuerySurface(display, j.surface, EGL14.EGL_WIDTH, wh, 0)
            EGL14.eglQuerySurface(display, j.surface, EGL14.EGL_HEIGHT, hh, 0)
            val vw = if (wh[0] > 0) wh[0] else j.texW
            val vh = if (hh[0] > 0) hh[0] else j.texH
            val p = ((System.nanoTime() - j.startNs).toFloat() / (j.durationMs * 1_000_000f)).coerceIn(0f, 1f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            j.wipe.draw(p, vw, vh, j.params)
            if (!EGL14.eglSwapBuffers(display, j.surface)) { fail(j, "swap 0x" + Integer.toHexString(EGL14.eglGetError())); continue }
            if (!j.firstFrameSent) { j.firstFrameSent = true; main.post { j.listener.onFirstFrame() } }
            if (p >= 1f) {
                // The view keeps showing this last frame (the destination) until the caller removes it.
                j.done = true
                releaseJobGl(j)
                main.post { j.listener.onFinished() }
            } else more = true
        }
        if (more) scheduleFrame()
    }
}

/*
 * Fit a source picture into a [texW]x[texH] zone texture exactly as the zone's view frames it
 * (ZoneTransitionFit.destRect: cover / contain / fill), on black, optionally flipped vertically for
 * a GL upload (GLES2 has no UNPACK_FLIP_Y; the same flip fitTransitionBitmap does, so a shader's uv
 * convention is the full-screen one). The view crossfade uses it unflipped.
 */
fun fitZoneTransitionBitmap(src: Bitmap, texW: Int, texH: Int, fit: String?, flipForGl: Boolean): Bitmap {
    val out = Bitmap.createBitmap(texW.coerceAtLeast(1), texH.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    val c = android.graphics.Canvas(out)
    c.drawColor(android.graphics.Color.BLACK)
    if (src.width > 0 && src.height > 0) {
        val r = ZoneTransitionFit.destRect(src.width, src.height, out.width, out.height, fit)
        if (flipForGl) c.scale(1f, -1f, out.width / 2f, out.height / 2f)
        c.drawBitmap(src, null, android.graphics.RectF(r[0], r[1], r[2], r[3]), android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
    }
    return out
}
