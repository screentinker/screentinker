'use strict';

/*
 * Template packages: parse, validate, canonicalise, pack. Pure — no database, no disk.
 *
 * ⚠️ A PACKAGE IS UNTRUSTED BYTES UNTIL signing.js SAYS OTHERWISE, and this module assumes the
 * worst of every one: it runs before any signature check, on input anyone can upload.
 *
 * ⚠️ WHY JSON AND NOT A ZIP. The community proposal said "a zip", and a zip is what authors will
 * hand us — scripts/template-catalog.js packs a folder or a zip into this format. But the file a
 * SERVER parses is one JSON document: no central directory that disagrees with the local headers,
 * no symlink entries, no compression ratio to bomb, no path-in-archive to slip. The whole attack
 * surface is JSON.parse behind a byte cap plus the path and size checks below. A second benefit:
 * canonical JSON is deterministic, so CI can rebuild a published package from source and prove the
 * signed bytes are the reviewed bytes (catalog/README.md "Reproducible").
 *
 * Envelope (the file on disk / on the wire):
 *   { "format": "screentinker-template/1", "package": "<base64 canonical bytes>",
 *     "signature": { "key_id": "<16 hex>", "sig": "<base64>" } | null }
 * Canonical package bytes: JSON with keys sorted at every depth and no whitespace, of
 *   { "manifest": {...}, "files": { "<path>": "<base64>" } }
 * A package's IDENTITY is sha256(canonical bytes) — not of the envelope — so signing, or
 * re-signing under a rotated key, never changes which package it is.
 */

const crypto = require('crypto');

const FORMAT = 'screentinker-template/1';

/*
 * Two budgets. Everything a document INLINES (html, css, js, images, fonts) shares the small one,
 * because it is re-emitted into every render. Large BINARY ASSETS (WebAssembly, game data, 3D
 * models) are never inlined — they are served by URL from /api/templates/asset/<sha>/ and fetched
 * by the template — so they get their own, larger budget. Only html templates may carry them.
 */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;             // inlined files, all together
const MAX_FILE_BYTES = 1024 * 1024;                  // one inlined file
const MAX_ASSET_FILE_BYTES = 16 * 1024 * 1024;       // one binary asset
const MAX_PACKAGE_BYTES = 24 * 1024 * 1024;          // everything
const MAX_ENVELOPE_BYTES = Math.ceil(MAX_PACKAGE_BYTES * 4 / 3) + 2 * 1024 * 1024;   // base64 + slack
const MAX_FILES = 64;
const MAX_PARAMS = 40;
const MAX_TAGS = 12;
const MAX_NETWORK = 8;

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const PARAM_RE = /^[a-z][a-z0-9_]{0,39}$/;
const SEGMENT = '[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}';
const PATH_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,3}$`);
// A bare hostname (optionally *.wildcard), lower-case. No scheme, port, path or IP literal: a
// template declares WHICH SITES it talks to, and the CSP builder adds https:// itself.
const HOST_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/*
 * ⚠️ THE CATALOG'S LICENCE RULE IS NOT ENFORCED HERE. What the official catalog will LIST (no
 * GPL/AGPL — the project's licence position) is checked by `template-catalog.js build`, because it
 * is a rule about what WE redistribute. A server importing a template for its own use may run
 * whatever licence its owner accepts; this module only insists the licence is named.
 */
const SPDX_ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'Unlicense']);
const SPDX_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]{1,39}$/;

const KINDS = new Set(['slide', 'html']);
const PARAM_TYPES = new Set(['text', 'textarea', 'color', 'number', 'select', 'image', 'timezone', 'locale', 'data_source', 'checkbox']);
const ORIENTATIONS = new Set(['landscape', 'portrait']);

const EXT_TYPES = Object.freeze({
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.txt': 'text/plain', '.md': 'text/markdown',
  // Binary assets: served by URL, never inlined (see the budgets above).
  '.wasm': 'application/wasm', '.wad': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
});
const BINARY_ASSET_EXTS = new Set(['.wasm', '.wad', '.bin', '.glb']);
const isBinaryAsset = (p) => BINARY_ASSET_EXTS.has(extOf(p));
const ROOT_EXTRAS = new Set(['LICENSE', 'LICENCE', 'NOTICE']);

class PackageError extends Error {
  constructor(message) { super(message); this.name = 'PackageError'; this.status = 400; }
}
const fail = (m) => { throw new PackageError(m); };

function extOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function mimeFor(p) {
  return EXT_TYPES[extOf(p)] || (ROOT_EXTRAS.has(p) ? 'text/plain' : null);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/*
 * Canonical JSON: sorted keys at every depth, no whitespace. Only the shapes JSON itself can carry
 * are accepted — a non-finite number or an undefined would serialise differently on the signer and
 * the verifier, and a signature over "whatever this happens to stringify to" is not a signature.
 */
function canonicalJson(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail('non-finite number in package');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (isPlainObject(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  fail('unsupported value in package');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* Strict base64: the alphabet, correct padding, and a round trip. Buffer.from(…,'base64') on its
 * own silently skips junk characters, so two different strings would decode to the same bytes. */
// ⚠️ NO GROUPED REPETITION: `(?:[A-Za-z0-9+/]{4})*` over an 8 MB string overflowed V8's regex
// stack with a RangeError instead of failing cleanly. A flat character class plus arithmetic.
const B64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function strictBase64(s, what) {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64_CHARS_RE.test(s)) fail(`${what} is not valid base64`);
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64') !== s) fail(`${what} is not canonical base64`);
  return buf;
}

function str(v, max, what, { required = false, prefix = 'manifest.' } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${prefix}${what} is required`);
    return '';
  }
  if (typeof v !== 'string') fail(`${prefix}${what} must be a string`);
  // Control characters are refused rather than stripped: a name is shown in the dashboard and a
  // stray U+202E (right-to-left override) is how "evil.exe" is dressed up as "exe.live".
  if (/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/.test(v)) fail(`${prefix}${what} contains control characters`);
  if (v.length > max) fail(`${prefix}${what} is too long (max ${max})`);
  return v;
}

