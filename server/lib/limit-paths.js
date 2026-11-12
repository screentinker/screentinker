/*
 * Rate-limit bucket naming. Pure, and extracted so it can be tested directly: it decides which
 * requests share a counter, and a mistake here makes a limit decorative rather than wrong-looking.
 */
const LIMIT_PATH_SHAPES = [
  // View-only display access: the token / display id is caller-chosen, so one bucket per shape.
  [/^\/view\/screen\/[^/]+\/?$/, () => '/view/screen/:id'],
  [/^\/view\/[^/]+\/?$/, () => '/view/:token'],
  [/^\/api\/view\/(t|d)\/[^/]+\/payload$/, (m) => `/api/view/${m[1]}/:key/payload`],
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
  // 3.0 SCIM: user and group ids are caller-chosen, so the whole protocol surface is one bucket per
  // IP; the admin routes fold their ids the same way.
  [/^\/scim(\/.*)?$/, () => '/scim/v2'],
  [/^\/api\/organizations\/[^/]+\/scim\/(tokens|mappings)\/[^/]+$/, (m) => `/api/organizations/:id/scim/${m[1]}/:id`],
  [/^\/api\/organizations\/[^/]+\/scim(\/(tokens|mappings|events|users))?$/, (m) => `/api/organizations/:id/scim${m[1] || ''}`],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+\/domains\/[^/]+\/verify$/, () => '/api/organizations/:id/sso/:id/domains/:domain/verify'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+\/test$/, () => '/api/organizations/:id/sso/:id/test'],
  [/^\/api\/organizations\/[^/]+\/sso\/[^/]+$/, () => '/api/organizations/:id/sso/:id'],
  [/^\/api\/organizations\/[^/]+\/sso$/, () => '/api/organizations/:id/sso'],
  [/^\/api\/data-sources\/[^/]+\/refresh$/, () => '/api/data-sources/:id/refresh'],
  // Templates: every id below is caller-chosen, and a preview holds a rendered document in memory.
  [/^\/api\/templates\/installed\/[^/]+\/[^/]+\/(preview|use)$/, (m) => `/api/templates/installed/:catalog/:id/${m[1]}`],
  [/^\/api\/templates\/installed\/[^/]+\/[^/]+$/, () => '/api/templates/installed/:catalog/:id'],
  [/^\/api\/templates\/preview\/[^/]+$/, () => '/api/templates/preview/:token'],
  [/^\/api\/templates\/thumb\/[^/]+$/, () => '/api/templates/thumb/:sha'],
  [/^\/api\/templates\/asset\/.+$/, () => '/api/templates/asset/:sha/:path'],
  /*
   * 3.0 content requests: the form code (/r/<code>) and the upload id are caller-chosen, and the
   * code is a secret — folded so a guess neither mints its own bucket nor lands in a 429 log line.
   */
  [/^\/r\/[^/]+$/, () => '/r/:code'],
  /*
   * "Now serving" queues: the customer page's token is a credential in the path, folded so a guess
   * neither mints its own bucket nor writes the token into a 429 log line.
   */
  [/^\/queue\/[^/]+$/, () => '/queue/:token'],
  [/^\/api\/public\/queue\/c\/[^/]+\/(state|ticket)$/, (m) => `/api/public/queue/c/:token/${m[1]}`],
  [/^\/api\/public\/queue\/c(\/.*)?$/, () => '/api/public/queue/c/:unmatched'],
  [/^\/api\/public\/requests\/form\/[^/]+\/uploads\/[^/]+$/, () => '/api/public/requests/form/:code/uploads/:id'],
  [/^\/api\/public\/requests\/form\/[^/]+(\/start|\/verify|\/verify\/confirm|\/sso|\/uploads|\/submit)?$/, (m) => `/api/public/requests/form/:code${m[1] || ''}`],
  [/^\/api\/public\/requests\/form(\/.*)?$/, () => '/api/public/requests/form/:unmatched'],
  /*
   * ⚠️ THE LAST SEGMENT IS A CREDENTIAL. An inbound hook's URL carries its secret, so without this
   * the per-IP bucket was keyed on it (a new bucket per probe) and the `[limit] 429 <endpoint>`
   * warning wrote the secret into the server log. The hook ID stays in the key (it is not a secret,
   * and one bucket per hook keeps tenants that send from a shared cloud IP, like Make or n8n, from
   * throttling each other); anything after it collapses. A path that is not a hook ID is one bucket.
   */
  [/^\/api\/hooks\/in\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/, (m) => `/api/hooks/in/${m[1]}/:secret`],
  [/^\/api\/hooks\/in(\/.*)?$/, () => '/api/hooks/in/:unmatched'],
];

/*
 * ⚠️ DECODED PER SEGMENT, because Express routes on the decoded path. Without this,
 * `/installed/local/%68tml-big/preview` reached the same handler as `/installed/local/html-big/preview`
 * but minted a fresh bucket — a limit anyone could step around by spelling a letter differently.
 * A decoded `/` is re-encoded so it cannot invent a path separator the router never saw.
 */
function decodeSegments(p) {
  return p.split('/').map((seg) => {
    if (!seg.includes('%')) return seg;
    try { return decodeURIComponent(seg).replace(/\//g, '%2f'); } catch { return seg; }
  }).join('/');
}

function canonicalLimitPath(rawPath) {
  const p = decodeSegments(rawPath)
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
