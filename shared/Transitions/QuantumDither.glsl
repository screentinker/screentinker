// Quantum Dither
// blurb: Pixels stay undecided, shimmering between both frames, then collapse on an ordered threshold.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float grain;     // = 180.0 [20.0..600.0]
uniform float coherence; // = 0.6 [0.0..1.0]
uniform float shimmer;   // = 0.5 [0.0..1.0]
uniform float edgeSoft;  // = 0.10 [0.01..0.4]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float bt_bayer2(vec2 a){ a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bt_bayer4(vec2 a){ return (bt_bayer2(a * 0.5) * 0.25 + bt_bayer2(a)) / 0.9375; }

vec4 transition(vec2 uv){
  vec2 g = floor(uv * vec2(grain * ratio, grain));
  float n  = bt_hash(g);
  float bo = bt_bayer4(g);
  float thr = mix(n, bo, coherence);

  float w = edgeSoft;
  float front = abs(progress - thr);
  float undecided = exp(-front / max(w, 0.01) * 1.4);
  thr += (bt_hash(g + floor(progress * 45.0) * 17.0) - 0.5) * shimmer * undecided * 0.5;

  float t = smoothstep(thr - w, thr + w, progress * (1.0 + 2.0 * w) - w);

  vec3 a = getFromColor(uv).rgb;
  vec3 b = getToColor(uv).rgb;
  vec3 col = mix(a, b, t);
  col += vec3(0.18, 0.55, 0.62) * undecided * shimmer * 0.5;
  return vec4(col, 1.0);
}
