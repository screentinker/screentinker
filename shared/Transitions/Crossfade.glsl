// Crossfade
// blurb: The plain dissolve. One frame melts evenly into the next; raise dipToBlack to pass through black on the way.
// Author: Emanuel Mairoll
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
//
// The one effect in this library that draws attention to the content rather than to itself. Every
// player drives `progress` linearly across durationMs, so the easing lives here: at ease=1 the blend
// follows a smoothstep (slow in, slow out), which is what a dissolve on a menu board is expected to
// look like; ease=0 is a straight linear mix for anyone matching another system's timing.
uniform float ease;       // = 1.0 [0.0..1.0]
uniform float dipToBlack; // = 0.0 [0.0..1.0]

vec4 transition(vec2 uv){
  float p = mix(progress, smoothstep(0.0, 1.0, progress), ease);
  vec3 a = getFromColor(uv).rgb;
  vec3 b = getToColor(uv).rgb;
  vec3 direct = mix(a, b, p);
  // fade down to black over the first half, back up from black over the second
  vec3 viaBlack = a * clamp(1.0 - 2.0 * p, 0.0, 1.0) + b * clamp(2.0 * p - 1.0, 0.0, 1.0);
  return vec4(mix(direct, viaBlack, dipToBlack), 1.0);
}
