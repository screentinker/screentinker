'use strict';

// Issue #18: deleting a user 500'd with "FOREIGN KEY constraint failed".
//
// 23 columns reference users(id) and only 4 (the *_members join tables +
// content_folders) carry ON DELETE CASCADE, so a bare `DELETE FROM users`
// fails the moment the user is referenced anywhere - and a real user always is
// (owns an org, created a workspace, has login activity). The schema also lacks
// cascades from workspaces -> tenant resources, so we cannot rely on the DB to
// clean up; we do it explicitly here in one transaction.
//
// Policy (chosen for #18):
//   - Refuse (OrgHasOtherMembersError -> 409) if the user OWNS an organization
//     that has any other member: don't nuke a shared tenant; transfer first.
//   - Otherwise hard-delete the organizations they solely own (and everything
//     inside), and for orgs they DON'T own, preserve the resources - just unlink
//     the user (SET NULL where the column is nullable, or reassign the legacy
//     creator user_id to the resource's org owner where it is NOT NULL).
//
// defer_foreign_keys=ON makes intra-transaction delete ORDER forgiving (FKs are
// validated once at COMMIT); we still clear every reference so COMMIT is clean.
// A table-existence guard keeps this resilient to partial/older schemas (and
// makes it unit-testable without standing up all ~25 tables).

class OrgHasOtherMembersError extends Error {
  constructor(message, sharedOrgCount) {
    super(message);
    this.name = 'OrgHasOtherMembersError';
    this.sharedOrgCount = sharedOrgCount;
  }
}

// Workspace-scoped tables whose rows must be deleted before their workspace
// (workspace_id is NO ACTION). CASCADE child tables (playlist_items, telemetry,
// assignments, layout_zones, *_devices, *_members) clean themselves up.
const WORKSPACE_SCOPED = [
  'playlists', 'schedules', 'video_walls', 'device_groups', 'devices',
  'content', 'layouts', 'widgets', 'content_folders', 'kiosk_pages',
  'white_labels', 'alert_configs',
];
// Logs that carry a device_id but NO foreign key (so they don't block, but we
// clean them to avoid dangling rows).
const DEVICE_LOG_TABLES = ['device_status_log', 'player_debug_logs', 'audience_buckets', 'audience_ingested', 'automation_device_state'];
// Nullable creator/inviter columns -> SET NULL (preserve the resource).
const NULLABLE_USER_REFS = [
  ['content', 'user_id'], ['devices', 'user_id'], ['layouts', 'user_id'], ['widgets', 'user_id'],
  ['workspaces', 'created_by'], ['organization_members', 'invited_by'], ['workspace_members', 'invited_by'],
  ['team_members', 'invited_by'], ['device_fingerprints', 'user_id'],
  ['activity_log', 'user_id'], ['activity_log', 'acting_user_id'],
  ['cap_feeds', 'user_id'], ['automation_hooks', 'created_by'], ['social_feeds', 'created_by'],
  ['social_connections', 'created_by'], ['bi_connections', 'created_by'], ['canva_integrations', 'updated_by'],
];
// NOT NULL legacy creator columns on workspace-scoped resources -> reassign to
// the resource's org owner (fallback: the acting admin) so the row survives.
const REASSIGN_USER_TABLES = [
  'playlists', 'schedules', 'video_walls', 'device_groups', 'kiosk_pages', 'white_labels', 'alert_configs',
];
// ⚠️ content_folders is NOT one of "their own memberships". Its user_id is the CREATOR of a
// shared workspace folder (routes/folders.js lists them by workspace_id; any member can make one),
// but the column is `NOT NULL REFERENCES users(id) ON DELETE CASCADE` - so the final DELETE FROM
// users silently took every folder the user ever created in somebody else's org, and (parent_id is
// CASCADE too) every subfolder OTHER members had built inside it, dropping their files back to the
// root. It is reassigned like the tables above, but only where it belongs to a workspace: a legacy
// workspace-less folder is visible to nobody but its creator, so it may go with them.
const REASSIGN_WORKSPACE_ONLY_TABLES = ['content_folders'];

const revisions = require('./revisions');

