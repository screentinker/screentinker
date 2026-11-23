'use strict';

/*
 * The sources lib/migrate can import from. Each adapter is one file and exposes:
 *
 *   id, name, mode ('api' | 'file' | 'none')
 *   fields       the connect form: [{ key, type: 'url'|'text'|'secret', required, help }]
 *   docs         the official documentation pages the adapter was written against (shown in the UI)
 *   checkCredentials(cred) -> { cred, label, upload_path? }   validate the form; throws { userMessage }
 *   open(cred, { uploadDir, job }) -> session { scan() -> catalog, fetchMedia(m, dest, maxBytes), close() }
 *
 * A 'none' entry is a vendor we looked at and cannot import from (no documented API or export);
 * it is listed so the wizard can say why, and offers the generic zip instead.
 *
 * The catalog shape every adapter returns is documented in lib/migrate/apply.js.
 */

const ADAPTERS = [
  require('./xibo'),
  require('./yodeck'),
  require('./optisigns'),
  require('./magicinfo'),
  require('./screencloud'),
  require('./anthias'),
  require('./screenly'),
  require('./generic-zip'),
];
const byId = new Map(ADAPTERS.map((a) => [a.id, a]));

function get(id) { return byId.get(String(id || '')) || null; }

/** What the wizard shows: never anything secret, just how to connect and why something is not possible. */
function list() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    mode: a.mode,
    fields: (a.fields || []).map((f) => ({ key: f.key, type: f.type, required: !!f.required, ...(f.options ? { options: f.options } : {}) })),
    docs: a.docs || [],
    imports: a.imports || [],
    self_hosted: !!a.selfHosted,
  }));
}

module.exports = { get, list, ADAPTERS };
