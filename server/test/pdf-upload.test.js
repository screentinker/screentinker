'use strict';

/* PDF → pages import: rendered in the uploader's browser with a vendored pdf.js, uploaded as PNGs.
 *
 * ⚠️ THE DESIGN DECISION UNDER TEST: the SERVER NEVER PARSES A PDF. Every permissive PDF renderer
 * that runs server-side needs either a canvas shim or a headless Chromium, prod has neither, and a
 * PDF parser is a large attack surface to add to an upload endpoint. So the pages arrive as
 * ordinary images through the ordinary path and the server-side allowlist stays exactly as strict
 * as it was. The first test pins that; if someone "helpfully" adds application/pdf to the sniffer
 * the whole rationale is gone and this should go red.
 *
 * The rest is what a vendored library needs: the files, their licences, the CSP that lets the
 * codecs compile, and the pure helpers that decide page size and naming.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'frontend', 'vendor', 'pdfjs');
const MODULE = path.join(ROOT, 'frontend', 'js', 'components', 'pdf-pages.js');
const LIBRARY = path.join(ROOT, 'frontend', 'js', 'views', 'content-library.js');

test('⚠️ the server still refuses a PDF upload — rendering is client-side by design', () => {
  const sniff = fs.readFileSync(path.join(__dirname, '..', 'lib', 'upload-sniff.js'), 'utf8');
  assert.doesNotMatch(sniff, /application\/pdf/, 'application/pdf must not enter the upload allowlist');
  assert.doesNotMatch(sniff, /'\.pdf'/, 'nor .pdf as a landing extension');
  // And nothing server-side reaches for a PDF library.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) {
    assert.doesNotMatch(dep, /pdf|poppler|mupdf|ghostscript/i, `server dependency ${dep} parses PDFs`);
  }
});

test('the vendored pdf.js is complete and every piece carries its licence', () => {
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'pdfjs.LICENSE',
    'wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'wasm/qcms_bg.wasm',
    'wasm/openjpeg.LICENSE', 'wasm/jbig2.LICENSE', 'wasm/qcms.LICENSE']) {
    assert.ok(fs.existsSync(path.join(VENDOR, f)), `missing frontend/vendor/pdfjs/${f}`);
  }
  assert.match(fs.readFileSync(path.join(VENDOR, 'pdfjs.LICENSE'), 'utf8'), /Apache License/);
  // Form scripting is deliberately not shipped: page rendering never runs a PDF's JavaScript.
  assert.ok(!fs.existsSync(path.join(VENDOR, 'wasm', 'quickjs-eval.wasm')),
    'quickjs-eval.wasm is not needed for rendering and must not be vendored');
  // The version pinned in the module matches the build actually on disk.
  const mod = fs.readFileSync(MODULE, 'utf8');
  const pinned = mod.match(/PDFJS_VERSION = '([^']+)'/)[1];
  assert.ok(fs.readFileSync(path.join(VENDOR, 'pdf.min.mjs'), 'utf8').includes(`"${pinned}"`),
    `pdf-pages.js pins ${pinned} but the vendored build is a different version`);
  // Recorded in the vendor README like every other library there.
  assert.match(fs.readFileSync(path.join(ROOT, 'frontend', 'vendor', 'README.md'), 'utf8'),
    new RegExp(`\\*\\*Version:\\*\\* ${pinned.replace(/\\./g, '\\\\.')}`));
});

test('the dashboard CSP admits WebAssembly compilation and nothing more', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Directives only: the comment above scriptSrc explains that this is NOT 'unsafe-eval', and an
  // assertion over the raw text would match its own explanation.
  const csp = server.slice(server.indexOf('const dashboardCsp'), server.indexOf('const dashboardCsp') + 2500)
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(csp, /'wasm-unsafe-eval'/, 'the codecs cannot compile without it');
  assert.doesNotMatch(csp, /'unsafe-eval'/, "'wasm-unsafe-eval' must not have been widened to 'unsafe-eval'");
  // A blob: worker would need worker-src; the module uses a same-origin file so 'self' suffices.
  assert.match(fs.readFileSync(MODULE, 'utf8'), /workerSrc = `\$\{VENDOR\}pdf\.worker\.min\.mjs`/);
});

test('pdf.js is loaded lazily, so a session that never uploads a PDF never fetches 1.7 MB', () => {
  const mod = fs.readFileSync(MODULE, 'utf8');
  assert.doesNotMatch(mod, /^import .*vendor/m, 'no static import of the vendored library');
  assert.match(mod, /import\(`\$\{VENDOR\}pdf\.min\.mjs`\)/, 'it is a dynamic import');
  const lib = fs.readFileSync(LIBRARY, 'utf8');
  assert.doesNotMatch(lib, /vendor\/pdfjs/, 'the view does not reach into vendor/ directly');
});

test('pages go through api.uploadContent, not a bare fetch or XHR (the house rule)', () => {
  const lib = fs.readFileSync(LIBRARY, 'utf8');
  const fn = lib.slice(lib.indexOf('async function importPdf'), lib.indexOf('\n}\n', lib.indexOf('async function importPdf')));
  assert.match(fn, /api\.uploadContent\(pages/, 'pages are uploaded through the shared helper');
  assert.doesNotMatch(fn, /new XMLHttpRequest|fetch\(/, 'no bespoke transport');
  assert.match(fn, /api\.createPlaylist\(/);
  assert.match(fn, /api\.addPlaylistItemsBulk\(/);
  // A PDF is routed away from the ordinary upload before it can reach the server.
  assert.match(lib, /const pdfs = all\.filter\(isPdf\)/);
  assert.match(lib, /const list = all\.filter\(\(f\) => !isPdf\(f\)\)/);
});

test('the main picker accepts PDFs and the replace-file picker does not', () => {
  const lib = fs.readFileSync(LIBRARY, 'utf8');
  const main = lib.match(/id="fileInput"[^>]*accept="([^"]+)"/)[1];
  assert.ok(main.includes('.pdf') && main.includes('application/pdf'), 'main picker takes PDFs');
  // Replacing ONE content row with a document that becomes MANY rows is not a replace.
  const replace = lib.match(/id="editFileReplace"[^>]*accept="([^"]+)"/)[1];
  assert.ok(!replace.includes('pdf'), 'the replace-file input must not offer PDFs');
});

/** Evaluate the module's pure exports without a DOM. */
function pureExports() {
  const src = fs.readFileSync(MODULE, 'utf8')
    .replace(/^export (const|function|async function) /gm, '$1 ')
    .replace(/^export \{[^}]*\};?$/m, '');
  const ctx = { module: {}, document: undefined };
  vm.runInNewContext(`${src}\nmodule.exports = { fitScale, baseName, pageFileName, isPdf, MAX_EDGE, MAX_PAGES };`, ctx);
  return ctx.module.exports;
}

