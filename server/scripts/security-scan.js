#!/usr/bin/env node
'use strict';

/*
 * Static security scan, mapped to the OWASP Top 10 (2021).
 *
 * Why this exists: by 2026-11 ScreenTinker had eight GitHub advisories, and most of them were the
 * same two mistakes made in a new place. XSS on the dashboard origin (kiosk `javascript:` button,
 * widget sandbox bypass, playlist preview banner) and SSRF (AI endpoint config, AI image URL).
 * A rule that only lives in someone's head gets forgotten, so this file writes the rules down as
 * AST checks and test/security-static.test.js fails CI when new code breaks one.
 *
 * It is a TRIPWIRE, not a proof. It is deliberately conservative: anything it cannot show is safe
 * is reported. Existing hits are recorded in test/security-baseline.json, so CI only fails on NEW
 * code. The baseline is debt, not approval: shrink it, never grow it casually.
 *
 * When it flags your code, in order of preference:
 *   1. Fix it. Use textContent / esc(), ssrf-guard, a `?` placeholder, path.basename, etc.
 *   2. If it is genuinely safe, say why next to it:
 *        // security-ok(<rule>): <reason, at least 10 characters>
 *      on the flagged line or the line above. The reason is the review record.
 *   3. Only for a bulk refactor: `node scripts/security-scan.js --update-baseline`, and say so in
 *      the PR description.
 *
 * Usage:
 *   node scripts/security-scan.js                     list findings not in the baseline
 *   node scripts/security-scan.js --all               list every finding
 *   node scripts/security-scan.js --rule dom-html-sink
 *   node scripts/security-scan.js --update-baseline   rewrite test/security-baseline.json
 */

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..');
const BASELINE_FILE = path.join(SERVER, 'test', 'security-baseline.json');

/* ------------------------------------------------------------------------------------------------
 * Rules. `side` says where a rule applies: 'server' (Node code), 'client' (browser code), 'any'.
 * ---------------------------------------------------------------------------------------------- */
const RULES = {
  'dom-html-sink': {
    owasp: 'A03 Injection (XSS)', side: 'client',
    help: 'innerHTML/outerHTML/insertAdjacentHTML/document.write with a value not shown to be escaped. Use textContent, or wrap every interpolation in esc().',
  },
  'url-sink': {
    owasp: 'A03 Injection (XSS)', side: 'client',
    help: 'A dynamic value assigned to location/href/src/action or passed to window.open/location.assign. Escaping does not stop javascript: URLs; allowlist http/https (or build the URL from a fixed prefix).',
  },
  'server-html-interp': {
    owasp: 'A03 Injection (XSS)', side: 'server',
    help: 'Server-built HTML template with an interpolation not shown to be escaped. Wrap it in esc()/escapeHtml(), or JSON-encode it safely for <script>.',
  },
  'code-eval': {
    owasp: 'A03 Injection', side: 'any',
    help: 'eval / new Function / string timers / vm.runIn*. Do not run strings as code.',
  },
  'sql-dynamic': {
    owasp: 'A03 Injection (SQL)', side: 'server',
    help: 'SQL text built from a value not shown to be a constant. Use ? placeholders; if a column or table name must vary, pick it from a fixed allowlist in a const.',
  },
  'cmd-injection': {
    owasp: 'A03 Injection (OS command)', side: 'server',
    help: 'exec/execSync with a dynamic string, or spawn/execFile with shell:true. Use execFile/spawn with an argument array and no shell.',
  },
  'regex-dynamic': {
    owasp: 'A03 Injection (ReDoS)', side: 'any',
    help: 'new RegExp(dynamic) without escaping. Escape the input (escapeRegExp) or use a fixed pattern.',
  },
  'ssrf-outbound': {
    owasp: 'A10 SSRF', side: 'server',
    help: 'Outbound request to a URL that is not a fixed https://host. Route it through lib/ssrf-guard.js (assertSafeUrl + pinnedLookup, or guardedRequest), and re-vet redirects.',
  },
  'open-redirect': {
    owasp: 'A01 Broken Access Control', side: 'server',
    help: 'Redirect/Location to a dynamic target. Only redirect to a same-origin path from a fixed allowlist, and reject // and \\ prefixes.',
  },
  'path-traversal': {
    owasp: 'A01 Broken Access Control', side: 'server',
    help: 'A filesystem path built from req.params/query/body/headers. Reduce it with path.basename or a safe-name check, then confirm it stays inside the intended directory.',
  },
  'auth-skip': {
    owasp: 'A01 Broken Access Control', side: 'server',
    help: 'A new unauthenticated bypass (req._skipAuth). Every public route needs its own review; record why it is public.',
  },
  'weak-hash': {
    owasp: 'A02 Cryptographic Failures', side: 'server',
    help: 'MD5/SHA-1. Use sha256 or better. Content fingerprints that are not security decisions can be suppressed with a reason.',
  },
  'insecure-random': {
    owasp: 'A02 Cryptographic Failures', side: 'server',
    help: 'Math.random() on the server. Use crypto.randomBytes/randomUUID/randomInt for anything an attacker could benefit from guessing.',
  },
  'weak-crypto': {
    owasp: 'A02 Cryptographic Failures', side: 'any',
    help: 'Deprecated or unsafe crypto: createCipher (no IV), ECB mode, TLS verification turned off.',
  },
  'jwt-unsafe': {
    owasp: 'A07 Identification and Authentication Failures', side: 'server',
    help: 'jwt.verify without an explicit algorithms list, or jwt.decode (unverified). Pin algorithms.',
  },
  'timing-compare': {
    owasp: 'A07 Identification and Authentication Failures', side: 'server',
    help: 'A secret (token/signature/hmac/key/password) compared with === or !==. Use crypto.timingSafeEqual on equal-length buffers.',
  },
  'bcrypt-low-cost': {
    owasp: 'A07 Identification and Authentication Failures', side: 'server',
    help: 'bcrypt cost below 10.',
  },
  'hardcoded-secret': {
    owasp: 'A07 Identification and Authentication Failures', side: 'any',
    help: 'A credential-looking literal (private key, live API key, or a secret/password property set to a literal). Load it from config/env.',
  },
  'cors-permissive': {
    owasp: 'A05 Security Misconfiguration', side: 'server',
    help: 'CORS that reflects any origin (origin: true / "*" / req.headers.origin) together with credentials.',
  },
  'security-header-off': {
    owasp: 'A05 Security Misconfiguration', side: 'server',
    help: 'A helmet protection switched off, or a security header removed.',
  },
  'cookie-flags': {
    owasp: 'A05 Security Misconfiguration', side: 'server',
    help: 'res.cookie without httpOnly: true and an explicit sameSite.',
  },
  'dynamic-require': {
    owasp: 'A08 Software and Data Integrity Failures', side: 'server',
    help: 'require()/import() of a computed path. Only load code from fixed paths or a verified plugin directory.',
  },
  'log-secret': {
    owasp: 'A09 Security Logging and Monitoring Failures', side: 'server',
    help: 'A credential-looking value passed to console/logger. Log a fingerprint or a length, never the value.',
  },
  'parse-error': {
    owasp: 'scanner', side: 'any',
    help: 'The scanner could not parse this file, so nothing in it was checked.',
  },
};

