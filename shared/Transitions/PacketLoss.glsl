// Packet Loss
// blurb: Blocks drop out of the stream, rows tear, and the new frame retransmits block by block.
// Author: Dan (ByteTinker)
// License: MIT
// GL Transitions v1 — GLSL ES 1.0, runs unmodified in WebGL1 and Android GLES2.
uniform float cols;     // = 26.0 [4.0..80.0]
uniform float rows;     // = 15.0 [3.0..48.0]
uniform float rowTear;  // = 0.06 [0.0..0.3]
uniform float garbage;  // = 0.5 [0.0..1.0]

float bt_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec4 transition(vec2 uv){
  float env = sin(3.14159265 * progress);
  vec2 bs = vec2(cols, rows);

  float rowId = floor(uv.y * rows);
  float tear = (bt_hash(vec2(rowId, floor(progress * 24.0))) - 0.5) * rowTear * env;
  vec2 uvt = vec2(fract(uv.x + tear), uv.y);

  vec2 blk = floor(uvt * bs);
  float dropT = 0.05 + bt_hash(blk) * 0.40;
  float backT = 0.55 + bt_hash(blk + 11.3) * 0.40;

  float gone = step(dropT, progress);
  float back = step(backT, progress);

  vec3 a = getFromColor(uvt).rgb;
  vec3 b = getToColor(uvt).rgb;

  vec3 junk = getFromColor(fract(uvt + vec2(bt_hash(blk + 3.1) * 0.5, bt_hash(blk + 5.7) * 0.5))).rgb;
  junk = junk.gbr * (0.4 + bt_hash(blk + 9.0) * 0.6);
  vec3 hole = mix(vec3(0.0), junk, garbage * step(0.55, bt_hash(blk + 2.2)));

  vec3 col = mix(a, hole, gone * (1.0 - back));
  col = mix(col, b, back);
  return vec4(col, 1.0);
}
