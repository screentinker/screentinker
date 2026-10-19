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
  // 3.0 Private AI (docs/private-ai.md): local provider, starter set, translations. Before /api/ai too.
  { path: '/api/ai/private',  mod: './routes/ai-private',   tenancy: true },
  { path: '/api/ai',          mod: './routes/ai',           tenancy: true },
  // ONVIF cameras (routes/onvif.js): reaches into a customer's network through their screens, so
  // signed-in people only, never an API token.
  { path: '/api/onvif',       mod: './routes/onvif',        tenancy: true },
  { path: '/api/provision',   mod: './routes/provisioning', tenancy: true },
  { path: '/api/teams',       mod: './routes/teams',        tenancy: true },
  { path: '/api/white-label', mod: './routes/white-label',  tenancy: true },
  /*
   * 3.0 Make a sign (lib/sign-templates.js) and the workspace brand kit (lib/brand-kit.js). JWT only:
   * they are dashboard authoring surfaces for a person; an integrator who wants a slide already has
   * /api/slide-decks on the token door.
   */
  { path: '/api/signs',       mod: './routes/signs',        tenancy: true },
  { path: '/api/brand-kit',   mod: './routes/brand-kit',    tenancy: true },
  /*
   * 3.0 Experiments (lib/experiments). JWT only: a test switches what screens show and reads a
   * store's sales through a saved POS credential — a person's decision, made in the dashboard.
   */
  { path: '/api/experiments', mod: './routes/experiments',  tenancy: true },
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
   * Teams webhook URL, a PagerDuty routing key or a Telegram bot token — credentials into someone
   * else's systems.
   */
  { path: '/api/alert-channels', mod: './routes/alert-channels', tenancy: true },
  /*
   * 3.0 site caches (lib/site-cache, docs/site-cache.md). JWT only: creating one mints a credential
   * that downloads this workspace's media. The box's own door is /api/site-cache/node, mounted in
   * server.js and authenticated by the box's token.
   */
  { path: '/api/site-caches', mod: './routes/site-caches', tenancy: true },
  /*
   * Screen verification (lib/screen-verify): what each screen is actually showing, its incidents,
   * and the workspace's settings. JWT only alongside alert channels: the settings decide how often
   * every screen is asked for a screenshot and who is paged.
   */
  { path: '/api/screen-verification', mod: './routes/screen-verification', tenancy: true },
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
   * Free stock photos and videos (lib/stock-media.js). JWT only: the provider keys and their quota
   * are the operator's, and the pickers that use this are dashboard pages, not integrations.
   */
  { path: '/api/stock', mod: './routes/stock-media', tenancy: true },
  /*
   * BI connections (lib/bi/connections.js): an organization's Grafana / Power BI / Tableau
   * credentials. JWT only for the same reason as alert channels — they reach into someone else's
   * systems. The dashboard widget's public endpoints are on /api/widgets.
   */
  { path: '/api/bi-connections', mod: './routes/bi-connections', tenancy: true },
  /*
   * 3.0 "Your data, provably" (routes/trust.js): the data handling report, the outbound connections
   * ledger, complete exports and "delete everything". JWT only: an export is everything an
   * organization has, and no API token should be able to take it or end the organization.
   */
  { path: '/api/trust', mod: './routes/trust', tenancy: true },
  /*
   * 3.0 move an organization to another server (routes/org-import.js, docs/move-server.md): imports,
   * the screen handover and the whole-server export. JWT only, for the same reason as /api/trust —
   * it writes a whole organization and can send every screen to another address.
   */
  { path: '/api/org-import', mod: './routes/org-import', tenancy: true },
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
   * 3.0 news feeds (lib/news-feed): "Find feeds" on a pasted site and item previews for the widget
   * editor and the designer. JWT only — each call makes this server read a third-party site. The
   * screen-facing reads (/api/news-feeds/items and /image) are mounted in server.js, signed.
   */
  { path: '/api/news-feeds', mod: './routes/news-feeds', tenancy: true },
  /*
   * Meeting-room displays (lib/rooms). JWT only: a connection holds an organization's Microsoft 365
   * client secret or Google service-account key, and a room may hold a private calendar address.
   * The page-facing reads and actions are /api/room-panel, mounted separately in server.js.
   */
  { path: '/api/rooms', mod: './routes/rooms', tenancy: true },
  /*
   * Audience counting (lib/audience.js). JWT only: switching a screen's camera on is a privacy
   * decision for an org owner or admin, never something an API token can do.
   */
  { path: '/api/audience',    mod: './routes/audience',     tenancy: true },
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
  /*
   * Content freshness (lib/freshness.js): the stale-content report, thresholds, snoozes and the
   * caller's own weekly-digest preference. JWT only: the digest preference is a person's, and the
   * report is a dashboard surface, not an integration one.
   */
  { path: '/api/freshness',   mod: './routes/freshness',    tenancy: true },
  /*
   * 3.0: screen share (lib/screen-share.js). JWT only: putting your screen on a TV is a person at a
   * browser. The meeting-room join is /api/share, mounted separately in server.js (no account).
   */
  { path: '/api/screen-share', mod: './routes/screen-share', tenancy: true },
  /*
   * 3.0 content requests (lib/content-requests.js): request forms and the requests they collect.
   * JWT only: a form decides who OUTSIDE the workspace may put things in front of a reviewer, which
   * is a signed-in person's call. The public side is /api/public/requests, mounted in server.js.
   */
  { path: '/api/content-requests', mod: './routes/content-requests', tenancy: true },
  /*
   * 3.0 energy & carbon (lib/energy, docs/energy.md): estimated kWh / CO2e, schedule savings, the
   * ESG exports and the org rollup. JWT only: it is a dashboard report, and the org rollup is a
   * signed-in org admin's view across workspaces, which a workspace-bound token must not reach.
   */
  { path: '/api/energy',      mod: './routes/energy',       tenancy: true },
  /*
   * 3.0 switch to ScreenTinker (lib/migrate): import from another signage CMS. JWT only: the person
   * pastes THEIR key for another vendor's account, and the server pulls with it; that is a signed-in
   * human's act, never an API token's.
   */
  { path: '/api/migrate', mod: './routes/migrate', tenancy: true },
  /*
   * 3.0 accessibility checker (lib/a11y, docs/accessibility.md): the report, the pre-publish check,
   * settings and "Generate captions". JWT only, like freshness: a dashboard surface, and captions
   * send a video's audio to an endpoint, which is a person's decision at a browser.
   */
  { path: '/api/accessibility', mod: './routes/accessibility', tenancy: true },
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
