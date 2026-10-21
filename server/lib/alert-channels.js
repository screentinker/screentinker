'use strict';

/*
 * Alert channels: where a workspace hears that a screen went offline, and that it came back.
 *
 * Kinds: email (a list of addresses), slack and teams (incoming webhooks), pagerduty (Events API
 * v2: an incident opens when the screen goes dark and RESOLVES itself when it comes back), telegram
 * (a bot posting into a chat, group or channel through the Bot API), and a generic webhook (JSON,
 * HMAC-signed when a secret is set).
 *
 * ⚠️ WEBHOOK URLS AND ROUTING KEYS ARE CREDENTIALS. A Slack or Teams webhook URL lets anyone who
 * holds it post into that channel; a PagerDuty routing key opens incidents; a Telegram bot token is
 * the whole bot. They are stored, used here, and NEVER sent back to a browser or an API token whole
 * (present() masks them), and never logged. Every URL is fetched through the SSRF guard (public
 * addresses only, no redirects).
 *
 * ⚠️ TELEGRAM PUTS THE TOKEN IN THE URL PATH (https://api.telegram.org/bot<token>/sendMessage), so
 * that URL is a credential exactly like a Slack webhook: no error, last_error or log line built here
 * contains it, and anything Telegram itself says back passes through redactTelegram() first.
 *
 * ONE ALERT PER OUTAGE PER CHANNEL, and a recovery only after an offline alert went out on that
 * channel: alert_deliveries is keyed by (channel, device, outage), the outage being the device's
 * last_heartbeat when it went dark — the same per-outage key the owner email uses.
 */

const crypto = require('crypto');

function dbOf() { return require('../db/database').db; }

const KINDS = ['email', 'slack', 'teams', 'pagerduty', 'telegram', 'webhook'];
/*
 * screen_problem / screen_ok come from screen verification (lib/screen-verify): a screen that is
 * online but showing a blank or frozen picture, the wrong thing, or has its panel switched off —
 * and the matching "it is fine again". Opt-in per channel like the other two; a channel created
 * without an explicit list gets all four.
 */
const EVENTS = ['device_offline', 'device_online', 'screen_problem', 'screen_ok'];
const SCOPE_KINDS = new Set(['workspace', 'group', 'device']);
const PAGERDUTY_URL = 'https://events.pagerduty.com/v2/enqueue';
const TELEGRAM_API = 'https://api.telegram.org';
// A bot token from @BotFather: the bot's numeric id, a colon, then the secret part.
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
// A chat id: a number (a user is positive, a group negative, a channel or supergroup -100…), or a
// public channel's @username.
const TELEGRAM_CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;
const MAX_EMAILS = 20;
const MAX_ATTEMPTS = 3;

let sendOverride = null;   // in-process tests only (_setSender)
let transportOverride = null;   // in-process tests only (_setTransport): stands in for guardedRequest

/* ============================== input ============================== */

function checkWebhookUrl(raw, kind) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return 'Enter the webhook address.'; }
  if (u.protocol !== 'https:') return 'The webhook address must start with https://';
  if (u.username || u.password) return 'The webhook address must not contain a username or password.';
  if (kind === 'slack' && !/(^|\.)slack\.com$/i.test(u.hostname)) return 'A Slack webhook address is on hooks.slack.com.';
  if (String(raw).length > 2000) return 'The webhook address is too long.';
  return null;
}

/**
 * Validate a create/update body. `existing` is the stored row (for an update): a secret left empty
 * keeps the stored one, so the dashboard never needs to see it to save other fields.
 */
