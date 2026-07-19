// Film Advance
// blurb: The strip pulls through the gate — frame bar and sprockets sweep past, shutter flickers, next frame registers with a bounce.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float frameBar;  // = 0.11 [0.02..0.35]
uniform float bounce;    // = 0.5 [0.0..1.5]
uniform float shutter;   // = 0.55 [0.0..1.0]
uniform float sprockets; // = 1.0 [0.0..1.0]
uniform float grainAmt;  // = 0.5 [0.0..1.0]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float e = progress;
  float env = sin(3.14159265 * e);

  // pull with a little registration overshoot at the gate
  float ease = smoothstep(0.0, 1.0, e);
  ease += bounce * 0.045 * sin(e * 18.85) * e * (1.0 - e) * 4.0;
  ease = clamp(ease, 0.0, 1.0);

  float o = ease * (1.0 + frameBar);
  float t = uv.y - o;

  vec3 col;
  if(t >= 0.0){
    col = getFromColor(vec2(uv.x, min(t, 1.0))).rgb;
  } else if(t <= -frameBar){
    col = getToColor(vec2(uv.x, clamp(t + 1.0 + frameBar, 0.0, 1.0))).rgb;
  } else {
    float scr = bt_hash(vec2(floor(uv.x * 400.0), floor(e * 12.0)));
    col = vec3(0.035, 0.028, 0.022) + vec3(0.10, 0.08, 0.06) * step(0.985, scr);
  }

  // edge perforations, present only while the strip is moving
  float edge = min(uv.x, 1.0 - uv.x);
  float band = 1.0 - smoothstep(0.030, 0.038, edge);
  float sy = fract((uv.y - o) * (1.0 / (1.0 + frameBar)) * 4.0);
  float holeY = 1.0 - smoothstep(0.26, 0.34, abs(sy - 0.5));
  float holeX = 1.0 - smoothstep(0.008, 0.014, abs(edge - 0.019));
  float perf = holeY * step(0.006, edge) * (1.0 - holeX * 0.0);
  vec3 strip = mix(vec3(0.02), vec3(0.86, 0.83, 0.75), perf);
  col = mix(col, strip, band * env * sprockets);

  // shutter blade
  float blade = 1.0 - shutter * env * (0.75 + 0.25 * sin(e * 62.8));
  col *= blade;

  // gate grain
  float g = bt_hash(uv * vec2(720.0, 405.0) + floor(e * 48.0)) - 0.5;
  col += vec3(g) * grainAmt * env * 0.20;

  return vec4(col, 1.0);
}
