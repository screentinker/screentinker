'use strict';

/*
 * The static security tripwire (scripts/security-scan.js), mapped to the OWASP Top 10.
 *
 * Fails CI when new code adds a finding that is not in test/security-baseline.json. The baseline
 * is existing debt: it may only shrink. If this test failed on your change, the message says
 * which rule, where, and how to fix it. See the header of scripts/security-scan.js.
 *
 * The second half pins the rules themselves, including the real code behind past advisories, so a
 * well-meant tweak to the scanner cannot quietly stop catching the bugs it was written for.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const scan = require('../scripts/security-scan');

const rulesOf = (rel, side, code) => scan.scanText(rel, side, code).map((f) => f.rule);
const has = (rel, side, code, rule) => rulesOf(rel, side, code).includes(rule);
const S = (code) => has.bind(null, 'server/lib/x.js', 'server', code);
const C = (code) => has.bind(null, 'frontend/js/x.js', 'client', code);

test('security scan: no NEW findings beyond test/security-baseline.json', () => {
  const findings = scan.scanAll();
  const { added } = scan.compare(findings, scan.loadBaseline());
  assert.equal(added.length, 0,
    `\n${added.length} new security finding(s):\n\n${added.map(scan.format).join('\n\n')}\n\n`
    + 'Fix it, or if it is genuinely safe add `// security-ok(<rule>): <why>` on or above the line.\n'
    + 'Run `node scripts/security-scan.js` in server/ to see these locally.\n');
});

test('security scan: the baseline only shrinks (fixed findings must be removed from it)', () => {
  const { stale } = scan.compare(scan.scanAll(), scan.loadBaseline());
  assert.equal(stale.length, 0,
    `\n${stale.length} baseline entr(ies) no longer occur. Nice. Remove them with\n`
    + '  node scripts/security-scan.js --update-baseline\n'
    + `(and check the diff only REMOVES lines):\n${stale.slice(0, 20).map((s) => '  ' + s.key).join('\n')}\n`);
});

test('security scan: every scanned file parses, and nothing unparseable is baselined', () => {
  const errors = scan.scanAll().filter((f) => f.rule === 'parse-error');
  assert.deepEqual(errors.map((f) => `${f.file}:${f.line} ${f.snippet}`), []);
  const base = Object.keys(scan.loadBaseline().entries || {});
  assert.deepEqual(base.filter((k) => k.startsWith('parse-error|')), []);
});

test('security scan: covers the server, the player and the dashboard', () => {
  const files = scan.listFiles().map((f) => f.rel);
  for (const must of ['server/server.js', 'server/routes/kiosk.js', 'server/lib/ssrf-guard.js', 'server/player/index.html', 'frontend/js/app.js', 'frontend/js/views/playlists.js']) {
    if (must === 'server/lib/ssrf-guard.js') continue; // scanned, but exempt from ssrf-outbound
    assert.ok(files.includes(must), `${must} must be scanned`);
  }
  assert.ok(!files.some((f) => f.startsWith('server/test/') || f.includes('node_modules') || f.includes('/vendor/')));
  assert.ok(files.length > 500, `only ${files.length} files scanned`);
});

/* ---------------------------------------------------------------------------------------------
 * Past advisories. Each is the vulnerable code as it was, reduced. These must keep failing.
 * ------------------------------------------------------------------------------------------- */

test('GHSA-885f: preview banner names written with innerHTML', () => {
  const code = `<script>
    function renderPreviewBanner(el, layout, zone, item) {
      const lines = ['Layout: ' + layout.name, 'Zone: ' + zone.name, 'Item: ' + item.name];
      el.innerHTML = lines.join('<br>');
    }</script>`;
  assert.ok(has('server/player/index.html', 'client', code, 'dom-html-sink'));
});

test('GHSA-g46x: kiosk page button navigates to a stored javascript: URL (inside a server template)', () => {
  const code = 'module.exports = (cfg) => `<!doctype html><html><body><div id="b"></div><script>'
    + 'document.addEventListener("click", function (e) { var btn = e.target.closest("button");'
    + ' var action = btn.dataset.action, page = btn.dataset.page;'
    + ' if (action === "page" && page) window.location.href = page; });'
    + '</script></body></html>`;';
  assert.ok(has('server/routes/kiosk.js', 'server', code, 'url-sink'));
  // the fix: scheme-checked first
  const fixed = code.replace('window.location.href = page;', '{ var to = siteUrl(page); if (to) window.location.href = to; }')
    .replace('<script>', '<script>function siteUrl(u){ return /^https?:/i.test(u) ? u : null; }');
  assert.ok(!has('server/routes/kiosk.js', 'server', fixed, 'url-sink'));
});

test('GHSA-4xm6 / GHSA-p76c: AI endpoint and returned image URL fetched without the SSRF guard', () => {
  assert.ok(S(`async function gen(baseUrl, p) { return fetch(baseUrl + '/images/generations', { method: 'POST', body: p }); }`)('ssrf-outbound'));
  assert.ok(S(`async function img(json) { const url = json.data[0].url; return fetch(url); }`)('ssrf-outbound'));
  // through the guard: fine
  assert.ok(!S(`const { assertSafeUrl } = require('./ssrf-guard');
    async function img(json) { const url = json.data[0].url; await assertSafeUrl(url); return fetch(url); }`)('ssrf-outbound'));
  // a fixed provider host: fine
  assert.ok(!S('async function f(id) { return fetch(`https://api.stripe.com/v1/customers/${id}`); }')('ssrf-outbound'));
});

/* ---------------------------------------------------------------------------------------------
 * One positive and one negative case per rule.
 * ------------------------------------------------------------------------------------------- */

test('A03 XSS: dom-html-sink', () => {
  assert.ok(C('function f(el, name) { el.innerHTML = `<b>${name}</b>`; }')('dom-html-sink'));
  assert.ok(C('function f(el, s) { el.insertAdjacentHTML("beforeend", s); }')('dom-html-sink'));
  assert.ok(C('function f(el, s) { el.setAttribute("onclick", s); }')('dom-html-sink'));
  assert.ok(!C('import { esc } from "./utils.js"; function f(el, name) { el.innerHTML = `<b>${esc(name)}</b>`; }')('dom-html-sink'));
  assert.ok(!C('function f(el, items) { el.innerHTML = items.map((i) => `<li>${esc(i.name)}</li>`).join(""); }')('dom-html-sink'));
  assert.ok(!C('function f(el, n) { el.innerHTML = `<b>${n.length}</b> ${t("x.y")}`; }')('dom-html-sink'));
  assert.ok(!C('function row(x) { return `<td>${esc(x)}</td>`; } function f(el, x) { el.innerHTML = row(x); }')('dom-html-sink'));
  assert.ok(!C('function f(el, s) { el.textContent = s; el.innerHTML = ""; }')('dom-html-sink'));
});

test('A03 XSS: url-sink (escaping does not stop javascript:)', () => {
  assert.ok(C('function f(a, u) { a.href = esc(u); }')('url-sink'));
  assert.ok(C('function f(u) { window.open(u); }')('url-sink'));
  assert.ok(C('function f(u) { location.assign(u); }')('url-sink'));
  assert.ok(!C('function f(a, id) { a.href = `/dashboard/#/devices/${id}`; }')('url-sink'));
  assert.ok(!C('function f(img, u) { img.src = u; }')('url-sink'));
  assert.ok(!C('function f(a, u) { if (!/^https?:/i.test(u)) return; a.href = u; }')('url-sink'));
  assert.ok(C('function f(a, id) { a.href = `//${id}`; }')('url-sink'), 'protocol-relative is not a same-origin path');
});

test('A03 XSS: server-html-interp', () => {
  assert.ok(S('function page(title) { return `<title>${title}</title>`; }')('server-html-interp'));
  assert.ok(!S('const esc = (s) => s; function page(title) { return `<title>${esc(title)}</title>`; }')('server-html-interp'));
  assert.ok(!S('function msg(n) { return `found ${n} items`; }')('server-html-interp'), 'not HTML');
});