/* ------------------------------------------------------------------------------------------------
 * Files.
 * ---------------------------------------------------------------------------------------------- */
const SCAN_ROOTS = [
  { dir: 'server', side: 'server' },
  { dir: 'server/player', side: 'client' }, // served to the browser
  { dir: 'frontend', side: 'client' },
];
const EXCLUDE = [
  /(^|\/)node_modules\//,
  /^server\/test\//,
  /(^|\/)vendor\//,
  /^frontend\/js\/i18n\//,         // translation tables, strings only
  /\.min\.js$/,
  /^server\/player\/legacy\.html$/, // generated from index.html (build-legacy-player.js)
  /-legacy\.js$/,                   // generated by esbuild from the sources we do scan
  /^server\/firmware\//,
  /^server\/db\/.*\.db/,
  /^server\/scripts\/security-scan\.js$/, // this file: its docs quote the patterns it looks for
  /^server\/smoke-ui\.js$/,              // local dev smoke driver against localhost
];
// Files whose job is the thing the rule forbids. Keep this list tiny and explain each entry.
const RULE_EXEMPT_FILES = {
  'ssrf-outbound': [
    'server/lib/ssrf-guard.js', // the guard itself
  ],
  'code-eval': [],
};

// Browser code inside server/ that is not under server/player.
const CLIENT_FILES_IN_SERVER = [/^server\/player\//];

function listFiles() {
  const out = new Map();
  const visit = (rel, side) => {
    const abs = path.join(REPO, rel);
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) visit(path.posix.join(rel, name), side);
      return;
    }
    if (!/\.(c?js|mjs|html)$/.test(rel)) return;
    if (EXCLUDE.some((re) => re.test(rel))) return;
    if (rel.startsWith('server/') && !rel.startsWith('server/player/') && rel.endsWith('.html')) return;
    let s = side;
    if (CLIENT_FILES_IN_SERVER.some((re) => re.test(rel))) s = 'client';
    out.set(rel, s);
  };
  for (const r of SCAN_ROOTS) visit(r.dir, r.side);
  return [...out.entries()].map(([rel, side]) => ({ rel, side }));
}

/* ------------------------------------------------------------------------------------------------
 * Parsing. HTML files contribute their inline <script> blocks, with line numbers preserved.
 * ---------------------------------------------------------------------------------------------- */
function sources(rel, text) {
  if (!rel.endsWith('.html')) return [{ code: text, lineOffset: 0 }];
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;
    const before = text.slice(0, m.index + m[0].indexOf('>') + 1);
    out.push({ code: m[2], lineOffset: before.split('\n').length - 1 });
  }
  return out;
}

function parse(code) {
  const opts = {
    ecmaVersion: 'latest', locations: true, allowHashBang: true,
    allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true,
  };
  const comments = [];
  try {
    return { ast: acorn.parse(code, { ...opts, sourceType: 'module', onComment: comments }), comments };
  } catch (e1) {
    comments.length = 0;
    try {
      return { ast: acorn.parse(code, { ...opts, sourceType: 'script', onComment: comments }), comments };
    } catch (e2) {
      return { error: e2 };
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Value analysis. `safety(node, mode)` answers: can this expression carry attacker-controlled text?
 *   mode 'html':  safe = constant, number, or passed through an escaping function.
 *   mode 'const': safe = built only from constants (escaping does NOT count). Used for SQL.
 * Identifiers and same-file functions are followed one hop at a time with a cycle guard.
 * ---------------------------------------------------------------------------------------------- */
const ESCAPERS = /^(esc|escape|escHtml|escapeHtml|escapeHTML|htmlEscape|escapeAttr|escAttr|escapeXml|xmlEscape|escXml|attr|escapeAttribute|sanitizeHtml|sanitize|DOMPurify\.sanitize|encodeURIComponent|encodeURI|safeJson|jsonForScript|scriptJson|JSON_for_script|cssEscape|CSS\.escape|qrSvg|safeHtml)$/;
const NUMERIC_CALLS = /^(Number|parseInt|parseFloat|Math\.\w+|Date\.now|isFinite|Boolean|String\.fromCharCode)$/;
const NUMERIC_METHODS = /^(toFixed|toPrecision|getTime|valueOf|indexOf|lastIndexOf|findIndex|getFullYear|getMonth|getDate|getHours|getMinutes|getSeconds|getDay|getUTCHours|getUTCMinutes|getTimezoneOffset)$/;
const NUMERIC_PROPS = /^(length|size|width|height|naturalWidth|naturalHeight|byteLength|count|total|duration|index|idx|i|n|x|y|w|h|left|top|right|bottom|opacity|zIndex|z|r|percent|pct|progress|offsetWidth|offsetHeight|clientWidth|clientHeight|scrollTop|scrollHeight)$/;
const PASSTHROUGH_METHODS = /^(join|trim|trimStart|trimEnd|toUpperCase|toLowerCase|toLocaleUpperCase|toLocaleLowerCase|padStart|padEnd|repeat|concat|slice|substring|substr|flat|filter|reverse|sort|toString)$/;
const I18N = /^(t|tr|i18n\.t|__)$/;

function calleeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    const obj = calleeName(node.object);
    return obj ? `${obj}.${node.property.name}` : node.property.name;
  }
  if (node.type === 'ThisExpression') return 'this';
  return '';
}
function propName(node) {
  if (node.type !== 'MemberExpression') return '';
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal') return String(node.property.value);
  return '';
}

function makeAnalyzer(ast) {
  // name -> list of value nodes it is ever given (declarations, assignments, +=)
  const bindings = new Map();
  // name -> list of function nodes
  const functions = new Map();
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  walk.full(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') {
      if (n.init && /Function/.test(n.init.type)) add(functions, n.id.name, n.init);
      else add(bindings, n.id.name, n.init || { type: 'Literal', value: '' });
    } else if (n.type === 'FunctionDeclaration' && n.id) {
      add(functions, n.id.name, n);
    } else if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') {
      add(bindings, n.left.name, n.right);
    }
  });

  // child_process: namespace identifiers and destructured function names
  const cpObjects = new Set();
  const cpNames = new Set();
  const isCpRequire = (x) => x && x.type === 'CallExpression' && calleeName(x.callee) === 'require'
    && x.arguments[0] && x.arguments[0].type === 'Literal' && /^(node:)?child_process$/.test(String(x.arguments[0].value));
  walk.full(ast, (n) => {
    if (n.type === 'VariableDeclarator' && isCpRequire(n.init)) {
      if (n.id.type === 'Identifier') cpObjects.add(n.id.name);
      if (n.id.type === 'ObjectPattern') for (const p of n.id.properties) if (p.type === 'Property') cpNames.add(p.value.type === 'Identifier' ? p.value.name : p.key.name);
    }
    if (n.type === 'ImportDeclaration' && /^(node:)?child_process$/.test(String(n.source.value))) {
      for (const sp of n.specifiers) {
        if (sp.type === 'ImportSpecifier') cpNames.add(sp.local.name);
        else cpObjects.add(sp.local.name);
      }
    }
  });

  const memo = new Map();
  const inProgress = new Set();

  function returnsOf(fn) {
    if (fn.expression) return [fn.body];
    const out = [];
    walk.recursive(fn.body, null, {
      Function() {}, // do not descend into nested functions
      ReturnStatement(n) { out.push(n.argument || { type: 'Literal', value: '' }); },
    });
    return out;
  }

  function safety(node, mode) {
    if (!node) return true;
    const key = mode + ':' + node.start + ':' + node.end;
    if (memo.has(key)) return memo.get(key);
    if (inProgress.has(key)) return true; // cycle: judged by the other branches
    inProgress.add(key);
    const r = compute(node, mode);
    inProgress.delete(key);
    memo.set(key, r);
    return r;
  }

  function compute(n, mode) {
    switch (n.type) {
      case 'Literal': return true;
      case 'TemplateLiteral': return n.expressions.every((e) => safety(e, mode));
      case 'TaggedTemplateExpression': {
        const tag = calleeName(n.tag);
        if (mode === 'html' && /^(html|safeHtml|sql)$/.test(tag)) return true;
        return false;
      }
      case 'BinaryExpression':
        if (n.operator === '+') return safety(n.left, mode) && safety(n.right, mode);
        return true; // arithmetic and comparisons yield numbers/booleans
      case 'UnaryExpression': return true;
      case 'UpdateExpression': return true;
      case 'LogicalExpression':
        if (n.operator === '&&') return safety(n.right, mode); // a falsy left renders as nothing harmful
        return safety(n.left, mode) && safety(n.right, mode);
      case 'ConditionalExpression': return safety(n.consequent, mode) && safety(n.alternate, mode);
      case 'SequenceExpression': return safety(n.expressions[n.expressions.length - 1], mode);
      case 'AwaitExpression': return safety(n.argument, mode);
      case 'ParenthesizedExpression': return safety(n.expression, mode);
      case 'ArrayExpression': return n.elements.every((e) => !e || safety(e.type === 'SpreadElement' ? e.argument : e, mode));
      case 'Identifier': {
        if (n.name === 'undefined' || n.name === 'NaN' || n.name === 'Infinity') return true;
        if (mode === 'html' && /^(i|j|k|n|idx|index|count|total|len|pct|percent|w|h|x|y|width|height)$/.test(n.name)) return true;
        const vals = bindings.get(n.name);
        if (!vals || !vals.length) return false; // a parameter or a global: unknown
        return vals.every((v) => safety(v, mode));
      }
      case 'MemberExpression': {
        const p = propName(n);
        if (NUMERIC_PROPS.test(p)) return true;
        // CONSTANT_TABLE[x] / CONSTS.name where the object is a const object/array of literals
        if (n.object.type === 'Identifier') {
          const vals = bindings.get(n.object.name);
          const unwrap = (v) => (v && v.type === 'CallExpression' && calleeName(v.callee) === 'Object.freeze' && v.arguments[0]) ? v.arguments[0] : v;
          if (vals && vals.length && vals.map(unwrap).every((v) => (v.type === 'ObjectExpression' || v.type === 'ArrayExpression') && constContainer(v, mode))) return true;
        }
        return false;
      }
      case 'CallExpression':
      case 'NewExpression': {
        const name = calleeName(n.callee);
        const last = name.split('.').pop();
        if (mode === 'html' && (ESCAPERS.test(name) || ESCAPERS.test(last))) return true;
        if (NUMERIC_CALLS.test(name)) return true;
        if (mode === 'html' && I18N.test(name)) return n.arguments.length <= 1 || n.arguments.slice(1).every((a) => safety(a, mode));
        if (name === 'Array.from' && n.arguments[1] && /Function/.test(n.arguments[1].type)) return returnsOf(n.arguments[1]).every((r) => safety(r, mode));
        if (name === 'Object.freeze' && n.arguments[0]) return safety(n.arguments[0], mode);
        if (n.callee.type === 'MemberExpression') {
          const m = propName(n.callee);
          if (NUMERIC_METHODS.test(m)) return true;
          if (m === 'map' || m === 'flatMap') {
            const cb = n.arguments[0];
            if (cb && /Function/.test(cb.type)) return returnsOf(cb).every((r) => safety(r, mode));
            return false;
          }
          if (m === 'fill') return n.arguments.length > 0 && safety(n.arguments[0], mode);
          if (m === 'replace' || m === 'replaceAll') {
            // "a".replace(x, y): result is safe if the receiver and the replacement are
            return safety(n.callee.object, mode) && (n.arguments[1] ? (/Function/.test(n.arguments[1].type) ? returnsOf(n.arguments[1]).every((r) => safety(r, mode)) : safety(n.arguments[1], mode)) : true);
          }
          if (PASSTHROUGH_METHODS.test(m)) {
            if (!safety(n.callee.object, mode)) return false;
            return n.arguments.every((a) => a.type === 'Literal' || safety(a, mode));
          }
          if (m === 'toLocaleString' || m === 'toLocaleDateString' || m === 'toLocaleTimeString' || m === 'toISOString') return mode === 'html';
          if (m === 'stringify' && name === 'JSON.stringify') return false; // JSON can contain </script> and quotes
        }
        if (n.callee.type === 'Identifier' && functions.has(n.callee.name)) {
          return functions.get(n.callee.name).every((fn) => returnsOf(fn).every((r) => safety(r, mode)));
        }
        if (/Function/.test(n.callee.type)) return returnsOf(n.callee).every((r) => safety(r, mode));
        return false;
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return true; // a function is not text
      default:
        return false;
    }
  }

  function constContainer(v, mode) {
    if (v.type === 'ArrayExpression') return v.elements.every((e) => !e || (e.type !== 'SpreadElement' && (e.type === 'Literal' || e.type === 'TemplateLiteral' && !e.expressions.length || (e.type === 'ObjectExpression' && constContainer(e, mode)))));
    return v.properties.every((p) => p.type === 'Property' && (p.value.type === 'Literal' || (p.value.type === 'TemplateLiteral' && !p.value.expressions.length) || ((p.value.type === 'ObjectExpression' || p.value.type === 'ArrayExpression') && constContainer(p.value, mode)) || /Function/.test(p.value.type)));
  }

  // modules this file loads (for libraries like axios whose names are common words)
  const requires = new Set();
  walk.full(ast, (n) => {
    if (n.type === 'CallExpression' && calleeName(n.callee) === 'require' && n.arguments[0] && n.arguments[0].type === 'Literal') requires.add(String(n.arguments[0].value));
    if (n.type === 'ImportDeclaration') requires.add(String(n.source.value));
  });

  return { safety, bindings, functions, cpObjects, cpNames, requires };
}

