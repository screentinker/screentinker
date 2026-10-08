'use strict';

/*
 * Grafana: the server renders a dashboard (or one panel) to PNG with Grafana's render API and the
 * screen shows the image. The service-account token stays here — a screen never talks to Grafana,
 * which also means a screen on a guest network can show a dashboard on a private one.
 *
 * Needs the Grafana Image Renderer (plugin or remote service) on the Grafana side; Test says so.
 *
 * Images are cached per widget and size for the widget's refresh interval, one fetch in flight per
 * key, and the last good image is served when Grafana is down — or when the caller's render budget
 * is spent — so a screen never goes blank on a Grafana restart.
 */

const biHttp = require('./http');

const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIME_RE = /^[A-Za-z0-9+\-/:. ]{1,40}$/;
const VAR_KEY_RE = /^var-[A-Za-z0-9_-]{1,64}$/;
const MIN_REFRESH = 30;

const cache = new Map();       // key -> { buf, type, at }
const inflight = new Map();    // key -> Promise
const MAX_ENTRIES = 200;

/** Validate the Grafana part of a widget config. Returns the clean object, or throws Error(message). */
function normaliseWidgetConfig(c) {
  const uid = String(c.dashboard_uid || '').trim();
  if (!UID_RE.test(uid)) throw new Error('Enter the dashboard UID (the part after /d/ in its address).');
  const out = { dashboard_uid: uid };
  if (c.panel_id !== undefined && c.panel_id !== null && c.panel_id !== '') {
    const p = Number(c.panel_id);
    if (!Number.isInteger(p) || p < 1 || p > 1e6) throw new Error('The panel ID must be a whole number.');
    out.panel_id = p;
  }
  const org = c.org_id === undefined || c.org_id === '' ? 1 : Number(c.org_id);
  if (!Number.isInteger(org) || org < 1 || org > 1e6) throw new Error('The Grafana organization ID must be a whole number.');
  out.org_id = org;
  out.theme = c.theme === 'light' ? 'light' : 'dark';
  for (const k of ['time_from', 'time_to']) {
    if (c[k] !== undefined && c[k] !== '') {
      if (!TIME_RE.test(String(c[k]))) throw new Error('Use a Grafana time such as now-6h or now.');
      out[k] = String(c[k]);
    }
  }
  // Template variables: "var-host=web1&var-env=prod". Only var-* keys survive, so this cannot be
  // used to smuggle render options (or anything else) into the URL.
  const vars = {};
  const raw = typeof c.vars === 'string' ? c.vars : '';
  for (const [k, v] of new URLSearchParams(raw.replace(/^\?/, ''))) {
    if (VAR_KEY_RE.test(k) && String(v).length <= 200) vars[k] = String(v);
  }
  out.vars = new URLSearchParams(vars).toString();
  return out;
}

function sizeBucket(n, lo, hi, def) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.max(lo, Math.min(hi, Math.round(v / 64) * 64));
}

/** The render URL. Width/height are bucketed so a cache entry serves every screen of a size. */
function renderUrl(conn, cfg, { width, height }) {
  const base = String(conn.config.base_url).replace(/\/+$/, '');
  const path = cfg.panel_id ? `/render/d-solo/${encodeURIComponent(cfg.dashboard_uid)}` : `/render/d/${encodeURIComponent(cfg.dashboard_uid)}`;
  const q = new URLSearchParams();
  q.set('orgId', String(cfg.org_id || 1));
  if (cfg.panel_id) q.set('panelId', String(cfg.panel_id));
  q.set('width', String(width));
  q.set('height', String(height));
  q.set('theme', cfg.theme === 'light' ? 'light' : 'dark');
  if (!cfg.panel_id) q.set('kiosk', '');
  if (cfg.time_from) q.set('from', cfg.time_from);
  if (cfg.time_to) q.set('to', cfg.time_to);
  q.set('timeout', '60');
  for (const [k, v] of new URLSearchParams(cfg.vars || '')) if (VAR_KEY_RE.test(k)) q.append(k, v);
  return `${base}${path}?${q.toString()}`;
}

