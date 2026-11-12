'use strict';

/*
 * A small database full of the awkward billing cases, shared by the tests that compare today's
 * per-person limits with per-organization ones (org-billing-report, limits-scope).
 * build(db) fills it and returns the ids, as S.
 */

const crypto = require('node:crypto');

function build(db) {
const now = () => Math.floor(Date.now() / 1000);
const rid = () => crypto.randomUUID();
let clock = 1000;

function person(name, fields = {}) {
  const id = rid();
  db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id) VALUES (?, ?, ?, 'x', 'local', 'user', 'free')`).run(id, name + '@example.com', name);
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  return id;
}
function orgWithWorkspace(owner, name) {
  const o = rid(), w = rid();
  db.prepare('INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)').run(o, name, owner, clock++);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(w, o, name + ' ws');
  return { o, w };
}
function screens(n, pairedBy, ws, label) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = rid();
    db.prepare(`INSERT INTO devices (id, name, status, user_id, workspace_id, device_token, client_type, created_at) VALUES (?, ?, 'online', ?, ?, ?, 'apk', ?)`)
      .run(id, `${label} ${i + 1}`, pairedBy, ws, crypto.randomBytes(16).toString('hex'), clock++);
    ids.push(id);
  }
  return ids;
}
const S = {};

{
  for (const [id, max] of [['free', 2], ['starter', 3], ['pro', 5], ['enterprise', -1]]) {
    db.prepare(`INSERT OR REPLACE INTO plans (id, name, display_name, max_devices, max_storage_mb) VALUES (?, ?, ?, ?, 100)`).run(id, id, id, max);
  }

  // 1. A paying owner alone, inside the limit: nothing changes.
  S.solo = person('solo', { plan_id: 'starter', stripe_subscription_id: 'sub_solo' });
  S.soloOrg = orgWithWorkspace(S.solo, 'Solo');
  S.soloScreens = screens(3, S.solo, S.soloOrg.w, 'solo');

  // 2. The stacking case: owner full on Starter (3), an invited member on a running trial adds 2 more.
  S.boss = person('boss', { plan_id: 'starter', stripe_subscription_id: 'sub_boss' });
  S.bossOrg = orgWithWorkspace(S.boss, 'Stacked');
  S.bossScreens = screens(3, S.boss, S.bossOrg.w, 'boss');
  S.guest = person('guest', { plan_id: 'pro', trial_started: now() - 86400, trial_plan: 'pro' });
  S.guestScreens = screens(2, S.guest, S.bossOrg.w, 'guest');

  // 3. The opposite: a Free member inside an unlimited organization is held to 2 today.
  S.ent = person('ent', { plan_id: 'enterprise', plan_comped: 1 });
  S.entOrg = orgWithWorkspace(S.ent, 'Unlimited');
  S.helper = person('helper');
  S.helperScreens = screens(4, S.helper, S.entOrg.w, 'helper');

  // 4. A lapsed trial nobody has read yet (the downgrade is still pending), 4 screens.
  S.lapsed = person('lapsed', { plan_id: 'pro', trial_started: now() - 30 * 86400, trial_plan: 'pro' });
  S.lapsedOrg = orgWithWorkspace(S.lapsed, 'Lapsed');
  S.lapsedScreens = screens(4, S.lapsed, S.lapsedOrg.w, 'lapsed');

  // 5. One person, two organizations, Pro (5): 3 screens in each.
  S.twin = person('twin', { plan_id: 'pro', stripe_subscription_id: 'sub_twin' });
  S.twinA = orgWithWorkspace(S.twin, 'Twin A');
  S.twinB = orgWithWorkspace(S.twin, 'Twin B');
  S.twinScreens = [...screens(3, S.twin, S.twinA.w, 'twinA'), ...screens(3, S.twin, S.twinB.w, 'twinB')];

  // 6. A screen with no workspace, and one nobody paired.
  S.loose = screens(1, S.solo, null, 'loose')[0];
  S.unclaimed = screens(1, null, null, 'unclaimed')[0];

  // 7. Storage: the owner uses 40 MB, a member 70 MB, limit 100.
  const put = (uid, ws, mb) => db.prepare(`INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, ?, ?, 'f', 'f', 'image/png', ?)`).run(rid(), uid, ws, mb * 1024 * 1024);
  put(S.boss, S.bossOrg.w, 40); put(S.guest, S.bossOrg.w, 70);
}
  return S;
}

module.exports = { build };
