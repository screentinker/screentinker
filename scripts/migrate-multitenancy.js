#!/usr/bin/env node
// Phase 1 multitenancy migration runner.
//
// Adds: organizations, organization_members, workspaces, workspace_members,
//       workspace_invites tables.
// Adds: workspace_id columns to every resource table; organization_id,
//       acting_user_id, was_acting_as to activity_log; reseller billing
//       metadata columns to workspaces (added at table create time).
// Backfills: one organization per existing user, one default workspace per
//            org (or one workspace per existing team), all resource rows
//            get the user's default workspace_id, activity_log gets both
//            workspace_id and organization_id. Roles migrate: superadmin
//            -> platform_admin, legacy 'admin' -> 'user'.
// Idempotent: tracked by schema_migrations row 'phase5_multitenancy_backfill'.
//             Re-running is a no-op.
//
// Two invocation modes:
//   1. CLI:        node scripts/migrate-multitenancy.js [--dry-run]
//   2. In-process: require('./scripts/migrate-multitenancy').runMigration({ db })
//
// In-process mode is used by server/db/database.js on startup so self-hosters
// who pull latest and restart don't have to remember to run the script
// manually.

'use strict';

const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..', 'server');
// Resolve modules relative to server/ where the deps live, not relative to
// this script's dir. Works both for CLI invocation and when require'd from
// database.js - Node resolves modules relative to the required file's own
// __dirname, not the caller's.
const resolveFromServer = (name) => require.resolve(name, { paths: [SERVER_DIR] });
// Whichever driver the server itself would use — this runs on FIRST BOOT, including on a
// player where better-sqlite3 is absent, and a miss here is a half-migrated database.
const { Database } = require(path.join(SERVER_DIR, 'db', 'sqlite-driver.js'));
const { v4: uuidv4 } = require(resolveFromServer('uuid'));
const config = require(path.join(SERVER_DIR, 'config'));

const MIGRATION_ID = 'phase5_multitenancy_backfill';

function alreadyApplied(db) {
  try {
    return !!db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
  } catch { return false; }
}

