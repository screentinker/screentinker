// Reel Change
// blurb: Cue mark burns in the corner, the splice jumps the frame, dust settles on the new reel.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float cueSize;  // = 0.045 [0.0..0.12]
uniform float jumpAmt;  // = 0.16 [0.0..0.5]
uniform float dust;     // = 0.6 [0.0..1.0]
uniform float scratch;  // = 0.5 [0.0..1.0]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float e = progress;
  float splice = clamp((e - 0.46) / 0.16, 0.0, 1.0);
  float active = step(0.46, e) * step(e, 0.62);

  // stepped misregistration through the splice
  float k = floor(splice * 4.0);
  float off = (bt_hash(vec2(k, 2.0)) - 0.5) * jumpAmt * (1.0 - splice) * active;

  vec2 su = vec2(uv.x, fract(uv.y + off));
  vec3 a = getFromColor(su).rgb;
  vec3 b = getToColor(su).rgb;
  vec3 col = mix(a, b, step(0.54, e));

  // black frame bar riding through during the splice
  float barY = fract(uv.y + off * 3.0 + k * 0.37);
  float bar = (1.0 - smoothstep(0.0, 0.045, abs(barY - 0.5))) * active;
  col = mix(col, vec3(0.02), bar);

  // cue mark, upper right, four-frame flicker
  vec2 cp = (uv - vec2(0.865, 0.855)) * vec2(ratio, 1.0);
  float ring = 1.0 - smoothstep(cueSize * 0.72, cueSize, length(cp));
  float cueWin = step(0.20, e) * step(e, 0.47);
  float flick = 0.55 + 0.45 * step(0.5, fract(e * 26.0));
  col += vec3(1.0, 0.94, 0.80) * ring * cueWin * flick * 0.85;

  // dust and scratches, decaying after the change
  float decay = exp(-max(e - 0.54, 0.0) * 9.0) * step(0.46, e);
  float sp = bt_hash(uv * vec2(300.0, 170.0) + floor(e * 40.0));
  col += vec3(0.9) * step(0.9975, sp) * dust * decay;
  float sc = bt_hash(vec2(floor(uv.x * 260.0), floor(e * 20.0)));
  col += vec3(0.85, 0.82, 0.74) * step(0.995, sc) * scratch * decay * 0.7;

  return vec4(col, 1.0);
}