test('A03 injection: code-eval, sql-dynamic, cmd-injection, regex-dynamic', () => {
  assert.ok(S('function f(s) { return eval(s); }')('code-eval'));
  assert.ok(S('function f(s) { return new Function(s); }')('code-eval'));
  assert.ok(S('function f(s) { setTimeout("go(" + s + ")", 1); }')('code-eval'));
  assert.ok(!S('function f() { setTimeout(() => go(), 1); }')('code-eval'));

  assert.ok(S('function f(db, name) { return db.prepare(`SELECT * FROM t WHERE name = \'${name}\'`).get(); }')('sql-dynamic'));
  assert.ok(S('function f(db, col) { return db.prepare("SELECT " + col + " FROM t").all(); }')('sql-dynamic'));
  assert.ok(!S('function f(db, name) { return db.prepare("SELECT * FROM t WHERE name = ?").get(name); }')('sql-dynamic'));
  assert.ok(!S('function f(db, ids) { return db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids); }')('sql-dynamic'));
  assert.ok(!S('const COLS = ["a", "b"]; function f(db) { return db.prepare(`SELECT ${COLS.join(",")} FROM t`).all(); }')('sql-dynamic'));
  assert.ok(!S('const ph = (n) => Array.from({ length: n }, () => "?").join(","); function f(db, ids) { return db.prepare(`SELECT 1 FROM t WHERE id IN (${ph(ids.length)})`).all(...ids); }')('sql-dynamic'));
  assert.ok(!S('function f(re, s) { return re.exec(s); }')('sql-dynamic'), 'RegExp#exec is not SQL');

  assert.ok(S('const { exec } = require("child_process"); function f(file) { exec(`convert ${file} out.png`); }')('cmd-injection'));
  assert.ok(S('const cp = require("node:child_process"); function f(a) { cp.spawn("x", [a], { shell: true }); }')('cmd-injection'));
  assert.ok(!S('const { execFile } = require("child_process"); function f(file) { execFile("convert", [file, "out.png"]); }')('cmd-injection'));

  assert.ok(S('function f(q) { return new RegExp(q); }')('regex-dynamic'));
  assert.ok(!S('function f(q) { return new RegExp(escapeRegExp(q), "i"); }')('regex-dynamic'));
});

test('A01: open-redirect, path-traversal, auth-skip', () => {
  assert.ok(S('function h(req, res) { res.redirect(req.query.next); }')('open-redirect'));
  assert.ok(!S('function h(req, res) { res.redirect(`/login?next=${encodeURIComponent(req.path)}`); }')('open-redirect'));
  assert.ok(S('function h(req, res) { res.sendFile(path.join(DIR, req.params.name)); }')('path-traversal'));
  assert.ok(!S('function h(req, res) { res.sendFile(path.join(DIR, path.basename(req.params.name))); }')('path-traversal'));
  assert.ok(!S('function h(req, res) { if (!OK.has(req.params.name)) return; res.sendFile(path.join(DIR, req.params.name)); }')('path-traversal'));
  assert.ok(S('app.get("/x", (req, res, next) => { req._skipAuth = true; next(); });')('auth-skip'));
});

test('A02 crypto: weak-hash, insecure-random, weak-crypto', () => {
  assert.ok(S('crypto.createHash("md5").update(x).digest("hex")')('weak-hash'));
  assert.ok(!S('crypto.createHash("sha256").update(x).digest("hex")')('weak-hash'));
  assert.ok(S('const token = Math.random().toString(36)')('insecure-random'));
  assert.ok(!has('frontend/js/x.js', 'client', 'const jitter = Math.random()', 'insecure-random'), 'browser jitter is fine');
  assert.ok(S('https.request({ host: "x", rejectUnauthorized: false })')('weak-crypto'));
  assert.ok(S('crypto.createCipher("aes-256-cbc", key)')('weak-crypto'));
  assert.ok(S('process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"')('weak-crypto'));
});

