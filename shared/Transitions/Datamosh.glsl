// Datamosh
// blurb: P-frame corruption — the old frame’s gradients smear the new one until the blocks give up.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float blockSize; // = 30.0 [6.0..90.0]
uniform float bleed;     // = 0.45 [0.0..1.5]
uniform float chroma;    // = 0.5 [0.0..2.0]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float env = sin(3.14159265 * progress);
  vec2 bs = vec2(blockSize * ratio, blockSize);
  vec2 blk = floor(uv * bs);

  vec3 c0 = getFromColor((blk + 0.5) / bs).rgb;
  vec3 c1 = getFromColor((blk + vec2(1.5, 0.5)) / bs).rgb;
  vec3 c2 = getFromColor((blk + vec2(0.5, 1.5)) / bs).rgb;
  vec2 mv = vec2(dot(c1 - c0, vec3(0.333)), dot(c2 - c0, vec3(0.333)));
  mv *= bleed * env * 5.0;

  float keep = step(progress, bt_hash(blk) * 0.85 + 0.10);

  vec3 A = getFromColor(fract(uv + mv)).rgb;
  vec2 ub = fract(uv + mv * 0.5);
  vec3 B;
  float ch = chroma * env * 0.01;
  B.r = getToColor(fract(ub + vec2(ch, 0.0))).r;
  B.g = getToColor(ub).g;
  B.b = getToColor(fract(ub - vec2(ch, 0.0))).b;

  vec3 res = mix(B, A, keep);
  float q = mix(255.0, 10.0, env);
  res = floor(res * q) / q;
  return vec4(res, 1.0);
}