test('a page is scaled so its longest edge is full HD, whichever way it faces', () => {
  const { fitScale, MAX_EDGE } = pureExports();
  assert.equal(MAX_EDGE, 1920);
  // US Letter portrait, 612x792pt: the height becomes 1920.
  assert.equal(Math.round(792 * fitScale(612, 792)), 1920);
  // A 16:9 slide exported to PDF, 960x540pt: lands at exactly 1920x1080.
  const s = fitScale(960, 540);
  assert.equal(Math.round(960 * s), 1920);
  assert.equal(Math.round(540 * s), 1080);
  // A degenerate viewport does not divide by zero.
  assert.equal(fitScale(0, 0), 1);
});

test('page files are named to sort, and the document name drops its extension', () => {
  const { baseName, pageFileName, isPdf } = pureExports();
  assert.equal(baseName('Quarterly report.pdf'), 'Quarterly report');
  assert.equal(baseName('Menu.PDF'), 'Menu');
  assert.equal(baseName(''), 'document');
  assert.equal(pageFileName('Menu', 3, 12), 'Menu-p03.png');
  assert.equal(pageFileName('Menu', 3, 120), 'Menu-p003.png', 'padding follows the page count');
  assert.equal(pageFileName('Menu', 1, 5), 'Menu-p01.png', 'never less than two digits');
  // Lexical order equals page order, which is what the bulk-add relies on.
  const names = [1, 2, 10, 11].map((n) => pageFileName('x', n, 11));
  assert.deepEqual([...names].sort(), names);
  assert.ok(isPdf({ type: 'application/pdf', name: 'a' }));
  assert.ok(isPdf({ type: '', name: 'a.PDF' }), 'by extension when the browser reports no type');
  assert.ok(!isPdf({ type: 'image/png', name: 'a.png' }));
});

test('the PDF module refuses to run a document\'s own JavaScript', () => {
  const mod = fs.readFileSync(MODULE, 'utf8');
  assert.match(mod, /isEvalSupported: false/, 'a PDF is a document, not a program');
  assert.match(mod, /enableXfa: false/);
});
