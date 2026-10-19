'use strict';

/*
 * What an organization import does with EVERY table an organization export carries
 * (lib/trust/export-tables.js EXPORTED). docs/move-server.md is the user-facing version.
 *
 * ⚠️ THIS LIST IS TOTAL ON PURPOSE, like the export's. test/trust-export.test.js fails on an exported
 * table that is neither restored here nor "not restored" with a reason, and on any `*_id` column of a
 * restored table that is not classified below (a scope, a reference, an external id or a person). A
 * new table or column therefore cannot be carried across, or silently dropped, by omission.
 *
 * Every restored row gets a NEW id and every reference is rewritten through the import's id map
 * (lib/trust/import-restore.js). A reference to something that is NOT in the archive is never kept
 * as written: kept, it could name a row that already exists on this server and belongs to someone
 * else — a hand-edited archive would otherwise reach across tenants through it.
 */

/* Restored as rows. `optional` names the scan option that can leave a history category out. */
const RESTORED = {
  // organization and its workspaces: built by the restore itself (new organization or an empty one)
  organizations: { special: true },
  workspaces: { billing_contract_ref: 'external', origin_node_id: null, storage_profile_id: null },
  // members: in an organization import they become pending invites; a whole-server restore
  // recreates the accounts (lib/trust/import-restore.js restoreMembers)
  users: { special: true },
  organization_members: { special: true },
  workspace_members: { special: true },
  workspace_invites: {},
  org_sso_providers: {},
  org_scim_settings: {},
  scim_groups: {},
  scim_group_mappings: {},
  scim_events: { optional: 'history' },
  // content
  content: {},
  content_folders: {},
  custom_fonts: {},
  custom_shaders: {},
  brand_kits: {},
  cloud_folders: {},
  cloud_folder_items: {},
  cloud_folder_removed: {},
  canva_links: {},
  content_requests: {},
  request_forms: {},
  // playlists
  playlists: {},
  playlist_items: {},
  playlist_item_schedules: {},
  // 3.0 campaigns: what each zone of a layout item plays (declared FKs: item, zone, playlist)
  playlist_item_zone_sources: {},
  corporate_slots: {},
  corporate_mandates: {},
  corporate_slot_fills: {},
  experiments: {},
  experiment_units: {},
  // schedules and layouts
  schedules: {},
  display_power_schedules: {},
  layouts: {},
  layout_zones: {},
  // 3.0 portrait / 4:3 versions of a layout's zones (declared FKs: layout, zone)
  layout_zone_variants: {},
  // signs
  slide_decks: {},
  kiosk_pages: {},
  kiosk_sessions: { optional: 'proof_of_play' },
  qr_links: {},
  qr_scans: { optional: 'proof_of_play' },
  sign_translations: {},
  widgets: {},
  // data sources and feeds
  data_sources: {},
  cap_feeds: {},
  cap_alerts: {},
  cap_feed_scopes: {},
  social_feeds: {},
  rooms: {},
  room_bookings: { optional: 'proof_of_play' },
  room_checkins: { optional: 'proof_of_play' },
  // devices
  devices: {},
  device_groups: {},
  device_group_members: {},
  device_settings: {},
  device_endpoints: {},
  device_fingerprints: {},
  device_telemetry: { optional: 'proof_of_play' },
  assignments: {},
  video_walls: {},
  video_wall_devices: {},
  triggers: {},
  trigger_assignments: {},
  emergency_activations: { optional: 'history' },
  emergency_trigger_scopes: {},
  device_languages: {},
  energy_device_settings: {},
  migration_screens: {},
  // alerts and screen verification
  alert_channels: {},
  alert_channel_scopes: {},
  alert_configs: {},
  alert_events: { optional: 'history' },
  alert_rules: {},
  screen_verification_settings: {},
  screen_verification_incidents: { optional: 'history' },
  // automation
  automation_hooks: {},
  automation_hook_calls: { optional: 'history' },
  automation_overrides: {},
  // organization-level integrations: restored DISCONNECTED (their credentials never leave a server)
  org_m365_apps: {},
  canva_integrations: {},
  bi_connections: {},
  social_connections: {},
  room_connections: {},
  audience_org_settings: {},
  // settings
  white_labels: {},
  ai_settings: {},
  freshness_settings: {},
  freshness_snoozes: {},
  energy_settings: {},
  org_ai_policy: {},
  a11y_settings: {},
  // version history and approvals
  revisions: { optional: 'history' },
  submissions: { optional: 'history' },
  // proof of play and usage
  play_logs: { optional: 'proof_of_play' },
  play_log_hourly: { optional: 'proof_of_play' },
  audience_buckets: { optional: 'proof_of_play' },
  device_usage_daily: { optional: 'proof_of_play' },
  device_status_log: { optional: 'proof_of_play' },
  device_events: { optional: 'proof_of_play' },
  energy_hourly: { optional: 'proof_of_play' },
  energy_daily: { optional: 'proof_of_play' },
  experiment_exposure: { optional: 'proof_of_play' },
  experiment_outcomes: { optional: 'proof_of_play' },
  // the audit trail, as read-only history
  activity_log: { optional: 'audit' },
};

