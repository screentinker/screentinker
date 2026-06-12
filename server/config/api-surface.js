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
  { path: '/api/activity',    mod: './routes/activity' },
  { path: '/api/kiosk',       mod: './routes/kiosk', renderBypass: true },
];

const JWT_ONLY_ROUTERS = [
  { path: '/api/ai',          mod: './routes/ai',           tenancy: true },
  { path: '/api/provision',   mod: './routes/provisioning', tenancy: true },
  { path: '/api/teams',       mod: './routes/teams',        tenancy: true },
  { path: '/api/white-label', mod: './routes/white-label',  tenancy: true },
  { path: '/api/workspaces',  mod: './routes/workspaces' },
  { path: '/api/admin',       mod: './routes/admin' },
  { path: '/api/tokens',      mod: './routes/tokens',       tenancy: true },
];

module.exports = { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS };
