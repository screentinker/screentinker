'use strict';

/*
 * Template parameters: an operator's values, validated against the template's declared params,
 * and — for slide templates — substituted into the slide document.
 *
 * ⚠️ TWO LAYERS, AND BOTH ARE LOAD-BEARING. Values are checked per type HERE, and for a slide the
 * substituted document then goes through slide-render's normalizeSlide, which is total and clamps
 * every value to an allowlist. So a value that slipped past these checks still cannot become
 * markup, CSS or a script; this layer exists so the operator gets a clear error on save instead of
 * a slide that silently renders the default.
 */

const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CONTENT_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const TPL_ASSET_RE = /^tpl:([a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}){0,3})$/;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const PLACEHOLDER_RE = /\{\{param:([a-z][a-z0-9_]{0,39})\}\}/g;
const WHOLE_PLACEHOLDER_RE = /^\{\{param:([a-z][a-z0-9_]{0,39})\}\}$/;

class ParamError extends Error {
  constructor(message, param) { super(message); this.name = 'ParamError'; this.status = 400; this.param = param; }
}

// Controls are refused except newline/tab in a textarea; bidi overrides always.
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i > 0 ? p.slice(i).toLowerCase() : '';
}

/** Is `v` a reference to an image file inside this package? */
function packageImage(v, files) {
  const m = TPL_ASSET_RE.exec(v);
  if (!m) return null;
  const p = m[1];
  if (!IMAGE_EXTS.has(extOf(p))) return null;
  if (files && !(files instanceof Map ? files.has(p) : Object.prototype.hasOwnProperty.call(files, p))) return null;
  return p;
}

/**
 * Check one value. Returns the normalised value; throws ParamError.
 * `ctx.files` — the package files (for tpl: image references).
 */
function checkValue(param, raw, ctx = {}) {
  const fail = (msg) => { throw new ParamError(`${param.label || param.name}: ${msg}`, param.name); };
  switch (param.type) {
    case 'text':
    case 'textarea': {
      if (typeof raw === 'number') raw = String(raw);
      if (typeof raw !== 'string') fail('must be text');
      if (raw.length > (param.max || 200)) fail(`must be at most ${param.max || 200} characters`);
      if (BAD_CHARS.test(raw) || (param.type === 'text' && /[\r\n]/.test(raw))) fail('contains characters that are not allowed');
      return raw;
    }
    case 'color':
      if (typeof raw !== 'string' || !COLOR_RE.test(raw.trim())) fail('must be a hex colour like #1A2B3C');
      return raw.trim();
    case 'number': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) fail('must be a number');
      if (param.min !== undefined && n < param.min) fail(`must be at least ${param.min}`);
      if (param.max !== undefined && n > param.max) fail(`must be at most ${param.max}`);
      return n;
    }
    case 'select':
      if (typeof raw !== 'string' || !(param.options || []).some((o) => o.value === raw)) fail('is not one of the choices');
      return raw;
    case 'checkbox':
      if (raw === 'true' || raw === 'false') return raw === 'true';
      if (typeof raw !== 'boolean') fail('must be true or false');
      return raw;
    case 'timezone':
      if (raw === '') return '';
      if (typeof raw !== 'string' || raw.length > 64 || !TZ_RE.test(raw)) fail('is not a timezone name');
      return raw;
    case 'locale':
      if (raw === '') return '';
      if (typeof raw !== 'string' || raw.length > 32 || !LOCALE_RE.test(raw)) fail('is not a language tag like en or de-CH');
      return raw;
    case 'data_source':
      if (raw === '') return '';
      if (typeof raw !== 'string' || !SLUG_RE.test(raw)) fail('is not a data source');
      if (ctx.dataSourceExists && !ctx.dataSourceExists(raw)) fail(`data source "${raw}" does not exist in this workspace`);
      return raw;
    case 'image':
      if (raw === '') return '';
      if (typeof raw !== 'string') fail('must be an image');
      if (raw.startsWith('tpl:')) {
        if (!packageImage(raw, ctx.files)) fail('refers to an image that is not in the template');
        return raw;
      }
      if (!CONTENT_ID_RE.test(raw)) fail('must be an image from your content library');
      if (ctx.contentExists && !ctx.contentExists(raw)) fail('is not an image in this workspace');
      return raw;
    default:
      fail('has an unknown type');
  }
  return undefined;
}

/**
 * Validate a full set of values against the params. Unknown keys are dropped; missing keys take
 * the default; a required param with neither is an error (unless `partial`).
 */
function resolveValues(params, valuesIn, ctx = {}) {
  const src = (valuesIn && typeof valuesIn === 'object' && !Array.isArray(valuesIn)) ? valuesIn : {};
  const out = {};
  for (const p of params || []) {
    const has = Object.prototype.hasOwnProperty.call(src, p.name) && src[p.name] !== null && src[p.name] !== undefined;
    let v;
    if (has) v = checkValue(p, src[p.name], ctx);
    else if (p.default !== undefined) {
      // A default is checked like any value: a template whose own default is invalid is broken,
      // and it should say so at install rather than render something nobody chose.
      v = checkValue(p, p.default, { ...ctx, dataSourceExists: null, contentExists: null });
    } else if (p.type === 'checkbox') v = false;
    else v = '';
    if (p.required && !ctx.partial && (v === '' || v === undefined)) {
      throw new ParamError(`${p.label || p.name} is required`, p.name);
    }
    out[p.name] = v;
  }
  return out;
}

/** Check a manifest's own defaults (install time). Returns null or an error message. */
function checkDefaults(manifest, files) {
  try {
    resolveValues(manifest.params, {}, { files, partial: true });
    return null;
  } catch (e) {
    return e.message;
  }
}

/** The data-source slugs a set of values binds to (for widget rev bumps). */
function boundSlugs(params, values) {
  return (params || []).filter((p) => p.type === 'data_source' && values[p.name]).map((p) => values[p.name]);
}

/*
 * ⚠️ SUBSTITUTION WALKS THE PARSED DOCUMENT, NEVER THE JSON TEXT. A string replace over
 * serialised JSON lets a value containing `"` rewrite the structure around it; here a value only
 * ever becomes the content of one string (or, for a whole-string placeholder, a scalar), and the
 * object shape is the template author's.
 */
function substitute(node, params, values, depth = 0) {
  if (depth > 12) return null;
  if (typeof node === 'string') {
    const whole = WHOLE_PLACEHOLDER_RE.exec(node);
    if (whole) {
      const p = params.find((x) => x.name === whole[1]);
      if (!p) return '';
      const v = values[p.name];
      return (v === undefined || v === null) ? '' : v;
    }
    if (!node.includes('{{param:')) return node;
    return node.replace(PLACEHOLDER_RE, (m, name) => {
      const p = params.find((x) => x.name === name);
      // Images and booleans only make sense as a whole value; embedded they are dropped.
      if (!p || p.type === 'image' || p.type === 'checkbox') return '';
      const v = values[name];
      return v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(node)) return node.slice(0, 200).map((x) => substitute(x, params, values, depth + 1));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = substitute(v, params, values, depth + 1);
    }
    return out;
  }
  return node;
}

module.exports = {
  ParamError, TZ_RE, LOCALE_RE, COLOR_RE, SLUG_RE, CONTENT_ID_RE, TPL_ASSET_RE, IMAGE_EXTS,
  checkValue, resolveValues, checkDefaults, boundSlugs, substitute, packageImage,
};
