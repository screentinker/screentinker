// Pixel Sort
// blurb: Columns tear and quantize like glitch art, then resolve on a staggered per-column threshold.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float columns;  // = 200.0 [20.0..600.0]
uniform float strength; // = 0.45 [0.0..1.0]
uniform float split;    // = 0.012 [0.0..0.06]
uniform float density;  // = 0.35 [0.0..0.9]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float env = sin(3.14159265 * progress);
  float col = floor(uv.x * columns);
  float seed = bt_hash(vec2(col, 3.0));
  float active = step(density, seed);

  float amt = env * strength * (seed * 2.0 - 1.0) * active;
  vec3 a = getFromColor(vec2(uv.x, fract(uv.y + amt))).rgb;

  float s = split * env * active;
  vec2 ub = vec2(uv.x, fract(uv.y - amt));
  vec3 b;
  b.r = getToColor(vec2(fract(ub.x + s), ub.y)).r;
  b.g = getToColor(ub).g;
  b.b = getToColor(vec2(fract(ub.x - s), ub.y)).b;

  float q = mix(255.0, 6.0, env);
  a = floor(a * q) / q;
  b = floor(b * q) / q;

  float t = smoothstep(seed * 0.5, seed * 0.5 + 0.5, progress);
  return vec4(mix(a, b, t), 1.0);
}
