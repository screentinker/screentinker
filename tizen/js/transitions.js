// GL Transitions v1 param parser — ByteTinker, MIT
//
// Single source of truth for shader parameters. The `.glsl` files declare their own
// params using the GL Transitions comment convention, extended with an optional range:
//
//     uniform float bounce; // = 0.5 [0.0..1.5]
//
// This parser is consumed by:
//   - the web player renderer   (uniform defaults + values from snapshot config)
//   - the Tizen player renderer (same)
//   - the dashboard picker      (slider min/max/default/step)
//
// There is deliberately no separate param schema. If you find yourself adding one,
// the shader and the UI have already drifted.

const PARAM_RE =
  /uniform\s+float\s+(\w+)\s*;\s*\/\/\s*=\s*(-?[\d.]+)\s*(?:\[\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*\])?/g;

/**
 * Parse param declarations out of a GLSL source string.
 * @param {string} src
 * @returns {Array<{name:string, default:number, min:number, max:number, step:number}>}
 */
function parseParams(src) {
  const out = [];
  let m;
  PARAM_RE.lastIndex = 0;
  while ((m = PARAM_RE.exec(src))) {
    const def = parseFloat(m[2]);
    const min = m[3] !== undefined ? parseFloat(m[3]) : Math.min(0, def);
    const max = m[4] !== undefined ? parseFloat(m[4]) : (def === 0 ? 1 : def * 2);
    out.push({ name: m[1], default: def, min, max, step: (max - min) / 200 });
  }
  return out;
}

/**
 * Merge stored values over defaults, dropping unknown keys and clamping to range.
 * Never trust the snapshot blob — a shader may have been edited since the playlist
 * was configured, and an out-of-range uniform can produce a black frame.
 * @param {Array} params result of parseParams
 * @param {Object} stored values from snapshot.transition.params
 */