/*
 * The integrations of #520-#526 (Canva, SharePoint, BI, social walls, audience counting, meeting rooms,
 * automation). Most of these tables carry no foreign key at all (canva_*, social_feeds/posts,
 * automation_subscriptions/deliveries/events/overrides, audience_buckets, cloud_folder_removed), and
 * the ones that do would only be cleaned by a cascade that has to be live on the connection doing the
 * delete. Rows that outlive their tenant are not just clutter here: a subscription keeps POSTing a
 * deleted workspace's events to a third party, a folder keeps pulling into nothing, a connection
 * keeps an encrypted credential. So they are deleted explicitly, children before parents.
 *
 * [parent table, its child tables keyed by the parent's id]. Every parent has a workspace_id.
 */
const WORKSPACE_INTEGRATIONS = [
  ['cloud_folders', [['cloud_folder_items', 'folder_id'], ['cloud_folder_removed', 'folder_id']]],
  ['social_feeds', [['social_posts', 'feed_id']]],
  ['rooms', [['room_bookings', 'room_id'], ['room_checkins', 'room_id']]],
  ['automation_hooks', [['automation_hook_calls', 'hook_id']]],
  ['automation_subscriptions', [['automation_deliveries', 'subscription_id']]],
  // Includes the hidden push-mode feeds automation hooks raise their alerts on (source = 'hook').
  ['cap_feeds', [['cap_alerts', 'feed_id'], ['cap_feed_scopes', 'feed_id']]],
  ['canva_links', []], ['canva_jobs', []],
  ['automation_overrides', []], ['automation_events', []], ['audience_buckets', []],
];
// Organization-level settings and credentials of the same features, keyed by organization_id.
// canva_connections made against the org's own Canva app go too (purgeOrgIntegrations) - nothing can
// refresh them once the app is gone. A person's connection to the INSTANCE app is theirs, not the
// org's, and survives until the person is deleted.
const ORG_INTEGRATIONS = [
  'org_m365_apps', 'canva_integrations', 'bi_connections', 'social_connections', 'room_connections', 'audience_org_settings',
];

function purgeWorkspaceIntegrations(db, wsIds, have, out) {
  const wph = inClause(wsIds.length);
  for (const [parent, children] of WORKSPACE_INTEGRATIONS) {
    if (!have.has(parent)) continue;
    for (const [child, col] of children) {
      if (!have.has(child)) continue;
      const r = db.prepare(`DELETE FROM ${child} WHERE ${col} IN (SELECT id FROM ${parent} WHERE workspace_id IN (${wph}))`).run(...wsIds);
      if (child === 'social_posts' && r.changes) out.socialPosts = true;
    }
    db.prepare(`DELETE FROM ${parent} WHERE workspace_id IN (${wph})`).run(...wsIds);
  }
}

function purgeOrgIntegrations(db, orgIds, have) {
  if (!orgIds.length) return;
  const oph = inClause(orgIds.length);
  for (const t of ORG_INTEGRATIONS) if (have.has(t)) db.prepare(`DELETE FROM ${t} WHERE organization_id IN (${oph})`).run(...orgIds);
  if (have.has('canva_connections')) db.prepare(`DELETE FROM canva_connections WHERE integration_key IN (${oph})`).run(...orgIds.map(id => `org:${id}`));
}

/*
 * Canva OAuth tokens are revoked AT CANVA as well as deleted here (lib/canva.js revoke() does the same
 * on disconnect). The tokens and the integration's client secret are read BEFORE the transaction - the
 * org's integration row may be one of the things it deletes - and revoked only after COMMIT, best
 * effort and in the background: a rolled-back delete must leave a working connection, and an
 * unreachable Canva must never fail or hold up a deletion. Returns [{ integration, tokens }].
 */
function collectCanvaTokens(db, have, { userId = null, orgIds = [] }) {
  if (!have.has('canva_connections')) return [];
  const keys = orgIds.map(id => `org:${id}`);
  const where = [];
  const args = [];
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (keys.length) { where.push(`integration_key IN (${inClause(keys.length)})`); args.push(...keys); }
  if (!where.length) return [];
  const rows = db.prepare(`SELECT integration_key, access_enc, refresh_enc FROM canva_connections WHERE ${where.join(' OR ')}`).all(...args);
  if (!rows.length) return [];
  const out = [];
  for (const row of rows) {
    try {
      const integration = require('./canva').integrationByKey(row.integration_key);
      if (!integration) continue;
      const secretbox = require('./secretbox');
      const tokens = [row.refresh_enc, row.access_enc].filter(Boolean).map(e => secretbox.decrypt(e)).filter(Boolean);
      if (tokens.length) out.push({ integration, tokens });
    } catch { /* an undecryptable secret cannot be revoked; the row is deleted regardless */ }
  }
  return out;
}

