// Thermal Bloom
// blurb: The frame falls into false colour, blooms hot, and the next image cools back out of it.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float heat;   // = 1.0 [0.0..1.0]
uniform float blur;   // = 0.010 [0.0..0.05]
uniform float gain;   // = 0.35 [0.0..1.2]

vec3 bt_iron(float t){
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(
    smoothstep(0.05, 0.55, t) * 1.15,
    smoothstep(0.40, 0.98, t),
    smoothstep(0.0, 0.22, t) * 0.62 - smoothstep(0.22, 0.62, t) * 0.60 + smoothstep(0.78, 1.0, t)
  ), 0.0, 1.0);
}

vec4 transition(vec2 uv){
  float env = sin(3.14159265 * progress);
  float t = smoothstep(0.34, 0.66, progress);

  float r = blur * env;
  vec3 a = vec3(0.0), b = vec3(0.0);
  for(int i = 0; i < 5; i++){
    float f = (float(i) - 2.0) * 0.5;
    a += getFromColor(clamp(uv + vec2(f * r * ratio, f * r), 0.0, 1.0)).rgb;
    b += getToColor(clamp(uv + vec2(f * r * ratio, -f * r), 0.0, 1.0)).rgb;
  }
  a /= 5.0; b /= 5.0;

  vec3 real = mix(a, b, t);
  float lum = dot(real, vec3(0.299, 0.587, 0.114));
  vec3 thermal = bt_iron(lum + env * gain);

  vec3 col = mix(real, thermal, env * heat);
  return vec4(col, 1.0);
}
