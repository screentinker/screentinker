// Etch
// blurb: Photomask reveal — the frame develops in on a stepper field, with a hot exposure edge.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float cellSize;  // = 26.0 [6.0..90.0]
uniform float edgeGlow;  // = 1.0 [0.0..3.0]
uniform float randomness;// = 0.55 [0.0..1.0]
uniform float softness;  // = 0.09 [0.005..0.3]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  vec2 g = floor(uv * vec2(cellSize * ratio, cellSize));
  float m = bt_hash(g);
  float sweep = (uv.x + uv.y) * 0.5;
  float mask = clamp(mix(sweep, m, randomness), 0.0, 1.0);

  float e = softness;
  float pp = progress * (1.0 + e);
  float t = smoothstep(mask, mask + e, pp);

  vec3 a = getFromColor(uv).rgb;
  vec3 b = getToColor(uv).rgb;
  vec3 res = mix(a, b, t);

  float edge = exp(-abs(pp - mask) / max(e, 0.005) * 1.6);
  edge *= (1.0 - smoothstep(0.92, 1.0, progress)) * smoothstep(0.0, 0.05, progress);
  res += vec3(1.0, 0.70, 0.22) * edge * edgeGlow * 0.7;

  return vec4(res, 1.0);
}