function validateParam(p, i, kind) {
  if (!isPlainObject(p)) fail(`params[${i}] must be an object`);
  const name = p.name;
  if (typeof name !== 'string' || !PARAM_RE.test(name)) fail(`params[${i}].name is invalid`);
  if (!PARAM_TYPES.has(p.type)) fail(`params[${i}].type "${String(p.type).slice(0, 20)}" is not a known type`);
  const out = {
    name,
    type: p.type,
    label: str(p.label || name, 80, `params[${i}].label`),
    help: str(p.help, 200, `params[${i}].help`),
    required: p.required === true,
  };
  if (p.type === 'select') {
    if (!Array.isArray(p.options) || !p.options.length || p.options.length > 50) fail(`params[${i}].options must be 1-50 entries`);
    out.options = p.options.map((o, j) => {
      const v = isPlainObject(o) ? o.value : o;
      const label = isPlainObject(o) ? o.label : o;
      if (typeof v !== 'string' || !v.length || v.length > 80) fail(`params[${i}].options[${j}] is invalid`);
      return { value: v, label: str(label == null ? v : String(label), 80, `params[${i}].options[${j}].label`) };
    });
  }
  if (p.type === 'text' || p.type === 'textarea') {
    const max = p.max === undefined ? (p.type === 'text' ? 200 : 2000) : Number(p.max);
    if (!Number.isInteger(max) || max < 1 || max > 2000) fail(`params[${i}].max must be 1-2000`);
    out.max = max;
  }
  if (p.type === 'number') {
    for (const k of ['min', 'max', 'step']) {
      if (p[k] !== undefined) {
        if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || Math.abs(p[k]) > 1e9) fail(`params[${i}].${k} must be a number`);
        out[k] = p[k];
      }
    }
  }
  if (p.default !== undefined) {
    // The default passes the same checks as an operator's value (params.js), which is where the
    // per-type rules live; here only its shape is bounded.
    if (!['string', 'number', 'boolean'].includes(typeof p.default)) fail(`params[${i}].default must be a scalar`);
    if (typeof p.default === 'string' && p.default.length > 2000) fail(`params[${i}].default is too long`);
    if (typeof p.default === 'number' && !Number.isFinite(p.default)) fail(`params[${i}].default must be finite`);
    out.default = p.default;
  }
  return out;
}