/*
 * Restored by a whole-server restore (platform admin, docs/move-server.md) but NOT by an
 * organization import, each with the reason an organization admin reads.
 */
const ORG_IMPORT_SKIPS = {
  workspace_reviewers: 'Reviewers are people: once your members accept their invites, choose the reviewers again (Settings → Approvals).',
  scim_users: 'People provisioned by SCIM are provisioned again by your identity provider once you give it this server\'s SCIM address and a new token.',
  scim_group_members: 'Follows the SCIM people above: your identity provider sends the group members again.',
  scim_workspace_grants: 'Follows the SCIM people above.',
  ai_private_hosts: 'A private AI address is approved per server by its platform administrator; ask the administrator of this server to allow it again.',
};

/* Never restored, in either mode — each with the reason. */
const NOT_RESTORED = {
  org_deletion_requests: 'A scheduled deletion of the old organization does not follow it to the new server.',
  storage_profiles: 'Storage bucket credentials never leave a server, so the media is restored into this server\'s storage. Set a bucket up again if you used one.',
  storage_migrations: 'A storage migration in progress on the old server.',
  org_sso_domains: 'Domain verification is proof for the old server. Verify your domain again (Settings → Single sign-on).',
  org_sso_only_requests: 'Requests to the old server\'s administrator to enforce single sign-on.',
  scim_tokens: 'SCIM tokens are credentials; create a new one for your identity provider.',
  content_locations: 'Where the old server kept the media bytes; this server records its own.',
  canva_jobs: 'Canva jobs in progress on the old server.',
  corporate_compositions: 'A cache of composed head office loops; it is rebuilt automatically.',
  social_posts: 'Social posts are fetched again from the networks once the feed\'s connection is reconnected.',
  screenshots: 'Screenshot images are not part of the export.',
  alert_deliveries: 'Delivery state of alerts the old server sent.',
  alert_rule_state: 'Live threshold state; it is rebuilt from the screens\' reports.',
  screen_verification_state: 'Live screen verification state; it is rebuilt as screens report.',
  screen_verification_deliveries: 'Delivery state of verification alerts the old server sent.',
  automation_subscriptions: 'Outgoing webhooks belong to an API token, and API tokens are not carried. Subscribe again with a new token.',
  automation_deliveries: 'The old server\'s outgoing webhook queue.',
  automation_events: 'The old server\'s outgoing webhook queue.',
  api_tokens: 'API tokens are credentials; create new ones and update the systems that used them.',
  api_token_targets: 'Follows the API tokens.',
  ai_credit_ledger: 'AI credits are bought on, and billed by, the old server.',
  ai_credit_reservations: 'AI credits are bought on, and billed by, the old server.',
  agency_notifications: 'The old server\'s notification queue for API tokens.',
  plugin_submissions: 'Plugins are approved per server by its platform administrator.',
  conversion_events: 'The hosting service\'s own product analytics, not your organization\'s data.',
  outbound_ledger: 'The old server\'s record of the hosts it contacted; this server keeps its own.',
};

