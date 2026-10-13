'use strict';

/*
 * Path containment, in one place. Resolve `parts` against `root` and hand the result back only
 * when it lands strictly INSIDE root; anything else — a `../` that climbs out, an absolute path
 * that points elsewhere, a sibling that merely shares root's prefix (`/data/content-old` beside
 * `/data/content`) — is null.
 *
 * ⚠️ STRICTLY INSIDE, never root itself. Every caller names a file or a per-row directory under
 * root, so `resolveWithin(contentDir, '')` meaning "contentDir" would only ever be a bug (an unlink
 * or rmSync aimed at the whole tree). The `root + sep` comparison is also what rules the sibling
 * case out: a bare `startsWith(root)` admits it.
 *
 * Purely lexical: symlinks are not followed, which is the same view of the tree every fs call
 * after it takes from a path built by path.join.
 */
const path = require('path');

function resolveWithin(root, ...parts) {
  if (!root) return null;
  const base = path.resolve(String(root));
  const full = path.resolve(base, ...parts.map((p) => String(p)));
  if (full.startsWith(base + path.sep)) return full;
  return null;
}

module.exports = { resolveWithin };