/**
 * Validate a manifest object and return a normalised copy containing only known keys.
 * Throws PackageError. `files` (the decoded file map) is used to check references.
 */
function validateManifest(m, files) {
  if (!isPlainObject(m)) fail('manifest must be an object');
  const id = m.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('manifest.id must match ^[a-z][a-z0-9-]{1,63}$');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) fail('manifest.version must be x.y.z');
  if (!KINDS.has(m.kind)) fail('manifest.kind must be "slide" or "html"');
  const kind = m.kind;
  const entry = m.entry === undefined ? (kind === 'html' ? 'index.html' : 'template.json') : m.entry;
  if (typeof entry !== 'string' || !PATH_RE.test(entry)) fail('manifest.entry is invalid');
  if (kind === 'html' && extOf(entry) !== '.html') fail('an html template entry must be a .html file');
  if (kind === 'slide' && extOf(entry) !== '.json') fail('a slide template entry must be a .json file');
  if (files && !Object.prototype.hasOwnProperty.call(files, entry)) fail(`entry "${entry}" is not in the package`);

  const license = str(m.license, 40, 'license', { required: true });
  if (!SPDX_RE.test(license)) fail(`manifest.license "${license}" is not an SPDX licence identifier`);

  let thumbnail = null;
  if (m.thumbnail !== undefined && m.thumbnail !== null) {
    if (typeof m.thumbnail !== 'string' || !PATH_RE.test(m.thumbnail)) fail('manifest.thumbnail is invalid');
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extOf(m.thumbnail))) fail('manifest.thumbnail must be png, jpg or webp');
    if (files && !Object.prototype.hasOwnProperty.call(files, m.thumbnail)) fail('manifest.thumbnail is not in the package');
    thumbnail = m.thumbnail;
  }

  let network = [];
  if (m.network !== undefined) {
    if (!Array.isArray(m.network) || m.network.length > MAX_NETWORK) fail(`manifest.network must be an array of at most ${MAX_NETWORK} hosts`);
    if (kind !== 'html' && m.network.length) fail('only html templates may declare network hosts');
    network = m.network.map((h) => {
      if (typeof h !== 'string' || !HOST_RE.test(h)) fail(`manifest.network host "${String(h).slice(0, 80)}" is not a hostname`);
      return h;
    });
  }

  const tags = m.tags === undefined ? [] : m.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) fail(`manifest.tags must be at most ${MAX_TAGS} strings`);
  tags.forEach((t, i) => { if (typeof t !== 'string' || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(t)) fail(`manifest.tags[${i}] is invalid`); });

  const orientation = m.orientation === undefined ? ['landscape'] : m.orientation;
  if (!Array.isArray(orientation) || !orientation.length || orientation.some((o) => !ORIENTATIONS.has(o))) {
    fail('manifest.orientation must list landscape and/or portrait');
  }

  const minServer = m.min_server === undefined ? '0.0.0' : m.min_server;
  if (typeof minServer !== 'string' || !SEMVER_RE.test(minServer)) fail('manifest.min_server must be x.y.z');

  const paramsIn = m.params === undefined ? [] : m.params;
  if (!Array.isArray(paramsIn) || paramsIn.length > MAX_PARAMS) fail(`manifest.params must be at most ${MAX_PARAMS} entries`);
  const params = paramsIn.map((p, i) => validateParam(p, i, kind));
  const seen = new Set();
  for (const p of params) {
    if (seen.has(p.name)) fail(`duplicate param "${p.name}"`);
    seen.add(p.name);
  }

  return {
    id,
    name: str(m.name, 80, 'name', { required: true }),
    version: m.version,
    kind,
    description: str(m.description, 500, 'description'),
    author: str(m.author, 80, 'author'),
    homepage: (() => {
      const h = str(m.homepage, 200, 'homepage');
      if (h && !/^https:\/\/[^\s"'<>]+$/.test(h)) fail('manifest.homepage must be an https URL');
      return h;
    })(),
    license,
    tags,
    orientation,
    min_server: minServer,
    entry,
    thumbnail,
    network,
    params,
  };
}

/*
 * ⚠️ TRANSLATIONS LIVE IN locales/<lang>.json, NEVER IN THE MANIFEST.
 *
 * The manifest refuses unknown keys (below), so a `translations` key there would make every
 * server older than this one refuse the template outright. A package file, on the other hand, is
 * something every server already accepts and ignores unless something asks for it — so a
 * template that ships locales/de.json still installs, unchanged, on an older server, which just
 * shows English. The file is therefore only ever an EXTRA: nothing renders from it, and a
 * template must work without it.
 *
 * Every string goes through the same str() rules as the English it replaces (plain text, no
 * control or bidi characters, the same length caps), and every key must name something that
 * exists in the manifest: a translation for a param or option the manifest does not have is an
 * author's typo that would otherwise sit there silently doing nothing.
 */
const LOCALE_LANGS = Object.freeze(['de', 'es', 'fr', 'hi', 'it', 'ja', 'nl', 'pt', 'zh']);
const LOCALE_FILE_RE = /^locales\/([a-z]{2})\.json$/;
const MAX_LOCALE_FILE_BYTES = 256 * 1024;
// Same character rule as an operator's value (params.js): a translated default is submitted as one.
const VALUE_BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

function validateLocaleFile(rel, buf, manifest) {
  const lang = LOCALE_FILE_RE.exec(rel)[1];
  const where = `${rel}: `;
  const lfail = (m) => fail(where + m);
  if (buf.length > MAX_LOCALE_FILE_BYTES) lfail(`is larger than ${MAX_LOCALE_FILE_BYTES} bytes`);
  let obj;
  try {
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    obj = JSON.parse(text);
  } catch { lfail('is not valid JSON'); }
  if (!isPlainObject(obj)) lfail('must be a JSON object');
  for (const k of Object.keys(obj)) if (!['name', 'description', 'params'].includes(k)) lfail(`unknown key "${k.slice(0, 40)}"`);
  const s = (v, max, what) => str(v, max, what, { prefix: where });
  const out = {};
  const name = s(obj.name, 80, 'name');
  if (name) out.name = name;
  const description = s(obj.description, 500, 'description');
  if (description) out.description = description;
  if (obj.params !== undefined) {
    if (!isPlainObject(obj.params)) lfail('params must be an object keyed by param name');
    const params = {};
    for (const pname of Object.keys(obj.params)) {
      const p = manifest.params.find((x) => x.name === pname);
      if (!p) lfail(`params."${pname.slice(0, 40)}" is not a param of this template`);
      const t = obj.params[pname];
      if (!isPlainObject(t)) lfail(`params.${pname} must be an object`);
      for (const k of Object.keys(t)) {
        if (!['label', 'help', 'options', 'default'].includes(k)) lfail(`params.${pname} has an unknown key "${k.slice(0, 40)}"`);
      }
      const tp = {};
      const label = s(t.label, 80, `params.${pname}.label`);
      if (label) tp.label = label;
      const help = s(t.help, 200, `params.${pname}.help`);
      if (help) tp.help = help;
      if (t.options !== undefined) {
        if (p.type !== 'select') lfail(`params.${pname}.options: only a select param has options`);
        if (!isPlainObject(t.options)) lfail(`params.${pname}.options must be an object keyed by option value`);
        const opts = {};
        for (const v of Object.keys(t.options)) {
          if (!p.options.some((o) => o.value === v)) lfail(`params.${pname}.options."${v.slice(0, 40)}" is not an option value of this param`);
          const ol = s(t.options[v], 80, `params.${pname}.options.${v.slice(0, 40)}`);
          if (ol) opts[v] = ol;
        }
        if (Object.keys(opts).length) tp.options = opts;
      }
      if (t.default !== undefined) {
        if (p.type !== 'text' && p.type !== 'textarea') lfail(`params.${pname}.default: only a text or textarea param may have a translated default`);
        const d = t.default;
        if (typeof d !== 'string') lfail(`params.${pname}.default must be a string`);
        if (d.length > p.max) lfail(`params.${pname}.default is too long (max ${p.max})`);
        if (VALUE_BAD_CHARS.test(d) || (p.type === 'text' && /[\r\n]/.test(d))) lfail(`params.${pname}.default contains characters that are not allowed`);
        if (d) tp.default = d;
      }
      if (Object.keys(tp).length) params[pname] = tp;
    }
    if (Object.keys(params).length) out.params = params;
  }
  return [lang, out];
}

/**
 * The validated translations of a package, { <lang>: { name?, description?, params? } }, from its
 * locales/<lang>.json files. Anything else under locales/ is an error (a folder of the same name
 * an html template used for its own purposes would otherwise be half-read as translations).
 */
function validateLocales(files, manifest) {
  const i18n = {};
  for (const [p, buf] of files) {
    if (!p.toLowerCase().startsWith('locales/')) continue;
    const m = LOCALE_FILE_RE.exec(p);
    if (!m || !LOCALE_LANGS.includes(m[1])) {
      fail(`"${p.slice(0, 80)}": only locales/<lang>.json is allowed under locales/, for lang in ${LOCALE_LANGS.join(', ')}`);
    }
    const [lang, out] = validateLocaleFile(p, buf, manifest);
    if (Object.keys(out).length) i18n[lang] = out;
  }
  return i18n;
}

/**
 * Decode and validate the canonical package bytes. Returns { manifest, files: Map<path, Buffer>, sha256, i18n }.
 * `i18n` is the validated locales/<lang>.json translations ({} when there are none).
 */
function parsePackageBytes(bytes, opts = {}) {
  if (!Buffer.isBuffer(bytes)) fail('package bytes must be a buffer');
  if (bytes.length > MAX_ENVELOPE_BYTES) fail('package is too large');
  let obj;
  try { obj = JSON.parse(bytes.toString('utf8')); } catch { fail('package is not valid JSON'); }
  if (!isPlainObject(obj)) fail('package must be an object');
  const keys = Object.keys(obj).sort().join(',');
  if (keys !== 'files,manifest') fail('package must contain exactly "manifest" and "files"');
  // ⚠️ THE BYTES MUST ALREADY BE CANONICAL. Otherwise one package has many encodings, each with
  // its own sha256, and "the index pins this hash" stops meaning "the index pins this package".
  // Compared as BYTES: invalid UTF-8 decodes to U+FFFD, so a string comparison let two different
  // byte sequences (two sha256s) pass as the same canonical package.
  if (!Buffer.from(canonicalJson(obj), 'utf8').equals(bytes)) fail('package bytes are not canonical');
  if (!isPlainObject(obj.files)) fail('package.files must be an object');

  const names = Object.keys(obj.files);
  if (!names.length) fail('package has no files');
  if (names.length > MAX_FILES) fail(`package has more than ${MAX_FILES} files`);
  const files = new Map();
  const lower = new Set();
  let total = 0;
  let totalAll = 0;
  for (const p of names) {
    if (!PATH_RE.test(p) || p.split('/').some((s) => s === '.' || s === '..' || s.startsWith('.'))) fail(`file path "${p.slice(0, 80)}" is not allowed`);
    if (p.includes('/') ? !EXT_TYPES[extOf(p)] : !mimeFor(p)) fail(`file type of "${p.slice(0, 80)}" is not allowed`);
    // Case-insensitive collisions ("Index.html" + "index.html") mean different things on
    // different filesystems; refuse them rather than guess which one a reviewer read.
    const lc = p.toLowerCase();
    if (lower.has(lc)) fail(`duplicate file path (case-insensitive) "${p.slice(0, 80)}"`);
    lower.add(lc);
    const buf = strictBase64(obj.files[p], `file "${p.slice(0, 80)}"`);
    const binary = isBinaryAsset(p);
    const cap = binary ? MAX_ASSET_FILE_BYTES : MAX_FILE_BYTES;
    if (buf.length > cap) fail(`file "${p.slice(0, 80)}" is larger than ${cap} bytes`);
    if (!binary) {
      total += buf.length;
      if (total > MAX_TOTAL_BYTES) fail(`package is larger than ${MAX_TOTAL_BYTES} bytes (not counting binary assets)`);
    }
    totalAll += buf.length;
    if (totalAll > MAX_PACKAGE_BYTES) fail(`package is larger than ${MAX_PACKAGE_BYTES} bytes`);
    files.set(p, buf);
  }
  const fileObj = Object.fromEntries(files);
  const manifest = validateManifest(obj.manifest, fileObj);
  if (manifest.kind !== 'html' && [...files.keys()].some(isBinaryAsset)) fail('only html templates may carry binary assets (.wasm, .wad, .bin, .glb)');
  if (manifest.thumbnail && isBinaryAsset(manifest.thumbnail)) fail('manifest.thumbnail must be an image');
  // The manifest as SHIPPED is what was signed; the normalised copy is what the server uses. A
  // shipped manifest carrying keys this version does not know is refused rather than silently
  // ignored, so a future field with security meaning is never dropped on an older server.
  const known = new Set(['id', 'name', 'version', 'kind', 'description', 'author', 'homepage', 'license', 'tags',
    'orientation', 'min_server', 'entry', 'thumbnail', 'network', 'params']);
  for (const k of Object.keys(obj.manifest)) if (!known.has(k)) fail(`manifest has an unknown key "${k.slice(0, 40)}"`);

  // After the manifest checks, so the param names it is checked against are the normalised ones.
  // At install/build a bad translation file is an error the author must see. When an ALREADY
  // INSTALLED package is loaded to render (opts.lenientLocales), a translation problem must never
  // blank the screens: the package loads without translations.
  let i18n;
  if (opts.lenientLocales) { try { i18n = validateLocales(files, manifest); } catch { i18n = {}; } }
  else i18n = validateLocales(files, manifest);

  return { manifest, files, sha256: sha256Hex(bytes), i18n };
}

/**
 * Parse a .sttemplate envelope. Returns { packageBytes, signature, manifest, files, sha256 }.
 * Does NOT verify the signature — signing.verifyPackage does, and callers must.
 */
function parseEnvelope(input, opts = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  if (buf.length > MAX_ENVELOPE_BYTES * 2) fail('template file is too large');
  let env;
  try { env = JSON.parse(buf.toString('utf8')); } catch { fail('template file is not valid JSON'); }
  if (!isPlainObject(env)) fail('template file must be an object');
  if (env.format !== FORMAT) fail(`unknown template format (expected ${FORMAT})`);
  for (const k of Object.keys(env)) if (!['format', 'package', 'signature'].includes(k)) fail(`template file has an unknown key "${k.slice(0, 40)}"`);
  const packageBytes = strictBase64(env.package, 'package');
  let signature = null;
  if (env.signature !== undefined && env.signature !== null) {
    const s = env.signature;
    if (!isPlainObject(s) || typeof s.key_id !== 'string' || !/^[0-9a-f]{16}$/.test(s.key_id)) fail('signature.key_id is invalid');
    const sig = strictBase64(s.sig, 'signature');
    if (sig.length !== 64) fail('signature must be 64 bytes');
    signature = { key_id: s.key_id, sig };
  }
  const parsed = parsePackageBytes(packageBytes, opts);
  return { packageBytes, signature, ...parsed };
}

/** Build canonical package bytes from a manifest and a { path: Buffer } map (the author side). */
function buildPackageBytes(manifest, files) {
  const enc = {};
  for (const [p, b] of Object.entries(files)) enc[p] = Buffer.from(b).toString('base64');
  const bytes = Buffer.from(canonicalJson({ manifest, files: enc }), 'utf8');
  parsePackageBytes(bytes);   // the author gets the same errors the server would give
  return bytes;
}

function buildEnvelope(packageBytes, signature = null) {
  return Buffer.from(JSON.stringify({
    format: FORMAT,
    package: packageBytes.toString('base64'),
    signature: signature ? { key_id: signature.key_id, sig: Buffer.from(signature.sig).toString('base64') } : null,
  }, null, 0) + '\n', 'utf8');
}

module.exports = {
  FORMAT, PackageError,
  MAX_TOTAL_BYTES, MAX_FILE_BYTES, MAX_ASSET_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_FILES, MAX_PARAMS, MAX_ENVELOPE_BYTES,
  BINARY_ASSET_EXTS, isBinaryAsset, SPDX_RE, LOCALE_LANGS, MAX_LOCALE_FILE_BYTES, validateLocales,
  ID_RE, SEMVER_RE, HOST_RE, PARAM_TYPES, EXT_TYPES, SPDX_ALLOWED,
  canonicalJson, sha256Hex, strictBase64, mimeFor, extOf, isPlainObject,
  validateManifest, parsePackageBytes, parseEnvelope, buildPackageBytes, buildEnvelope,
};
