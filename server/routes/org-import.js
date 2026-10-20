'use strict';

/*
 * Move an organization to another server (lib/trust/import.js, docs/move-server.md).
 *
 * Mounted at /api/org-import, JWT only, resolveTenancy (config/api-surface.js): an import writes a
 * whole organization, and a handover moves every screen, so no API token reaches any of it.
 *
 *   who                          what
 *   org owner / org admin        import into a NEW organization (they own it) or an EMPTY one they
 *                                own or administer — by pull or browser upload; see their own
 *                                organization's import jobs; hand their screens to a new server
 *   platform admin               all of that for any organization, plus an archive already on this
 *                                server's disk (DATA_DIR/imports), and the whole-server export and
 *                                restore
 *   anyone else                  nothing (403)
 *
 * A job is visible to the person who started it, to the owners and admins of the organization it
 * restored into, and to platform administrators — never by guessing an id (404).
 */

const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const { isOrgAdmin } = require('../lib/permissions');
const { denyReadOnly } = require('../lib/tenancy');
const { auditFromReq } = require('../lib/audit');
const imp = require('../lib/trust/import');
const screens = require('../lib/trust/import-screens');
const instanceExport = require('../lib/trust/instance-export');
const exporter = require('../lib/trust/export');

const origin = (req) => require('../lib/public-origin').publicOrigin(req);
const who = (req) => ({ userId: req.user.id, orgId: req.organizationId || null, platformAdmin: !!req.isPlatformAdmin });

function realPerson(req, res) {
  // A break-glass or support session is a synthetic identity: it may look, it may not move an
  // organization (the same rule as the complete export).
  if (['recovery', 'support'].includes(req.user.auth_provider) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.user.id)) {
    res.status(403).json({ error: 'Not available to this session' });
    return false;
  }
  return true;
}
function denyNotAdmin(req, res) {
  if (req.isPlatformAdmin) return false;
  if (!req.organizationId || !isOrgAdmin(req)) { res.status(403).json({ error: 'Organization owners and admins only' }); return true; }
  return false;
}
function denyNotPlatform(req, res) {
  if (!req.isPlatformAdmin) { res.status(403).json({ error: 'Platform admin only' }); return true; }
  return false;
}
function fail(res, e) {
  if (e instanceof imp.ImportError || (e && e.status && e.code)) return res.status(e.status || 400).json({ error: e.message, code: e.code });
  if (e instanceof exporter.ExportError) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

/** The job, if this request may see it; otherwise a 404 has been sent. */
function loadJob(req, res) {
  const job = imp.getJob(db, req.params.id);
  const ok = job && (req.isPlatformAdmin || (!job.parent_id && job.kind === 'org' && (
    job.requested_by === req.user.id
    || (job.organization_id && imp.canTarget(db, { userId: req.user.id }, job.organization_id)))));
  if (!ok) { res.status(404).json({ error: 'Import not found' }); return null; }
  return job;
}

/* ───────────── what this person can do here ───────────── */

router.get('/context', (req, res) => {
  const canOrg = !!(req.isPlatformAdmin || (req.organizationId && isOrgAdmin(req)));
  const targets = !canOrg ? [] : (req.isPlatformAdmin
    ? db.prepare('SELECT id, name FROM organizations ORDER BY name LIMIT 500').all()
    : db.prepare("SELECT o.id, o.name FROM organizations o JOIN organization_members m ON m.organization_id = o.id WHERE m.user_id = ? AND m.role IN ('org_owner','org_admin') ORDER BY o.name").all(req.user.id))
    .map((o) => ({ ...o, empty: imp.isEmptyOrg(db, o.id) }));
  let emailConfigured = false;
  try { emailConfigured = require('../services/email').isConfigured(); } catch (_) { emailConfigured = false; }
  res.json({
    can_import: canOrg,
    platform_admin: !!req.isPlatformAdmin,
    organization_id: req.organizationId || null,
    email_configured: emailConfigured,
    self_hosted: !!require('../config').selfHosted,
    chunk_bytes: 8 * 1024 * 1024,
    imports_folder: req.isPlatformAdmin ? imp.importsDir() : null,
    targets,
    limits: { per_day: imp.MAX_PER_DAY },
  });
});

router.get('/disk', (req, res) => {
  if (denyNotPlatform(req, res)) return;
  res.json({ folder: imp.importsDir(), files: imp.listDisk() });
});

/* ───────────── jobs ───────────── */

router.get('/jobs', (req, res) => {
  let rows;
  if (req.isPlatformAdmin && req.query.scope === 'instance') {
    rows = db.prepare("SELECT * FROM org_imports WHERE kind = 'instance' ORDER BY created_at DESC LIMIT 20").all();
  } else {
    if (denyNotAdmin(req, res)) return;
    rows = db.prepare(`SELECT * FROM org_imports WHERE kind = 'org' AND parent_id IS NULL AND (requester_org_id = ? OR organization_id = ? OR requested_by = ?)
                        ORDER BY created_at DESC LIMIT 20`).all(req.organizationId || '', req.organizationId || '', req.user.id)
      .filter((j) => j.requested_by === req.user.id || req.isPlatformAdmin || (j.organization_id && imp.canTarget(db, who(req), j.organization_id)) || j.requester_org_id === req.organizationId);
  }
  res.json({ jobs: rows.map(imp.publicJob) });
});

router.post('/jobs', async (req, res) => {
  if (!realPerson(req, res)) return;
  const b = req.body || {};
  const kind = b.kind === 'instance' ? 'instance' : 'org';
  if (kind === 'instance' ? denyNotPlatform(req, res) : denyNotAdmin(req, res)) return;
  if (!req.isPlatformAdmin && denyReadOnly(req, res)) return;
  try {
    const job = await imp.create(db, who(req), { source: b.source, kind, url: b.url, file_name: b.file_name, bytes: b.bytes, disk_name: b.disk_name });
    auditFromReq(req, 'trust.import_started', { import_id: job.id, kind, source: job.source, from: job.source_url ? new URL(job.source_url).host : undefined });
    res.status(201).json(imp.publicJob(job));
  } catch (e) { fail(res, e); }
});

router.get('/jobs/:id', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const out = imp.publicJob(job);
  if (job.source === 'upload' && job.status === 'receiving') {
    let offset = 0;
    try { offset = require('fs').statSync(imp.archivePath(job)).size; } catch (_) { offset = 0; }
    out.offset = offset;
  }
  if (job.kind === 'instance') out.children = db.prepare('SELECT * FROM org_imports WHERE parent_id = ? ORDER BY created_at, rowid').all(job.id).map(imp.publicJob);
  res.json(out);
});

/* Append a chunk of an uploaded archive. Raw bytes; Upload-Offset says where the client believes it is. */
router.patch('/jobs/:id/upload', express.raw({ type: () => true, limit: imp.CHUNK_MAX }), (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  if (job.requested_by !== req.user.id) return res.status(403).json({ error: 'Only the person who started this import can upload to it' });
  const offset = Number(req.get('Upload-Offset'));
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: 'Upload-Offset header is required' });
  try {
    const r = imp.appendChunk(db, job, offset, Buffer.isBuffer(req.body) ? req.body : null);
    if (!r.ok) return res.status(409).json({ error: `offset mismatch: this upload is at ${r.offset}`, offset: r.offset });
    res.set('Upload-Offset', String(r.offset));
    res.json({ offset: r.offset, complete: !!r.complete });
  } catch (e) { fail(res, e); }
});

router.post('/jobs/:id/link', async (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  try { res.json(imp.publicJob(await imp.relink(db, job, (req.body || {}).url))); } catch (e) { fail(res, e); }
});

router.post('/jobs/:id/restore', (req, res) => {
  if (!realPerson(req, res)) return;
  const job = loadJob(req, res);
  if (!job) return;
  if (job.kind === 'instance' && denyNotPlatform(req, res)) return;
  if (!req.isPlatformAdmin && job.requested_by !== req.user.id) return res.status(403).json({ error: 'Only the person who started this import can restore it' });
  const b = req.body || {};
  const target = b.target && b.target.mode === 'existing' ? { mode: 'existing', organization_id: b.target.organization_id } : { mode: 'new', name: b.target && b.target.name };
  try {
    const out = imp.startRestore(db, job, who(req), { target, options: b.options || {} });
    auditFromReq(req, 'trust.import_restore_started', { import_id: job.id, target: target.mode, organization_id: out.organization_id || undefined });
    res.status(202).json(imp.publicJob(out));
  } catch (e) { fail(res, e); }
});

router.post('/jobs/:id/cancel', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  try { imp.cancel(db, job); auditFromReq(req, 'trust.import_cancelled', { import_id: job.id }); res.json(imp.publicJob(imp.getJob(db, job.id))); } catch (e) { fail(res, e); }
});

router.post('/jobs/:id/discard-partial', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  try { imp.discardPartial(db, job); auditFromReq(req, 'trust.import_partial_deleted', { import_id: job.id }); res.json(imp.publicJob(imp.getJob(db, job.id))); } catch (e) { fail(res, e); }
});

/* ───────────── people ───────────── */

