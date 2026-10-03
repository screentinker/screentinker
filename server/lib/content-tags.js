'use strict';

// Content tags (string labels) and meta (key=value). Stored as JSON TEXT.
// Tags are denormalized onto the published snapshot so a screen can skip offline.

const TAG_RE = /^[\p{L}\p{N}_.:-]+$/u;
const MAX_TAGS = 32;
const MAX_TAG = 40;
const MAX_META = 32;
const MAX_KEY = 40;
const MAX_VAL = 200;

function normalizeTags(v) {
  if (v === undefined) return undefined;
  if (v == null || v === '') return [];
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/[,;\n]/);
  else return false;
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const s = String(raw).trim().toLowerCase().slice(0, MAX_TAG);
    if (!s || seen.has(s) || !TAG_RE.test(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Meta values are free-form labels (room names, ids, urls). Keys are charset-locked
// (TAG_RE); values only get length + a defensive scrub of control chars and angle
// brackets, so a value can never carry a raw tag into a future unescaped render.
// Written as a char-code filter (not a regex literal) to keep this source pure ASCII.
function scrubVal(s) {
  const str = String(s);
  let out = '';
  for (let i = 0; i < str.length && out.length < MAX_VAL; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x3c /* < */ || c === 0x3e /* > */) continue;
    out += str[i];
  }
  return out;
}

function normalizeMeta(v) {
  if (v === undefined) return undefined;
  if (v == null || v === '') return {};
  let obj = v;
  if (typeof v === 'string') {
    obj = {};
    for (const line of v.split('\n')) {
      const i = line.indexOf('=');
      if (i < 1) continue;
      obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const out = {};
  let n = 0;
  for (const [k, val] of Object.entries(obj)) {
    const key = String(k).trim().slice(0, MAX_KEY);
    if (!key || !TAG_RE.test(key)) continue;
    out[key] = val == null ? '' : scrubVal(val);
    if (++n >= MAX_META) break;
  }
  return out;
}

function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function parseMeta(raw) {
  if (!raw) return {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

module.exports = { normalizeTags, normalizeMeta, parseTags, parseMeta };
