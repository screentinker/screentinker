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
  // Content approval and version history. Workspace-scoped through the same tenancy middleware
  // as everything above; the settings endpoint is admin-only inside the router.
  { path: '/api/approvals',   mod: './routes/approvals' },
  { path: '/api/revisions',   mod: './routes/revisions' },
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
  // CAP emergency feeds (lib/cap/feeds.js): an integrator wires a site's alert feed from its own tooling.
  { path: '/api/cap-feeds',   mod: './routes/cap-feeds' },
  // Tracked QR links (lib/qr-links.js): workspace content an integrator may create from their own tooling.
  { path: '/api/qr-links',    mod: './routes/qr-links' },
  /*
   * Zapier (and any REST-hook client) — lib/automation. On the token door because Zapier IS an API
   * token: it subscribes to events, polls them, and runs actions. Polling needs 'read'; subscribing
   * and the data action need 'write'; emergency, trigger and playlist actions need 'full' (they
   * take over screens). Hook URLs themselves are minted on /api/automation, which is JWT only.
   */
  { path: '/api/zapier',      mod: './routes/zapier' },
  /*
   * Display power schedules — the weekly BACKLIGHT clock. Public (token-reachable) for the same
   * reason as triggers: an integrator provisioning a site sets these from their own tooling, and
   * "the screens are dark 22:00-06:00" is exactly the kind of thing that belongs in a site
   * handover script rather than in twenty dashboard visits.
   *
   * ⚠️ Like triggers, the DECISION is not here. The panel evaluates its own windows offline; this
   * router only defines them. Nothing in it can turn a device off — see routes/display-power-schedules.js.
   */
  { path: '/api/display-power-schedules', mod: './routes/display-power-schedules' },
  /*
   * Saved device endpoints — REST calls a PANEL makes on its own network. Public (token-reachable)
   * for the same reason as triggers: an integrator provisioning a site configures "poll the PLC
   * every minute" from their own tooling.
   *
   * ⚠️ The REQUESTS are not made here. The panel runs them on its own clock, offline, which is the
   * whole point — this server has no route to the customer's 192.168.x.x. See routes/device-endpoints.js.
   */
  { path: '/api/device-endpoints', mod: './routes/device-endpoints' },
];

const JWT_ONLY_ROUTERS = [
  /*
   * Hosted AI images paid in org credits (docs/ai-credits.md). BEFORE /api/ai: Express walks mounts
   * in order, and listing it after would run /api/ai's auth + tenancy first for every hosted call.
   */
  { path: '/api/ai/hosted',   mod: './routes/ai-hosted',    tenancy: true },
  { path: '/api/ai',          mod: './routes/ai',           tenancy: true },
  { path: '/api/provision',   mod: './routes/provisioning', tenancy: true },
  { path: '/api/teams',       mod: './routes/teams',        tenancy: true },
  { path: '/api/white-label', mod: './routes/white-label',  tenancy: true },
  { path: '/api/workspaces',  mod: './routes/workspaces' },
  // Player rollouts (lib/ota-rollout.js). Before /api/admin: Express walks mounts in order.
  { path: '/api/admin/ota-rollouts', mod: './routes/ota-rollouts' },
  { path: '/api/admin',       mod: './routes/admin' },
  /*
   * Storage profiles (docs/storage.md). JWT only: a profile holds cloud credentials and decides
   * where every workspace in the org writes — not something an API token should reach.
   */
  { path: '/api/storage-profiles', mod: './routes/storage-profiles', tenancy: true },
  /*
   * Alert channels (lib/alert-channels.js). JWT only, for the same reason: a channel holds a Slack /
   * Teams webhook URL or a PagerDuty routing key — credentials into someone else's systems.
   */
  { path: '/api/alert-channels', mod: './routes/alert-channels', tenancy: true },
  /*
   * Canva (lib/canva.js). JWT only: a Canva connection is a person's grant to read their designs,
   * and the org integration holds a client secret. The OAuth callback is mounted on its own in
   * server.js, because the browser comes back from canva.com without a bearer token.
   */
  { path: '/api/canva',       mod: './routes/canva',        tenancy: true },
  /*
   * Microsoft 365 app + SharePoint/OneDrive folder syncs (routes/m365.js). JWT only: the app is a
   * credential into the customer's own tenant, configured from the dashboard.
   */
  { path: '/api/m365', mod: './routes/m365', tenancy: true },
  /*
   * BI connections (lib/bi/connections.js): an organization's Grafana / Power BI / Tableau
   * credentials. JWT only for the same reason as alert channels — they reach into someone else's
   * systems. The dashboard widget's public endpoints are on /api/widgets.
   */
  { path: '/api/bi-connections', mod: './routes/bi-connections', tenancy: true },
  /*
   * Automation (lib/automation): inbound hook URLs are credentials that can take over screens, so
   * minting, rotating and test-firing them is a signed-in admin's act. JWT only.
   */
  { path: '/api/automation', mod: './routes/automation', tenancy: true },
  /*
   * Social walls (lib/social/*): an organization's social network credentials (secrets never
   * returned) and a workspace's feeds and moderation queue. JWT only — no API token reaches them.
   */
  { path: '/api/social', mod: './routes/social', tenancy: true },
  /*
   * Meeting-room displays (lib/rooms). JWT only: a connection holds an organization's Microsoft 365
   * client secret or Google service-account key, and a room may hold a private calendar address.
   * The page-facing reads and actions are /api/room-panel, mounted separately in server.js.
   */
  { path: '/api/rooms', mod: './routes/rooms', tenancy: true },
  /*
   * Plugin zip submissions from workspace editors. JWT-only: installing Node is not
   * something an API token should be able to queue. 404s when PLUGINS_ENABLED is unset.
   */
  { path: '/api/plugin-submissions', mod: './routes/plugin-submissions', tenancy: true },
  // Templates library (lib/templates). JWT only: installing changes what code the server serves.
  { path: '/api/templates',   mod: './routes/templates',    tenancy: true },
  /*
   * Server diagnostics for a platform operator: instance shape, the loop-lag history the server has
   * always recorded and never shown, and an in-process CPU profile. JWT-only and gated again inside
   * on requirePlatformAdmin — a workspace owner is not an operator of the host.
   */
  { path: '/api/admin/diagnostics', mod: './routes/diagnostics' },
  { path: '/api/tokens',      mod: './routes/tokens',       tenancy: true },
  /*
   * Corporate (head office) playlists, mandates and their settings. JWT-only (decision D12): a
   * token acts as its owner with role 'user', and an org admin's token would otherwise be able to
   * repoint every store's screens. Authoring is a signed-in human action.
   */
  { path: '/api/corporate',   mod: './routes/corporate',    tenancy: true },
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
