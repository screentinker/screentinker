// Van Eck
// blurb: The next frame reconstructs from raster noise, scanline by scanline, behind an acquisition beam.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float lineCount; // = 300.0 [60.0..720.0]
uniform float smear;     // = 0.07 [0.0..0.3]
uniform float jitter;    // = 0.35 [0.0..1.0]
uniform float phosphor;  // = 1.0 [0.0..1.0]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float gate = smoothstep(0.0, 0.04, progress);
  float line = floor(uv.y * lineCount);
  float ly   = line / lineCount;

  float j = bt_hash(vec2(line, 7.0)) * jitter;
  float thresh = clamp(ly * (1.0 - jitter) + j, 0.0, 0.8);
  float acq = smoothstep(thresh, thresh + 0.18, progress);

  vec3 b = vec3(0.0);
  float sm = smear * (1.0 - acq);
  for(int i = 0; i < 6; i++){
    float f = float(i) / 5.0;
    b += getToColor(vec2(fract(uv.x + f * sm), uv.y)).rgb;
  }
  b /= 6.0;

  float lum = dot(b, vec3(0.299, 0.587, 0.114));
  vec3 phos = vec3(lum) * mix(vec3(1.0), vec3(1.0, 0.72, 0.25), phosphor);
  b = mix(phos, b, acq);

  float n = bt_hash(uv * vec2(900.0, 500.0) + floor(progress * 90.0));
  b = mix(b, vec3(n) * mix(vec3(1.0), vec3(1.0, 0.72, 0.25), phosphor), (1.0 - acq) * 0.55);

  vec3 a = getFromColor(uv).rgb;
  float wipe = smoothstep(thresh - 0.25, thresh, progress) * gate;
  vec3 res = mix(a, b, wipe);

  float beam = exp(-abs(progress - thresh) * 55.0) * gate;
  res += beam * vec3(1.0, 0.78, 0.34) * 0.55;

  res = mix(res, getToColor(uv).rgb, smoothstep(0.96, 1.0, progress));
  return vec4(res, 1.0);
}
