'use strict';

/*
 * Password / secret fields on plugin schemas. GET never returns the value (empty string
 * so the form stays blank). PUT with blank / "***" keeps the stored value. authorization
 * is always treated as secret even if a plugin forgot to mark it.
 */

// Backstop for a plugin author who forgot to mark a secret field. Redaction is driven by field
// TYPE (`password`) or an explicit `secret: true`, but a field named like a credential yet typed
// `text` would otherwise be returned in the clear by GET. Names matching this pattern are treated
// as secret regardless of type, so a mistyped field fails closed. It can over-redact a field that
// merely contains one of these words; hiding a value is the safe direction for a backstop.
const SECRETY_NAME_RE = /(?:^|[_-])(?:token|secret|password|passwd|api[_-]?key|apikey|auth|authorization|bearer|credential|access[_-]?key)(?:$|[_-])|^(?:token|secret|password|apikey|authorization|bearer)$/i;

function secretNames(fields) {
  const names = new Set(['authorization']);
  for (const f of fields || []) {
    if (!f || typeof f.name !== 'string') continue;
    if (f.type === 'password' || f.secret === true || SECRETY_NAME_RE.test(f.name)) names.add(f.name);
  }
  return names;
}

function fieldsForDataSource(type) {
  // Built-in types (REST's auth token / password) first: a plugin can never claim their names.
  const builtin = require('../data-sources/builtin-types').getBuiltinType(type);
  if (builtin) return builtin.fields;
  try {
    const pluginRegistry = require('./registry');
    const spec = pluginRegistry.getDataSource(type);
    return (spec && spec.fields) || [];
  } catch {
    return [];
  }
}

function fieldsForWidget(type) {
  try {
    const pluginRegistry = require('./registry');
    const spec = pluginRegistry.getWidget(type);
    return (spec && spec.fields) || [];
  } catch {
    return [];
  }
}

function redactSecrets(cfg, fields) {
  const out = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  for (const name of secretNames(fields)) {
    if (out[name] != null && out[name] !== '') out[name] = '';
  }
  return out;
}

function mergeSecrets(incoming, existing, fields) {
  const next = { ...(incoming && typeof incoming === 'object' ? incoming : {}) };
  const prev = existing && typeof existing === 'object' ? existing : {};
  for (const name of secretNames(fields)) {
    if (next[name] == null || next[name] === '' || next[name] === '***') {
      if (prev[name] != null && prev[name] !== '') next[name] = prev[name];
      else delete next[name];
    }
  }
  return next;
}

// ---- Encryption at rest --------------------------------------------------------------------
// Secret FIELD values are stored encrypted (AES-256-GCM via lib/secretbox, key derived from the
// instance JWT secret). A stored secret carries the marker below so its state is self-describing:
// a value with the marker is ciphertext, anything else is legacy plaintext (migrated on next write,
// or by the one-time pass in db/database.js). Rotating JWT_SECRET makes ciphertext undecryptable;
// decrypt then yields '' and the operator re-enters the secret -- matches BYOK AI keys (#41).
const ENC_PREFIX = 'enc:v1:';
const secretbox = require('../secretbox');

/** Encrypt the secret fields of [cfg] in place-of a copy. Blank / already-encrypted values pass. */
function encryptSecrets(cfg, fields) {
  const out = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  for (const name of secretNames(fields)) {
    const v = out[name];
    if (v == null || v === '' || (typeof v === 'string' && v.startsWith(ENC_PREFIX))) continue;
    const enc = secretbox.encrypt(String(v));
    if (enc) out[name] = ENC_PREFIX + enc;
  }
  return out;
}

/** Decrypt the secret fields of [cfg]. Ciphertext -> plaintext; legacy plaintext passes unchanged;
 *  ciphertext that will not decrypt (rotated key) becomes '' so it reads as "needs re-entry". */
function decryptSecrets(cfg, fields) {
  const out = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  for (const name of secretNames(fields)) {
    const v = out[name];
    if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) continue; // legacy plaintext or absent
    const plain = secretbox.decrypt(v.slice(ENC_PREFIX.length));
    out[name] = plain == null ? '' : plain;
  }
  return out;
}

/** True if any secret field in [cfg] is still legacy plaintext (used by the one-time migration). */
function hasPlaintextSecret(cfg, fields) {
  if (!cfg || typeof cfg !== 'object') return false;
  for (const name of secretNames(fields)) {
    const v = cfg[name];
    if (typeof v === 'string' && v !== '' && !v.startsWith(ENC_PREFIX)) return true;
  }
  return false;
}

function redactConfigJson(json, fields) {
  let cfg;
  try { cfg = JSON.parse(json || '{}'); } catch { return json; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return json;
  let changed = false;
  const out = { ...cfg };
  for (const name of secretNames(fields)) {
    if (out[name] != null && out[name] !== '') {
      out[name] = '';
      changed = true;
    }
  }
  return changed ? JSON.stringify(out) : json;
}

module.exports = {
  SECRETY_NAME_RE,
  secretNames,
  redactSecrets,
  mergeSecrets,
  encryptSecrets,
  decryptSecrets,
  hasPlaintextSecret,
  fieldsForDataSource,
  fieldsForWidget,
  redactConfigJson,
  ENC_PREFIX,
};