function inviteRows(req, job) {
  return db.prepare(`SELECT i.id, i.email, i.role, i.org_role, i.org_only, i.expires_at, w.name AS workspace_name
                       FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
                      WHERE i.import_job_id = ? AND w.organization_id = ? ORDER BY i.email, w.name`).all(job.id, job.organization_id || '')
    .map((i) => ({ ...i, org_only: !!i.org_only, accept_url: `${origin(req)}/app#/accept-invite/${i.id}` }));
}

router.get('/jobs/:id/invites', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  res.json({ invites: inviteRows(req, job) });
});

/*
 * Email the invites — only when this server can send mail and the administrator chose to. Without
 * mail the page shows each link to copy instead; nothing is sent behind anyone's back.
 */
router.post('/jobs/:id/invites/send', async (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const email = require('../services/email');
  if (!email.isConfigured()) return res.status(409).json({ error: 'This server cannot send email. Copy the invite links instead.', code: 'no_email' });
  const only = Array.isArray((req.body || {}).emails) ? new Set(req.body.emails.map((e) => String(e).toLowerCase())) : null;
  const byEmail = new Map();
  for (const i of inviteRows(req, job)) {
    if (only && !only.has(i.email.toLowerCase())) continue;
    if (!byEmail.has(i.email)) byEmail.set(i.email, []);
    byEmail.get(i.email).push(i);
  }
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(job.organization_id) || { name: '' };
  let sent = 0, failed = 0;
  for (const [to, list] of byEmail) {
    const text = [
      `${req.user.name || req.user.email} has moved ${org.name} to a new ScreenTinker server, and invited you to it.`,
      '',
      'To accept, sign in (or create an account with this email address) and open:',
      ...list.map((i) => `  ${i.workspace_name}: ${i.accept_url}`),
      '',
      'Passkeys do not move between servers: sign in with your password or single sign-on, then add a passkey again.',
    ].join('\n');
    try {
      const r = await email.sendEmail({ to, subject: `You've been invited to ${org.name} on its new ScreenTinker server`, text });
      if (r && r.sent) sent += 1; else failed += 1;
    } catch (_) { failed += 1; }
  }
  auditFromReq(req, 'trust.import_invites_sent', { import_id: job.id, sent, failed });
  res.json({ sent, failed });
});

/* A set-password link for an account a whole-server restore created (it has no password). */
router.post('/accounts/:userId/password-link', (req, res) => {
  if (denyNotPlatform(req, res)) return;
  const u = db.prepare('SELECT id, email, password_hash, auth_provider FROM users WHERE id = ?').get(String(req.params.userId));
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (u.password_hash) return res.status(409).json({ error: 'This account already has a password' });
  const token = require('../lib/passwordReset').issue(u.id);
  auditFromReq(req, 'trust.import_password_link', { user_id: u.id });
  res.json({ email: u.email, url: `${origin(req)}/app#/reset-password?token=${encodeURIComponent(token)}`, expires_in_minutes: 60 });
});

router.get('/jobs/:id/accounts', (req, res) => {
  if (denyNotPlatform(req, res)) return;
  const job = loadJob(req, res);
  if (!job) return;
  res.json({ accounts: db.prepare("SELECT id, email, name, role, auth_provider, password_hash IS NULL AS needs_password FROM users WHERE id IN (SELECT DISTINCT new_id FROM org_import_ids WHERE tbl = 'users' AND job_id IN (SELECT id FROM org_imports WHERE id = ? OR parent_id = ?)) ORDER BY email").all(job.id, job.id) });
});

/* ───────────── screens ───────────── */

router.get('/jobs/:id/screens', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  if (job.status !== 'done') return res.json({ screens: [] });
  res.json({ screens: screens.listScreens(db, job, origin(req)) });
});

router.get('/jobs/:id/handover', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  if (job.status !== 'done') return res.status(409).json({ error: 'The import has not finished' });
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(job.organization_id) || {};
  auditFromReq(req, 'trust.import_handover_downloaded', { import_id: job.id });
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'attachment; filename="screentinker-screen-handover.json"');
  res.json(screens.handoverDoc(db, job, origin(req), org.name));
});

