'use strict';

/*
 * EVERY table in the database, classified for the complete organization export (lib/trust/export.js).
 *
 * ⚠️ THIS LIST IS TOTAL ON PURPOSE. test/trust-export.test.js walks sqlite_master and fails on any
 * table that is neither exported (with a category and a scope) nor excluded (with a reason). A new
 * table therefore cannot be left out of "everything" by omission: whoever adds it decides, here,
 * whether it is the organization's data and how a row is found to belong to one.
 *
 * scope:
 *   { ws: col }               rows whose `col` is one of the organization's workspaces
 *   { org: col }              rows whose `col` is the organization
 *   { via: col, parent: t }   rows whose `col` is the id (or `pk`) of an exported row of table t
 *   { self: true }            the organization row itself
 *   { members: true }         users who are members of the organization (a subset of columns)
 *   { audit: true }           activity_log: the org's workspaces, or the org itself
 *
 * Secrets never leave, whatever the scope: any column whose NAME looks like a credential
 * (lib/secret-names.js, the definition mesh replication and MCP already share) is dropped, the
 * replication BLOCKLIST is applied, and JSON config columns are scrubbed of encrypted values and
 * secret-named keys (lib/mesh/replication.js scrubJson). See redactRow in export.js.
 */

const ws = (col = 'workspace_id') => ({ ws: col });
const org = (col = 'organization_id') => ({ org: col });
const via = (col, parent, pk = 'id') => ({ via: col, parent, pk });

// The categories a manifest always lists, in this order — even an empty one says "nothing of this kind".
const CATEGORIES = [
  'organization', 'members', 'content', 'playlists', 'schedules', 'layouts', 'signs', 'widgets',
  'data_sources', 'devices', 'alerts', 'automation', 'integrations', 'settings', 'history',
  'proof_of_play', 'audit', 'outbound',
];