function resolveParams(params, stored) {
  const out = {};
  for (const p of params) {
    const v = stored && typeof stored[p.name] === 'number' ? stored[p.name] : p.default;
    out[p.name] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

// The renderer wraps each .glsl with this. Keep it identical across web, Tizen, and
// Android — the shader sources assume exactly these names and nothing else.
const PREAMBLE = `precision highp float;
varying vec2 vUv;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float progress;
uniform float ratio;
vec4 getFromColor(vec2 uv){ return texture2D(uFrom, uv); }
vec4 getToColor(vec2 uv){ return texture2D(uTo, uv); }
`;

const EPILOGUE = `
void main(){ gl_FragColor = transition(vUv); }`;

const VERTEX = `attribute vec2 aPos;
varying vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseParams, resolveParams, PREAMBLE, EPILOGUE, VERTEX };
} else if (typeof self !== 'undefined') {
  self.TransitionParams = { parseParams, resolveParams, PREAMBLE, EPILOGUE, VERTEX }; // browser (player/demo)
}

;
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

;
window.__TRANSITION_SHADERS={"CRTCollapse":"// CRT Collapse\n// blurb: Frame crushes to a line, then a dot, then the next image blooms back out. Power-cycle drama.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float lineHold; // = 0.16 [0.0..0.45]\nuniform float flashGain;// = 1.6 [0.0..4.0]\nuniform float bloom;    // = 14.0 [4.0..40.0]\n\nvec4 transition(vec2 uv){\n  vec2 c = uv - 0.5;\n  float half_ = 0.5 * lineHold + 0.5;   // unused shaping guard\n  float pa = clamp(progress / 0.45, 0.0, 1.0);\n  float pb = clamp((progress - 0.55) / 0.45, 0.0, 1.0);\n\n  float vs  = 1.0 - smoothstep(0.0, 0.70, pa);\n  float hs  = 1.0 - smoothstep(0.62, 1.0, pa);\n  float vs2 = smoothstep(0.0, 0.38, pb);\n  float hs2 = smoothstep(0.30, 1.0, pb);\n\n  vec3 col = vec3(0.0);\n  if(progress < 0.5){\n    if(abs(c.y) < vs * 0.5 + 0.0016 && abs(c.x) < hs * 0.5 + 0.0016){\n      vec2 s = vec2(c.x / max(hs, 0.003), c.y / max(vs, 0.003)) + 0.5;\n      col = getFromColor(clamp(s, 0.0, 1.0)).rgb;\n    }\n  } else {\n    if(abs(c.y) < vs2 * 0.5 + 0.0016 && abs(c.x) < hs2 * 0.5 + 0.0016){\n      vec2 s = vec2(c.x / max(hs2, 0.003), c.y / max(vs2, 0.003)) + 0.5;\n      col = getToColor(clamp(s, 0.0, 1.0)).rgb;\n    }\n  }\n\n  float d = length(vec2(c.x * ratio, c.y));\n  float flash = exp(-pow(abs(progress - 0.5) * 8.0, 2.0));\n  col += vec3(1.0, 0.96, 0.88) * flash * exp(-d * bloom) * flashGain;\n  return vec4(col, 1.0);\n}\n","Datamosh":"// Datamosh\n// blurb: P-frame corruption — the old frame’s gradients smear the new one until the blocks give up.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float blockSize; // = 30.0 [6.0..90.0]\nuniform float bleed;     // = 0.45 [0.0..1.5]\nuniform float chroma;    // = 0.5 [0.0..2.0]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float env = sin(3.14159265 * progress);\n  vec2 bs = vec2(blockSize * ratio, blockSize);\n  vec2 blk = floor(uv * bs);\n\n  vec3 c0 = getFromColor((blk + 0.5) / bs).rgb;\n  vec3 c1 = getFromColor((blk + vec2(1.5, 0.5)) / bs).rgb;\n  vec3 c2 = getFromColor((blk + vec2(0.5, 1.5)) / bs).rgb;\n  vec2 mv = vec2(dot(c1 - c0, vec3(0.333)), dot(c2 - c0, vec3(0.333)));\n  mv *= bleed * env * 5.0;\n\n  float keep = step(progress, bt_hash(blk) * 0.85 + 0.10);\n\n  vec3 A = getFromColor(fract(uv + mv)).rgb;\n  vec2 ub = fract(uv + mv * 0.5);\n  vec3 B;\n  float ch = chroma * env * 0.01;\n  B.r = getToColor(fract(ub + vec2(ch, 0.0))).r;\n  B.g = getToColor(ub).g;\n  B.b = getToColor(fract(ub - vec2(ch, 0.0))).b;\n\n  vec3 res = mix(B, A, keep);\n  float q = mix(255.0, 10.0, env);\n  res = floor(res * q) / q;\n  return vec4(res, 1.0);\n}\n","Etch":"// Etch\n// blurb: Photomask reveal — the frame develops in on a stepper field, with a hot exposure edge.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float cellSize;  // = 26.0 [6.0..90.0]\nuniform float edgeGlow;  // = 1.0 [0.0..3.0]\nuniform float randomness;// = 0.55 [0.0..1.0]\nuniform float softness;  // = 0.09 [0.005..0.3]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  vec2 g = floor(uv * vec2(cellSize * ratio, cellSize));\n  float m = bt_hash(g);\n  float sweep = (uv.x + uv.y) * 0.5;\n  float mask = clamp(mix(sweep, m, randomness), 0.0, 1.0);\n\n  float e = softness;\n  float pp = progress * (1.0 + e);\n  float t = smoothstep(mask, mask + e, pp);\n\n  vec3 a = getFromColor(uv).rgb;\n  vec3 b = getToColor(uv).rgb;\n  vec3 res = mix(a, b, t);\n\n  float edge = exp(-abs(pp - mask) / max(e, 0.005) * 1.6);\n  edge *= (1.0 - smoothstep(0.92, 1.0, progress)) * smoothstep(0.0, 0.05, progress);\n  res += vec3(1.0, 0.70, 0.22) * edge * edgeGlow * 0.7;\n\n  return vec4(res, 1.0);\n}\n","FiberSplice":"// Fiber Splice\n// blurb: Two ends draw apart, the arc fires, and the new frame fuses in from the seam.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float separation; // = 0.30 [0.0..0.5]\nuniform float arcGain;    // = 1.8 [0.0..4.0]\nuniform float arcTight;   // = 26.0 [4.0..80.0]\nuniform float flicker;    // = 0.5 [0.0..1.0]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float x = uv.x;\n  float ph = clamp(progress / 0.46, 0.0, 1.0);\n  float pb = clamp((progress - 0.54) / 0.46, 0.0, 1.0);\n\n  vec3 col = vec3(0.0);\n  if(progress < 0.5){\n    float off = ph * separation;\n    if(x < 0.5 - off)       col = getFromColor(vec2(x + off, uv.y)).rgb;\n    else if(x >= 0.5 + off) col = getFromColor(vec2(x - off, uv.y)).rgb;\n  } else {\n    float off = (1.0 - pb) * separation;\n    if(x < 0.5 - off)       col = getToColor(vec2(x + off, uv.y)).rgb;\n    else if(x >= 0.5 + off) col = getToColor(vec2(x - off, uv.y)).rgb;\n  }\n\n  float fl = 1.0 + flicker * (bt_hash(vec2(floor(uv.y * 90.0), floor(progress * 120.0))) - 0.5);\n  float arc = exp(-abs(x - 0.5) * arcTight) * exp(-pow((progress - 0.5) * 8.5, 2.0)) * fl;\n  col += vec3(0.72, 0.88, 1.0) * arc * arcGain;\n  col += vec3(1.0) * arc * arc * 0.6;\n\n  return vec4(col, 1.0);\n}\n","FilmAdvance":"// Film Advance\n// blurb: The strip pulls through the gate — frame bar and sprockets sweep past, shutter flickers, next frame registers with a bounce.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float frameBar;  // = 0.11 [0.02..0.35]\nuniform float bounce;    // = 0.5 [0.0..1.5]\nuniform float shutter;   // = 0.55 [0.0..1.0]\nuniform float sprockets; // = 1.0 [0.0..1.0]\nuniform float grainAmt;  // = 0.5 [0.0..1.0]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float e = progress;\n  float env = sin(3.14159265 * e);\n\n  // pull with a little registration overshoot at the gate\n  float ease = smoothstep(0.0, 1.0, e);\n  ease += bounce * 0.045 * sin(e * 18.85) * e * (1.0 - e) * 4.0;\n  ease = clamp(ease, 0.0, 1.0);\n\n  float o = ease * (1.0 + frameBar);\n  float t = uv.y - o;\n\n  vec3 col;\n  if(t >= 0.0){\n    col = getFromColor(vec2(uv.x, min(t, 1.0))).rgb;\n  } else if(t <= -frameBar){\n    col = getToColor(vec2(uv.x, clamp(t + 1.0 + frameBar, 0.0, 1.0))).rgb;\n  } else {\n    float scr = bt_hash(vec2(floor(uv.x * 400.0), floor(e * 12.0)));\n    col = vec3(0.035, 0.028, 0.022) + vec3(0.10, 0.08, 0.06) * step(0.985, scr);\n  }\n\n  // edge perforations, present only while the strip is moving\n  float edge = min(uv.x, 1.0 - uv.x);\n  float band = 1.0 - smoothstep(0.030, 0.038, edge);\n  float sy = fract((uv.y - o) * (1.0 / (1.0 + frameBar)) * 4.0);\n  float holeY = 1.0 - smoothstep(0.26, 0.34, abs(sy - 0.5));\n  float holeX = 1.0 - smoothstep(0.008, 0.014, abs(edge - 0.019));\n  float perf = holeY * step(0.006, edge) * (1.0 - holeX * 0.0);\n  vec3 strip = mix(vec3(0.02), vec3(0.86, 0.83, 0.75), perf);\n  col = mix(col, strip, band * env * sprockets);\n\n  // shutter blade\n  float blade = 1.0 - shutter * env * (0.75 + 0.25 * sin(e * 62.8));\n  col *= blade;\n\n  // gate grain\n  float g = bt_hash(uv * vec2(720.0, 405.0) + floor(e * 48.0)) - 0.5;\n  col += vec3(g) * grainAmt * env * 0.20;\n\n  return vec4(col, 1.0);\n}\n","PacketLoss":"// Packet Loss\n// blurb: Blocks drop out of the stream, rows tear, and the new frame retransmits block by block.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float cols;     // = 26.0 [4.0..80.0]\nuniform float rows;     // = 15.0 [3.0..48.0]\nuniform float rowTear;  // = 0.06 [0.0..0.3]\nuniform float garbage;  // = 0.5 [0.0..1.0]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float env = sin(3.14159265 * progress);\n  vec2 bs = vec2(cols, rows);\n\n  float rowId = floor(uv.y * rows);\n  float tear = (bt_hash(vec2(rowId, floor(progress * 24.0))) - 0.5) * rowTear * env;\n  vec2 uvt = vec2(fract(uv.x + tear), uv.y);\n\n  vec2 blk = floor(uvt * bs);\n  float dropT = 0.05 + bt_hash(blk) * 0.40;\n  float backT = 0.55 + bt_hash(blk + 11.3) * 0.40;\n\n  float gone = step(dropT, progress);\n  float back = step(backT, progress);\n\n  vec3 a = getFromColor(uvt).rgb;\n  vec3 b = getToColor(uvt).rgb;\n\n  vec3 junk = getFromColor(fract(uvt + vec2(bt_hash(blk + 3.1) * 0.5, bt_hash(blk + 5.7) * 0.5))).rgb;\n  junk = junk.gbr * (0.4 + bt_hash(blk + 9.0) * 0.6);\n  vec3 hole = mix(vec3(0.0), junk, garbage * step(0.55, bt_hash(blk + 2.2)));\n\n  vec3 col = mix(a, hole, gone * (1.0 - back));\n  col = mix(col, b, back);\n  return vec4(col, 1.0);\n}\n","PixelSort":"// Pixel Sort\n// blurb: Columns tear and quantize like glitch art, then resolve on a staggered per-column threshold.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float columns;  // = 200.0 [20.0..600.0]\nuniform float strength; // = 0.45 [0.0..1.0]\nuniform float split;    // = 0.012 [0.0..0.06]\nuniform float density;  // = 0.35 [0.0..0.9]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float env = sin(3.14159265 * progress);\n  float col = floor(uv.x * columns);\n  float seed = bt_hash(vec2(col, 3.0));\n  float active = step(density, seed);\n\n  float amt = env * strength * (seed * 2.0 - 1.0) * active;\n  vec3 a = getFromColor(vec2(uv.x, fract(uv.y + amt))).rgb;\n\n  float s = split * env * active;\n  vec2 ub = vec2(uv.x, fract(uv.y - amt));\n  vec3 b;\n  b.r = getToColor(vec2(fract(ub.x + s), ub.y)).r;\n  b.g = getToColor(ub).g;\n  b.b = getToColor(vec2(fract(ub.x - s), ub.y)).b;\n\n  float q = mix(255.0, 6.0, env);\n  a = floor(a * q) / q;\n  b = floor(b * q) / q;\n\n  float t = smoothstep(seed * 0.5, seed * 0.5 + 0.5, progress);\n  return vec4(mix(a, b, t), 1.0);\n}\n","QuantumDither":"// Quantum Dither\n// blurb: Pixels stay undecided, shimmering between both frames, then collapse on an ordered threshold.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float grain;     // = 180.0 [20.0..600.0]\nuniform float coherence; // = 0.6 [0.0..1.0]\nuniform float shimmer;   // = 0.5 [0.0..1.0]\nuniform float edgeSoft;  // = 0.10 [0.01..0.4]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\nfloat bt_bayer2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }\nfloat bt_bayer4(vec2 a){ return (bt_bayer2(a * 0.5) * 0.25 + bt_bayer2(a)) / 0.9375; }\n\nvec4 transition(vec2 uv){\n  vec2 g = floor(uv * vec2(grain * ratio, grain));\n  float n  = bt_hash(g);\n  float bo = bt_bayer4(g);\n  float thr = mix(n, bo, coherence);\n\n  float w = edgeSoft;\n  float front = abs(progress - thr);\n  float undecided = exp(-front / max(w, 0.01) * 1.4);\n  thr += (bt_hash(g + floor(progress * 45.0) * 17.0) - 0.5) * shimmer * undecided * 0.5;\n\n  float t = smoothstep(thr - w, thr + w, progress * (1.0 + 2.0 * w) - w);\n\n  vec3 a = getFromColor(uv).rgb;\n  vec3 b = getToColor(uv).rgb;\n  vec3 col = mix(a, b, t);\n  col += vec3(0.18, 0.55, 0.62) * undecided * shimmer * 0.5;\n  return vec4(col, 1.0);\n}\n","ReelChange":"// Reel Change\n// blurb: Cue mark burns in the corner, the splice jumps the frame, dust settles on the new reel.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float cueSize;  // = 0.045 [0.0..0.12]\nuniform float jumpAmt;  // = 0.16 [0.0..0.5]\nuniform float dust;     // = 0.6 [0.0..1.0]\nuniform float scratch;  // = 0.5 [0.0..1.0]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float e = progress;\n  float splice = clamp((e - 0.46) / 0.16, 0.0, 1.0);\n  float active = step(0.46, e) * step(e, 0.62);\n\n  // stepped misregistration through the splice\n  float k = floor(splice * 4.0);\n  float off = (bt_hash(vec2(k, 2.0)) - 0.5) * jumpAmt * (1.0 - splice) * active;\n\n  vec2 su = vec2(uv.x, fract(uv.y + off));\n  vec3 a = getFromColor(su).rgb;\n  vec3 b = getToColor(su).rgb;\n  vec3 col = mix(a, b, step(0.54, e));\n\n  // black frame bar riding through during the splice\n  float barY = fract(uv.y + off * 3.0 + k * 0.37);\n  float bar = (1.0 - smoothstep(0.0, 0.045, abs(barY - 0.5))) * active;\n  col = mix(col, vec3(0.02), bar);\n\n  // cue mark, upper right, four-frame flicker\n  vec2 cp = (uv - vec2(0.865, 0.855)) * vec2(ratio, 1.0);\n  float ring = 1.0 - smoothstep(cueSize * 0.72, cueSize, length(cp));\n  float cueWin = step(0.20, e) * step(e, 0.47);\n  float flick = 0.55 + 0.45 * step(0.5, fract(e * 26.0));\n  col += vec3(1.0, 0.94, 0.80) * ring * cueWin * flick * 0.85;\n\n  // dust and scratches, decaying after the change\n  float decay = exp(-max(e - 0.54, 0.0) * 9.0) * step(0.46, e);\n  float sp = bt_hash(uv * vec2(300.0, 170.0) + floor(e * 40.0));\n  col += vec3(0.9) * step(0.9975, sp) * dust * decay;\n  float sc = bt_hash(vec2(floor(uv.x * 260.0), floor(e * 20.0)));\n  col += vec3(0.85, 0.82, 0.74) * step(0.995, sc) * scratch * decay * 0.7;\n\n  return vec4(col, 1.0);\n}\n","SignalLock":"// Signal Lock\n// blurb: Static, rolling sync bars, then the picture snaps in like a tuner acquiring.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float noiseAmount; // = 0.85 [0.0..1.0]\nuniform float rollSpeed;   // = 2.4 [0.0..8.0]\nuniform float barCount;    // = 3.0 [0.0..8.0]\nuniform float tearAmount;  // = 0.12 [0.0..0.5]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float env = sin(3.14159265 * progress);          // 0 at both ends\n  float settle = 1.0 - smoothstep(0.55, 1.0, progress);\n\n  vec2 uvr = uv;\n  uvr.y = fract(uv.y + settle * progress * rollSpeed);\n  float line = floor(uv.y * 240.0);\n  float tear = (bt_hash(vec2(line, floor(progress * 30.0))) - 0.5) * tearAmount * env;\n  uvr.x = fract(uv.x + tear);\n\n  vec4 a = getFromColor(uv);\n  vec4 b = getToColor(uvr);\n  float sig = smoothstep(0.42, 0.58, progress);\n  vec4 img = mix(a, b, sig);\n\n  float bp = fract(uv.y + progress * barCount);\n  float bar = smoothstep(0.0, 0.05, bp) * (1.0 - smoothstep(0.05, 0.11, bp));\n  img.rgb += bar * 0.40 * env;\n\n  float st = bt_hash(uv * vec2(640.0, 360.0) + floor(progress * 60.0));\n  img.rgb = mix(img.rgb, vec3(st), pow(env, 0.55) * noiseAmount * 0.7);\n\n  return vec4(img.rgb, 1.0);\n}\n","SpectrumSweep":"// Spectrum Sweep\n// blurb: An analyzer band crosses the frame, drawing the incoming image as bars before it resolves.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float bandWidth; // = 0.22 [0.05..0.6]\nuniform float barCount;  // = 64.0 [8.0..200.0]\nuniform float glow;      // = 1.2 [0.0..3.0]\nuniform float floorLift; // = 0.12 [0.0..0.5]\n\nvec4 transition(vec2 uv){\n  float front = progress * (1.0 + bandWidth) - bandWidth;\n  vec3 a = getFromColor(uv).rgb;\n  vec3 b = getToColor(uv).rgb;\n\n  if(uv.x < front)               return vec4(b, 1.0);\n  if(uv.x > front + bandWidth)   return vec4(a, 1.0);\n\n  float k = (uv.x - front) / bandWidth;          // 0 at trailing edge, 1 at leading\n  float bx = (floor(uv.x * barCount) + 0.5) / barCount;\n\n  vec3 s = b;\n  float lum = dot(getToColor(vec2(bx, uv.y)).rgb, vec3(0.299, 0.587, 0.114));\n  float h = clamp(lum + floorLift, 0.0, 1.0);\n\n  float bar = step(uv.y, h) * (0.35 + 0.65 * step(h - 0.02, uv.y));\n  float gap = smoothstep(0.0, 0.06, fract(uv.x * barCount)) * (1.0 - smoothstep(0.94, 1.0, fract(uv.x * barCount)));\n  vec3 analyzer = vec3(0.25, 1.0, 0.72) * bar * gap;\n\n  vec3 col = mix(s, analyzer, smoothstep(0.15, 0.85, k));\n  col = mix(col, a, smoothstep(0.75, 1.0, k));\n  col += vec3(0.4, 1.0, 0.8) * exp(-abs(k - 1.0) * 22.0) * glow;\n  return vec4(col, 1.0);\n}\n","ThermalBloom":"// Thermal Bloom\n// blurb: The frame falls into false colour, blooms hot, and the next image cools back out of it.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float heat;   // = 1.0 [0.0..1.0]\nuniform float blur;   // = 0.010 [0.0..0.05]\nuniform float gain;   // = 0.35 [0.0..1.2]\n\nvec3 bt_iron(float t){\n  t = clamp(t, 0.0, 1.0);\n  return clamp(vec3(\n    smoothstep(0.05, 0.55, t) * 1.15,\n    smoothstep(0.40, 0.98, t),\n    smoothstep(0.0, 0.22, t) * 0.62 - smoothstep(0.22, 0.62, t) * 0.60 + smoothstep(0.78, 1.0, t)\n  ), 0.0, 1.0);\n}\n\nvec4 transition(vec2 uv){\n  float env = sin(3.14159265 * progress);\n  float t = smoothstep(0.34, 0.66, progress);\n\n  float r = blur * env;\n  vec3 a = vec3(0.0), b = vec3(0.0);\n  for(int i = 0; i < 5; i++){\n    float f = (float(i) - 2.0) * 0.5;\n    a += getFromColor(clamp(uv + vec2(f * r * ratio, f * r), 0.0, 1.0)).rgb;\n    b += getToColor(clamp(uv + vec2(f * r * ratio, -f * r), 0.0, 1.0)).rgb;\n  }\n  a /= 5.0; b /= 5.0;\n\n  vec3 real = mix(a, b, t);\n  float lum = dot(real, vec3(0.299, 0.587, 0.114));\n  vec3 thermal = bt_iron(lum + env * gain);\n\n  vec3 col = mix(real, thermal, env * heat);\n  return vec4(col, 1.0);\n}\n","TraceRoute":"// Trace Route\n// blurb: Copper traces route across the board and the new frame fills in behind them.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float pitch;    // = 30.0 [6.0..90.0]\nuniform float wander;   // = 0.45 [0.0..1.0]\nuniform float traceGlow;// = 1.4 [0.0..3.0]\nuniform float traceW;   // = 0.10 [0.02..0.35]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  vec2 gv = vec2(pitch * ratio, pitch);\n  vec2 cell = floor(uv * gv);\n  vec2 f = fract(uv * gv);\n\n  float march = (cell.x / gv.x) * 0.65 + abs(cell.y / gv.y - 0.5) * 0.35;\n  float d = clamp(mix(march, bt_hash(cell), wander), 0.0, 0.92);\n\n  float e = 0.07;\n  float pp = progress * (1.0 + e);\n  float fill = smoothstep(d, d + e, pp);\n\n  vec3 a = getFromColor(uv).rgb;\n  vec3 b = getToColor(uv).rgb;\n  vec3 col = mix(a, b, fill);\n\n  float horiz = step(0.5, bt_hash(cell + 4.7));\n  float line = mix(\n    1.0 - smoothstep(0.0, traceW, abs(f.x - 0.5)),\n    1.0 - smoothstep(0.0, traceW, abs(f.y - 0.5)),\n    horiz);\n  float pad = 1.0 - smoothstep(0.0, traceW * 1.6, length(f - 0.5));\n  float front = exp(-abs(pp - d) / max(e, 0.005) * 1.5);\n  front *= smoothstep(0.0, 0.05, progress) * (1.0 - smoothstep(0.92, 1.0, progress));\n\n  col += vec3(1.0, 0.58, 0.20) * max(line, pad) * front * traceGlow;\n  return vec4(col, 1.0);\n}\n","VanEck":"// Van Eck\n// blurb: The next frame reconstructs from raster noise, scanline by scanline, behind an acquisition beam.\n// Author: Dan (ByteTinker)\n// License: MIT\n// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.\nuniform float lineCount; // = 300.0 [60.0..720.0]\nuniform float smear;     // = 0.07 [0.0..0.3]\nuniform float jitter;    // = 0.35 [0.0..1.0]\nuniform float phosphor;  // = 1.0 [0.0..1.0]\n\nfloat bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n\nvec4 transition(vec2 uv){\n  float gate = smoothstep(0.0, 0.04, progress);\n  float line = floor(uv.y * lineCount);\n  float ly   = line / lineCount;\n\n  float j = bt_hash(vec2(line, 7.0)) * jitter;\n  float thresh = clamp(ly * (1.0 - jitter) + j, 0.0, 0.8);\n  float acq = smoothstep(thresh, thresh + 0.18, progress);\n\n  vec3 b = vec3(0.0);\n  float sm = smear * (1.0 - acq);\n  for(int i = 0; i < 6; i++){\n    float f = float(i) / 5.0;\n    b += getToColor(vec2(fract(uv.x + f * sm), uv.y)).rgb;\n  }\n  b /= 6.0;\n\n  float lum = dot(b, vec3(0.299, 0.587, 0.114));\n  vec3 phos = vec3(lum) * mix(vec3(1.0), vec3(1.0, 0.72, 0.25), phosphor);\n  b = mix(phos, b, acq);\n\n  float n = bt_hash(uv * vec2(900.0, 500.0) + floor(progress * 90.0));\n  b = mix(b, vec3(n) * mix(vec3(1.0), vec3(1.0, 0.72, 0.25), phosphor), (1.0 - acq) * 0.55);\n\n  vec3 a = getFromColor(uv).rgb;\n  float wipe = smoothstep(thresh - 0.25, thresh, progress) * gate;\n  vec3 res = mix(a, b, wipe);\n\n  float beam = exp(-abs(progress - thresh) * 55.0) * gate;\n  res += beam * vec3(1.0, 0.78, 0.34) * 0.55;\n\n  res = mix(res, getToColor(uv).rgb, smoothstep(0.96, 1.0, progress));\n  return vec4(res, 1.0);\n}\n"};
window.__TRANSITION_MANIFEST=[{"id":"CRTCollapse","name":"CRT Collapse","blurb":"Frame crushes to a line, then a dot, then the next image blooms back out. Power-cycle drama.","file":"CRTCollapse.glsl","params":[{"name":"lineHold","default":0.16,"min":0,"max":0.45},{"name":"flashGain","default":1.6,"min":0,"max":4},{"name":"bloom","default":14,"min":4,"max":40}]},{"id":"Datamosh","name":"Datamosh","blurb":"P-frame corruption — the old frame’s gradients smear the new one until the blocks give up.","file":"Datamosh.glsl","params":[{"name":"blockSize","default":30,"min":6,"max":90},{"name":"bleed","default":0.45,"min":0,"max":1.5},{"name":"chroma","default":0.5,"min":0,"max":2}]},{"id":"Etch","name":"Etch","blurb":"Photomask reveal — the frame develops in on a stepper field, with a hot exposure edge.","file":"Etch.glsl","params":[{"name":"cellSize","default":26,"min":6,"max":90},{"name":"edgeGlow","default":1,"min":0,"max":3},{"name":"randomness","default":0.55,"min":0,"max":1},{"name":"softness","default":0.09,"min":0.005,"max":0.3}]},{"id":"FiberSplice","name":"Fiber Splice","blurb":"Two ends draw apart, the arc fires, and the new frame fuses in from the seam.","file":"FiberSplice.glsl","params":[{"name":"separation","default":0.3,"min":0,"max":0.5},{"name":"arcGain","default":1.8,"min":0,"max":4},{"name":"arcTight","default":26,"min":4,"max":80},{"name":"flicker","default":0.5,"min":0,"max":1}]},{"id":"FilmAdvance","name":"Film Advance","blurb":"The strip pulls through the gate — frame bar and sprockets sweep past, shutter flickers, next frame registers with a bounce.","file":"FilmAdvance.glsl","params":[{"name":"frameBar","default":0.11,"min":0.02,"max":0.35},{"name":"bounce","default":0.5,"min":0,"max":1.5},{"name":"shutter","default":0.55,"min":0,"max":1},{"name":"sprockets","default":1,"min":0,"max":1},{"name":"grainAmt","default":0.5,"min":0,"max":1}]},{"id":"PacketLoss","name":"Packet Loss","blurb":"Blocks drop out of the stream, rows tear, and the new frame retransmits block by block.","file":"PacketLoss.glsl","params":[{"name":"cols","default":26,"min":4,"max":80},{"name":"rows","default":15,"min":3,"max":48},{"name":"rowTear","default":0.06,"min":0,"max":0.3},{"name":"garbage","default":0.5,"min":0,"max":1}]},{"id":"PixelSort","name":"Pixel Sort","blurb":"Columns tear and quantize like glitch art, then resolve on a staggered per-column threshold.","file":"PixelSort.glsl","params":[{"name":"columns","default":200,"min":20,"max":600},{"name":"strength","default":0.45,"min":0,"max":1},{"name":"split","default":0.012,"min":0,"max":0.06},{"name":"density","default":0.35,"min":0,"max":0.9}]},{"id":"QuantumDither","name":"Quantum Dither","blurb":"Pixels stay undecided, shimmering between both frames, then collapse on an ordered threshold.","file":"QuantumDither.glsl","params":[{"name":"grain","default":180,"min":20,"max":600},{"name":"coherence","default":0.6,"min":0,"max":1},{"name":"shimmer","default":0.5,"min":0,"max":1},{"name":"edgeSoft","default":0.1,"min":0.01,"max":0.4}]},{"id":"ReelChange","name":"Reel Change","blurb":"Cue mark burns in the corner, the splice jumps the frame, dust settles on the new reel.","file":"ReelChange.glsl","params":[{"name":"cueSize","default":0.045,"min":0,"max":0.12},{"name":"jumpAmt","default":0.16,"min":0,"max":0.5},{"name":"dust","default":0.6,"min":0,"max":1},{"name":"scratch","default":0.5,"min":0,"max":1}]},{"id":"SignalLock","name":"Signal Lock","blurb":"Static, rolling sync bars, then the picture snaps in like a tuner acquiring.","file":"SignalLock.glsl","params":[{"name":"noiseAmount","default":0.85,"min":0,"max":1},{"name":"rollSpeed","default":2.4,"min":0,"max":8},{"name":"barCount","default":3,"min":0,"max":8},{"name":"tearAmount","default":0.12,"min":0,"max":0.5}]},{"id":"SpectrumSweep","name":"Spectrum Sweep","blurb":"An analyzer band crosses the frame, drawing the incoming image as bars before it resolves.","file":"SpectrumSweep.glsl","params":[{"name":"bandWidth","default":0.22,"min":0.05,"max":0.6},{"name":"barCount","default":64,"min":8,"max":200},{"name":"glow","default":1.2,"min":0,"max":3},{"name":"floorLift","default":0.12,"min":0,"max":0.5}]},{"id":"ThermalBloom","name":"Thermal Bloom","blurb":"The frame falls into false colour, blooms hot, and the next image cools back out of it.","file":"ThermalBloom.glsl","params":[{"name":"heat","default":1,"min":0,"max":1},{"name":"blur","default":0.01,"min":0,"max":0.05},{"name":"gain","default":0.35,"min":0,"max":1.2}]},{"id":"TraceRoute","name":"Trace Route","blurb":"Copper traces route across the board and the new frame fills in behind them.","file":"TraceRoute.glsl","params":[{"name":"pitch","default":30,"min":6,"max":90},{"name":"wander","default":0.45,"min":0,"max":1},{"name":"traceGlow","default":1.4,"min":0,"max":3},{"name":"traceW","default":0.1,"min":0.02,"max":0.35}]},{"id":"VanEck","name":"Van Eck","blurb":"The next frame reconstructs from raster noise, scanline by scanline, behind an acquisition beam.","file":"VanEck.glsl","params":[{"name":"lineCount","default":300,"min":60,"max":720},{"name":"smear","default":0.07,"min":0,"max":0.3},{"name":"jitter","default":0.35,"min":0,"max":1},{"name":"phosphor","default":1,"min":0,"max":1}]}];
