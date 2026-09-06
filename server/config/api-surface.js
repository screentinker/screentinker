'use strict';

// SINGLE SOURCE OF TRUTH for the API router partition.
//
// server.js mounts from these two lists; test/api.test.js (the partition firewall
// test) asserts against the SAME lists. Because both read this one file, the mount
// list and the test cannot drift: add a router to PUBLIC_ROUTERS and it gets the
// token front door AND the firewall test covers it; the day a JWT-only router stops
// returning 401 to a `Bearer st_` token (e.g. someone gives it the token door), CI
// fails. This is the firewall-rule-as-code.
//
//   PUBLIC_ROUTERS   - token-reachable. Mounted with the bearerAuth front door +
//                      resolveTenancy + tokenScopeGate. A scoped API token AND a JWT
//                      session both reach these.
//   JWT_ONLY_ROUTERS - requireAuth only (no token front door). A `Bearer st_` token
//                      fails jwt.verify -> 401, so these are unreachable by any token
//                      (secure by exclusion). Privileged surfaces live here.
//
// Per-entry flags:
//   renderBypass: also exposes a public GET /:id/render (device render) that skips auth.
//   tenancy:      JWT-only router also runs resolveTenancy (acts on the caller's active
//                 workspace). Routers without it target a workspace by URL/body param
//                 and are gated per-handler (e.g. canAdminWorkspace).

const PUBLIC_ROUTERS = [
  { path: '/api/devices',     mod: './routes/devices' },
  { path: '/api/content',     mod: './routes/content' },
  { path: '/api/folders',     mod: './routes/folders' },
  { path: '/api/assignments', mod: './routes/assignments' },
  { path: '/api/layouts',     mod: './routes/layouts' },
  { path: '/api/widgets',     mod: './routes/widgets', renderBypass: true },
  { path: '/api/schedules',   mod: './routes/schedules' },
  { path: '/api/walls',       mod: './routes/video-walls' },
  { path: '/api/reports',     mod: './routes/reports' },
  { path: '/api/groups',      mod: './routes/device-groups' },
  { path: '/api/playlists',   mod: './routes/playlists' },
  // Slide decks: the authoring document. Publishes to a playlist of slide widgets — see
  // lib/slide-deck.js for why that is the whole design rather than a new content type.
  { path: '/api/slide-decks', mod: './routes/slide-decks' },
  // Uploaded fonts for slides. Workspace-scoped; see routes/fonts.js for why redistribution is
  // the thing to understand about this one.
  { path: '/api/fonts',       mod: './routes/fonts' },
  // #320: operator-uploaded GLSL transitions. Workspace-scoped like fonts, and for the same reason:
  // it is the customer's content and the customer's licence, not part of the shipped library.
  { path: '/api/transitions/custom', mod: './routes/custom-shaders' },
  { path: '/api/activity',    mod: './routes/activity' },
  { path: '/api/kiosk',       mod: './routes/kiosk', renderBypass: true },
  { path: '/api/pip',         mod: './routes/pip' },
  // Data Sources (iCal, APIs, etc.) for dynamic slide template interpolation
  { path: '/api/data-sources', mod: './routes/data-sources' },
  // Trigger DEFINITIONS. ⚠️ Public (token-reachable) on purpose — an integrator provisioning a site
  // configures these from their own tooling. The FIRE path is not here and never will be: it lives
  // on the device, because a trigger that needs this server is a trigger that fails with the WAN
  // down, which is the whole feature. See docs/triggers-design.md.
  { path: '/api/triggers',    mod: './routes/triggers' },
];

const JWT_ONLY_ROUTERS = [
  { path: '/api/ai',          mod: './routes/ai',           tenancy: true },
  { path: '/api/provision',   mod: './routes/provisioning', tenancy: true },
  { path: '/api/teams',       mod: './routes/teams',        tenancy: true },
  { path: '/api/white-label', mod: './routes/white-label',  tenancy: true },
  { path: '/api/workspaces',  mod: './routes/workspaces' },
  { path: '/api/admin',       mod: './routes/admin' },
  /*
   * Server diagnostics for a platform operator: instance shape, the loop-lag history the server has
   * always recorded and never shown, and an in-process CPU profile. JWT-only and gated again inside
   * on requirePlatformAdmin — a workspace owner is not an operator of the host.
   */
  { path: '/api/admin/diagnostics', mod: './routes/diagnostics' },
  { path: '/api/tokens',      mod: './routes/tokens',       tenancy: true },
];

// #73: AGENCY_ROUTERS - capability-restricted ('agency' scope) surface. Mounted with
// bearerAuth + resolveTenancy + agencyGate (NOT tokenScopeGate). An 'agency' token is
// OFF the read/write/full ladder, so tokenScopeGate rejects it on every PUBLIC_ROUTER -
// it can reach ONLY this router, and only its allowlisted playlists in its bound
// workspace (agencyGate enforces both). read/write/full tokens and JWTs are rejected here.
const AGENCY_ROUTERS = [
  { path: '/api/agency', mod: './routes/agency' },
];

module.exports = { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS, AGENCY_ROUTERS };