const EXPORTED = {
  // organization
  organizations: { category: 'organization', scope: { self: true } },
  workspaces: { category: 'organization', scope: org() },
  org_deletion_requests: { category: 'organization', scope: org() },
  storage_profiles: { category: 'settings', scope: org('org_id') },
  storage_migrations: { category: 'settings', scope: org('org_id') },
  // members and identity
  users: { category: 'members', scope: { members: true } },
  organization_members: { category: 'members', scope: org() },
  workspace_members: { category: 'members', scope: ws() },
  workspace_invites: { category: 'members', scope: ws() },
  workspace_reviewers: { category: 'members', scope: ws() },
  org_sso_providers: { category: 'members', scope: org() },
  org_sso_domains: { category: 'members', scope: org() },
  org_sso_only_requests: { category: 'members', scope: org() },
  org_scim_settings: { category: 'members', scope: org() },
  scim_tokens: { category: 'members', scope: org() },
  scim_users: { category: 'members', scope: org() },
  scim_groups: { category: 'members', scope: org() },
  scim_group_members: { category: 'members', scope: via('group_id', 'scim_groups') },
  scim_group_mappings: { category: 'members', scope: org() },
  scim_workspace_grants: { category: 'members', scope: org() },
  scim_events: { category: 'members', scope: org() },
  // content
  content: { category: 'content', scope: ws() },
  content_folders: { category: 'content', scope: ws() },
  content_locations: { category: 'content', scope: via('content_id', 'content') },
  custom_fonts: { category: 'content', scope: ws() },
  custom_shaders: { category: 'content', scope: ws() },
  brand_kits: { category: 'content', scope: ws() },
  cloud_folders: { category: 'content', scope: ws() },
  cloud_folder_items: { category: 'content', scope: via('folder_id', 'cloud_folders') },
  cloud_folder_removed: { category: 'content', scope: via('folder_id', 'cloud_folders') },
  canva_links: { category: 'content', scope: ws() },
  canva_jobs: { category: 'content', scope: ws() },
  content_requests: { category: 'content', scope: ws() },
  request_forms: { category: 'content', scope: ws() },
  // playlists
  playlists: { category: 'playlists', scope: ws() },
  playlist_items: { category: 'playlists', scope: via('playlist_id', 'playlists') },
  playlist_item_schedules: { category: 'playlists', scope: via('playlist_item_id', 'playlist_items') },
  // 3.0 campaigns: what each zone of a layout item plays (lib/campaign.js).
  playlist_item_zone_sources: { category: 'playlists', scope: via('item_id', 'playlist_items') },
  corporate_slots: { category: 'playlists', scope: org() },
  corporate_mandates: { category: 'playlists', scope: org() },
  corporate_slot_fills: { category: 'playlists', scope: ws() },
  corporate_compositions: { category: 'playlists', scope: via('playlist_id', 'playlists') },
  // schedules
  schedules: { category: 'schedules', scope: ws() },
  display_power_schedules: { category: 'schedules', scope: ws() },
  // layouts
  layouts: { category: 'layouts', scope: ws() },
  layout_zones: { category: 'layouts', scope: via('layout_id', 'layouts') },
  // 3.0: a layout's portrait / 4:3 versions (lib/layout-variants.js).
  layout_zone_variants: { category: 'layouts', scope: via('layout_id', 'layouts') },
  // slides, signs, kiosks
  slide_decks: { category: 'signs', scope: ws() },
  kiosk_pages: { category: 'signs', scope: ws() },
  kiosk_sessions: { category: 'signs', scope: ws() },
  qr_links: { category: 'signs', scope: ws() },
  qr_scans: { category: 'signs', scope: via('link_id', 'qr_links') },
  // widgets
  widgets: { category: 'widgets', scope: ws() },
  // data sources and feeds (configs only: secrets are redacted)
  data_sources: { category: 'data_sources', scope: ws() },
  cap_feeds: { category: 'data_sources', scope: ws() },
  cap_alerts: { category: 'data_sources', scope: via('feed_id', 'cap_feeds') },
  cap_feed_scopes: { category: 'data_sources', scope: via('feed_id', 'cap_feeds') },
  social_feeds: { category: 'data_sources', scope: ws() },
  social_posts: { category: 'data_sources', scope: via('feed_id', 'social_feeds') },
  rooms: { category: 'data_sources', scope: ws() },
  room_bookings: { category: 'data_sources', scope: via('room_id', 'rooms') },
  room_checkins: { category: 'data_sources', scope: via('room_id', 'rooms') },
  // devices
  devices: { category: 'devices', scope: ws() },
  device_groups: { category: 'devices', scope: ws() },
  device_group_members: { category: 'devices', scope: via('group_id', 'device_groups') },
  device_settings: { category: 'devices', scope: ws() },
  device_endpoints: { category: 'devices', scope: ws() },
  device_fingerprints: { category: 'devices', scope: via('device_id', 'devices') },
  device_telemetry: { category: 'devices', scope: via('device_id', 'devices') },
  assignments: { category: 'devices', scope: via('device_id', 'devices') },
  video_walls: { category: 'devices', scope: ws() },
  video_wall_devices: { category: 'devices', scope: via('wall_id', 'video_walls') },
  triggers: { category: 'devices', scope: ws() },
  trigger_assignments: { category: 'devices', scope: via('trigger_id', 'triggers') },
  emergency_activations: { category: 'devices', scope: via('trigger_id', 'triggers') },
  emergency_trigger_scopes: { category: 'devices', scope: via('trigger_id', 'triggers') },
  screenshots: { category: 'devices', scope: via('device_id', 'devices') },
  // alerts and screen verification
  alert_channels: { category: 'alerts', scope: ws() },
  alert_channel_scopes: { category: 'alerts', scope: via('channel_id', 'alert_channels') },
  alert_deliveries: { category: 'alerts', scope: via('channel_id', 'alert_channels') },
  alert_configs: { category: 'alerts', scope: ws() },
  alert_events: { category: 'alerts', scope: ws() },
  alert_rules: { category: 'alerts', scope: ws() },
  alert_rule_state: { category: 'alerts', scope: via('rule_id', 'alert_rules') },
  screen_verification_settings: { category: 'alerts', scope: ws() },
  screen_verification_incidents: { category: 'alerts', scope: ws() },
  screen_verification_state: { category: 'alerts', scope: ws() },
  screen_verification_deliveries: { category: 'alerts', scope: via('incident_id', 'screen_verification_incidents') },
  // automation and API access (token hashes are redacted; names, scopes and dates remain)
  automation_hooks: { category: 'automation', scope: ws() },
  automation_hook_calls: { category: 'automation', scope: via('hook_id', 'automation_hooks') },
  automation_subscriptions: { category: 'automation', scope: ws() },
  automation_deliveries: { category: 'automation', scope: via('subscription_id', 'automation_subscriptions') },
  automation_events: { category: 'automation', scope: ws() },
  automation_overrides: { category: 'automation', scope: ws() },
  api_tokens: { category: 'automation', scope: ws() },
  api_token_targets: { category: 'automation', scope: via('token_id', 'api_tokens') },
  // organization-level integrations (credentials redacted)
  org_m365_apps: { category: 'integrations', scope: org() },
  canva_integrations: { category: 'integrations', scope: org() },
  bi_connections: { category: 'integrations', scope: org() },
  social_connections: { category: 'integrations', scope: org() },
  room_connections: { category: 'integrations', scope: org() },
  audience_org_settings: { category: 'integrations', scope: org() },
  // workspace settings
  white_labels: { category: 'settings', scope: ws() },
  ai_settings: { category: 'settings', scope: ws() },
  ai_credit_ledger: { category: 'settings', scope: org('org_id') },
  ai_credit_reservations: { category: 'settings', scope: ws() },
  freshness_settings: { category: 'settings', scope: ws() },
  freshness_snoozes: { category: 'settings', scope: ws() },
  agency_notifications: { category: 'settings', scope: ws() },
  plugin_submissions: { category: 'settings', scope: ws() },
  // version history and approvals
  revisions: { category: 'history', scope: ws() },
  submissions: { category: 'history', scope: ws() },
  // proof of play, usage and device logs
  play_logs: { category: 'proof_of_play', scope: ws() },
  play_log_hourly: { category: 'proof_of_play', scope: ws() },
  audience_buckets: { category: 'proof_of_play', scope: ws() },
  device_usage_daily: { category: 'proof_of_play', scope: via('device_id', 'devices') },
  device_status_log: { category: 'proof_of_play', scope: via('device_id', 'devices') },
  device_events: { category: 'proof_of_play', scope: via('device_id', 'devices') },
  conversion_events: { category: 'proof_of_play', scope: ws() },
  feedback: { category: 'proof_of_play', scope: ws() },
  // energy and carbon report (3.0)
  energy_settings: { category: 'settings', scope: ws() },
  energy_device_settings: { category: 'devices', scope: ws() },
  energy_hourly: { category: 'proof_of_play', scope: ws() },
  energy_daily: { category: 'proof_of_play', scope: ws() },
  // private AI and sign translation (3.0)
  ai_private_hosts: { category: 'settings', scope: org('org_id') },
  org_ai_policy: { category: 'settings', scope: org('org_id') },
  sign_translations: { category: 'signs', scope: ws() },
  device_languages: { category: 'devices', scope: ws() },
  // experiments (3.0)
  experiments: { category: 'playlists', scope: ws() },
  experiment_units: { category: 'playlists', scope: via('experiment_id', 'experiments') },
  experiment_exposure: { category: 'proof_of_play', scope: via('experiment_id', 'experiments') },
  experiment_outcomes: { category: 'proof_of_play', scope: via('experiment_id', 'experiments') },
  // accessibility checker (3.0)
  a11y_settings: { category: 'settings', scope: ws() },
  // switch to ScreenTinker (3.0): screens imported from another system, waiting to be paired
  migration_screens: { category: 'devices', scope: ws() },
  // the audit trail
  activity_log: { category: 'audit', scope: { audit: true } },
  // what the server contacted on the organization's behalf (host level, lib/outbound-ledger.js)
  outbound_ledger: { category: 'outbound', scope: org() },
};