/*
 * Columns that hold a person's id. In an organization import every person is a pending invite, so
 * these become the importing administrator (or NULL where a column may be empty, for history);
 * a whole-server restore maps them to the recreated accounts.
 */
const USER_COLUMNS = new Set([
  'user_id', 'created_by', 'updated_by', 'uploaded_by', 'decided_by', 'requested_by', 'submitted_by',
  'reviewer_id', 'actor_user_id', 'published_by', 'added_by', 'started_by', 'ended_by', 'invited_by',
  'owner_user_id', 'acting_user_id',
]);

/*
 * The columns that scope a row to the organization (rewritten to the destination organization or the
 * new workspace ids), per the export's scope.
 */
const SCOPE_COLUMNS = new Set(['workspace_id', 'organization_id', 'org_id']);

/*
 * References the database does not declare as foreign keys, per table: column -> the table it names,
 * or '*' for a polymorphic reference (scope_kind/scope_id and friends) that may name any restored row.
 * Declared foreign keys are read from the schema (PRAGMA foreign_key_list) and need no entry.
 * A value not in the import's map is dropped (NULL, or the row when the column is required).
 */
const REFS = {
  workspaces: { billing_contract_ref: 'external', origin_node_id: null, storage_profile_id: null },
  organizations: { hq_workspace_id: 'workspaces', storage_profile_id: null, stripe_customer_id: null, stripe_subscription_id: null },
  users: { provider_id: null, stripe_customer_id: null, stripe_subscription_id: null },
  workspace_invites: { import_job_id: null },
  org_sso_providers: { client_id: 'external' },
  scim_users: { external_id: 'external' },
  custom_shaders: { shader_id: 'external' },
  assignments: { zone_id: 'layout_zones' },
  org_scim_settings: { default_workspace_id: 'workspaces' },
  content: { team_id: null, storage_profile_id: null },
  brand_kits: { logo_content_id: 'content' },
  cloud_folders: { playlist_id: 'playlists', drive_id: 'external', item_id: 'external' },
  cloud_folder_items: { content_id: 'content', remote_id: 'external' },
  cloud_folder_removed: { content_id: 'content', folder_id: 'cloud_folders' },
  canva_links: { content_id: 'content', design_id: 'external' },
  content_requests: { form_id: 'request_forms', content_id: 'content', submission_id: 'submissions' },
  request_forms: { folder_id: 'content_folders' },
  playlists: { default_zone_id: 'layout_zones', published_default_zone_id: 'layout_zones' },
  playlist_items: { experiment_id: 'experiments' },
  corporate_mandates: { target_id: '*' },
  corporate_slot_fills: { scope_id: '*' },
  experiments: { playlist_id: 'playlists' },
  schedules: {},
  layouts: { team_id: null },
  slide_decks: { playlist_id: 'playlists' },
  kiosk_sessions: { device_id: 'devices', widget_id: 'widgets', client_id: 'external' },
  sign_translations: { source_deck_id: 'slide_decks' },
  widgets: { team_id: null },
  cap_feeds: { widget_id: 'widgets' },
  cap_feed_scopes: { scope_id: '*' },
  rooms: { connection_id: 'room_connections', calendar_id: 'external' },
  room_bookings: { device_id: 'devices', event_id: 'external' },
  room_checkins: { device_id: 'devices', event_id: 'external' },
  devices: { layout_id: 'layouts', wall_id: 'video_walls', team_id: null, default_content_id: 'content', attached_node_id: null },
  device_settings: { default_content_id: 'content', layout_id: 'layouts', playlist_id: 'playlists', team_id: null },
  device_endpoints: {},
  video_walls: { team_id: null },
  triggers: { target_ref: '*' },
  trigger_assignments: { target_id: '*' },
  emergency_trigger_scopes: { scope_id: '*' },
  device_languages: { device_id: 'devices' },
  energy_device_settings: { device_id: 'devices' },
  migration_screens: { job_id: null, playlist_id: 'playlists', layout_id: 'layouts', device_id: 'devices' },
  alert_channel_scopes: { scope_id: '*' },
  alert_events: { rule_id: 'alert_rules', device_id: 'devices' },
  screen_verification_incidents: {},
  automation_hooks: { feed_id: 'social_feeds' },
  automation_overrides: { hook_id: 'automation_hooks', scope_id: '*', playlist_id: 'playlists' },
  org_m365_apps: { tenant_id: 'external', client_id: 'external' },
  canva_integrations: { client_id: 'external' },
  room_connections: { tenant_id: 'external', client_id: 'external' },
  revisions: { resource_id: '*', parent_id: 'revisions', submission_id: 'submissions', file_ref: null, thumb_ref: null },
  submissions: { resource_id: '*', request_id: 'content_requests' },
  play_logs: { client_event_id: 'external', zone_id: 'layout_zones', layout_id: 'layouts' },
  play_log_hourly: { device_id: 'devices', content_id: '*' },
  audience_buckets: { device_id: 'devices', item_id: '*', playlist_id: 'playlists' },
  device_usage_daily: { device_id: 'devices' },
  device_status_log: { device_id: 'devices' },
  device_events: { device_id: 'devices' },
  energy_hourly: { device_id: 'devices' },
  energy_daily: { device_id: 'devices' },
  experiment_units: { square_location_id: 'external', shopify_location_id: 'external' },
  experiment_exposure: { device_id: 'devices' },
  experiment_outcomes: { unit_key: 'external' },
  activity_log: { device_id: 'devices' },
  scim_groups: { external_id: 'external' },
  scim_events: {},
  social_feeds: {},
  device_fingerprints: { hw_fingerprint: 'external' },
  automation_hook_calls: { hook_id: 'automation_hooks' },
  emergency_activations: {},
  qr_scans: {},
  corporate_slots: {},
  freshness_snoozes: { resource_id: '*' },
};