function normaliseInput(body, existing = null) {
  const b = body || {};
  const out = {};
  const kind = existing ? existing.kind : b.kind;
  if (!existing) {
    if (!KINDS.includes(kind)) return { error: `kind must be one of: ${KINDS.join(', ')}` };
    out.kind = kind;
  }
  if (b.name !== undefined || !existing) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return { error: 'name required' };
    out.name = name;
  }
  const prev = existing ? parseConfig(existing.config) : {};
  const cfg = { ...prev };
  if (kind === 'email') {
    if (b.emails !== undefined || !existing) {
      const list = (Array.isArray(b.emails) ? b.emails : String(b.emails || '').split(/[,;\s]+/))
        .map((e) => String(e).trim().toLowerCase()).filter(Boolean);
      if (!list.length) return { error: 'Add at least one email address.' };
      if (list.length > MAX_EMAILS) return { error: `At most ${MAX_EMAILS} addresses.` };
      const bad = list.find((e) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e));
      if (bad) return { error: `Not an email address: ${bad}` };
      cfg.emails = [...new Set(list)];
    }
  } else if (kind === 'slack' || kind === 'teams' || kind === 'webhook') {
    if (b.url !== undefined && b.url !== '') {
      const e = checkWebhookUrl(b.url, kind);
      if (e) return { error: e };
      cfg.url = String(b.url).trim();
    } else if (!existing || !prev.url) {
      return { error: 'Enter the webhook address.' };
    }
    if (kind === 'webhook' && b.secret !== undefined && b.secret !== '') cfg.secret = String(b.secret).slice(0, 200);
    if (kind === 'webhook' && b.secret === null) delete cfg.secret;
  } else if (kind === 'pagerduty') {
    if (b.routing_key !== undefined && b.routing_key !== '') {
      const k = String(b.routing_key).trim();
      if (!/^[A-Za-z0-9]{20,64}$/.test(k)) return { error: 'A PagerDuty integration (routing) key is 32 letters and digits.' };
      cfg.routing_key = k;
    } else if (!existing || !prev.routing_key) {
      return { error: 'Enter the PagerDuty integration key.' };
    }
  } else if (kind === 'telegram') {
    // ⚠️ The token is never echoed back, not even in the "that is not a token" error.
    if (b.bot_token !== undefined && b.bot_token !== '') {
      const k = String(b.bot_token).trim();
      if (!TELEGRAM_TOKEN_RE.test(k) || k.length > 200) return { error: 'A Telegram bot token looks like 123456789:AA… (the bot\'s number, a colon, then letters and digits). @BotFather gives it to you.' };
      cfg.bot_token = k;
    } else if (!existing || !prev.bot_token) {
      return { error: 'Enter the Telegram bot token.' };
    }
    if (b.chat_id !== undefined && b.chat_id !== '') {
      const c = String(b.chat_id).trim();
      if (!TELEGRAM_CHAT_RE.test(c)) return { error: 'A Telegram chat ID is a number (a group\'s starts with -, a channel\'s with -100) or a public channel\'s @username.' };
      cfg.chat_id = c;
    } else if (!existing || !prev.chat_id) {
      return { error: 'Enter the Telegram chat ID.' };
    }
    // #648 (@arminfauland): good news (back online, screen OK) can arrive without a sound, so the
    // group's notifications stay for what needs action. Absent on an edit keeps the stored choice.
    if (b.silent_info !== undefined) cfg.silent_info = b.silent_info === true || b.silent_info === 'true' || b.silent_info === 1;
  }
  out.config = JSON.stringify(cfg);
  if (b.events !== undefined || !existing) {
    const ev = (Array.isArray(b.events) ? b.events : EVENTS).filter((e) => EVENTS.includes(e));
    if (!ev.length) return { error: `events must include at least one of: ${EVENTS.join(', ')}` };
    out.events = JSON.stringify([...new Set(ev)]);
  }
  if (b.offline_minutes !== undefined) {
    const n = parseInt(b.offline_minutes, 10);
    if (!Number.isFinite(n) || n < 2 || n > 1440) return { error: 'offline_minutes must be 2–1440' };
    out.offline_minutes = n;
  }
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  return { fields: out };
}

function validateScopes(db, workspaceId, scopes) {
  if (scopes === undefined) return { rows: null };
  if (!Array.isArray(scopes) || !scopes.length) return { error: 'scopes must be a non-empty array of { scope_kind: workspace|group|device, scope_id }' };
  const rows = [];
  const seen = new Set();
  for (const s of scopes) {
    const kind = s && s.scope_kind;
    if (!SCOPE_KINDS.has(kind)) return { error: `invalid scope_kind: ${kind}` };
    const id = kind === 'workspace' ? workspaceId : String((s && s.scope_id) || '');
    if (kind === 'group' && !db.prepare('SELECT 1 FROM device_groups WHERE id = ? AND workspace_id = ?').get(id, workspaceId)) return { error: `group ${id} is not in this workspace` };
    if (kind === 'device' && !db.prepare('SELECT 1 FROM devices WHERE id = ? AND workspace_id = ?').get(id, workspaceId)) return { error: `screen ${id} is not in this workspace` };
    const k = `${kind}|${id}`;
    if (!seen.has(k)) { seen.add(k); rows.push({ scope_kind: kind, scope_id: id }); }
  }
  return { rows };
}