function put(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

async function fetchPng(conn, token, url) {
  const r = await biHttp.request(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'image/png' },
    allowPrivate: !!conn.allow_private,
    timeoutMs: 70000,
  });
  if (r.status !== 200) {
    const why = r.status === 401 || r.status === 403 ? 'Grafana refused the service account token'
      : r.status === 404 ? 'Grafana has no such dashboard, or the image renderer is not installed'
        : `Grafana answered ${r.status}`;
    throw new Error(why);
  }
  const type = String(r.headers['content-type'] || '');
  if (!/^image\/(png|jpeg)/.test(type)) throw new Error('Grafana did not return an image — is the image renderer installed?');
  return { buf: r.body, type: type.split(';')[0] };
}

/**
 * The image for a widget at a size. Returns { buf, type, at, stale, error? } or throws when there
 * is nothing at all to show.
 */
async function imageFor(widgetId, conn, cfg, size, { refreshSec = 300, now = Date.now(), beforeFetch = null } = {}) {
  const width = sizeBucket(size.width, 320, 3840, 1920);
  const height = sizeBucket(size.height, 240, 2160, 1080);
  const url = renderUrl(conn, cfg, { width, height });
  const key = `${widgetId}|${conn.id}|${conn.updated_at}|${url}`;
  const ttl = Math.max(MIN_REFRESH, Number(refreshSec) || 300) * 1000;
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return { ...hit, stale: false };
  if (!inflight.has(key)) {
    // Only a call that would reach Grafana is counted (routes/widgets.js): a refused one still gets
    // the last image, so a busy fleet or a stranger with the address never blanks a screen.
    if (beforeFetch && !beforeFetch()) {
      if (hit) return { ...hit, stale: true, error: 'rate limited' };
      throw Object.assign(new Error('Too many renders for this dashboard'), { status: 429 });
    }
    const token = require('./connections').secretOf(conn);
    const p = fetchPng(conn, token, url)
      .then((img) => { const e = { ...img, at: Date.now() }; put(key, e); return e; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    return { ...(await inflight.get(key)), stale: false };
  } catch (err) {
    if (hit) return { ...hit, stale: true, error: err.message };
    throw err;
  }
}

/** Connection test: the token is accepted, and whether the image renderer is there. */
async function test(conn) {
  const base = String(conn.config.base_url).replace(/\/+$/, '');
  const token = require('./connections').secretOf(conn);
  const checks = [];
  const opts = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, allowPrivate: !!conn.allow_private, maxBytes: 1024 * 1024 };
  try {
    const r = await biHttp.request(`${base}/api/search?limit=1`, opts);
    checks.push({ name: 'token', ok: r.status === 200, detail: r.status === 200 ? 'accepted' : `Grafana answered ${r.status}` });
  } catch (e) {
    checks.push({ name: 'token', ok: false, detail: biHttp.describe(e) });
    return { ok: false, checks };
  }
  try {
    const r = await biHttp.request(`${base}/api/plugins/grafana-image-renderer/settings`, opts);
    // A remote renderer service is configured in grafana.ini and does not appear as a plugin, so a
    // 404 is a warning the admin can judge, not a failure.
    checks.push({ name: 'renderer', ok: r.status === 200, warn: r.status !== 200, detail: r.status === 200 ? 'image renderer plugin installed' : 'image renderer plugin not found (fine if you run the renderer as a remote service)' });
  } catch (e) {
    checks.push({ name: 'renderer', ok: false, warn: true, detail: biHttp.describe(e) });
  }
  return { ok: checks.every((c) => c.ok || c.warn), checks };
}

function _resetCache() { cache.clear(); inflight.clear(); }

module.exports = { normaliseWidgetConfig, renderUrl, imageFor, test, sizeBucket, _resetCache };
