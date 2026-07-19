// Signal Lock
// blurb: Static, rolling sync bars, then the picture snaps in like a tuner acquiring.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float noiseAmount; // = 0.85 [0.0..1.0]
uniform float rollSpeed;   // = 2.4 [0.0..8.0]
uniform float barCount;    // = 3.0 [0.0..8.0]
uniform float tearAmount;  // = 0.12 [0.0..0.5]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float env = sin(3.14159265 * progress);          // 0 at both ends
  float settle = 1.0 - smoothstep(0.55, 1.0, progress);

  vec2 uvr = uv;
  uvr.y = fract(uv.y + settle * progress * rollSpeed);
  float line = floor(uv.y * 240.0);
  float tear = (bt_hash(vec2(line, floor(progress * 30.0))) - 0.5) * tearAmount * env;
  uvr.x = fract(uv.x + tear);

  vec4 a = getFromColor(uv);
  vec4 b = getToColor(uvr);
  float sig = smoothstep(0.42, 0.58, progress);
  vec4 img = mix(a, b, sig);

  float bp = fract(uv.y + progress * barCount);
  float bar = smoothstep(0.0, 0.05, bp) * (1.0 - smoothstep(0.05, 0.11, bp));
  img.rgb += bar * 0.40 * env;

  float st = bt_hash(uv * vec2(640.0, 360.0) + floor(progress * 60.0));
  img.rgb = mix(img.rgb, vec3(st), pow(env, 0.55) * noiseAmount * 0.7);

  return vec4(img.rgb, 1.0);
}
