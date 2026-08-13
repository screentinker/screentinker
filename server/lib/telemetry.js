'use strict';

/*
 * Opt-in install statistics.
 *
 * WHY THIS EXISTS: there is no way to answer "how many screens run ScreenTinker?" — the product is
 * self-hostable by design, so most installs are invisible to us on purpose. This asks, once, and
 * only reports if the operator says yes.
 *
 * WHAT IS SENT — the whole payload, three fields:
 *
 *     { instance_id, version, screen_count }
 *
 * and nothing else. No hostnames, no addresses, no organization or user names, no device names,
 * no content or filenames, no user counts. The list is short on purpose: every field added costs
 * participation, and participation is the only thing that makes the resulting number worth
 * quoting. Anyone can verify it — the payload is built in `payload()` below, in one place, and
 * `getLastReport()` shows an operator the exact bytes last sent.
 *
 * `instance_id` is a random UUID generated on first use and kept in app_settings. It carries no
 * information about the install; its only job is to let two reports from the same server be
 * recognised as the same server, so a count is a count rather than a sum of duplicates. That does
 * make a report PSEUDONYMOUS rather than anonymous, and the wording shown to operators says so.
 *
 * ⚠️ Restoring a backup or cloning a VM carries the id with it, so two installs report as one.
 * Deliberate: under-counting is the honest failure here, and the alternative (re-identifying on
 * some hardware signal) means collecting exactly the kind of thing this file promises not to.
 *
 * ⚠️ Opt-in populations are self-selected, so the total is a FLOOR — "at least N screens" — never
 * a basis for extrapolating a fleet size.
 */

const crypto = require('crypto');
const appSettings = require('./app-settings');

const KEY_ID = 'telemetry_instance_id';
const KEY_ENABLED = 'telemetry_enabled';      // unset = never asked
const KEY_LAST = 'telemetry_last_report';     // last SUCCESSFUL send
const KEY_LAST_ERROR = 'telemetry_last_error';// last FAILED attempt — see getLastError

/*
 * Where reports go. TWO independent destinations, deliberately:
 *
 *   SCREENTINKER_ENDPOINT  hard-wired, and reached only when the operator has switched sharing on.
 *                          Not overridable — an "override" that silently redirected the shared
 *                          report would make the opt-in mean something different from what it says.
 *
 *   TELEMETRY_EXTRA_ENDPOINT  an operator's OWN collector, for their own fleet numbers. Additional,
 *                          never a replacement, and named so it cannot be mistaken for one. It is
 *                          sent independently of the sharing toggle: it is their server posting to
 *                          their host, so our opt-in has no business gating it. An operator who
 *                          wants internal statistics and nothing leaving for us sets this and
 *                          leaves sharing off — that combination is supported on purpose.
 */
const SCREENTINKER_ENDPOINT = 'https://stats.screentinker.com/api/telemetry/report';
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;   // daily; this is a count, not a metric
const FIRST_REPORT_DELAY_MS = 5 * 60 * 1000;      // let boot settle before any outbound call

let timer = null;

/* The instance's own id, minted on first read. Stable for the life of the install. */
function instanceId() {
  let id = appSettings.get(KEY_ID, null);
  if (!id) {
    id = crypto.randomUUID();
    appSettings.set(KEY_ID, id);
  }
  return id;
}

/*
 * 'unasked' | 'on' | 'off'. The distinction matters: 'unasked' is what the prompt keys on, and a
 * declined install must be remembered as 'off' rather than falling back to 'unasked' and being
 * asked again on every update — re-prompting is how telemetry gets patched out by annoyed admins.
 */
function state() {
  const v = appSettings.get(KEY_ENABLED, undefined);
  if (v === undefined) return 'unasked';
  return (v === 'true' || v === '1') ? 'on' : 'off';
}

function setEnabled(enabled) {
  appSettings.setBool(KEY_ENABLED, !!enabled);
  return state();
}