/* ------------------------------------------------------------------------------------------------
 * Helpers for specific rules.
 * ---------------------------------------------------------------------------------------------- */
const REQ_TAINT = /\breq\.(params|query|body|headers|cookies|path|url|originalUrl|file|files)\b|\breq\.get\(/;
// Names that hold a credential. Content digests and nonces are deliberately NOT here: comparing a
// file's sha256 or an OIDC nonce with === leaks nothing an attacker can use.
const SECRETY = /(^|_|[a-z])(token|secret|signature|hmac|apikey|api_key|apiKey|password|passwd|passphrase|privatekey|private_key|privateKey|totp|csrf)$/i;
const NOT_SECRET_NAME = /(length|count|type|id|ids|name|names|expires|expiry|exp|at|url|uri|path|hint|label|kind|mode|enabled|required|set|present|hash|hashed|Hash|status|version|prefix|scope|scopes|header|field|key_id|keyId|ttl|len|valid|ok|error|err|Error)$/;

function fixedOrigin(node) {
  // A URL is "fixed" when its text starts with a literal http(s)://host/ (or is a literal).
  const first = node.type === 'Literal' ? String(node.value)
    : node.type === 'TemplateLiteral' ? node.quasis[0].value.cooked
    : node.type === 'BinaryExpression' && node.operator === '+' ? leftmostString(node) : null;
  if (first == null) return false;
  if (node.type === 'Literal') return true;
  return /^https?:\/\/[^/${}\s]+\//i.test(first) || /^https?:\/\/[^/${}\s]+$/i.test(first) && node.type === 'Literal';
}
function leftmostString(n) {
  while (n.type === 'BinaryExpression' && n.operator === '+') n = n.left;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis[0].value.cooked;
  return null;
}
function fixedPath(node) {
  // A redirect/URL target that is a same-origin path we wrote: literal, or a template/concat whose
  // leading literal is "/" followed by a character that is not "/" or "\".
  const s = node.type === 'Literal' ? (typeof node.value === 'string' ? node.value : null)
    : node.type === 'TemplateLiteral' ? node.quasis[0].value.cooked
    : node.type === 'BinaryExpression' && node.operator === '+' ? leftmostString(node) : null;
  if (s == null) return false;
  if (node.type === 'Literal') return !/^\s*javascript:/i.test(s);
  return /^\/[^/\\]/.test(s) || /^#/.test(s) || /^\?/.test(s) || /^https?:\/\/[^/${}\s]+\//i.test(s) || /^(mailto|tel):/i.test(s);
}

function enclosingFunction(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) if (/Function/.test(ancestors[i].type)) return ancestors[i];
  return ancestors[0];
}
function containsCall(root, re) {
  let found = false;
  walk.full(root, (n) => {
    if (found) return;
    if (n.type === 'CallExpression' && re.test(calleeName(n.callee))) found = true;
    if (n.type === 'Identifier' && re.test(n.name)) found = true;
  });
  return found;
}
function objProp(obj, name) {
  if (!obj || obj.type !== 'ObjectExpression') return undefined;
  for (const p of obj.properties) {
    if (p.type !== 'Property') continue;
    const k = p.key.type === 'Identifier' ? p.key.name : p.key.value;
    if (k === name) return p.value;
  }
  return undefined;
}
function looksLikeHtml(quasis) {
  return quasis.some((q) => /<\/?[a-zA-Z][\w-]*[\s>/]|<!--/.test(q.value.cooked || ''));
}

/* ------------------------------------------------------------------------------------------------
 * The scan of one parsed source.
 * ---------------------------------------------------------------------------------------------- */