async function revokeAtCanva(integration, token) {
  const base = (process.env.CANVA_API_BASE || 'https://api.canva.com/rest').replace(/\/+$/, '');
  const basic = Buffer.from(`${integration.clientId}:${integration.clientSecret || ''}`).toString('base64');
  await fetch(`${base}/v1/oauth/revoke`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(10000),
  });
}

// After COMMIT: the side effects outside the database. `revokeCanva(integration, token)` is
// injectable for tests (like `unlink`). Social images are content-addressed and shared between
// feeds, so they are not deleted per post: media.gc() drops every file no surviving post uses.
function afterCommit({ canva = [], socialPosts = false }, revokeCanva = revokeAtCanva) {
  for (const { integration, tokens } of canva) {
    for (const token of tokens) {
      Promise.resolve().then(() => revokeCanva(integration, token)).catch(() => { /* best effort */ });
    }
  }
  if (socialPosts) {
    try { require('./social/media').gc(require('../db/database').db); } catch { /* the periodic gc gets them */ }
  }
}

/*
 * A person stops being a member of a workspace (removed, or moved by a platform admin): what they set
 * up there under their OWN name stops working for them. Their Canva links go (the library items stay;
 * a link re-exports through the person's own Canva connection, which the workspace no longer reaches),
 * their SharePoint folder syncs are paused (the content and the mapping stay, so an admin can see what
 * it was and resume or remove it), and their REST-hook subscriptions are deleted - otherwise the
 * workspace's events keep flowing to a URL of someone who has left.
 *
 * Skipped where they still reach the workspace through an org_owner / org_admin role (canAccessWorkspace):
 * losing the membership row did not take their access away. Call it AFTER the membership row is gone,
 * in the same transaction. Returns { canva_links, cloud_folders_paused, subscriptions }.
 */
function releaseWorkspaceMember(db, { userId, workspaceIds }) {
  const have = tablesPresent(db);
  const out = { canva_links: 0, cloud_folders_paused: 0, subscriptions: 0 };
  for (const wsId of workspaceIds) {
    const ws = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(wsId);
    if (ws && have.has('organization_members')) {
      const om = db.prepare('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?').get(ws.organization_id, userId);
      if (om && (om.role === 'org_owner' || om.role === 'org_admin')) continue;
    }
    if (have.has('canva_links')) out.canva_links += db.prepare('DELETE FROM canva_links WHERE workspace_id = ? AND user_id = ?').run(wsId, userId).changes;
    if (have.has('cloud_folders')) {
      out.cloud_folders_paused += db.prepare(`UPDATE cloud_folders SET enabled = 0, last_status = 'error',
          last_error = 'Paused: the person who set up this folder is no longer a member of this workspace.',
          updated_at = strftime('%s','now') WHERE workspace_id = ? AND user_id = ? AND enabled = 1`).run(wsId, userId).changes;
    }
    if (have.has('automation_subscriptions')) {
      const subIds = db.prepare('SELECT id FROM automation_subscriptions WHERE workspace_id = ? AND user_id = ?').all(wsId, userId).map(r => r.id);
      out.subscriptions += dropSubscriptions(db, subIds, 'the subscriber left the workspace', have);
    }
  }
  return out;
}

// Delete REST-hook subscriptions; their pending deliveries are failed with `reason` (as the Zapier
// unsubscribe route does) so the delivery log still says what happened. Returns how many went.
function dropSubscriptions(db, subIds, reason, have = tablesPresent(db)) {
  if (!subIds.length || !have.has('automation_subscriptions')) return 0;
  const sph = inClause(subIds.length);
  if (have.has('automation_deliveries')) {
    db.prepare(`UPDATE automation_deliveries SET status = 'failed', last_error = ? WHERE subscription_id IN (${sph}) AND status = 'pending'`).run(reason, ...subIds);
  }
  return db.prepare(`DELETE FROM automation_subscriptions WHERE id IN (${sph})`).run(...subIds).changes;
}

/*
 * An API token is revoked: the Zapier (REST-hook) subscriptions it created go with it. A subscription
 * records the token that made it (automation_subscriptions.token_id), and a Zap that can no longer
 * authenticate cannot unsubscribe - so without this, deliveries continue to a receiver whose credential
 * was taken away. Subscriptions made from a dashboard session (token_id NULL) are not a token's.
 */
