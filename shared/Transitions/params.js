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
const PREAMBLE = 'precision highp float;\n'
  + 'varying vec2 vUv;\n'
  + 'uniform sampler2D uFrom;\n'
  + 'uniform sampler2D uTo;\n'
  + 'uniform float progress;\n'
  + 'uniform float ratio;\n'
  + 'vec4 getFromColor(vec2 uv){ return texture2D(uFrom, uv); }\n'
  + 'vec4 getToColor(vec2 uv){ return texture2D(uTo, uv); }\n';

const EPILOGUE = '\nvoid main(){ gl_FragColor = transition(vUv); }';

const VERTEX = 'attribute vec2 aPos;\n'
  + 'varying vec2 vUv;\n'
  + 'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }';

// Export to BOTH, never either/or. A BrightSign roHtmlWidget is created with
// `nodejs_enabled: true`, which puts Node's `module` into the page's classic-script scope — so an
// `else` here means the browser branch never runs on that platform and `self.TransitionParams` is
// simply never set. The player's transitionRuntimeReady() is a presence check on exactly that
// global, so transitions were dark on every BrightSign, and the failure looked like a GPU problem
// rather than a module-format one. Anything a browser is meant to see must be assigned
// unconditionally.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseParams, resolveParams, PREAMBLE, EPILOGUE, VERTEX };
}
if (typeof self !== 'undefined') {
  self.TransitionParams = { parseParams, resolveParams, PREAMBLE, EPILOGUE, VERTEX }; // browser (player/demo)
}
