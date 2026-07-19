// Portable WebGL transition compositor (GL Transitions v1).
//
// ONE implementation, consumed by both the web player (inlined at build) and the Tizen player.
// No DOM dependency beyond the <canvas> handed in. The .glsl shaders + params.js are the single
// source of truth; this module only wraps (PREAMBLE + shader + EPILOGUE, shared VERTEX) and runs
// them. It composites TWO textures (from -> to) across `progress` 0..1; the outgoing frame stays
// live in `uFrom` for the whole transition, so there is never a blank seam.
//
// Never-blank teeth live here too: on `webglcontextlost` the renderer flips `lost` and calls
// opts.onContextLost so the player can hard-cut to a plain <img> instead of showing black.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TransitionRenderer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('shader compile failed: ' + log);
    }
    return s;
  }

  // wrap = { PREAMBLE, EPILOGUE, VERTEX } from params.js
  function createRenderer(canvas, wrap, opts) {
    opts = opts || {};
    const attrs = {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    };
    const gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) throw new Error('no-webgl');

    let lost = false;
    const onLost = (e) => { e.preventDefault(); lost = true; if (opts.onContextLost) opts.onContextLost(); };
    const onRestored = () => { lost = false; programs = {}; buildQuad(); if (opts.onContextRestored) opts.onContextRestored(); };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);

    let quadBuf, vShader;
    function buildQuad() {
      quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      vShader = compile(gl, gl.VERTEX_SHADER, wrap.VERTEX);
    }
    buildQuad();

    let programs = {}; // shaderSrc -> { program, uni:{} }
    function programFor(src) {
      if (programs[src]) return programs[src];
      const f = compile(gl, gl.FRAGMENT_SHADER, wrap.PREAMBLE + '\n' + src + '\n' + wrap.EPILOGUE);
      const p = gl.createProgram();
      gl.attachShader(p, vShader);
      gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p); gl.deleteShader(f);
        throw new Error('program link failed: ' + log);
      }
      gl.deleteShader(f);
      programs[src] = { program: p, uni: {} };
      return programs[src];
    }
    function uniLoc(rec, name) {
      if (!(name in rec.uni)) rec.uni[name] = gl.getUniformLocation(rec.program, name);
      return rec.uni[name];
    }

    function makeTex() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    }
    let texFrom = makeTex(), texTo = makeTex();
    let curShader = null;

    function upload(tex, source) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);            // match getFromColor/getToColor uv convention
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    return {
      get lost() { return lost; },
      gl,
      // Compile eagerly so a bad shader throws HERE (caller hard-cuts) rather than mid-transition.
      setShader(src) { curShader = src; programFor(src); },
      setFrom(img) { upload(texFrom, img); },
      setTo(img) { upload(texTo, img); },
      resize(w, h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); },
      render(progress, params) {
        if (lost || !curShader) return false;
        const rec = programFor(curShader);
        gl.useProgram(rec.program);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFrom); gl.uniform1i(uniLoc(rec, 'uFrom'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texTo); gl.uniform1i(uniLoc(rec, 'uTo'), 1);
        gl.uniform1f(uniLoc(rec, 'progress'), Math.max(0, Math.min(1, progress)));
        gl.uniform1f(uniLoc(rec, 'ratio'), canvas.width / Math.max(1, canvas.height));
        if (params) for (const k in params) { const loc = uniLoc(rec, k); if (loc) gl.uniform1f(loc, params[k]); }
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
      },
      destroy() {
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        try {
          gl.deleteTexture(texFrom); gl.deleteTexture(texTo); gl.deleteBuffer(quadBuf);
          for (const k in programs) gl.deleteProgram(programs[k].program);
        } catch (e) { /* context already gone */ }
        programs = {};
      },
    };
  }

  return { createRenderer, compile };
});