test('A07 auth: jwt-unsafe, timing-compare, bcrypt-low-cost, hardcoded-secret', () => {
  assert.ok(S('jwt.verify(t, SECRET)')('jwt-unsafe'));
  assert.ok(!S('jwt.verify(t, SECRET, { algorithms: ["HS256"] })')('jwt-unsafe'));
  assert.ok(S('function ok(req, row) { return req.body.token === row.api_token; }')('timing-compare'));
  assert.ok(!S('function ok(a, b) { return crypto.timingSafeEqual(a, b); }')('timing-compare'));
  assert.ok(!S('function ok(row, d) { return row.byte_digest === d; }')('timing-compare'), 'a content digest is not a secret');
  assert.ok(!S('function ok(token) { return token === undefined; }')('timing-compare'));
  assert.ok(S('bcrypt.hash(pw, 8)')('bcrypt-low-cost'));
  assert.ok(!S('bcrypt.hash(pw, 12)')('bcrypt-low-cost'));
  assert.ok(S('const cfg = { clientSecret: "a8f3k29dk3m4n5b6v7" }')('hardcoded-secret'));
  assert.ok(S(`const k = "${'-----BEGIN ' + 'PRIVATE KEY-----'}abc"`)('hardcoded-secret'));
  assert.ok(!S('const cfg = { clientSecret: process.env.X, password: "change-me-please1" }')('hardcoded-secret'));
});

test('A05 misconfig: cors-permissive, security-header-off, cookie-flags', () => {
  assert.ok(S('app.use(cors({ origin: true, credentials: true }))')('cors-permissive'));
  assert.ok(!S('app.use(cors({ origin: ALLOWED, credentials: true }))')('cors-permissive'));
  assert.ok(S('function h(req, res) { res.setHeader("Access-Control-Allow-Origin", req.headers.origin); }')('cors-permissive'));
  assert.ok(S('app.use(helmet({ contentSecurityPolicy: false }))')('security-header-off'));
  assert.ok(S('function h(req, res) { res.removeHeader("X-Frame-Options"); }')('security-header-off'));
  assert.ok(S('function h(req, res) { res.cookie("sid", v); }')('cookie-flags'));
  assert.ok(S('function h(req, res) { res.cookie("sid", v, { httpOnly: true }); }')('cookie-flags'), 'sameSite must be explicit');
  assert.ok(!S('function h(req, res) { res.cookie("sid", v, { httpOnly: true, sameSite: "lax", secure: true }); }')('cookie-flags'));
});

test('A08 / A09: dynamic-require, log-secret', () => {
  assert.ok(S('function load(name) { return require("./plugins/" + name); }')('dynamic-require'));
  assert.ok(!S('const x = require("./fixed")')('dynamic-require'));
  assert.ok(S('function f(user) { console.log("login", user.password); }')('log-secret'));
  assert.ok(S('function f(t) { console.log(`token=${t.api_token}`); }')('log-secret'));
  assert.ok(!S('function f(token) { console.log("token length", token.length, !!token); }')('log-secret'));
});

test('suppressions need a known rule and a reason', () => {
  const ok = 'function h(req, res) {\n  // security-ok(open-redirect): next is checked against ALLOWED_NEXT above\n  res.redirect(req.query.next);\n}';
  assert.ok(!S(ok)('open-redirect'));
  const lazy = 'function h(req, res) {\n  // security-ok(open-redirect): fine\n  res.redirect(req.query.next);\n}';
  assert.ok(S(lazy)('open-redirect'), 'a short reason does not suppress');
  assert.ok(S(lazy)('parse-error'), 'and it is reported');
  const wrongRule = 'function h(req, res) {\n  // security-ok(sql-dynamic): this is not the rule that fires here\n  res.redirect(req.query.next);\n}';
  assert.ok(S(wrongRule)('open-redirect'));
});

test('every rule has an OWASP mapping and fix text, and the baseline names only known rules', () => {
  for (const [k, r] of Object.entries(scan.RULES)) {
    assert.ok(r.owasp && r.help && r.help.length > 20, k);
    assert.ok(['server', 'client', 'any'].includes(r.side), k);
  }
  for (const k of Object.keys(scan.loadBaseline().entries || {})) assert.ok(scan.RULES[k.split('|')[0]], k);
  assert.equal(path.basename(scan.BASELINE_FILE), 'security-baseline.json');
});
