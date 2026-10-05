'use strict';

/*
 * THE BACKSTOP — per-connection SQLite TEMP triggers that make a forgotten writer fail CLOSED.
 *
 * About 35 places write playlist_items (docs: code map §7). The JS guard (lib/corporate/guard.js)
 * sits at the chokepoints and gives the good 403 messages; this exists for the writer nobody
 * remembered — a new route next year, a lib helper reached by a path nobody traced. Inside a
 * request whose actor cannot author corporate content, any INSERT/UPDATE/DELETE of a governed
 * playlist's items, item schedules, or the playlist row itself aborts with the code as its message
 * (RAISE(ABORT, 'CORPORATE_LOCKED')), which server.js's error handler maps to a 403.
 *
 * ⚠️ FAIL-OPEN FOR ACTORLESS CODE, BY DESIGN. No AsyncLocalStorage store = system (migrations,
 * the scheduler, content expiry, mesh apply, runAsSystem). That means a write path that LOST its
 * async context (a callback-style library, a socket handler) is treated as system too. The
 * tripwire in actor.js logs that case when it happens inside an HTTP request, and the corporate
 * route tests assert the counter stays at zero.
 *
 * ⚠️ THE UDFs NEVER QUERY THE DATABASE. better-sqlite3 refuses any statement on a connection that is
 * busy executing one, and these run inside the triggering INSERT. They read only the actor's
 * precomputed sets. They are registered NON-deterministic (the default): marking them
 * deterministic would let SQLite reuse one actor's answer for another statement.
 *
 * TEMP triggers live only on this process's connection: the sqlite3 CLI, backup scripts and the
 * offline analysis rig are unaffected, nothing is replicated or exported, and they cannot collide
 * with the mesh's `mesh_cl_*` change-capture triggers (different schema, different names).
 * FK cascade deletes fire them too, so a content delete that would take a row out of a corporate
 * playlist fails closed.
 */

const actor = require('./actor');

function stSystem() {
  const a = actor.current();
  if (!a) { actor.noteActorlessWrite(); return 1; }
  return 0;
}

function stCanAuthor(orgId) {
  const a = actor.current();
  if (!a) return 1;
  return actor.canAuthorOrg(a, orgId) ? 1 : 0;
}

// "Is playlist X governed?" — corporate itself, or a child of a corporate playlist.
const governed = (pidExpr) => `EXISTS (SELECT 1 FROM main.playlists gp WHERE gp.id = ${pidExpr} AND (gp.corporate = 1 OR EXISTS (
       SELECT 1 FROM main.playlist_items gx JOIN main.playlists gc ON gc.id = gx.playlist_id
        WHERE gx.child_playlist_id = gp.id AND gc.corporate = 1)))`;
const orgOf = (pidExpr) => `(SELECT gw.organization_id FROM main.playlists gp JOIN main.workspaces gw ON gw.id = gp.workspace_id WHERE gp.id = ${pidExpr})`;
// Cheapest test first: one partial-index probe, so an install without corporate playlists pays nothing.
const ANY_CORPORATE = 'EXISTS (SELECT 1 FROM main.playlists WHERE corporate = 1)';
const lockedFor = (pidExpr) => `(${governed(pidExpr)} AND st_corp_can_author(${orgOf(pidExpr)}) = 0)`;

