'use strict';

/*
 * Head office (corporate) playlists, Stage D — the dashboard's wiring, checked from source (spec §7,
 * §8 Stage D). The views themselves are driven in a real browser by the smoke run; this file pins the
 * things that have shipped broken before and that a browser run would only catch by luck:
 *
 *   - the view is routed and has a nav item (a missing module returns index.html with 200)
 *   - every refusal code the server can send has an English translation, so a store user is told
 *     why in the UI's words (the two codes that carry per-action text are the server's own)
 *   - the COMPUTED key families exist (t() returns the raw key for a missing one, and the static
 *     i18n test cannot see a computed key)
 *   - every tn() key has both plural forms
 *   - the content picker's slot filter agrees with the server's "unbounded item" rule, so the
 *     picker never offers what the server refuses, or hides what it accepts
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - frontend/js/app.js: drop the '#/corporate' route branch      -> "the view is routed ..."
 *   - frontend/js/components/content-picker.js: drop the HLS test  -> "the picker's slot filter ..."
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FE = path.join(__dirname, '..', '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FE, p), 'utf8');
const EN = read('js/i18n/en.js');
const defined = new Set([...EN.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]));

test('the view is routed, imported and has a nav item', () => {
  const app = read('js/app.js');
  assert.match(app, /import \* as corporate from '\.\/views\/corporate\.js';/);
  assert.match(app, /hash === '#\/corporate' \|\| hash\.startsWith\('#\/corporate\/'\)\) \{\s*\/\/[^\n]*\n\s*currentView = corporate;\s*corporate\.render\(app\);/);
  assert.match(app, /syncCorporateNav\(\);/, 'the nav item is shown/hidden per viewer');
  const html = read('index.html');
  assert.match(html, /<li id="corporateNavItem" style="display:none"><a href="#\/corporate" class="nav-link" data-view="corporate">/);
  for (const f of ['js/views/corporate.js', 'js/components/corporate-ui.js', 'js/components/corporate-settings.js', 'js/components/corporate-slot-dialog.js']) {
    assert.ok(fs.existsSync(path.join(FE, f)), `${f} is imported but missing`);
  }
});

test('every refusal code the server can send has an English translation', () => {
  const { MESSAGES } = require('../lib/corporate/guard');
  // These two carry the whole sentence in their vars (per action / per clash): the server's text is the message.
  const PER_ACTION = new Set(['CORPORATE_MEMBERSHIP', 'CORPORATE_EMERGENCY_TOKEN']);
  const missing = Object.keys(MESSAGES).filter((c) => !PER_ACTION.has(c) && !defined.has(`corp.err.${c}`));
  assert.deepEqual(missing, [], `no corp.err key for: ${missing.join(', ')}`);
});

test('computed key families exist: device control labels, target kinds, coverage reasons', () => {
  const dd = read('js/views/device-detail.js');
  const block = dd.slice(dd.indexOf('const CORP_GATED_CONTROLS = {'), dd.indexOf('};', dd.indexOf('const CORP_GATED_CONTROLS = {')));
  const cmds = [...block.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(cmds.length >= 10, 'the gated control map should have parsed');
  for (const c of [...cmds, 'other']) assert.ok(defined.has(`corp.ctl.${c}`), `corp.ctl.${c}`);
  // Every command head office gates on the server has a control label the page could show.
  const { GATED_COMMANDS } = require('../lib/corporate/guard');
  for (const c of Object.keys(GATED_COMMANDS)) assert.ok(defined.has(`corp.ctl.${c}`), `corp.ctl.${c} (server-gated)`);
  for (const k of ['org', 'workspace', 'group', 'wall', 'device']) assert.ok(defined.has(`corp.kind.${k}`), `corp.kind.${k}`);

  // Coverage reasons: every reason lib/corporate/emergency.js can emit is mapped, and every mapped key exists.
  const em = fs.readFileSync(path.join(__dirname, '..', 'lib', 'corporate', 'emergency.js'), 'utf8');
  const fn = em.slice(em.indexOf('function reasonsFor'), em.indexOf('\n}\n', em.indexOf('function reasonsFor')));
  const reasons = new Set([...fn.matchAll(/\.push\('([a-z_]+)'\)/g)].map((m) => m[1]));
  assert.ok(reasons.size >= 7, 'the reason list should have parsed');
  const view = read('js/views/corporate.js');
  const map = view.slice(view.indexOf('const REASON_KEY = {'), view.indexOf('};', view.indexOf('const REASON_KEY = {')));
  const mapped = Object.fromEntries([...map.matchAll(/([a-z_]+):\s*'([a-z_.]+)'/g)].map((m) => [m[1], m[2]]));
  for (const r of reasons) {
    assert.ok(mapped[r], `coverage reason ${r} has no wording in views/corporate.js REASON_KEY`);
    assert.ok(defined.has(mapped[r]), `${mapped[r]} missing from en.js`);
  }
});

test('every tn() key has both plural forms', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'i18n') walk(p); } else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(FE, 'js'));
  const missing = [];
  for (const f of files) {
    for (const [, key] of fs.readFileSync(f, 'utf8').matchAll(/\btn\(\s*'(corp\.[a-z0-9_.]+)'/g)) {
      for (const form of ['_one', '_other']) if (!defined.has(key + form)) missing.push(`${path.basename(f)}: ${key}${form}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the picker\'s slot filter agrees with the server\'s unbounded-item rule', () => {
  const src = read('js/components/content-picker.js');
  const i = src.indexOf('function slotPlayableItem(');
  assert.ok(i > 0, 'slotPlayableItem missing from content-picker.js');
  let depth = 0; let j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  const ctx = {};
  vm.runInNewContext(src.slice(i, j + 1) + '\nthis.f = slotPlayableItem;', ctx);
  const { isUnboundedItem } = require('../lib/corporate/compose');
  // A library row as the picker sees it: duration_sec is the content's own (probed) length.
  const rows = [
    { mime_type: 'image/png', duration_sec: 10 }, { mime_type: 'image/png', duration_sec: null },
    { mime_type: 'video/mp4', duration_sec: 30 }, { mime_type: 'video/mp4', duration_sec: null }, { mime_type: 'video/mp4', duration_sec: 0 },
    { mime_type: 'video/hls', duration_sec: 30 }, { mime_type: 'video/hls', duration_sec: null }, { mime_type: 'VIDEO/HLS', duration_sec: 30 },
    { mime_type: 'video/rtsp', duration_sec: 30 }, { mime_type: 'video/youtube', duration_sec: 200 },
    { mime_type: 'audio/mpeg', duration_sec: 120 }, { mime_type: 'audio/mpeg', duration_sec: null },
    { mime_type: 'text/html', duration_sec: null },
  ];
  for (const r of rows) {
    const server = !isUnboundedItem({ mime_type: r.mime_type, content_duration: r.duration_sec });
    assert.equal(ctx.f(r, true), server, `${r.mime_type} / ${r.duration_sec}: picker ${ctx.f(r, true)} vs server ${server}`);
  }
  // allow_video off removes timed media, never anything else.
  assert.equal(ctx.f({ mime_type: 'video/mp4', duration_sec: 30 }, false), false);
  assert.equal(ctx.f({ mime_type: 'audio/mpeg', duration_sec: 30 }, false), false, 'audio counts as video (B19)');
  assert.equal(ctx.f({ mime_type: 'image/png', duration_sec: 10 }, false), true);
});

test('corporate views import every helper they use (the missing-esc shape)', () => {
  // A helper used but never imported is a ReferenceError inside a click handler, which no parse
  // check sees. Each of these is used by the named file.
  const need = {
    'js/views/corporate.js': ['esc', 'hydrateAuthImages', 'showToast', 'api', 't', 'tn'],
    'js/components/corporate-ui.js': ['esc', 'hydrateAuthImages', 'showToast', 'api', 't', 'tn'],
    'js/components/corporate-settings.js': ['esc', 'showToast', 'api', 't', 'tn', 'ask', 'openWorkspaceCreateModal'],
    'js/components/corporate-slot-dialog.js': ['esc', 'showToast', 'api', 't', 'tn', 'openModal', 'limitsText'],
    'js/views/triggers.js': ['chip'],
    'js/views/device-detail.js': ['cui'],
    'js/views/playlists.js': ['cui', 'openSlotDialog'],
    'js/views/dashboard.js': ['cui'],
    'js/views/schedule.js': ['workspaceCoverage'],
    'js/views/video-wall.js': ['cui'],
  };
  for (const [file, names] of Object.entries(need)) {
    const src = read(file);
    const imports = src.split('\n').filter((l) => /^import /.test(l) || /^\s+[A-Za-z_, ]+$/.test(l)).join('\n')
      + src.slice(0, src.indexOf('\n\n', src.lastIndexOf('\nimport ')) + 1);
    for (const n of names) {
      const imported = new RegExp(`import[^;]*\\b${n}\\b[^;]*from`, 's').test(imports) || new RegExp(`import \\* as ${n} from`).test(imports);
      assert.ok(imported, `${file} uses ${n} but does not import it`);
    }
  }
});