function setScopes(db, channelId, rows) {
  db.prepare('DELETE FROM alert_channel_scopes WHERE channel_id = ?').run(channelId);
  const ins = db.prepare('INSERT OR IGNORE INTO alert_channel_scopes (channel_id, scope_kind, scope_id) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(channelId, r.scope_kind, r.scope_id);
}
function scopesOf(db, channelId) {
  return db.prepare('SELECT scope_kind, scope_id FROM alert_channel_scopes WHERE channel_id = ? ORDER BY scope_kind, scope_id').all(channelId);
}
function inScope(db, channelId, deviceId) {
  return !!db.prepare(`SELECT 1 FROM alert_channel_scopes s WHERE s.channel_id = ? AND (
      s.scope_kind = 'workspace' OR (s.scope_kind = 'device' AND s.scope_id = ?)
      OR (s.scope_kind = 'group' AND EXISTS (SELECT 1 FROM device_group_members m WHERE m.group_id = s.scope_id AND m.device_id = ?)))`)
    .get(channelId, deviceId, deviceId);
}

function parseConfig(raw) { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function parseEvents(raw) { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }

function maskUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}/…${String(u).slice(-4)}`; } catch { return '…'; }
}

/** The row as the dashboard and the API see it: credentials masked, never whole. */
function present(db, row) {
  const cfg = parseConfig(row.config);
  const shown = {};
  if (row.kind === 'email') shown.emails = cfg.emails || [];
  if (cfg.url) shown.url_hint = maskUrl(cfg.url);
  if (cfg.routing_key) shown.routing_key_hint = `…${cfg.routing_key.slice(-4)}`;
  if (row.kind === 'telegram') {
    // The chat id alone lets nobody post (that takes the token), so the form can show it to edit.
    if (cfg.bot_token) shown.bot_token_hint = `…${cfg.bot_token.slice(-4)}`;
    shown.chat_id = cfg.chat_id || null;
    shown.silent_info = !!cfg.silent_info;
  }
  if (row.kind === 'webhook') shown.has_secret = !!cfg.secret;
  return {
    id: row.id, name: row.name, kind: row.kind, enabled: !!row.enabled,
    events: parseEvents(row.events), offline_minutes: row.offline_minutes,
    scopes: scopesOf(db, row.id), ...shown,
    last_sent_at: row.last_sent_at || null, last_error: row.last_error || null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

/* ============================== messages ============================== */

const SCREEN_PROBLEM_TEXT = {
  blank: 'is showing a blank screen',
  frozen: 'appears frozen (the picture has stopped changing)',
  unexpected: 'is not showing what it is scheduled to show',
  panel_off: 'has its display panel switched off',
};
const SCREEN_PROBLEM_TITLE = { blank: 'Blank screen', frozen: 'Frozen screen', unexpected: 'Unexpected content', panel_off: 'Panel off' };

function describe(event, device, { minutes, dashboardUrl, check, reason }) {
  const name = device.name || device.id;
  const mins = (n) => `${n} minute${n === 1 ? '' : 's'}`;
  if (event === 'screen_problem') {
    return { title: `${SCREEN_PROBLEM_TITLE[check] || 'Screen problem'}: ${name}`,
      text: `The screen "${name}" ${SCREEN_PROBLEM_TEXT[check] || 'has a problem'}${minutes ? ` and has for ${mins(minutes)}` : ''}. It is online and answering, so this would not show up as an offline alert.`,
      severity: 'warning' };
  }
  if (event === 'screen_ok') {
    if (reason === 'offline') {
      return { title: `Verification paused: ${name}`, text: `The screen "${name}" went offline, so its ${(SCREEN_PROBLEM_TITLE[check] || 'screen problem').toLowerCase()} is no longer being watched. Offline alerts take over from here.`, severity: 'info' };
    }
    if (reason === 'scheduled') {
      return { title: `Scheduled sleep: ${name}`, text: `The screen "${name}" is now in its scheduled power-off window, so its ${(SCREEN_PROBLEM_TITLE[check] || 'screen problem').toLowerCase()} is closed.`, severity: 'info' };
    }
    return { title: `Screen OK: ${name}`, text: `The screen "${name}" is showing its content again${minutes ? ` after ${mins(minutes)}` : ''}.`, severity: 'info' };
  }
  if (event === 'device_offline') {
    return { title: `Offline: ${name}`, text: `The screen "${name}" has been offline for ${minutes} minute${minutes === 1 ? '' : 's'}.`, severity: 'error' };
  }
  if (event === 'device_online') {
    return { title: `Back online: ${name}`, text: `The screen "${name}" is back online${minutes ? ` after ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}.`, severity: 'info' };
  }
  return { title: 'ScreenTinker test alert', text: 'This is a test from ScreenTinker. Alerts for this channel will look like this.', severity: 'info' };
}