const TRIGGERS = {
  corp_guard_pi_ins: `CREATE TEMP TRIGGER corp_guard_pi_ins BEFORE INSERT ON main.playlist_items
    WHEN st_corp_system() = 0 AND ${ANY_CORPORATE} AND ${lockedFor('NEW.playlist_id')}
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,
  corp_guard_pi_upd: `CREATE TEMP TRIGGER corp_guard_pi_upd BEFORE UPDATE ON main.playlist_items
    WHEN st_corp_system() = 0 AND ${ANY_CORPORATE} AND (${lockedFor('OLD.playlist_id')} OR ${lockedFor('NEW.playlist_id')})
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,
  corp_guard_pi_del: `CREATE TEMP TRIGGER corp_guard_pi_del BEFORE DELETE ON main.playlist_items
    WHEN st_corp_system() = 0 AND ${ANY_CORPORATE} AND ${lockedFor('OLD.playlist_id')}
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,

  // Per-item schedule blocks (dayparts) belong to the item's playlist.
  corp_guard_pis_ins: `CREATE TEMP TRIGGER corp_guard_pis_ins BEFORE INSERT ON main.playlist_item_schedules
    WHEN st_corp_system() = 0 AND ${ANY_CORPORATE}
     AND ${lockedFor('(SELECT si.playlist_id FROM main.playlist_items si WHERE si.id = NEW.playlist_item_id)')}
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,
  corp_guard_pis_upd: `CREATE TEMP TRIGGER corp_guard_pis_upd BEFORE UPDATE ON main.playlist_item_schedules
    WHEN st_corp_system() = 0 AND ${ANY_CORPORATE}
     AND (${lockedFor('(SELECT si.playlist_id FROM main.playlist_items si WHERE si.id = OLD.playlist_item_id)')}
       OR ${lockedFor('(SELECT si.playlist_id FROM main.playlist_items si WHERE si.id = NEW.playlist_item_id)')})
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,
  corp_guard_pis_del: `CREATE TEMP TRIGGER corp_guard_pis_del BEFORE DELETE ON main.playlist_item_schedules
    WHEN st_corp_system() = 0 AND ${ANY_CORPORATE}
     AND ${lockedFor('(SELECT si.playlist_id FROM main.playlist_items si WHERE si.id = OLD.playlist_item_id)')}
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,

  /* The playlist row: metadata, the corporate flag itself, a workspace move, and the PUBLISH
   * columns. A non-author publishing a governed playlist through a route that skipped the JS check
   * (approvals publish, agency auto-publish, a future one) fails here. System republishes — ancestor
   * republish, smart refresh, content expiry, the mute-sync patch — run as system and pass. */
  corp_guard_pl_upd: `CREATE TEMP TRIGGER corp_guard_pl_upd
    BEFORE UPDATE OF name, description, playback_order, smart_rules, corporate, workspace_id,
                     published_snapshot, published_composable, published_structure, status ON main.playlists
    WHEN st_corp_system() = 0 AND (OLD.corporate = 1 OR NEW.corporate = 1 OR ${governed('OLD.id')})
     AND (st_corp_can_author((SELECT w.organization_id FROM main.workspaces w WHERE w.id = OLD.workspace_id)) = 0
       OR st_corp_can_author((SELECT w.organization_id FROM main.workspaces w WHERE w.id = NEW.workspace_id)) = 0)
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,
  corp_guard_pl_del: `CREATE TEMP TRIGGER corp_guard_pl_del BEFORE DELETE ON main.playlists
    WHEN st_corp_system() = 0 AND OLD.corporate = 1
     AND st_corp_can_author((SELECT w.organization_id FROM main.workspaces w WHERE w.id = OLD.workspace_id)) = 0
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,
  corp_guard_pl_ins: `CREATE TEMP TRIGGER corp_guard_pl_ins BEFORE INSERT ON main.playlists
    WHEN NEW.corporate = 1 AND st_corp_system() = 0
     AND st_corp_can_author((SELECT w.organization_id FROM main.workspaces w WHERE w.id = NEW.workspace_id)) = 0
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_LOCKED'); END`,

  /* Always-on STRUCTURAL checks — no actor involved, they hold for system writers too.
   *   a slot placement outside a corporate playlist is a ghost item on every player;
   *   a nested playlist inside a slot fill breaks the depth-1 nesting cap through the back door. */
  corp_guard_pi_slot_ins: `CREATE TEMP TRIGGER corp_guard_pi_slot_ins BEFORE INSERT ON main.playlist_items
    WHEN NEW.slot_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM main.playlists p WHERE p.id = NEW.playlist_id AND p.corporate = 1)
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_SLOT_OUTSIDE'); END`,
  corp_guard_pi_slot_upd: `CREATE TEMP TRIGGER corp_guard_pi_slot_upd BEFORE UPDATE OF slot_id, playlist_id ON main.playlist_items
    WHEN NEW.slot_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM main.playlists p WHERE p.id = NEW.playlist_id AND p.corporate = 1)
    BEGIN SELECT RAISE(ABORT, 'CORPORATE_SLOT_OUTSIDE'); END`,
  corp_guard_pi_fillflat_ins: `CREATE TEMP TRIGGER corp_guard_pi_fillflat_ins BEFORE INSERT ON main.playlist_items
    WHEN NEW.child_playlist_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM main.corporate_slot_fills f WHERE f.fill_playlist_id = NEW.playlist_id)
    BEGIN SELECT RAISE(ABORT, 'FILL_FLAT'); END`,
  corp_guard_pi_fillflat_upd: `CREATE TEMP TRIGGER corp_guard_pi_fillflat_upd BEFORE UPDATE OF child_playlist_id, playlist_id ON main.playlist_items
    WHEN NEW.child_playlist_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM main.corporate_slot_fills f WHERE f.fill_playlist_id = NEW.playlist_id)
    BEGIN SELECT RAISE(ABORT, 'FILL_FLAT'); END`,
};

/**
 * Register the UDFs and (re)create every TEMP trigger on this connection. Idempotent. Call AFTER
 * the corporate schema and the resolver views exist (db/database.js, and fixtures that want it).
 */
function applyCorporateGuards(db) {
  db.function('st_corp_system', { deterministic: false }, stSystem);
  db.function('st_corp_can_author', { deterministic: false }, stCanAuthor);
  for (const name of Object.keys(TRIGGERS)) db.exec(`DROP TRIGGER IF EXISTS temp.${name}`);
  for (const sql of Object.values(TRIGGERS)) db.exec(sql);
}

const LOCK_RE = /^(CORPORATE_[A-Z_]+|FILL_[A-Z_]+)$/;

/** Is this error a backstop RAISE (or a CorporateError)? Routes that catch their own errors rethrow these. */
function isCorporateLockError(e) {
  if (!e) return false;
  if (e.name === 'CorporateError') return true;
  return typeof e.message === 'string' && LOCK_RE.test(e.message.trim());
}

module.exports = { applyCorporateGuards, isCorporateLockError, TRIGGER_NAMES: Object.keys(TRIGGERS) };