function dropTokenSubscriptions(db, tokenIds) {
  const have = tablesPresent(db);
  if (!tokenIds.length || !have.has('automation_subscriptions')) return 0;
  const subIds = db.prepare(`SELECT id FROM automation_subscriptions WHERE token_id IN (${inClause(tokenIds.length)})`).all(...tokenIds).map(r => r.id);
  return dropSubscriptions(db, subIds, 'the API token that subscribed was revoked', have);
}

const inClause = n => Array.from({ length: n }, () => '?').join(',');
function tablesPresent(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
}

// Delete the given workspaces and every tenant resource inside them. The
// workspace-scoped tables are NO ACTION (won't cascade from the workspace), so
// we delete them explicitly first; their CASCADE children (playlist_items,
// telemetry, assignments, layout_zones, *_devices) and workspace_members/invites
// clean themselves up. MUST run inside a transaction with defer_foreign_keys=ON.
// `have` is the set of existing table names (tablesPresent()). Returns the content rows it
// deleted, for removeDeletedFiles() to clear off disk once the transaction has COMMITTED.
const CONTENT_FILE_COLS = ['filepath', 'thumbnail_path', 'subtitle_url', 'file_size'];
function purgeWorkspaces(db, wsIds, have, out = {}) {
  if (!wsIds.length) return [];
  const wph = inClause(wsIds.length);
  // ⚠️ Audit F23: rows were all this ever deleted. Remember what the content rows point at on disk
  // (the caller unlinks it after COMMIT), and take the version history with the workspace:
  // revisions/submissions/workspace_reviewers have no FK to workspaces, so nothing cascades, and a
  // surviving revision keeps its retained .history bytes alive through revision-retention forever.
  // Submissions BEFORE revisions (submissions.revision_id is a NO ACTION FK). Matched by workspace
  // AND by resource id, because revisions.workspace_id is nullable.
  let contentRows = [];
  if (have.has('content')) {
    const cols = new Set(db.prepare('PRAGMA table_info(content)').all().map(c => c.name));
    const pick = ['id', ...CONTENT_FILE_COLS.filter(c => cols.has(c))].join(', ');
    contentRows = db.prepare(`SELECT ${pick} FROM content WHERE workspace_id IN (${wph})`).all(...wsIds);
  }
  for (const hist of ['submissions', 'revisions']) {
    if (!have.has(hist)) continue;
    db.prepare(`DELETE FROM ${hist} WHERE workspace_id IN (${wph})`).run(...wsIds);
    for (const [type, table] of Object.entries(revisions.TABLE)) {
      if (!have.has(table)) continue;
      db.prepare(`DELETE FROM ${hist} WHERE resource_type = ? AND resource_id IN (SELECT id FROM ${table} WHERE workspace_id IN (${wph}))`).run(type, ...wsIds);
    }
  }
  if (have.has('workspace_reviewers')) db.prepare(`DELETE FROM workspace_reviewers WHERE workspace_id IN (${wph})`).run(...wsIds);
  if (have.has('devices')) {
    const devIds = db.prepare(`SELECT id FROM devices WHERE workspace_id IN (${wph})`).all(...wsIds).map(r => r.id);
    if (devIds.length) {
      const dph = inClause(devIds.length);
      for (const lt of DEVICE_LOG_TABLES) if (have.has(lt)) db.prepare(`DELETE FROM ${lt} WHERE device_id IN (${dph})`).run(...devIds);
    }
  }
  purgeWorkspaceIntegrations(db, wsIds, have, out);
  for (const t of WORKSPACE_SCOPED) if (have.has(t)) db.prepare(`DELETE FROM ${t} WHERE workspace_id IN (${wph})`).run(...wsIds);
  // #150: purge fingerprint-keyed device settings for these workspaces. device_settings has
  // NO FK to devices (so it survives device deletion by design), which means it is NOT caught
  // by this cascade either — purge it explicitly so saved settings can never bleed onto a
  // different tenant if the same physical device (same fingerprint) later pairs elsewhere.
  if (have.has('device_settings')) db.prepare(`DELETE FROM device_settings WHERE workspace_id IN (${wph})`).run(...wsIds);
  if (have.has('activity_log')) db.prepare(`UPDATE activity_log SET workspace_id = NULL WHERE workspace_id IN (${wph})`).run(...wsIds);
  db.prepare(`DELETE FROM workspaces WHERE id IN (${wph})`).run(...wsIds); // cascades workspace_members/invites
  return contentRows;
}

