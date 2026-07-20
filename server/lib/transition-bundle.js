'use strict';
// Builds the transition runtime the web player loads: params.js + renderer.js (both UMD -> set
// window.TransitionParams / window.TransitionRenderer in the browser) plus a shader-id -> source map.
// Assembled once from shared/Transitions so the player, Tizen, and CI can't drift from the .glsl files.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '../../shared/Transitions');

function build() {
  const params = fs.readFileSync(path.join(DIR, 'params.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(DIR, 'renderer.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const shaders = {};
  for (const e of manifest) shaders[e.id] = fs.readFileSync(path.join(DIR, e.file), 'utf8');
  // __TRANSITION_SHADERS: id -> GLSL source (player + dashboard preview).
  // __TRANSITION_MANIFEST: [{id,name,blurb,params}] for the dashboard picker (names + slider ranges).
  return `${params}\n;\n${renderer}\n;\n`
    + `window.__TRANSITION_SHADERS=${JSON.stringify(shaders)};\n`
    + `window.__TRANSITION_MANIFEST=${JSON.stringify(manifest)};\n`;
}

let cached = null;
module.exports = {
  bundle() { if (cached == null) cached = build(); return cached; },
};
