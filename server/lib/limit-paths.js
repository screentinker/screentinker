/*
 * Rate-limit bucket naming. Pure, and extracted so it can be tested directly: it decides which
 * requests share a counter, and a mistake here makes a limit decorative rather than wrong-looking.
 */
const LIMIT_PATH_SHAPES = [
  [/^\/api\/auth\/oidc\/[^/]+\/(start|callback)$/, (m) => `/api/auth/oidc/:slug/${m[1]}`],
  [/^\/api\/organizations\/sso-only\/removal-requests\/[^/]+\/[^/]+$/, () => '/api/organizations/sso-only/removal-requests/:id/:decision'],
  [/^\/api\/organizations\/sso-only\/removal-requests$/, () => '/api/organizations/sso-only/removal-requests'],
  [/^\/api\/organizations\/[^/]+\/sso-only\/removal-request\/[^/]+$/, () => '/api/organizations/:id/sso-only/removal-request/:id'],
  [/^\/api\/organizations\/[^/]+\/sso-only\/removal-request$/, () => '/api/organizations/:id/sso-only/removal-request'],
  [/^\/api\/organizations\/[^/]+\/sso-only$/, () => '/api/organizations/:id/sso-only'],
  // The reset/target routes mint a bucket per TARGET without this, which is the same
  // caller-chosen-segment defect, at the mount next door.
  [/^\/api\/auth\/users\/[^/]+\/(.+)$/, (m) => `/api/auth/users/:id/${m[1]}`],
  /*
   * ⚠️ THE SESSION ID IS A CALLER-CHOSEN SEGMENT, so without these the chunk PATCHes fell through
   * to the verbatim path and every upload session minted its OWN bucket — the exact defect the
   * note above describes, at the mount next door. One bucket per IP per endpoint, not per session.
   */
  [/^\/api\/content\/uploads\/[^/]+\/finalize$/, () => '/api/content/uploads/:id/finalize'],
  [/^\/api\/content\/uploads\/[^/]+$/, () => '/api/content/uploads/:id'],
  // Session CREATION is one segment deep, so it otherwise canonicalises to '/api/content/:id' and
  // shares a bucket with every other content operation. It wants its own, and a tight one.
  [/^\/api\/content\/uploads$/, () => '/api/content/uploads'],
  [/^\/api\/content\/[^/]+$/, () => '/api/content/:id'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+\/domains\/[^/]+\/verify$/, () => '/api/organizations/:id/sso/:id/domains/:domain/verify'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+\/test$/, () => '/api/organizations/:id/sso/:id/test'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+$/, () => '/api/organizations/:id/sso/:id'],
  [/^\/api\/organizations\/[^/]+\/sso$/, () => '/api/organizations/:id/sso'],
  [/^\/api\/data-sources\/[^/]+\/refresh$/, () => '/api/data-sources/:id/refresh'],
];

function canonicalLimitPath(rawPath) {
  const p = rawPath
    .replace(/\/{2,}/g, '/')      // collapse doubled separators
    .replace(/\/+$/, '')          // a trailing slash is the same endpoint
    .toLowerCase()
    || '/';
  for (const [re, to] of LIMIT_PATH_SHAPES) {
    const m = p.match(re);
    if (m) return to(m);
  }
  // Unrecognised, but still under a mount whose ids are caller-chosen: one shared bucket, kept
  // apart from every real endpoint so flooding it cannot starve them.
  if (p.startsWith('/api/organizations/')) return '/api/organizations/:unmatched';
  return p;
}

module.exports = { LIMIT_PATH_SHAPES, canonicalLimitPath };