// Not the organization's data (instance configuration, shared caches, other people's), or not data
// at all (transient state a restart would rebuild). Each one says why.
const EXCLUDED = {
  app_settings: 'instance configuration, not an organization\'s',
  a11y_media_checks: 'cached results of the accessibility checks on media: recomputed automatically',
  content_video_variants: 'TV-safe re-encoded copies of tall videos (lib/video-variants.js): a cache, made again on demand on the new server',
  video_variant_usage: 'per-month encode minutes for the hosted TV-safe copy allowance: instance accounting, not the organization\'s data',
  site_caches: 'a site cache box and the credential it signs in with: set the box up again on the new server (docs/site-cache.md)',
  device_wifi_networks: 'Wi-Fi passwords of the screens (#720, lib/device-wifi.js): credentials into the customer\'s network never leave a server; the screens keep the networks they already joined, and new ones are entered again on the new server',
  site_cache_assignments: 'which screens use a site cache box: follows site_caches',
  migration_jobs: 'import jobs from another signage system: transient, and may still hold an encrypted source credential',
  migration_items: 'an import\'s source-to-ScreenTinker id map, only used to make re-running an import safe',
  schema_migrations: 'database bookkeeping',
  plans: 'the instance\'s plan catalog',
  promotions: 'the instance\'s promotions',
  billing_receipts: 'a person\'s receipts: in their personal export',
  telemetry_reports: 'the statistics collector\'s own table (other installs)',
  event_loop_lag: 'server performance samples',
  hardware_submissions: 'the public certified-hardware queue',
  ota_rollouts: 'player release rollouts, instance-wide',
  plugin_allowlist: 'instance plugin approvals',
  plugin_state: 'instance plugin state',
  template_catalogs: 'instance template catalog configuration',
  templates_installed: 'instance template library',
  template_seen: 'a person\'s "seen" markers: in their personal export',
  feedback_prompts: 'which feedback questions a person has already been asked (lib/feedback.js): the hosting service\'s bookkeeping',
  feedback_followups: 'which feedback follow-up emails a person was sent (lib/feedback.js): the hosting service\'s bookkeeping',
  recovery_grants: 'break-glass credentials (secret)',
  support_grants: 'support access credentials (secret)',
  support_requests: 'support access codes (secret)',
  saml_requests: 'transient sign-in state',
  saml_used_assertions: 'replay protection, transient',
  app_sso_codes: 'transient sign-in hand-off codes (secret)',
  webauthn_challenges: 'transient passkey challenges',
  webauthn_credentials: 'a person\'s passkeys: in their personal export',
  totp_recovery_codes: 'two-factor recovery codes (secret)',
  teams: 'legacy per-person teams: in the personal export',
  team_members: 'legacy per-person teams: in the personal export',
  team_invites: 'legacy per-person teams',
  canva_connections: 'a person\'s own Canva sign-in (OAuth tokens)',
  freshness_digest_prefs: 'a person\'s email preference: in their personal export',
  request_email_challenges: 'transient email verification codes (secret)',
  request_tickets: 'transient request-page tickets (secret)',
  upload_sessions: 'in-progress uploads, transient',
  social_media: 'content-addressed image cache shared by every feed (the posts reference it)',
  weather_cells: 'shared weather cache',
  audience_ingested: 'deduplication hashes, transient',
  automation_device_state: 'transient automation state',
  embedded_cursor: 'transient player position',
  embedded_zone_cursor: 'transient player position',
  room_panel_presence: 'transient panel heartbeat',
  play_log_rollup_dirty: 'internal rollup bookkeeping',
  play_log_rollup_state: 'internal rollup bookkeeping',
  player_debug_logs: 'short-lived player diagnostics keyed by device, not tenant',
  device_diagnostic_logs: 'short-lived hardware diagnostics keyed by device, not tenant',
  data_exports: 'the export jobs themselves',
  instance_exports: 'the platform administrator\'s whole-server export jobs',
  org_imports: 'organization import jobs on this server (docs/move-server.md): may hold an encrypted download key',
  org_import_ids: 'an import\'s old-to-new id map, only used to resume an interrupted import',
  mesh_change_log: 'replication log, derived from the tables exported here',
  mesh_client_access: 'multi-server mesh topology, instance-wide',
  mesh_clients: 'multi-server mesh topology, instance-wide',
  mesh_content_cache: 'mesh media cache, instance-wide',
  mesh_content_provenance: 'mesh media provenance, instance-wide',
  mesh_edges: 'mesh links (credentials), instance-wide',
  mesh_mirror_alerts: 'mirror of another server\'s alerts',
  mesh_mirror_devices: 'mirror of another server\'s devices',
  mesh_mirror_nodes: 'mirror of other servers',
  mesh_mirror_play_logs: 'mirror of another server\'s plays',
  mesh_mirror_workspaces: 'mirror of another server\'s workspaces',
  mesh_node: 'this server\'s mesh identity',
  mesh_node_paths: 'mesh topology',
  mesh_pairing_codes: 'mesh pairing codes (secret)',
  mesh_invites: 'mesh replica invites (secret)',
  mesh_player_events: 'mesh delivery queue, transient',
  mesh_player_verdicts: 'mesh verification cache',
  mesh_pull_tickets: 'mesh download tickets (secret)',
  mesh_tombstones: 'mesh deletion markers',
  mesh_write_ops: 'mesh write journal',
};

// Columns of `users` an organization export carries for each MEMBER. A member's personal data
// beyond who they are and how they sign in belongs in their own personal export.
const MEMBER_COLUMNS = ['id', 'email', 'name', 'auth_provider', 'role', 'totp_enabled', 'email_verified', 'created_at', 'last_login', 'disabled_at'];

module.exports = { CATEGORIES, EXPORTED, EXCLUDED, MEMBER_COLUMNS };
