'use strict';

const esbuild = require('esbuild');

const START = '<script>\n    // ==================== i18n ====================';
let cached = null;

function html(source) {
  if (cached && cached.source === source) return cached.html;
  const compatible = source.replace(/inset:\s*0/g, 'top:0;right:0;bottom:0;left:0');
  const start = compatible.indexOf(START);
  const codeStart = start + '<script>'.length;
  const end = compatible.indexOf('\n  </script>', codeStart);
  if (start < 0 || end < 0) throw new Error('player script marker not found');
  const code = compatible.slice(codeStart, end);
  const legacy = esbuild.transformSync(code, { loader: 'js', target: 'chrome53' }).code;
  const result = compatible.slice(0, codeStart) + '\n' + legacy + compatible.slice(end);
  cached = { source, html: result };
  return result;
}

module.exports = { html };