// After COMMIT only (a rolled-back cascade must leave every file in place): unlink the deleted
// rows' media through the refcounted path - mesh-shared bytes another workspace still serves are
// kept - and their .history copies. Returns { files_removed, bytes_freed }. `unlink(rel, column)`
// is injectable for tests; lib/content-files is required lazily, only when there is work.
function removeDeletedFiles(contentRows, unlink) {
  if (!contentRows.length) return { files_removed: 0, bytes_freed: 0 };
  return require('./content-files').removeDeletedContentFiles(contentRows, { unlink });
}

// #36: cascade-delete a single workspace (and all its tenant resources). The
// parent org is left intact. Platform-admin action; callers gate authorization.
function deleteWorkspaceCascade(db, { workspaceId, unlink, before, revokeCanva }) {
  const side = {};
  const gone = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    // `before` runs inside the same transaction: a caller's own cleanup (corporate targets) commits
    // with the delete or not at all, and the files still go only after commit (audit F23).
    if (before) before();
    return purgeWorkspaces(db, [workspaceId], tablesPresent(db), side);
  })();
  afterCommit(side, revokeCanva);
  return removeDeletedFiles(gone, unlink);
}

// #36: cascade-delete an organization - all its workspaces + tenant resources,
// then the org itself (cascades organization_members). Member USERS are NOT
// deleted (they may belong to other orgs); they simply lose this membership.
function deleteOrgCascade(db, { orgId, unlink, revokeCanva }) {
  const have = tablesPresent(db);
  const side = { canva: collectCanvaTokens(db, have, { orgIds: [orgId] }) };
  const gone = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    const wsIds = db.prepare('SELECT id FROM workspaces WHERE organization_id = ?').all(orgId).map(r => r.id);
    const rows = purgeWorkspaces(db, wsIds, have, side);
    purgeOrgIntegrations(db, [orgId], have);
    if (have.has('activity_log')) db.prepare('UPDATE activity_log SET organization_id = NULL WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId); // cascades organization_members
    return rows;
  })();
  afterCommit(side, revokeCanva);
  return removeDeletedFiles(gone, unlink);
}

function listOwnedOrgsWithSharing(db, userId) {
  let orgs = [];
  try { orgs = db.prepare('SELECT id FROM organizations WHERE owner_user_id = ?').all(userId); }
  catch { return []; } // no organizations table (legacy) -> nothing owned
  return orgs.map(o => {
    const otherOrgMembers = db.prepare(
      'SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = ? AND user_id != ?'
    ).get(o.id, userId).c;
    const otherWsMembers = db.prepare(`
      SELECT COUNT(*) AS c FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE w.organization_id = ? AND wm.user_id != ?
    `).get(o.id, userId).c;
    return { id: o.id, shared: (otherOrgMembers + otherWsMembers) > 0 };
  });
}