/**
 * The HTTP request (or email) for one alert on one channel. Pure, so the shapes are tested
 * exactly. `ctx`: { event, device, minutes, workspace, dashboardUrl, dedupKey, nowIso }.
 */
function buildMessage(channel, ctx) {
  const cfg = parseConfig(channel.config);
  const d = describe(ctx.event, ctx.device || {}, ctx);
  const link = ctx.dashboardUrl && ctx.device && ctx.device.id ? `${ctx.dashboardUrl.replace(/\/+$/, '')}/app#/device/${ctx.device.id}` : null;
  const ws = ctx.workspace ? ctx.workspace.name : '';
  switch (channel.kind) {
    case 'email':
      return { kind: 'email', to: cfg.emails || [], subject: d.title, text: `${d.text}${ws ? `\n\nWorkspace: ${ws}` : ''}${link ? `\n\n${link}` : ''}\n\n- ScreenTinker` };
    case 'slack':
      return { kind: 'http', url: cfg.url, body: {
        text: `${d.severity === 'error' ? ':red_circle:' : d.severity === 'warning' ? ':large_yellow_circle:' : ':large_green_circle:'} ${d.title}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${slackEsc(d.title)}*\n${slackEsc(d.text)}${ws ? `\n_${slackEsc(ws)}_` : ''}${link ? `\n<${link}|Open in ScreenTinker>` : ''}` } }],
      } };
    case 'teams':
      // Teams "Workflows" incoming webhooks take an Adaptive Card wrapped in a message.
      return { kind: 'http', url: cfg.url, body: {
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: d.title, color: d.severity === 'error' ? 'Attention' : d.severity === 'warning' ? 'Warning' : 'Good', wrap: true },
            { type: 'TextBlock', text: d.text, wrap: true },
            ...(ws ? [{ type: 'TextBlock', text: ws, isSubtle: true, spacing: 'None', wrap: true }] : []),
          ],
          ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in ScreenTinker', url: link }] } : {}),
        } }],
      } };
    case 'pagerduty':
      // screen_ok resolves the screen_problem incident the same way device_online resolves an outage.
      return { kind: 'http', url: PAGERDUTY_URL, body: (ctx.event === 'device_online' || ctx.event === 'screen_ok')
        ? { routing_key: cfg.routing_key, event_action: 'resolve', dedup_key: ctx.dedupKey }
        : { routing_key: cfg.routing_key, event_action: 'trigger', dedup_key: ctx.dedupKey,
            payload: { summary: d.title, source: (ctx.device && ctx.device.name) || 'ScreenTinker', severity: ctx.event === 'test' ? 'info' : (d.severity === 'warning' ? 'warning' : 'error'),
              component: 'screen', group: ws || undefined, timestamp: ctx.nowIso, custom_details: { message: d.text, device_id: ctx.device && ctx.device.id } },
            ...(link ? { links: [{ href: link, text: 'Open in ScreenTinker' }] } : {}) } };
    case 'telegram': {
      // Bot API sendMessage with HTML formatting: only &, < and > need escaping (plus " inside the
      // link's href). The URL carries the token, so this message is a credential like a Slack one.
      const icon = d.severity === 'error' ? '\u{1F534}' : d.severity === 'warning' ? '\u{1F7E1}' : '\u{1F7E2}';
      const text = `${icon} <b>${htmlEsc(d.title)}</b>\n${htmlEsc(d.text)}${ws ? `\n<i>${htmlEsc(ws)}</i>` : ''}${link ? `\n<a href="${htmlEsc(link)}">Open in ScreenTinker</a>` : ''}`;
      return { kind: 'http', service: 'telegram', url: `${TELEGRAM_API}/bot${cfg.bot_token}/sendMessage`, body: {
        chat_id: cfg.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
        // Info-level events only (back online, screen OK, scheduled sleep); problems always ring,
        // and so does a test, which is how you hear that the channel works.
        ...(cfg.silent_info && d.severity === 'info' && ctx.event !== 'test' ? { disable_notification: true } : {}),
      } };
    }
    case 'webhook': {
      const body = { event: ctx.event, ...(ctx.check ? { check: ctx.check } : {}), title: d.title, message: d.text, workspace: ws || null,
        device: ctx.device ? { id: ctx.device.id, name: ctx.device.name } : null, minutes: ctx.minutes ?? null, url: link, sent_at: ctx.nowIso };
      const raw = JSON.stringify(body);
      const headers = {};
      if (cfg.secret) {
        const ts = String(Math.floor(Date.parse(ctx.nowIso) / 1000));
        headers['X-ScreenTinker-Timestamp'] = ts;
        headers['X-ScreenTinker-Signature'] = 'sha256=' + crypto.createHmac('sha256', cfg.secret).update(`${ts}.${raw}`).digest('hex');
      }
      return { kind: 'http', url: cfg.url, body, raw, headers };
    }
    default: return null;
  }
}

function slackEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function htmlEsc(s) { return slackEsc(s).replace(/"/g, '&quot;'); }

/** Anything that could be a bot token, or the URL path that carries one, cut out of a string. */
function redactTelegram(s) {
  return String(s == null ? '' : s).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot…').replace(/\d+:[A-Za-z0-9_-]{20,}/g, '…');
}

/**
 * Telegram answers JSON whatever the status: { ok: true, result } or { ok: false, error_code,
 * description, parameters? }. A 429 carries parameters.retry_after (seconds); it is a failure like
 * any other, and the next minute's tick tries again (rateLimited tells the tick to stop sending to
 * this channel for the rest of this pass, rather than spend every pending alert's attempts on it).
 */
function telegramResult(res) {
  let j = null;
  try { j = JSON.parse(res.text || ''); } catch { /* not JSON: judged by the status alone */ }
  const sc = res.statusCode;
  if (sc >= 200 && sc < 300 && j && j.ok === true) return { ok: true };
  const p = (j && j.parameters) || {};
  if (sc === 429 || (j && j.error_code === 429)) {
    const s = Number(p.retry_after);
    return { ok: false, rateLimited: true, error: `Telegram is limiting this bot (HTTP 429)${s > 0 ? `; it asked to wait ${Math.round(s)} s` : ''}.` };
  }
  if (p.migrate_to_chat_id) return { ok: false, error: `Telegram: this group became a supergroup. Change the chat ID to ${String(p.migrate_to_chat_id).replace(/[^\d-]/g, '').slice(0, 24)}.` };
  const desc = j && typeof j.description === 'string' ? redactTelegram(j.description).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
  if (desc) return { ok: false, error: `Telegram refused the message: ${desc}` };
  return { ok: false, error: sc >= 200 && sc < 300 ? 'Telegram did not accept the message.' : `The service answered HTTP ${sc}.` };
}

/** Deliver one message. Resolves { ok, error }. Never throws, never logs a credential. */
async function deliver(msg) {
  if (!msg) return { ok: false, error: 'Unknown channel kind' };
  if (sendOverride) return sendOverride(msg);
  try {
    if (msg.kind === 'email') {
      const { sendEmail } = require('../services/email');
      for (const to of msg.to) {
        const r = await sendEmail({ to, subject: msg.subject, text: msg.text });
        if (r && r.sent === false && r.reason === 'not_configured') return { ok: false, error: 'Email is not set up on this server.' };
      }
      return { ok: true };
    }
    const request = transportOverride || require('./ssrf-guard').guardedRequest;
    const raw = msg.raw || JSON.stringify(msg.body);
    const telegram = msg.service === 'telegram';
    const res = await request(msg.url, {
      method: 'POST', body: raw, timeoutMs: 10000, maxBytes: 64 * 1024, responseType: 'text', maxRedirects: 0, accept2xx: true,
      // Telegram explains a refusal in the body of a 4xx ("chat not found", retry_after), so read it.
      ...(telegram ? { acceptAnyStatus: true } : {}),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ScreenTinker-Alerts/1', ...(msg.headers || {}) },
    });
    if (telegram) return telegramResult(res);
    if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true };
    return { ok: false, error: `The service answered HTTP ${res.statusCode}.`, ...(res.statusCode === 429 ? { rateLimited: true } : {}) };
  } catch (e) {
    // ⚠️ e.message is never passed on: for Slack, Teams and Telegram the URL is the credential.
    const sc = e && (e.statusCode || Number((String(e.message).match(/\b([45]\d\d)\b/) || [])[1]));
    if (sc) return { ok: false, error: `The service answered HTTP ${sc}.`, ...(sc === 429 ? { rateLimited: true } : {}) };
    if (e && /timed out|timeout/i.test(e.message || '')) return { ok: false, error: 'The service did not answer in time.' };
    return { ok: false, error: 'The service could not be reached.' };   // never the URL: it is a credential
  }
}

/* ============================== the tick ============================== */

/** APP_URL, as invites and unsubscribe links use; without it the message simply carries no link. */
function dashboardUrl() {
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : null;
}

function recordResult(db, channel, r, now) {
  if (r.ok) db.prepare('UPDATE alert_channels SET last_sent_at = ?, last_error = NULL WHERE id = ?').run(now, channel.id);
  else db.prepare('UPDATE alert_channels SET last_error = ? WHERE id = ?').run(r.error || 'Delivery failed', channel.id);
}

/**
 * One pass: offline alerts for outages past each channel's threshold, and recoveries for screens
 * that came back after an offline alert went out on that channel. Called by the alert service's
 * minute tick. `localRowsSql`: the replica filter (a replica never alerts for a copied workspace).
 */
async function tick({ db = dbOf(), now = Math.floor(Date.now() / 1000), localRowsSql = () => '1=1' } = {}) {
  let channels;
  try { channels = db.prepare('SELECT * FROM alert_channels WHERE enabled = 1').all(); } catch { return { sent: 0 }; }
  if (!channels.length) return { sent: 0 };
  let sent = 0;
  const url = dashboardUrl();
  const wsName = new Map();
  const nameOf = (id) => { if (!wsName.has(id)) wsName.set(id, (db.prepare('SELECT name FROM workspaces WHERE id = ?').get(id) || {}).name || ''); return wsName.get(id); };

  for (const ch of channels) {
    const events = parseEvents(ch.events);
    const thresh = (ch.offline_minutes || 5) * 60;
    // A channel that answered 429 gets nothing more this pass: what is still pending keeps its
    // attempts and goes out on a later tick, instead of each one failing against the same limit.
    let limited = false;
    if (events.includes('device_offline')) {
      // Measured from when the screen was due: an embedded display asleep until its next scheduled
      // call (heartbeat_expected_by) is not late before then. The outage KEY stays last_heartbeat.
      // The upper bound keeps a new channel from announcing screens that have been dark for weeks.
      // It is a day PAST the threshold, not a fixed day: a fixed 86400 s left a 1440-minute
      // threshold (the form's maximum) no window at all, and one near it a window of a minute or two.
      const rows = db.prepare(`SELECT d.id, d.name, d.last_heartbeat,
          MAX(d.last_heartbeat, COALESCE(d.heartbeat_expected_by, 0)) AS overdue_since FROM devices d
        WHERE d.workspace_id = ? AND d.status = 'offline' AND d.last_heartbeat IS NOT NULL AND ${localRowsSql('d')}
          AND (? - MAX(d.last_heartbeat, COALESCE(d.heartbeat_expected_by, 0))) > ?
          AND (? - MAX(d.last_heartbeat, COALESCE(d.heartbeat_expected_by, 0))) < ?`).all(ch.workspace_id, now, thresh, now, thresh + 86400);
      for (const d of rows) {
        if (limited) break;
        if (!inScope(db, ch.id, d.id)) continue;
        const del = db.prepare('SELECT * FROM alert_deliveries WHERE channel_id = ? AND device_id = ? AND outage = ?').get(ch.id, d.id, d.last_heartbeat);
        if (del && (del.offline_sent_at || del.attempts >= MAX_ATTEMPTS)) continue;
        const minutes = Math.floor((now - d.overdue_since) / 60);
        const r = await deliver(buildMessage(ch, { event: 'device_offline', device: d, minutes, workspace: { name: nameOf(ch.workspace_id) }, dashboardUrl: url,
          dedupKey: `screentinker-${d.id}-${d.last_heartbeat}`, nowIso: new Date(now * 1000).toISOString() }));
        db.prepare(`INSERT INTO alert_deliveries (channel_id, device_id, outage, offline_sent_at, attempts) VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(channel_id, device_id, outage) DO UPDATE SET offline_sent_at = excluded.offline_sent_at, attempts = alert_deliveries.attempts + 1`)
          .run(ch.id, d.id, d.last_heartbeat, r.ok ? now : null);
        recordResult(db, ch, r, now);
        if (r.ok) sent++;
        if (r.rateLimited) limited = true;
      }
    }
    if (events.includes('device_online') && !limited) {
      // Back = the device is online and has heartbeated since the outage that was alerted.
      const rows = db.prepare(`SELECT a.outage, a.offline_sent_at, d.id, d.name, d.last_heartbeat FROM alert_deliveries a
        JOIN devices d ON d.id = a.device_id
        WHERE a.channel_id = ? AND a.offline_sent_at IS NOT NULL AND a.online_sent_at IS NULL AND a.online_attempts < ?
          AND d.status = 'online' AND d.last_heartbeat > a.outage AND ${localRowsSql('d')}`).all(ch.id, MAX_ATTEMPTS);
      for (const d of rows) {
        if (limited) break;
        const minutes = Math.max(0, Math.floor((d.last_heartbeat - d.outage) / 60));
        const r = await deliver(buildMessage(ch, { event: 'device_online', device: d, minutes, workspace: { name: nameOf(ch.workspace_id) }, dashboardUrl: url,
          dedupKey: `screentinker-${d.id}-${d.outage}`, nowIso: new Date(now * 1000).toISOString() }));
        db.prepare('UPDATE alert_deliveries SET online_sent_at = ?, online_attempts = online_attempts + 1 WHERE channel_id = ? AND device_id = ? AND outage = ?')
          .run(r.ok ? now : null, ch.id, d.id, d.outage);
        recordResult(db, ch, r, now);
        if (r.ok) sent++;
        if (r.rateLimited) limited = true;
      }
    }
  }
  // A week of delivery history is plenty to suppress duplicates.
  try { db.prepare('DELETE FROM alert_deliveries WHERE COALESCE(online_sent_at, offline_sent_at, outage) < ?').run(now - 7 * 86400); } catch (_) { /* */ }
  return { sent };
}

/** The Test button: one message, now, recorded like a real one. */
async function sendTest(db, channel) {
  const now = Math.floor(Date.now() / 1000);
  const r = await deliver(buildMessage(channel, { event: 'test', device: null, workspace: { name: (db.prepare('SELECT name FROM workspaces WHERE id = ?').get(channel.workspace_id) || {}).name },
    dashboardUrl: dashboardUrl(), dedupKey: `screentinker-test-${channel.id}-${now}`, nowIso: new Date(now * 1000).toISOString() }));
  recordResult(db, channel, r, now);
  // A PagerDuty test opens an incident; close it straight away so nobody is paged for a test.
  if (r.ok && channel.kind === 'pagerduty') {
    const cfg = parseConfig(channel.config);
    await deliver({ kind: 'http', url: PAGERDUTY_URL, body: { routing_key: cfg.routing_key, event_action: 'resolve', dedup_key: `screentinker-test-${channel.id}-${now}` } });
  }
  return r;
}

function _setSender(fn) { sendOverride = fn || null; }
function _setTransport(fn) { transportOverride = fn || null; }

module.exports = {
  KINDS, EVENTS, normaliseInput, validateScopes, setScopes, scopesOf, inScope, present, buildMessage, deliver, tick, sendTest,
  checkWebhookUrl, redactTelegram, _setSender, _setTransport,
  // Shared with lib/screen-verify, which delivers its own incidents through these channels.
  parseEvents, dashboardUrl, recordResult,
};