function scanSource({ rel, side, code, lineOffset, ast, comments }) {
  const findings = [];
  const lines = code.split('\n');
  const an = makeAnalyzer(ast);
  const applies = (rule) => {
    const s = RULES[rule].side;
    if (s !== 'any' && s !== side) return false;
    if ((RULE_EXEMPT_FILES[rule] || []).includes(rel)) return false;
    return true;
  };

  // Suppressions: `security-ok(rule): reason` in a comment on the same line or the line above.
  const suppress = new Map(); // line -> Set(rule)
  const badSuppressions = [];
  for (const c of comments) {
    const re = /security-ok\(([\w,\s-]+)\)\s*:?\s*(.*)/g;
    let m;
    while ((m = re.exec(c.value))) {
      const rules = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const reason = m[2].replace(/\*\/\s*$/, '').trim();
      const line = c.loc.end.line;
      for (const r of rules) {
        if (!RULES[r] || reason.length < 10) { badSuppressions.push({ line: c.loc.start.line, rule: r, reason }); continue; }
        for (const l of [line, line + 1]) {
          if (!suppress.has(l)) suppress.set(l, new Set());
          suppress.get(l).add(r);
        }
      }
    }
  }

  const report = (rule, node, detail) => {
    if (!applies(rule)) return;
    const line = node.loc.start.line;
    if (suppress.get(line)?.has(rule)) return;
    const raw = code.slice(node.start, Math.min(node.end, node.start + 400));
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
    findings.push({ rule, file: rel, line: line + lineOffset, snippet, detail: detail || '' });
  };
  for (const b of badSuppressions) {
    findings.push({ rule: 'parse-error', file: rel, line: b.line + lineOffset, snippet: `security-ok(${b.rule}) ${b.reason}`, detail: 'unknown rule or reason shorter than 10 characters' });
  }

  walk.ancestor(ast, {
    AssignmentExpression(n, _st, anc) {
      const p = propName(n.left);
      // DOM HTML sinks
      if ((p === 'innerHTML' || p === 'outerHTML') && !an.safety(n.right, 'html')) report('dom-html-sink', n);
      // srcdoc is an HTML sink too
      if (p === 'srcdoc' && !an.safety(n.right, 'html')) report('dom-html-sink', n);
      // URL sinks
      const isLocation = n.left.type === 'Identifier' && n.left.name === 'location'
        || n.left.type === 'MemberExpression' && /(^|\.)location$/.test(calleeName(n.left.object)) && p === 'href'
        || n.left.type === 'MemberExpression' && /^(window|document|self|top|parent)$/.test(calleeName(n.left.object)) && p === 'location';
      if ((isLocation || /^(href|src|action|formAction|data)$/.test(p)) && n.operator === '=') {
        // javascript: does not run from <img>/<video>/<audio>/<source> src, so media elements are not URL sinks
        const recv = n.left.type === 'MemberExpression' ? code.slice(n.left.object.start, n.left.object.end) : '';
        const media = p === 'src' && /(img|image|video|audio|poster|thumb|pic|photo|icon|source|media|preview|logo|avatar)\w*$/i.test(recv);
        const selfReload = n.right.type === 'MemberExpression' && code.slice(n.right.start, n.right.end) === code.slice(n.left.start, n.left.end);
        const blob = n.right.type === 'CallExpression' && /createObjectURL$/.test(calleeName(n.right.callee));
        if (!media && !selfReload && !blob && !fixedPath(n.right) && !an.safety(n.right, 'const') && !urlChecked(n.right, anc)) report('url-sink', n);
      }
      // req._skipAuth = true
      if (p === '_skipAuth' && n.right.type === 'Literal' && n.right.value === true) report('auth-skip', n);
    },

    CallExpression(n, _st, anc) {
      const name = calleeName(n.callee);
      const last = name.split('.').pop();
      const a0 = n.arguments[0];

      // --- XSS (client) ---
      if (last === 'insertAdjacentHTML' && n.arguments[1] && !an.safety(n.arguments[1], 'html')) report('dom-html-sink', n);
      if (/^(document\.)?(write|writeln)$/.test(name) && name.startsWith('document') && a0 && !an.safety(a0, 'html')) report('dom-html-sink', n);
      if (last === 'createContextualFragment' && a0 && !an.safety(a0, 'html')) report('dom-html-sink', n);
      if (last === 'parseFromString' && a0 && !an.safety(a0, 'html')) report('dom-html-sink', n);
      if (last === 'setAttribute' && a0 && a0.type === 'Literal') {
        const attr = String(a0.value).toLowerCase();
        const v = n.arguments[1];
        if (/^on/.test(attr) && v && !an.safety(v, 'const')) report('dom-html-sink', n);
        if (/^(href|src|action|formaction|xlink:href)$/.test(attr) && v && !fixedPath(v) && !an.safety(v, 'const') && !urlChecked(v, anc)) report('url-sink', n);
        if (attr === 'srcdoc' && v && !an.safety(v, 'html')) report('dom-html-sink', n);
      }
      if ((name === 'window.open' || name === 'open' && side === 'client') && a0 && !fixedPath(a0) && !an.safety(a0, 'const') && !urlChecked(a0, anc)) report('url-sink', n);
      if (/(^|\.)location\.(assign|replace)$/.test(name) && a0 && !fixedPath(a0) && !an.safety(a0, 'const') && !urlChecked(a0, anc)) report('url-sink', n);

      // --- code eval ---
      if (name === 'eval' || name === 'window.eval' || name === 'Function') report('code-eval', n);
      if (/^(window\.)?(setTimeout|setInterval)$/.test(name) && a0 && (a0.type === 'Literal' && typeof a0.value === 'string' || a0.type === 'TemplateLiteral' || a0.type === 'BinaryExpression')) report('code-eval', n);
      if (/^(vm\.)?(runInNewContext|runInThisContext|runInContext|compileFunction)$/.test(name) && (name.startsWith('vm.') || an.bindings.has('vm'))) report('code-eval', n);

      // --- SQL ---
      if ((last === 'prepare' || (last === 'exec' && /(^|\.)(db|database|conn|sqlite|tx|handle|this\.db|\w*Db|\w*DB)$/.test(name.split('.').slice(0, -1).join('.'))) || last === 'pragma') && n.callee.type === 'MemberExpression' && a0) {
        if (!an.safety(a0, 'const')) report('sql-dynamic', n);
      }

      // --- OS command ---
      const cpFn = n.callee.type === 'Identifier' && an.cpNames.has(n.callee.name) ? n.callee.name
        : n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && an.cpObjects.has(n.callee.object.name) ? propName(n.callee) : '';
      if (/^(exec|execSync)$/.test(cpFn) && a0 && !an.safety(a0, 'const')) report('cmd-injection', n);
      if (/^(spawn|spawnSync|execFile|execFileSync|fork)$/.test(cpFn)) {
        const opts = n.arguments.find((a) => a.type === 'ObjectExpression');
        const sh = objProp(opts, 'shell');
        if (sh && !(sh.type === 'Literal' && sh.value === false)) report('cmd-injection', n);
      }

      // --- regex ---
      if ((name === 'RegExp') && a0 && !an.safety(a0, 'const') && !containsCall(a0, /escape(RegExp|Regex|Re)?$|escapeRegExp|reEscape|escRe/i)) report('regex-dynamic', n);

      // --- SSRF ---
      if (isOutbound(name, n, an) && a0) {
        const target = a0.type === 'ObjectExpression' ? (objProp(a0, 'hostname') || objProp(a0, 'host') || objProp(a0, 'url')) : a0;
        const fixed = target ? (fixedOrigin(target) || an.safety(target, 'const') || constUrlBinding(target, an)) : true;
        if (!fixed && !ssrfGuarded(n, anc)) report('ssrf-outbound', n);
      }

      // --- redirects ---
      if (/^res\w*\.(redirect|location)$/.test(name) || /^(reply|ctx)\.redirect$/.test(name)) {
        const target = n.arguments[n.arguments.length - 1];
        if (target && !fixedPath(target) && !an.safety(target, 'const') && !urlChecked(target, anc)) report('open-redirect', n);
      }
      if (/\.(setHeader|set|header)$/.test(name) && /^res/.test(name) && a0 && a0.type === 'Literal' && /^location$/i.test(String(a0.value))) {
        const v = n.arguments[1];
        if (v && !fixedPath(v) && !an.safety(v, 'const') && !urlChecked(v, anc)) report('open-redirect', n);
      }

      // --- path traversal ---
      {
        let pathArgs = null;
        if (/^path\.(join|resolve)$/.test(name)) pathArgs = n.arguments;
        else if (/^res\w*\.(sendFile|download)$/.test(name)) pathArgs = n.arguments.slice(0, 1);
        else if (/^(fs|fsp|fs\.promises|promises|fsPromises)\.(rename|renameSync|copyFile|copyFileSync|symlink|symlinkSync|link|linkSync|cp|cpSync)$/.test(name)) pathArgs = n.arguments.slice(0, 2);
        else if (/^(fs|fsp|fs\.promises|promises|fsPromises)\.\w+$/.test(name)) pathArgs = n.arguments.slice(0, 1);
        if (pathArgs) {
          const fnText = code.slice(enclosingFunction(anc).start, enclosingFunction(anc).end);
          for (const a of pathArgs) {
            const txt = code.slice(a.start, a.end);
            const m = txt.match(/req\.(params|query|body|headers|cookies)(\.\w+|\[[^\]]+\])?/);
            if (!m) continue;
            if (/path\.basename\(|safeName|sanitizeFilename|safeFilename|isSafeName|SAFE_NAME|\.replace\(\/\[\^/.test(txt)) continue;
            // looked up in an allowlist first: ALLOWED.has(req.params.name) / .includes(...)
            if (fnText.includes(`.has(${m[0]})`) || fnText.includes(`.includes(${m[0]})`)) continue;
            report('path-traversal', n);
            break;
          }
        }
      }

      // --- crypto ---
      if (last === 'createHash' && a0 && a0.type === 'Literal' && /^(md5|sha1|md4|ripemd160)$/i.test(String(a0.value))) report('weak-hash', n);
      if (last === 'createHmac' && a0 && a0.type === 'Literal' && /^(md5|md4)$/i.test(String(a0.value))) report('weak-hash', n);
      if (name === 'Math.random') report('insecure-random', n);
      if (/^(crypto\.)?(createCipher|createDecipher)$/.test(name)) report('weak-crypto', n);
      if (/^(crypto\.)?(createCipheriv|createDecipheriv)$/.test(name) && a0 && a0.type === 'Literal' && /ecb/i.test(String(a0.value))) report('weak-crypto', n);

      // --- JWT ---
      if (/^(jwt|jsonwebtoken)\.verify$/.test(name)) {
        const opts = n.arguments[2];
        if (!opts || opts.type !== 'ObjectExpression' || !objProp(opts, 'algorithms')) report('jwt-unsafe', n);
      }
      if (/^(jwt|jsonwebtoken)\.decode$/.test(name)) report('jwt-unsafe', n);

      // --- bcrypt ---
      if (/^(bcrypt|bcryptjs)\.(hash|hashSync|genSalt|genSaltSync)$/.test(name)) {
        const cost = /genSalt/.test(name) ? a0 : n.arguments[1];
        if (cost && cost.type === 'Literal' && typeof cost.value === 'number' && cost.value < 10) report('bcrypt-low-cost', n);
      }

      // --- CORS ---
      if (name === 'cors' && a0 && a0.type === 'ObjectExpression') {
        const o = objProp(a0, 'origin');
        const c = objProp(a0, 'credentials');
        const any = o && (o.type === 'Literal' && (o.value === true || o.value === '*'));
        if (any && c && c.type === 'Literal' && c.value === true) report('cors-permissive', n);
      }
      if (/\.(setHeader|set|header)$/.test(name) && a0 && a0.type === 'Literal' && /^access-control-allow-origin$/i.test(String(a0.value))) {
        const v = n.arguments[1];
        const txt = v ? code.slice(v.start, v.end) : '';
        if (/req\.headers\.origin|req\.get\(['"]origin['"]\)|req\.header\(['"]origin['"]\)/i.test(txt)) {
          const fn = enclosingFunction(anc);
          if (!containsCall(fn, /allow(ed)?Origins?|ORIGIN_ALLOW|isAllowedOrigin|originAllowed|trustedOrigin/i)) report('cors-permissive', n);
        }
      }

      // --- headers off ---
      if (name === 'helmet' && a0 && a0.type === 'ObjectExpression') {
        for (const p of a0.properties) {
          if (p.type === 'Property' && p.value.type === 'Literal' && p.value.value === false) report('security-header-off', p, (p.key.name || p.key.value));
        }
      }
      if (/\.removeHeader$/.test(name) && a0 && a0.type === 'Literal' && /^(content-security-policy|x-frame-options|strict-transport-security|x-content-type-options)$/i.test(String(a0.value))) report('security-header-off', n);

      // --- cookies ---
      if (/^res\w*\.cookie$/.test(name)) {
        const opts = n.arguments[2];
        const ho = objProp(opts, 'httpOnly');
        const ss = objProp(opts, 'sameSite');
        if (!opts || opts.type !== 'ObjectExpression' ? true : !(ho && ho.type === 'Literal' && ho.value === true) || !ss) {
          if (!(opts && opts.type !== 'ObjectExpression')) report('cookie-flags', n); // a shared options const is reviewed where it is defined
        }
      }

      // --- dynamic require ---
      if (name === 'require' && a0 && !an.safety(a0, 'const') && a0.type !== 'Literal') report('dynamic-require', n);

      // --- logging secrets ---
      if (/^(console\.(log|info|warn|error|debug)|log|logger\.\w+|this\.log)$/.test(name)) {
        for (const a of n.arguments) {
          if (mentionsSecret(a)) { report('log-secret', n); break; }
        }
      }
    },

    NewExpression(n) {
      const name = calleeName(n.callee);
      if (name === 'Function') report('code-eval', n);
      if (/^(vm\.)?Script$/.test(name) && (name.startsWith('vm.') || an.bindings.has('vm'))) report('code-eval', n);
      if (name === 'RegExp' && n.arguments[0] && !an.safety(n.arguments[0], 'const') && !containsCall(n.arguments[0], /escape(RegExp|Regex|Re)?$|escapeRegExp|reEscape|escRe/i)) report('regex-dynamic', n);
    },

    ImportExpression(n) {
      if (side === 'server' && n.source && !an.safety(n.source, 'const')) report('dynamic-require', n);
    },

    TemplateLiteral(n, _st, anc) {
      if (side === 'server' && n.quasis.some((q) => /<script\b/i.test(q.value.raw))) scanEmbeddedScripts(n);
      if (side !== 'server' || !n.expressions.length || !looksLikeHtml(n.quasis)) return;
      const parent = anc[anc.length - 2];
      if (parent && parent.type === 'TaggedTemplateExpression') return;
      // SQL text that happens to contain "<" is not HTML; skip templates passed straight to prepare()
      if (parent && parent.type === 'CallExpression' && /prepare|exec$/.test(calleeName(parent.callee))) return;
      const bad = n.expressions.filter((e) => !an.safety(e, 'html'));
      if (bad.length) report('server-html-interp', n, bad.map((e) => code.slice(e.start, e.end).slice(0, 40)).join(' | '));
    },

    BinaryExpression(n) {
      if (n.operator !== '===' && n.operator !== '!==' && n.operator !== '==' && n.operator !== '!=') return;
      const isSecret = (x) => {
        const nm = x.type === 'Identifier' ? x.name : x.type === 'MemberExpression' ? propName(x) : '';
        return nm && SECRETY.test(nm) && !NOT_SECRET_NAME.test(nm);
      };
      const trivial = (x) => x.type === 'Literal' || x.type === 'UnaryExpression' || x.type === 'Identifier' && /^(undefined|null)$/.test(x.name) || x.type === 'TemplateLiteral' && !x.expressions.length;
      if ((isSecret(n.left) && !trivial(n.right)) || (isSecret(n.right) && !trivial(n.left))) report('timing-compare', n);
    },

    Property(n) {
      const k = n.key && (n.key.type === 'Identifier' ? n.key.name : n.key.value);
      if (k === 'rejectUnauthorized' && n.value.type === 'Literal' && n.value.value === false) report('weak-crypto', n);
      if (typeof k === 'string' && /^(secret|password|passwd|apiKey|api_key|clientSecret|client_secret|privateKey|private_key|jwtSecret|token|accessToken|access_token|authToken)$/i.test(k)
        && n.value.type === 'Literal' && typeof n.value.value === 'string' && looksLikeRealSecret(n.value.value)) report('hardcoded-secret', n);
    },

    Literal(n) {
      if (typeof n.value !== 'string') return;
      if (/-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(n.value)
        || /\b(sk_live_[0-9a-zA-Z]{16,}|rk_live_[0-9a-zA-Z]{16,}|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{40,}|xox[bpa]-[0-9A-Za-z-]{20,}|AIza[0-9A-Za-z_-]{35}|sk-ant-[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{40,})\b/.test(n.value)) report('hardcoded-secret', n);
    },
  });

  // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  walk.simple(ast, {
    AssignmentExpression(n) {
      if (propName(n.left) === 'NODE_TLS_REJECT_UNAUTHORIZED') report('weak-crypto', n);
    },
  });

  return findings;

  /* -- closures over this source -- */
  function scanEmbeddedScripts(n) {
    // Browser code the server sends inside an HTML template (widget and kiosk renders). This is
    // where GHSA-g46x lived: `window.location.href = page` in a page the server built. Each ${...}
    // becomes an unknown identifier, so a value that came from the template is treated as unsafe.
    let text = '';
    n.quasis.forEach((q, i) => { text += q.value.raw; if (i < n.expressions.length) text += '__TPL__'; });
    text = text.replace(/\\`/g, '`').replace(/\\\$\{/g, '${').replace(/\\\\/g, '\\');
    for (const src of sources('embedded.html', text)) {
      const p = parse(src.code);
      if (p.error) continue; // a fragment assembled across several templates; nothing to check alone
      const inner = scanSource({ rel, side: 'client', code: src.code, lineOffset: lineOffset + n.loc.start.line - 1 + src.lineOffset, ast: p.ast, comments: p.comments });
      for (const f of inner) if (f.rule !== 'parse-error') findings.push(f);
    }
  }
  function urlChecked(node, anc) {
    // A URL value is accepted when the enclosing function visibly vets the scheme, or when the value
    // comes from a same-file function that does (siteUrl(page) in the kiosk fix).
    const CHECK = /safeUrl|safeHref|sanitizeUrl|isSafeUrl|isHttpUrl|httpUrl|allowedUrl|isAllowedUrl|assertSafeUrl|parseSafeUrl|SAFE_SCHEMES|SAFE_PROTOCOLS|\/\^https\?:|\/\^\(https\?|protocol\s*(===|!==)\s*['"]https?:|\.protocol\)|\['https?:'|\["https?:"|startsWith\(['"]https?:|startsWith\(['"]\/['"]\)/;
    const fn = enclosingFunction(anc);
    if (CHECK.test(code.slice(fn.start, fn.end))) return true;
    const seen = new Set();
    const fromChecker = (v) => {
      if (!v || seen.has(v)) return false;
      seen.add(v);
      if (v.type === 'CallExpression' && v.callee.type === 'Identifier') {
        const fns = an.functions.get(v.callee.name);
        if (fns && fns.every((f) => CHECK.test(code.slice(f.start, f.end)))) return true;
      }
      if (v.type === 'Identifier') {
        const vals = an.bindings.get(v.name);
        return !!(vals && vals.length && vals.every(fromChecker));
      }
      if (v.type === 'LogicalExpression' || v.type === 'ConditionalExpression') {
        const parts = v.type === 'LogicalExpression' ? [v.left, v.right] : [v.consequent, v.alternate];
        return parts.every((x) => fromChecker(x) || fixedPath(x) || an.safety(x, 'const'));
      }
      return false;
    };
    return fromChecker(node);
  }
  function ssrfGuarded(n, anc) {
    const fn = enclosingFunction(anc);
    if (containsCall(fn, /^(assertSafeUrl|parseSafeUrl|guardedRequest|pinnedLookup|isBlockedFor|guardedFetch|safeFetch|ssrfGuard|ssrf\.\w+|guard\.\w+)$/)) return true;
    const opts = n.arguments.find((a, i) => i > 0 && a.type === 'ObjectExpression');
    if (opts && (objProp(opts, 'lookup') || objProp(opts, 'dispatcher'))) return true;
    return false;
  }
}

function isOutbound(name, n, an) {
  if (name === 'fetch' || name === 'globalThis.fetch' || name === 'undici.fetch' || name === 'undici.request') return true;
  if (/^(https?|http2)\.(request|get)$/.test(name)) return true;
  const lib = name.split('.')[0];
  if ((lib === 'axios' || lib === 'got' || lib === 'needle' || lib === 'superagent') && an.requires.has(lib)) return true;
  return false;
}
function constUrlBinding(node, an) {
  // new URL('https://host/...') or a URL built from a fixed origin
  if (node.type === 'NewExpression' && calleeName(node.callee) === 'URL') {
    const base = node.arguments[1] || node.arguments[0];
    return !!base && (fixedOrigin(base) || an.safety(base, 'const'));
  }
  if (node.type === 'Identifier') {
    const vals = an.bindings.get(node.name);
    return !!(vals && vals.length && vals.every((v) => v && (fixedOrigin(v) || constUrlBinding(v, an))));
  }
  return false;
}
function mentionsSecret(a) {
  let hit = false;
  walk.full(a, (n) => {
    if (hit) return;
    const nm = n.type === 'Identifier' ? n.name : n.type === 'MemberExpression' ? propName(n) : '';
    if (!nm || !SECRETY.test(nm) || NOT_SECRET_NAME.test(nm)) return;
    hit = true;
  });
  if (!hit) return false;
  // `token.length`, `!!token`, `typeof secret`, `Boolean(token)`, `token ? 'yes' : 'no'` are fine
  const t = a.type;
  if (t === 'Literal') return false;
  if (t === 'UnaryExpression') return false;
  if (t === 'MemberExpression' && /^(length|size)$/.test(propName(a))) return false;
  if (t === 'ConditionalExpression') return false;
  if (t === 'TemplateLiteral') return a.expressions.some((e) => mentionsSecret(e));
  if (t === 'CallExpression') {
    const nm = calleeName(a.callee);
    if (/^(Boolean|fingerprint|redact|mask|hashForLog|tokenHint|keyHint|\w*Hint|\w*Fingerprint|\w*fingerprint|sha256|hash)$/.test(nm.split('.').pop())) return false;
    if (/\.(slice|substring|substr)$/.test(nm)) return false;
    return a.arguments.some((x) => mentionsSecret(x));
  }
  if (t === 'BinaryExpression') return mentionsSecret(a.left) || mentionsSecret(a.right);
  if (t === 'LogicalExpression') return mentionsSecret(a.left) || mentionsSecret(a.right);
  if (t === 'ObjectExpression') return a.properties.some((p) => p.type === 'Property' && mentionsSecret(p.value));
  return true;
}
function looksLikeRealSecret(s) {
  if (s.length < 12) return false;
  if (/^(change|replace|your|example|placeholder|xxx|test|dummy|secret|password|redacted|\*+|<|\$\{|process\.env|todo|none|null|undefined)/i.test(s)) return false;
  if (/\s/.test(s)) return false;
  return /[A-Za-z]/.test(s) && /\d/.test(s);
}

/* ------------------------------------------------------------------------------------------------
 * Driver.
 * ---------------------------------------------------------------------------------------------- */
function scanFile({ rel, side }) {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const out = [];
  for (const src of sources(rel, text)) {
    const p = parse(src.code);
    if (p.error) {
      out.push({ rule: 'parse-error', file: rel, line: (p.error.loc ? p.error.loc.line : 0) + src.lineOffset, snippet: String(p.error.message).slice(0, 120), detail: '' });
      continue;
    }
    out.push(...scanSource({ rel, side, code: src.code, lineOffset: src.lineOffset, ast: p.ast, comments: p.comments }));
  }
  return out;
}
function scanText(rel, side, text) {
  // For tests: scan a string as if it were file `rel`.
  const out = [];
  for (const src of sources(rel, text)) {
    const p = parse(src.code);
    if (p.error) { out.push({ rule: 'parse-error', file: rel, line: 0, snippet: String(p.error.message), detail: '' }); continue; }
    out.push(...scanSource({ rel, side, code: src.code, lineOffset: src.lineOffset, ast: p.ast, comments: p.comments }));
  }
  return out;
}

function scanAll() {
  const all = [];
  for (const f of listFiles()) all.push(...scanFile(f));
  return all;
}

// Baseline keys ignore line numbers so unrelated edits do not churn the file.
function keyOf(f) { return `${f.rule}|${f.file}|${f.snippet}`; }
function tally(findings) {
  const m = new Map();
  for (const f of findings) m.set(keyOf(f), (m.get(keyOf(f)) || 0) + 1);
  return m;
}
function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return { entries: {} }; }
}
function compare(findings, baseline) {
  const now = tally(findings);
  const base = new Map(Object.entries(baseline.entries || {}));
  const added = [];
  const counted = new Map();
  for (const f of findings) {
    const k = keyOf(f);
    const n = (counted.get(k) || 0) + 1;
    counted.set(k, n);
    if (n > (base.get(k) || 0)) added.push(f);
  }
  const stale = [];
  for (const [k, n] of base) if ((now.get(k) || 0) < n) stale.push({ key: k, was: n, now: now.get(k) || 0 });
  return { added, stale };
}
function writeBaseline(findings) {
  const entries = {};
  for (const [k, n] of [...tally(findings).entries()].sort((a, b) => a[0].localeCompare(b[0]))) entries[k] = n;
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  const doc = {
    _readme: 'Known findings of scripts/security-scan.js, recorded so CI fails only on NEW ones. This is debt, not approval. Fix entries and delete them; do not add to it by hand. Regenerate: node scripts/security-scan.js --update-baseline',
    totals: Object.fromEntries(Object.entries(byRule).sort()),
    entries,
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(doc, null, 1) + '\n');
}

function format(f) {
  const r = RULES[f.rule];
  return `${f.file}:${f.line}  [${f.rule}] ${r.owasp}\n    ${f.snippet}${f.detail ? `\n    unsafe: ${f.detail}` : ''}\n    fix: ${r.help}`;
}

module.exports = { RULES, scanAll, scanText, listFiles, compare, loadBaseline, writeBaseline, keyOf, format, BASELINE_FILE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const ruleArg = args.includes('--rule') ? args[args.indexOf('--rule') + 1] : null;
  let findings = scanAll();
  if (args.includes('--update-baseline')) {
    writeBaseline(findings);
    console.log(`wrote ${path.relative(REPO, BASELINE_FILE)}: ${findings.length} findings`);
    process.exit(0);
  }
  if (ruleArg) findings = findings.filter((f) => f.rule === ruleArg);
  if (args.includes('--summary')) {
    const c = {};
    for (const f of findings) c[f.rule] = (c[f.rule] || 0) + 1;
    console.log(c);
    process.exit(0);
  }
  const shown = args.includes('--all') ? findings : compare(findings, loadBaseline()).added.filter((f) => !ruleArg || f.rule === ruleArg);
  for (const f of shown) console.log(format(f) + '\n');
  console.log(`${shown.length} finding(s)${args.includes('--all') ? '' : ' not in the baseline'}`);
  process.exit(shown.length ? 1 : 0);
}
