'use strict';

/*
 * ONE definition of "this field name holds a credential".
 *
 * Two subsystems need it for the same reason and must not disagree: mesh replication decides which
 * columns never leave for a replica, and the MCP layer decides which fields never reach a model.
 * A second copy is how one of them silently stops catching a newly added secret — which is the
 * failure this regex exists to prevent in the first place.
 */

/**
 * What a column or field name looks like when it holds a secret. Deliberately broad: a false
 * positive costs a field nobody needed, a false negative ships a credential.
 */
const SECRET_NAME_RE = /hash|secret|token|password|totp|stripe|_pin$|^pin$|credential|api_key|auth_header|_enc$/i;

/*
 * Secrets whose NAME does not look like one. Mesh replication catches these on an explicit per-table
 * BLOCKLIST, which is right for a schema copy — but a name-shape test alone misses them, and the MCP
 * layer has no per-table list to fall back on.
 *
 * `pairing_code` claims an unpaired display into a workspace; `enrol_key` enrols a mesh node. Neither
 * reads as a credential, both are one. The test asserts every name on replication's device and
 * trigger blocklists is caught here, so the two mechanisms cannot disagree about what a secret is.
 */
const SECRET_FIELD_NAMES = new Set(['pairing_code', 'enrol_key']);

/** True when a field of this name must never leave the server. */
function isSecretName(name) {
  const k = String(name);
  return SECRET_FIELD_NAMES.has(k.toLowerCase()) || SECRET_NAME_RE.test(k);
}

module.exports = { SECRET_NAME_RE, SECRET_FIELD_NAMES, isSecretName };
