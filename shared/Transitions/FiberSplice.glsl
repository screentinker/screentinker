// Fiber Splice
// blurb: Two ends draw apart, the arc fires, and the new frame fuses in from the seam.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float separation; // = 0.30 [0.0..0.5]
uniform float arcGain;    // = 1.8 [0.0..4.0]
uniform float arcTight;   // = 26.0 [4.0..80.0]
uniform float flicker;    // = 0.5 [0.0..1.0]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float x = uv.x;
  float ph = clamp(progress / 0.46, 0.0, 1.0);
  float pb = clamp((progress - 0.54) / 0.46, 0.0, 1.0);

  vec3 col = vec3(0.0);
  if(progress < 0.5){
    float off = ph * separation;
    if(x < 0.5 - off)       col = getFromColor(vec2(x + off, uv.y)).rgb;
    else if(x >= 0.5 + off) col = getFromColor(vec2(x - off, uv.y)).rgb;
  } else {
    float off = (1.0 - pb) * separation;
    if(x < 0.5 - off)       col = getToColor(vec2(x + off, uv.y)).rgb;
    else if(x >= 0.5 + off) col = getToColor(vec2(x - off, uv.y)).rgb;
  }

  float fl = 1.0 + flicker * (bt_hash(vec2(floor(uv.y * 90.0), floor(progress * 120.0))) - 0.5);
  float arc = exp(-abs(x - 0.5) * arcTight) * exp(-pow((progress - 0.5) * 8.5, 2.0)) * fl;
  col += vec3(0.72, 0.88, 1.0) * arc * arcGain;
  col += vec3(1.0) * arc * arc * 0.6;

  return vec4(col, 1.0);
}
