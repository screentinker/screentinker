// Spectrum Sweep
// blurb: An analyzer band crosses the frame, drawing the incoming image as bars before it resolves.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float bandWidth; // = 0.22 [0.05..0.6]
uniform float barCount;  // = 64.0 [8.0..200.0]
uniform float glow;      // = 1.2 [0.0..3.0]
uniform float floorLift; // = 0.12 [0.0..0.5]

vec4 transition(vec2 uv){
  float front = progress * (1.0 + bandWidth) - bandWidth;
  vec3 a = getFromColor(uv).rgb;
  vec3 b = getToColor(uv).rgb;

  if(uv.x < front)               return vec4(b, 1.0);
  if(uv.x > front + bandWidth)   return vec4(a, 1.0);

  float k = (uv.x - front) / bandWidth;          // 0 at trailing edge, 1 at leading
  float bx = (floor(uv.x * barCount) + 0.5) / barCount;

  vec3 s = b;
  float lum = dot(getToColor(vec2(bx, uv.y)).rgb, vec3(0.299, 0.587, 0.114));
  float h = clamp(lum + floorLift, 0.0, 1.0);

  float bar = step(uv.y, h) * (0.35 + 0.65 * step(h - 0.02, uv.y));
  float gap = smoothstep(0.0, 0.06, fract(uv.x * barCount)) * (1.0 - smoothstep(0.94, 1.0, fract(uv.x * barCount)));
  vec3 analyzer = vec3(0.25, 1.0, 0.72) * bar * gap;

  vec3 col = mix(s, analyzer, smoothstep(0.15, 0.85, k));
  col = mix(col, a, smoothstep(0.75, 1.0, k));
  col += vec3(0.4, 1.0, 0.8) * exp(-abs(k - 1.0) * 22.0) * glow;
  return vec4(col, 1.0);
}