router.post('/jobs/:id/screens/:deviceId/pair', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  // An owner or admin of the organization the screen was imported into (not merely of whichever
  // organization this session happens to be looking at).
  if (!req.isPlatformAdmin && !(job.organization_id && imp.canTarget(db, who(req), job.organization_id))) return res.status(403).json({ error: 'Organization owners and admins only' });
  const pairLockout = require('../lib/pair-lockout');
  const ip = req.ip || '';
  if (pairLockout.isLocked(ip)) return res.status(429).json({ error: 'Too many failed pairing attempts. Try again in a few minutes.' });
  const r = screens.pairInto(db, { importedId: String(req.params.deviceId), code: (req.body || {}).pairing_code, orgId: job.organization_id });
  if (r.error) {
    if (r.guess) pairLockout.recordFailure(ip);
    return res.status(r.status).json({ error: r.error });
  }
  pairLockout.reset(ip);
  const deviceNs = req.app.get('io') && req.app.get('io').of('/device');
  if (deviceNs) deviceNs.to(r.device.id).emit('device:paired', { device_id: r.device.id, name: r.device.name, settings_pin: r.device.settings_pin || undefined, brand: require('../lib/branding').playerBrandForDevice(db, r.device.id) });
  auditFromReq(req, 'trust.import_screen_paired', { import_id: job.id, device_id: r.device.id, previous_id: r.previous_id });
  res.json({ id: r.device.id, name: r.device.name, previous_id: r.previous_id });
});

/*
 * SOURCE SIDE of the move: this server's organization admin sends their screens to the new server,
 * using the handover file the new server produced. Each screen gets the existing "switch server"
 * command (set_server_url) with the new server's enrolment key for it.
 */
router.post('/handover', (req, res) => {
  if (!realPerson(req, res)) return;
  if (!req.organizationId || !isOrgAdmin(req)) return res.status(403).json({ error: 'Organization owners and admins only' });
  const b = req.body || {};
  if (b.confirm !== true) return res.status(400).json({ error: 'Confirm that every screen should switch to the new server.' });
  const deviceNs = req.app.get('io') && req.app.get('io').of('/device');
  if (!deviceNs) return res.status(503).json({ error: 'The realtime layer is not available.' });
  try {
    const out = screens.applyHandover(db, { doc: b.handover, orgId: req.organizationId, deviceNs, actor: require('../lib/corporate/actor').fromReq(req), onlyIds: Array.isArray(b.device_ids) ? b.device_ids : null });
    auditFromReq(req, 'trust.screens_handed_over', { to: out.server, sent: out.sent, total: out.results.length });
    res.json(out);
  } catch (e) { fail(res, e); }
});

/* ───────────── whole server (platform admin) ───────────── */

router.get('/instance-exports', (req, res) => {
  if (denyNotPlatform(req, res)) return;
  res.json({ exports: db.prepare('SELECT * FROM instance_exports ORDER BY created_at DESC LIMIT 10').all().map(instanceExport.publicJob), limits: { per_day: instanceExport.MAX_PER_DAY, link_minutes: exporter.LINK_TTL_MIN, kept_hours: exporter.TTL_HOURS } });
});

router.post('/instance-exports', (req, res) => {
  if (denyNotPlatform(req, res)) return;
  if (!realPerson(req, res)) return;
  try {
    const id = instanceExport.request(db, req.user.id, req.body || {});
    auditFromReq(req, 'trust.export_instance_requested', { export_id: id });
    res.status(202).json(instanceExport.publicJob(db.prepare('SELECT * FROM instance_exports WHERE id = ?').get(id)));
  } catch (e) { fail(res, e); }
});

router.post('/instance-exports/:id/link', (req, res) => {
  if (denyNotPlatform(req, res)) return;
  const job = db.prepare('SELECT * FROM instance_exports WHERE id = ?').get(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'Export not found' });
  try {
    const { key, expires_at } = instanceExport.link(db, job);
    res.json({ url: `/api/public/instance-export/${encodeURIComponent(job.id)}?key=${encodeURIComponent(key)}`, expires_at });
  } catch (e) { fail(res, e); }
});

/** GET /api/public/instance-export/:id?key= — the bundle, to a platform administrator's link. */
function instanceDownload(req, res) {
  const job = instanceExport.verifyKey(db, req.params.id, req.query.key);
  const user = job && db.prepare('SELECT id, role FROM users WHERE id = ?').get(job.user_id);
  const { isPlatformRole } = require('../middleware/auth');
  const p = job && instanceExport.filePath(job);
  if (!job || !user || !isPlatformRole(user.role) || !p || !require('fs').existsSync(p)) return res.status(404).json({ error: 'This download link is not valid or has expired.' });
  const date = new Date((job.finished_at || job.created_at) * 1000).toISOString().slice(0, 10);
  require('./trust').sendArchive(req, res, p, {
    name: `screentinker-server-export-${date}.zip`, sha256: job.sha256,
    onFirstByte: () => {
      db.prepare('UPDATE instance_exports SET downloads = downloads + 1 WHERE id = ?').run(job.id);
      require('../lib/audit').audit('trust.export_instance_downloaded', { userId: job.user_id, ip: req.ip || null, details: { export_id: job.id } });
    },
  });
}

module.exports = router;
module.exports.instanceDownload = instanceDownload;
