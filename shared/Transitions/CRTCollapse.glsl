// CRT Collapse
// blurb: Frame crushes to a line, then a dot, then the next image blooms back out. Power-cycle drama.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float lineHold; // = 0.16 [0.0..0.45]
uniform float flashGain;// = 1.6 [0.0..4.0]
uniform float bloom;    // = 14.0 [4.0..40.0]

vec4 transition(vec2 uv){
  vec2 c = uv - 0.5;
  float half_ = 0.5 * lineHold + 0.5;   // unused shaping guard
  float pa = clamp(progress / 0.45, 0.0, 1.0);
  float pb = clamp((progress - 0.55) / 0.45, 0.0, 1.0);

  float vs  = 1.0 - smoothstep(0.0, 0.70, pa);
  float hs  = 1.0 - smoothstep(0.62, 1.0, pa);
  float vs2 = smoothstep(0.0, 0.38, pb);
  float hs2 = smoothstep(0.30, 1.0, pb);

  vec3 col = vec3(0.0);
  if(progress < 0.5){
    if(abs(c.y) < vs * 0.5 + 0.0016 && abs(c.x) < hs * 0.5 + 0.0016){
      vec2 s = vec2(c.x / max(hs, 0.003), c.y / max(vs, 0.003)) + 0.5;
      col = getFromColor(clamp(s, 0.0, 1.0)).rgb;
    }
  } else {
    if(abs(c.y) < vs2 * 0.5 + 0.0016 && abs(c.x) < hs2 * 0.5 + 0.0016){
      vec2 s = vec2(c.x / max(hs2, 0.003), c.y / max(vs2, 0.003)) + 0.5;
      col = getToColor(clamp(s, 0.0, 1.0)).rgb;
    }
  }

  float d = length(vec2(c.x * ratio, c.y));
  float flash = exp(-pow(abs(progress - 0.5) * 8.0, 2.0));
  col += vec3(1.0, 0.96, 0.88) * flash * exp(-d * bloom) * flashGain;
  return vec4(col, 1.0);
}