/* Every field that leaves this install, built in one place so it can be audited at a glance. */
function payload(db) {
  return {
    instance_id: instanceId(),
    version: require('../version'),
    screen_count: countScreens(db),
  };
}

// Devices that have actually been paired — a provisioning row nobody ever connected is not a
// screen, and counting it would overstate exactly the number this exists to state honestly.
function countScreens(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM devices WHERE device_token IS NOT NULL').get().c;
  } catch (_) {
    return 0;
  }
}

/* The address an operator may need to allowlist for the shared report. Hard-wired. */
function endpoint() { return SCREENTINKER_ENDPOINT; }

/* The operator's own collector, if they configured one. Null when they have not. */
function extraEndpoint() { return process.env.TELEMETRY_EXTRA_ENDPOINT || null; }

/*
 * Everywhere this report is going, right now, and why — so the UI can list every destination
 * rather than implying there is only one. Sharing gates OUR endpoint alone.
 */
function destinations() {
  const out = [];
  if (state() === 'on') out.push({ url: endpoint(), kind: 'screentinker' });
  const extra = extraEndpoint();
  if (extra) out.push({ url: extra, kind: 'extra' });
  return out;
}

/* What was last sent, and when. Surfaced in Settings so an operator can check rather than trust. */
function getLastReport() {
  const raw = appSettings.get(KEY_LAST, null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/*
 * The last FAILED attempt, kept separately from the last success.
 *
 * A self-hosted server frequently sits behind egress filtering, so "enabled but nothing arrives"
 * is the normal failure and it is otherwise completely silent — the operator sees "nothing has
 * been sent" and has no way to tell a blocked firewall from a broken feature. Recording the
 * failure lets the UI name the host that needs unblocking instead.
 */
function getLastError() {
  const raw = appSettings.get(KEY_LAST_ERROR, null);
  if (!raw) return null;   // '' is how a success clears it
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/*
 * Send one report. Returns {sent:false, reason} rather than throwing — a stats call must never be
 * able to affect the running server, so every failure path here is quiet and local.
 */
async function postTo(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? { sent: true } : { sent: false, reason: `http_${res.status}` };
  } catch (err) {
    // Offline, DNS failure, blocked egress — all normal for a self-hosted box, none of them news
    // in the log, but all worth surfacing in the UI so the operator can act on it.
    return { sent: false, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function report(db, { urls = null } = {}) {
  // `urls` is a test seam. Normal callers get destinations() — sharing gates ours, an operator's
  // own collector is independent of it.
  const targets = urls || destinations();
  if (!targets.length) return { sent: false, reason: 'not_enabled', results: [] };

  const now = () => Math.floor(Date.now() / 1000);
  const body = payload(db);

  // Every destination is attempted, independently. One unreachable collector must not stop the
  // other from receiving — a blocked corporate firewall on their host should not cost us the
  // shared count, and our endpoint being down should not cost them their own fleet numbers.
  const results = [];
  for (const t of targets) results.push({ ...t, ...(await postTo(t.url, body)) });

  const failed = results.filter(r => !r.sent);
  if (results.some(r => r.sent)) appSettings.set(KEY_LAST, JSON.stringify({ at: now(), body, results }));
  // Keep only a LIVE complaint: record what is still failing, and clear it once nothing is.
  appSettings.set(KEY_LAST_ERROR, failed.length
    ? JSON.stringify({ at: now(), reason: failed[0].reason, url: failed[0].url, failed })
    : '');

  return { sent: failed.length === 0, results, body, reason: failed[0]?.reason };
}

function start(db) {
  if (timer) return;
  const tick = () => { report(db).catch(() => {}); };
  setTimeout(tick, FIRST_REPORT_DELAY_MS).unref?.();
  timer = setInterval(tick, REPORT_INTERVAL_MS);
  timer.unref?.();   // never hold the process open for a stats timer
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { instanceId, state, setEnabled, payload, report, endpoint, extraEndpoint, destinations, getLastReport, getLastError, start, stop };