/*
 * Integer references: rows whose own id is an INTEGER the database assigns, so their new ids are only
 * known once inserted (the referencing table is restored after them).
 */
const INT_REFS = {
  'playlist_item_schedules.playlist_item_id': 'playlist_items',
  'experiments.slot_item_id': 'playlist_items',
};

/*
 * Values that must be unique on the whole server. When the old value is taken here, the row gets a
 * fresh one and the restore says so (a printed QR code or a shared request link names the old one).
 */
const UNIQUE_REGENERATE = {
  qr_links: ['code'],
  request_forms: ['code'],
  content_requests: ['ref'],
  org_sso_providers: ['slug'],
  workspaces: ['slug'],
};

/** Which of an import's history categories a restored table belongs to (null: always restored). */
function optionalOf(table) {
  return (RESTORED[table] && RESTORED[table].optional) || null;
}

/** 'restore' | 'skip' for this table in this mode, with the reason when skipped. */
function decision(table, { instance = false } = {}) {
  if (RESTORED[table]) return { restore: true };
  if (ORG_IMPORT_SKIPS[table]) return instance ? { restore: true } : { restore: false, reason: ORG_IMPORT_SKIPS[table] };
  if (NOT_RESTORED[table]) return { restore: false, reason: NOT_RESTORED[table] };
  return null;
}

module.exports = { RESTORED, ORG_IMPORT_SKIPS, NOT_RESTORED, USER_COLUMNS, SCOPE_COLUMNS, REFS, INT_REFS, UNIQUE_REGENERATE, optionalOf, decision };