// Throws OrgHasOtherMembersError if the user owns a shared org. Otherwise
// deletes the user and resolves every reference in one transaction, then removes
// the files of the content that went with their solo orgs ({ files_removed, bytes_freed }).
function deleteUserCascade(db, { targetId, actingAdminId, unlink, revokeCanva }) {
  const owned = listOwnedOrgsWithSharing(db, targetId);
  const shared = owned.filter(o => o.shared);
  if (shared.length > 0) {
    throw new OrgHasOtherMembersError(
      'User owns an organization with other members - reassign ownership before deleting',
      shared.length
    );
  }
  const soloOrgIds = owned.map(o => o.id);

  const have = tablesPresent(db);
  // Their own Canva connections (encrypted OAuth tokens), and any made against a solo org's app.
  const side = { canva: collectCanvaTokens(db, have, { userId: targetId, orgIds: soloOrgIds }) };

  let gone = [];
  const run = db.transaction(() => {
    // FK checks deferred to COMMIT: order of our deletes no longer matters, only
    // that no dangling reference remains at the end.
    db.pragma('defer_foreign_keys = ON');

    // 1) Hard-delete the orgs the user solely owns (and everything inside).
    if (soloOrgIds.length) {
      const wsIds = db.prepare(
        `SELECT id FROM workspaces WHERE organization_id IN (${inClause(soloOrgIds.length)})`
      ).all(...soloOrgIds).map(r => r.id);
      gone = purgeWorkspaces(db, wsIds, have, side);
      purgeOrgIntegrations(db, soloOrgIds, have);

      const oph = inClause(soloOrgIds.length);
      if (have.has('activity_log')) db.prepare(`UPDATE activity_log SET organization_id = NULL WHERE organization_id IN (${oph})`).run(...soloOrgIds);
      db.prepare(`DELETE FROM organizations WHERE id IN (${oph})`).run(...soloOrgIds); // cascades organization_members
    }

    // 2) Unlink the user's footprint in orgs they DON'T own (rows still present).
    // 2a) nullable creator/inviter columns -> SET NULL.
    for (const [t, c] of NULLABLE_USER_REFS) if (have.has(t)) db.prepare(`UPDATE ${t} SET ${c} = NULL WHERE ${c} = ?`).run(targetId);

    // 2b) NOT NULL legacy creator columns -> reassign to the resource's org owner
    //     (fallback acting admin), preserving the resource under a valid owner.
    for (const t of REASSIGN_USER_TABLES) {
      if (!have.has(t)) continue;
      db.prepare(`
        UPDATE ${t} SET user_id = COALESCE(
          (SELECT o.owner_user_id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = ${t}.workspace_id),
          ?
        ) WHERE user_id = ?
      `).run(actingAdminId, targetId);
    }
    for (const t of REASSIGN_WORKSPACE_ONLY_TABLES) {
      if (!have.has(t)) continue;
      db.prepare(`
        UPDATE ${t} SET user_id = COALESCE(
          (SELECT o.owner_user_id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = ${t}.workspace_id),
          ?
        ) WHERE user_id = ? AND workspace_id IS NOT NULL
      `).run(actingAdminId, targetId);
    }

    // 2b') Integrations that act AS the person (#520-#523). These stop working without them, so they
    //      are not reassigned to the org owner the way 2b's resources are: their Canva connections are
    //      deleted (revoked at Canva after COMMIT) and so are their design links and import jobs - the
    //      library items stay, they just stop refreshing from a Canva account that no longer exists.
    //      Their SharePoint folder syncs follow the SET NULL rule for a nullable creator (2a) and are
    //      paused, since a sync ingests as its creator and refuses an owner without an account; the
    //      folder and the content it brought in stay for an admin to resume under someone or remove.
    //      Their REST-hook subscriptions - made from a session, or with any of their API tokens
    //      (which this delete cascades) - are deleted so nothing keeps posting to their receivers.
    if (have.has('canva_connections')) db.prepare('DELETE FROM canva_connections WHERE user_id = ?').run(targetId);
    if (have.has('canva_links')) db.prepare('DELETE FROM canva_links WHERE user_id = ?').run(targetId);
    if (have.has('canva_jobs')) db.prepare('DELETE FROM canva_jobs WHERE user_id = ?').run(targetId);
    if (have.has('cloud_folders')) {
      db.prepare(`UPDATE cloud_folders SET user_id = NULL, enabled = 0, last_status = 'error',
          last_error = 'Paused: the person who set up this folder no longer has an account.',
          updated_at = strftime('%s','now') WHERE user_id = ?`).run(targetId);
    }
    if (have.has('automation_subscriptions')) {
      const tokenSql = have.has('api_tokens') ? ' OR token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)' : '';
      const subIds = db.prepare(`SELECT id FROM automation_subscriptions WHERE user_id = ?${tokenSql}`)
        .all(...(tokenSql ? [targetId, targetId] : [targetId])).map(r => r.id);
      dropSubscriptions(db, subIds, 'the subscriber was deleted', have);
    }

    // 2c) Legacy teams + NOT NULL invite rows the user owns / sent.
    if (have.has('teams')) db.prepare('DELETE FROM teams WHERE owner_id = ?').run(targetId); // cascades team_members/invites
    if (have.has('team_invites')) db.prepare('DELETE FROM team_invites WHERE invited_by = ?').run(targetId);
    if (have.has('workspace_invites')) db.prepare('DELETE FROM workspace_invites WHERE invited_by = ?').run(targetId);

    // 3) Finally the user. Their own memberships (organization_members,
    //    workspace_members, team_members) CASCADE on this delete - and so does any
    //    workspace-LESS legacy folder of theirs (shared folders were reassigned in 2b).
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  });

  run();
  afterCommit(side, revokeCanva);
  return removeDeletedFiles(gone, unlink);
}

module.exports = {
  deleteUserCascade, OrgHasOtherMembersError, listOwnedOrgsWithSharing,
  deleteWorkspaceCascade, deleteOrgCascade,
  releaseWorkspaceMember, dropTokenSubscriptions,
};