function runMigration({ db: existingDb = null, dryRun = false, logger = console } = {}) {
  const db = existingDb || (() => {
    const d = new Database(config.dbPath);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    return d;
  })();
  const ownDb = !existingDb;

  try {
    if (alreadyApplied(db)) {
      logger.log('[migrate] already applied - nothing to do');
      return { skipped: true };
    }

    logger.log(`[migrate] mode=${dryRun ? 'DRY RUN' : 'COMMIT'}`);
    logger.log(`[migrate] db=${config.dbPath}`);

    // 1. New tables (idempotent).
    db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id                      TEXT PRIMARY KEY,
        name                    TEXT NOT NULL,
        slug                    TEXT UNIQUE,
        owner_user_id           TEXT NOT NULL REFERENCES users(id),
        plan_id                 TEXT DEFAULT 'free' REFERENCES plans(id),
        stripe_customer_id      TEXT,
        stripe_subscription_id  TEXT,
        subscription_status     TEXT DEFAULT 'active',
        subscription_ends       INTEGER,
        grace_period_ends       INTEGER,
        locked_at               INTEGER,
        -- The rest of the billing state (server/lib/org-billing.js): a true copy of the owner's
        -- while the person pays, the source of truth once the organization does. Declared here so
        -- a fresh install has them from the start; an older table gains them at boot.
        trial_started           INTEGER,
        trial_plan              TEXT,
        trial_expired_at        INTEGER,
        trial_ending_email_sent_at        INTEGER,
        trial_expired_email_sent_at       INTEGER,
        renewal_at              INTEGER,
        past_due_since          INTEGER,
        payment_failed_email_sent_at      INTEGER,
        subscription_lapsed_email_sent_at INTEGER,
        plan_comped             INTEGER NOT NULL DEFAULT 0,
        billing_follows_org     TEXT,
        default_brand_name      TEXT,
        default_logo_url        TEXT,
        default_primary_color   TEXT,
        widget_sandbox_isolation_disabled INTEGER NOT NULL DEFAULT 0,
        created_at              INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at              INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS organization_members (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role            TEXT NOT NULL DEFAULT 'org_admin',
        invited_by      TEXT REFERENCES users(id),
        joined_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(organization_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id                    TEXT PRIMARY KEY,
        organization_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name                  TEXT NOT NULL,
        slug                  TEXT,
        created_by            TEXT REFERENCES users(id),
        billing_type          TEXT DEFAULT 'client_billable',
        billing_notes         TEXT,
        billing_contact_email TEXT,
        billing_contract_ref  TEXT,
        created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(organization_id, slug)
      );

      CREATE TABLE IF NOT EXISTS workspace_members (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role            TEXT NOT NULL DEFAULT 'workspace_viewer',
        invited_by      TEXT REFERENCES users(id),
        joined_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(workspace_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_invites (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email           TEXT NOT NULL,
        role            TEXT NOT NULL DEFAULT 'workspace_viewer',
        invited_by      TEXT NOT NULL REFERENCES users(id),
        expires_at      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `);

    // 2. Additive columns (idempotent: ignore 'duplicate column' errors).
    const alters = [
      'ALTER TABLE devices         ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE content         ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE playlists       ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE layouts         ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE widgets         ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE schedules       ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE video_walls     ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE device_groups   ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE white_labels    ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE kiosk_pages     ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE alert_configs   ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE activity_log    ADD COLUMN workspace_id    TEXT REFERENCES workspaces(id)',
      'ALTER TABLE activity_log    ADD COLUMN organization_id TEXT REFERENCES organizations(id)',
      'ALTER TABLE activity_log    ADD COLUMN acting_user_id  TEXT REFERENCES users(id)',
      'ALTER TABLE activity_log    ADD COLUMN was_acting_as   INTEGER DEFAULT 0',
    ];
    for (const sql of alters) {
      try { db.exec(sql); } catch (e) { /* column exists */ }
    }

    // 3. Indexes.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_devices_workspace        ON devices(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_content_workspace        ON content(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_playlists_workspace      ON playlists(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_video_walls_workspace    ON video_walls(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspaces_organization  ON workspaces(organization_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_user   ON workspace_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id);
    `);

    // 4. Backfill (single transaction).
    const users       = db.prepare('SELECT * FROM users').all();
    const teams       = db.prepare('SELECT * FROM teams').all();
    const teamMembers = db.prepare('SELECT * FROM team_members').all();

    const userDefaultWs = new Map();   // user_id -> workspace_id
    const userToOrg     = new Map();   // user_id -> organization_id

    const RESOURCE_TABLES_WITH_TEAM_ID  = ['devices', 'content', 'layouts', 'widgets', 'video_walls'];
    const RESOURCE_TABLES_NO_TEAM_ID    = ['playlists', 'schedules', 'device_groups', 'white_labels', 'kiosk_pages', 'alert_configs'];

    function table_has_col(t, c) {
      return db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
    }

    const stats = { orgs: 0, workspaces: 0, org_members: 0, ws_members: 0, role_changes: { sa: 0, adm: 0 }, backfill: {} };

    const backfill = db.transaction(() => {
      for (const u of users) {
        const orgId = uuidv4();
        const orgName = (u.name && u.name.trim()) ? `${u.name}'s organization` : `${u.email}'s organization`;
        db.prepare(`INSERT INTO organizations (
          id, name, owner_user_id, plan_id,
          stripe_customer_id, stripe_subscription_id,
          subscription_status, subscription_ends
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          orgId, orgName, u.id, u.plan_id || 'free',
          u.stripe_customer_id || null, u.stripe_subscription_id || null,
          u.subscription_status || 'active', u.subscription_ends || null
        );
        stats.orgs++;
        db.prepare(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`).run(orgId, u.id);
        stats.org_members++;
        userToOrg.set(u.id, orgId);

        const ownedTeams = teams.filter(t => t.owner_id === u.id);
        let defaultWsId;
        if (ownedTeams.length === 0) {
          defaultWsId = uuidv4();
          db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Default', ?)`).run(defaultWsId, orgId, u.id);
          stats.workspaces++;
          db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`).run(defaultWsId, u.id);
          stats.ws_members++;
        } else {
          // Re-use each team's id as the workspace id so existing FKs and bookmarks survive.
          for (const t of ownedTeams) {
            db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, ?, ?)`).run(t.id, orgId, t.name, t.owner_id);
            stats.workspaces++;
            const tms = teamMembers.filter(m => m.team_id === t.id);
            let ownerSeen = false;
            for (const m of tms) {
              if (m.user_id === t.owner_id) ownerSeen = true;
              const wsRole =
                m.role === 'owner'  ? 'workspace_admin' :
                m.role === 'editor' ? 'workspace_editor' :
                                      'workspace_viewer';
              db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)`)
                .run(t.id, m.user_id, wsRole, m.invited_by || null, m.joined_at || Math.floor(Date.now() / 1000));
              stats.ws_members++;
            }
            if (!ownerSeen) {
              db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`).run(t.id, t.owner_id);
              stats.ws_members++;
            }
          }
          defaultWsId = ownedTeams
            .slice()
            .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))[0].id;
        }
        userDefaultWs.set(u.id, defaultWsId);
      }

      for (const t of RESOURCE_TABLES_WITH_TEAM_ID) {
        if (!table_has_col(t, 'workspace_id')) { stats.backfill[t] = 'skipped (no workspace_id col)'; continue; }
        const rows = db.prepare(`SELECT id, user_id, team_id FROM ${t} WHERE workspace_id IS NULL`).all();
        const upd = db.prepare(`UPDATE ${t} SET workspace_id = ? WHERE id = ?`);
        let filled = 0;
        for (const r of rows) {
          const wsId = r.team_id || userDefaultWs.get(r.user_id);
          if (wsId) { upd.run(wsId, r.id); filled++; }
        }
        stats.backfill[t] = `${filled}/${rows.length}`;
      }
      for (const t of RESOURCE_TABLES_NO_TEAM_ID) {
        if (!table_has_col(t, 'workspace_id')) { stats.backfill[t] = 'skipped (no workspace_id col)'; continue; }
        const rows = db.prepare(`SELECT id, user_id FROM ${t} WHERE workspace_id IS NULL`).all();
        const upd = db.prepare(`UPDATE ${t} SET workspace_id = ? WHERE id = ?`);
        let filled = 0;
        for (const r of rows) {
          const wsId = userDefaultWs.get(r.user_id);
          if (wsId) { upd.run(wsId, r.id); filled++; }
        }
        stats.backfill[t] = `${filled}/${rows.length}`;
      }

      const aRows = db.prepare(`SELECT id, user_id FROM activity_log WHERE workspace_id IS NULL OR organization_id IS NULL`).all();
      const aUpd  = db.prepare(`UPDATE activity_log SET workspace_id = ?, organization_id = ? WHERE id = ?`);
      let aFilled = 0;
      for (const r of aRows) {
        const wsId  = r.user_id ? (userDefaultWs.get(r.user_id) || null) : null;
        const orgId = r.user_id ? (userToOrg.get(r.user_id)     || null) : null;
        aUpd.run(wsId, orgId, r.id);
        if (wsId || orgId) aFilled++;
      }
      stats.backfill.activity_log = `${aFilled}/${aRows.length} (NULLs are anonymous platform events)`;

      // Role migration.
      stats.role_changes.sa  = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'`).get().n;
      stats.role_changes.adm = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
      db.prepare(`UPDATE users SET role = 'platform_admin' WHERE role = 'superadmin'`).run();
      db.prepare(`UPDATE users SET role = 'user'           WHERE role = 'admin'`).run();

      db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);

      if (dryRun) {
        // Force rollback by throwing - better-sqlite3 db.transaction() reverts everything.
        throw new Error('__DRY_RUN_ROLLBACK__');
      }
    });

    try {
      backfill();
      logger.log('[migrate] committed');
      return { ok: true, stats };
    } catch (e) {
      if (e.message === '__DRY_RUN_ROLLBACK__') {
        logger.log('[migrate] rolled back (dry run)');
        return { ok: true, dryRun: true, stats };
      }
      throw e;
    }
  } finally {
    if (ownDb) db.close();
  }
}

// CLI wrapper - only fires when invoked as 'node scripts/migrate-multitenancy.js'.
// When required from server/db/database.js the CLI block is skipped.
if (require.main === module) {
  process.chdir(SERVER_DIR);
  const dryRun = process.argv.includes('--dry-run');
  try {
    const result = runMigration({ dryRun });
    if (result.stats) {
      console.log('---summary---');
      console.log(JSON.stringify(result.stats, null, 2));
    }
    process.exit(0);
  } catch (e) {
    console.error('[migrate] FAILED:', e.message);
    process.exit(1);
  }
}

module.exports = { runMigration };
