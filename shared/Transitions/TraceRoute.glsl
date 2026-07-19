// Trace Route
// blurb: Copper traces route across the board and the new frame fills in behind them.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float pitch;    // = 30.0 [6.0..90.0]
uniform float wander;   // = 0.45 [0.0..1.0]
uniform float traceGlow;// = 1.4 [0.0..3.0]
uniform float traceW;   // = 0.10 [0.02..0.35]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  vec2 gv = vec2(pitch * ratio, pitch);
  vec2 cell = floor(uv * gv);
  vec2 f = fract(uv * gv);

  float march = (cell.x / gv.x) * 0.65 + abs(cell.y / gv.y - 0.5) * 0.35;
  float d = clamp(mix(march, bt_hash(cell), wander), 0.0, 0.92);

  float e = 0.07;
  float pp = progress * (1.0 + e);
  float fill = smoothstep(d, d + e, pp);

  vec3 a = getFromColor(uv).rgb;
  vec3 b = getToColor(uv).rgb;
  vec3 col = mix(a, b, fill);

  float horiz = step(0.5, bt_hash(cell + 4.7));
  float line = mix(
    1.0 - smoothstep(0.0, traceW, abs(f.x - 0.5)),
    1.0 - smoothstep(0.0, traceW, abs(f.y - 0.5)),
    horiz);
  float pad = 1.0 - smoothstep(0.0, traceW * 1.6, length(f - 0.5));
  float front = exp(-abs(pp - d) / max(e, 0.005) * 1.5);
  front *= smoothstep(0.0, 0.05, progress) * (1.0 - smoothstep(0.92, 1.0, progress));

  col += vec3(1.0, 0.58, 0.20) * max(line, pad) * front * traceGlow;
  return vec4(col, 1.0);
}
