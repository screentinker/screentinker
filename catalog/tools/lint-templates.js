#!/usr/bin/env node
'use strict';

/*
 * Catalog lint: the review rules a machine can check, run on every pull request (validate.yml)
 * and locally with `node tools/lint-templates.js templates`.
 *
 * It complements, and never replaces, `template-catalog.js build` (which enforces the manifest,
 * file and parameter rules exactly as a server does) and a human reviewer (who reads every line).
 * Everything here is a heuristic with one job: make the obvious violations impossible to miss.
 *
 * Exit 1 on any error. Warnings are printed for the reviewer and do not fail the run.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'templates');
const MAX_THUMB = 200 * 1024;
const MAX_LINE = 400;          // longer lines look minified / generated
const ALLOWED_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'Unlicense']);
// URLs that are identifiers, not network access (XML namespaces).
const NAMESPACE_HOSTS = new Set(['www.w3.org']);
const CODE_EXT = new Set(['.html', '.js', '.css', '.svg', '.json']);

const errors = [];
const warnings = [];
const err = (t, m) => errors.push(`${t}: ${m}`);
const warn = (t, m) => warnings.push(`${t}: ${m}`);

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

function hostAllowed(host, network) {
  return network.some((n) => (n.startsWith('*.') ? host.endsWith(n.slice(1)) : host === n));
}

for (const id of fs.readdirSync(root).sort()) {
  const dir = path.join(root, id);
  if (!fs.statSync(dir).isDirectory() || id.startsWith('.')) continue;
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) { err(id, `manifest.json: ${e.message}`); continue; }
  const network = Array.isArray(m.network) ? m.network : [];
  const files = walk(dir);

  // --- licence & paperwork
  if (!ALLOWED_LICENSES.has(m.license)) err(id, `license "${m.license}" is not allowed`);
  if (!files.includes('LICENSE') && !files.includes('LICENCE')) err(id, 'no LICENSE file');
  if (!files.includes('README.md')) err(id, 'no README.md');
  const bundled = files.filter((f) => /\.(woff2|png|jpe?g|webp|gif|svg)$/i.test(f) && f !== m.thumbnail);
  if (files.some((f) => /\.woff2$/i.test(f))) {
    if (!files.includes('NOTICE')) err(id, 'bundles fonts but has no NOTICE');
    if (!files.some((f) => /OFL[^/]*\.txt$/i.test(f))) err(id, 'bundles fonts but ships no OFL licence text (fonts/OFL-<family>.txt)');
  }
  if (bundled.length && !files.includes('NOTICE')) warn(id, `bundles ${bundled.length} media file(s) and has no NOTICE — fine only if they are all original work`);
  const notice = files.includes('NOTICE') ? fs.readFileSync(path.join(dir, 'NOTICE'), 'utf8') : '';
  if (/\b(A?GPL|LGPL|SSPL|non-?commercial|CC[- ]BY[- ]NC|CC[- ]BY[- ]SA)\b/i.test(notice)) err(id, 'NOTICE mentions a licence that is not accepted (GPL/AGPL/LGPL/SSPL/NC/SA)');

  // --- thumbnail
  const thumb = m.thumbnail || 'thumbnail.png';
  if (!files.includes(thumb)) err(id, `thumbnail ${thumb} missing`);
  else if (fs.statSync(path.join(dir, thumb)).size > MAX_THUMB) err(id, `thumbnail is ${fs.statSync(path.join(dir, thumb)).size} bytes (max ${MAX_THUMB})`);

  if (m.kind !== 'html' && network.length) err(id, 'only html templates may declare network hosts');

  // --- code
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!CODE_EXT.has(ext)) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const where = `${id}/${f}`;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.length > MAX_LINE && !(f === 'template.json' || f === 'manifest.json')) err(where, `line ${i + 1} is ${line.length} characters — minified or generated code is not accepted`);
    });
    if (ext === '.js' || ext === '.html' || ext === '.svg') {
      const checks = [
        [/\beval\s*\(/, 'eval()'],
        [/\bnew\s+Function\s*\(/, 'new Function()'],
        [/\bFunction\s*\(\s*['"`]/, 'Function("…")'],
        [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'setTimeout/setInterval with a string'],
        [/\bdocument\.write(?:ln)?\s*\(/, 'document.write()'],
        [/\b(?:webkit)?RTCPeerConnection\b|\bRTCDataChannel\b/, 'WebRTC (not fenced by CSP on Chromium players)'],
        [/\b(?:location\s*(?:\.href)?\s*=|location\.(?:assign|replace)\s*\(|window\.open\s*\()/, 'navigation / window.open (a way to send data to undeclared hosts)'],
        [/createElement\s*\(\s*['"`]script['"`]\s*\)/i, 'a dynamically created <script>'],
        [/\bimport\s*\(|^\s*import\s[^(]|<script[^>]+type\s*=\s*["']module/im, 'ES module import (not supported — files are inlined)'],
        [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, 'network API — only for hosts in manifest.network'],
        [/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, 'HTML injection sink — write values with textContent'],
        [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/, 'storage API — throws in the opaque-origin sandbox'],
        [/<(?:audio|video)\b[^>]*\bautoplay\b(?![^>]*\bmuted\b)/i, 'media that could play sound'],
      ];
      for (const [re, what] of checks) {
        if (re.test(text)) {
          const serious = /eval|Function|string|document\.write|<script>|module|WebRTC|navigation/.test(what);
          (serious ? err : warn)(where, `uses ${what}`);
        }
      }
    }
    // URLs: every host must be declared (namespaces excepted). Protocol-relative too.
    const urlRe = /\b(?:https?|wss?):\/\/([a-z0-9.-]+)|(?:src|href)\s*=\s*["']\/\/([a-z0-9.-]+)/gi;
    let mm;
    while ((mm = urlRe.exec(text))) {
      const host = (mm[1] || mm[2]).toLowerCase();
      if (NAMESPACE_HOSTS.has(host)) continue;
      if (f === 'manifest.json' || f.endsWith('.md')) continue;
      if (!hostAllowed(host, network)) err(where, `refers to ${host}, which is not in manifest.network`);
      else if (/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(text.slice(Math.max(0, mm.index - 12), mm.index + 8))) {
        err(where, `loads ${host} as a script/style/asset — ship it in the package instead (no CDN)`);
      }
    }
  }
}

for (const w of warnings) console.log(`warning  ${w}`);
for (const e of errors) console.log(`ERROR    ${e}`);
console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
