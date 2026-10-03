'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const PLAYER = path.join(SERVER, 'player');
const START = '<script>\n    // ==================== i18n ====================';
let esbuild;

function compiler() {
  if (esbuild) return esbuild;
  try {
    esbuild = require('esbuild');
    return esbuild;
  } catch (_) {
    throw new Error('esbuild is required to build legacy player artifacts; run npm install first');
  }
}

function transform(source) {
  return compiler().transformSync(source, { loader: 'js', target: 'chrome53' }).code;
}

function legacyHtml() {
  const source = fs.readFileSync(path.join(PLAYER, 'index.html'), 'utf8');
  const start = source.indexOf(START);
  if (start < 0) throw new Error('player script start marker not found');
  const codeStart = start + '<script>'.length;
  const end = source.indexOf('\n  </script>', codeStart);
  if (end < 0) throw new Error('player script end marker not found');
  const output = source.slice(0, codeStart) + '\n' + transform(source.slice(codeStart, end)) + source.slice(end);
  return output
    .replace('src="/player/live-publish.js"', 'src="/player/live-publish-legacy.js"')
    .replace('src="/player/talk.js"', 'src="/player/talk-legacy.js"');
}

const outputs = [
  [path.join(PLAYER, 'legacy.html'), legacyHtml],
  [path.join(PLAYER, 'sw-legacy.js'), () => transform(fs.readFileSync(path.join(PLAYER, 'sw.js'), 'utf8'))],
  [path.join(PLAYER, 'live-publish-legacy.js'), () => transform(fs.readFileSync(path.join(SERVER, 'lib', 'live-publish.js'), 'utf8'))],
  [path.join(PLAYER, 'talk-legacy.js'), () => transform(fs.readFileSync(path.join(SERVER, 'lib', 'talk-web.js'), 'utf8'))],
];

const check = process.argv.includes('--check');
for (const [file, build] of outputs) {
  const output = build();
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output) {
      throw new Error(path.relative(SERVER, file) + ' is stale; run npm run build:legacy-player');
    }
  } else {
    fs.writeFileSync(file, output);
  }
}
