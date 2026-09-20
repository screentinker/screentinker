/*
 * NOC — the mesh / scale-out graph of THIS server, live.
 *
 * ⚠️ THIS NODE ONLY. Nodes are this server, its parents, its children and the servers whose
 * reports demonstrably travelled through a child (docs/scale-out.md "NOC on this server"). Nothing
 * here dials another server, discovers a URL, or asks a customer who did not enrol for anything
 * (I7, I8). Every number comes from one poll of GET /api/mesh/noc, which is built from what this
 * node already holds; opening this page starts no snapshot, no cache fill and no mesh read.
 *
 * ⚠️ POLLS ONLY WHILE IT IS THE ACTIVE VIEW AND THE TAB IS VISIBLE. The interval is created in
 * start(), cleared in stop(), and stop() runs on cleanup() (app.js view swap) and on
 * visibilitychange -> hidden. There is no other setInterval in this file (a source test holds it).
 *
 * "Data movement" is a pulse on a link when one of its sampled counters changed since the last
 * poll — a change-log rev, a device summary, a drained player event, a relayed command, a stored
 * file. No envelope is streamed to the browser; the counters are what moved.
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

const POLL_MS = 3000;
const DEVICE_LIST_MAX = 30;   // above this, show counts and point at the fleet page — never one DOM node per screen

let timer = null;
let active = false;
let host = null;
let last = null;          // previous sample, for pulses
let selected = null;      // node id
const pulses = new Map(); // edgeId -> until (ms)

/* ------------------------------ lifecycle ------------------------------ */

export async function render(container) {
  host = container;
  active = true;
  container.innerHTML = `
    <div class="page-header">
      <div><h1>NOC</h1><div class="subtitle">This server's mesh, live. Polled every ${POLL_MS / 1000} s while this page is open.</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <span id="nocAsOf" style="color:var(--text-muted);font-size:12px"></span>
        <button class="btn btn-secondary btn-sm" id="nocRefresh">Refresh</button>
      </div>
    </div>
    <div id="nocBody"><p style="color:var(--text-muted)">Loading…</p></div>`;
  container.querySelector('#nocRefresh').addEventListener('click', () => tick());
  document.addEventListener('visibilitychange', onVisibility);
  await tick();
  start();
}

export function cleanup() {
  stop();
  active = false;
  document.removeEventListener('visibilitychange', onVisibility);
  host = null; last = null; selected = null; pulses.clear();
}

function start() {
  if (timer || !active || document.visibilityState === 'hidden') return;
  timer = setInterval(tick, POLL_MS);
}
function stop() { if (timer) clearInterval(timer); timer = null; }
function onVisibility() { if (document.visibilityState === 'hidden') stop(); else { tick(); start(); } }
export function isPolling() { return !!timer; }

/* ------------------------------ data ------------------------------ */

async function tick() {
  if (!active || !host) return;
  let data;
  try { data = await api.get('/mesh/noc'); } catch (e) {
    const body = host.querySelector('#nocBody');
    if (body) body.innerHTML = `<p style="color:var(--text-muted)">${esc(e.message)}</p>`;
    // A 404 means the mesh is off here; a 403 that this is not the instance owner. Either way, stop asking.
    if (/404|403|not found|owner/i.test(e.message || '')) stop();
    return;
  }
  detectMovement(data);
  last = data;
  draw(data);
}

function detectMovement(data) {
  if (!last) return;
  const prev = new Map(last.links.map((l) => [l.edgeId, l.movement || {}]));
  for (const l of data.links) {
    const p = prev.get(l.edgeId);
    if (!p) continue;
    const m = l.movement || {};
    const moved = Object.keys(m).some((k) => k !== 'last_sync_at' ? m[k] !== p[k] : (m[k] || 0) > (p[k] || 0));
    if (moved) pulses.set(l.edgeId, Date.now() + POLL_MS);
  }
}

/* ------------------------------ layout + draw ------------------------------ */

const STATE_COLOUR = { connected: '#22c55e', lagging: '#f59e0b', down: '#ef4444', revoked: '#6b7280', unknown: '#6b7280' };
const roleLabel = (r) => ({ 'serves-dashboard': 'dashboard', 'terminates-players': 'players', 'caches-content': 'cache',
                            'relays-for-subtree': 'relay', 'redistributes-content': 'redistributes' }[r] || r);
const fmtBytes = (b) => (b == null ? '—' : b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GiB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MiB` : `${b} B`);
const short = (id) => String(id || '').slice(0, 8);

function draw(data) {
  const body = host && host.querySelector('#nocBody');
  if (!body) return;
  const asOf = host.querySelector('#nocAsOf');
  if (asOf) asOf.textContent = `as of ${new Date(data.asOf * 1000).toLocaleTimeString()}`;

  const parents = data.nodes.filter((n) => n.kind === 'parent');
  const children = data.nodes.filter((n) => n.kind === 'child');
  const indirect = data.indirect || [];
  const W = Math.max(720, Math.max(parents.length, children.length, 1) * 220 + 80);
  const rows = 2 + (parents.length ? 1 : 0) + (indirect.length ? 1 : 0);
  const H = 120 * rows + 40;
  const pos = new Map();
  let y = 70;
  const place = (list, yy) => list.forEach((n, i) => pos.set(n.id, { x: 40 + (W - 80) * ((i + 0.5) / list.length), y: yy }));
  if (parents.length) { place(parents, y); y += 120; }
  pos.set(data.self.id, { x: W / 2, y }); y += 120;
  place(children, y); y += 120;
  place(indirect, y);

  const nodeBox = (n, kind) => {
    const p = pos.get(n.id); if (!p) return '';
    const sel = selected === n.id;
    const roles = kind === 'self' ? n.roles : (kind === 'child' ? n.capabilitiesHere : n.roles) || [];
    const sc = n.screens;
    const line2 = sc ? `${sc.online ?? 0}/${sc.total ?? 0} online${sc.attachedHere ? ` · ${sc.attachedHere} here` : ''}${sc.attachedElsewhere ? ` · ${sc.attachedElsewhere} via replica` : ''}` : (kind === 'indirect' ? `${n.hops} hop(s)` : '');
    return `
      <g class="noc-node" data-node="${esc(n.id)}" transform="translate(${p.x - 90},${p.y - 28})" style="cursor:pointer">
        <rect width="180" height="56" rx="8" fill="var(--bg-card,#1f2937)" stroke="${sel ? 'var(--primary,#3b82f6)' : 'var(--border,#374151)'}" stroke-width="${sel ? 2 : 1}"/>
        <text x="10" y="20" fill="var(--text,#e5e7eb)" font-size="13" font-weight="600">${esc((n.name || short(n.id)).slice(0, 22))}${kind === 'self' ? ' (this server)' : ''}</text>
        <text x="10" y="36" fill="var(--text-muted,#9ca3af)" font-size="11">${esc(roles.map(roleLabel).join(' · ') || kind)}</text>
        <text x="10" y="50" fill="var(--text-muted,#9ca3af)" font-size="11">${esc(line2)}</text>
      </g>`;
  };
  const edgeLine = (l) => {
    const a = pos.get(l.from), b = pos.get(l.to); if (!a || !b) return '';
    const colour = STATE_COLOUR[l.state] || STATE_COLOUR.unknown;
    const pulsing = (pulses.get(l.edgeId) || 0) > Date.now();
    const label = l.direction === 'down'
      ? `${l.lag_s == null ? 'lag ?' : `lag ${l.lag_s}s`}${l.players ? ` · q${l.players.pending}` : ''}${l.cache ? ` · ${fmtBytes(l.cache.bytes)}` : ''}`
      : `${l.ackedRev != null && l.headRev != null ? `acked ${l.ackedRev}/${l.headRev}` : l.state}`;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return `
      <g class="noc-edge${pulsing ? ' noc-pulse' : ''}" data-edge="${esc(l.edgeId)}">
        <line x1="${a.x}" y1="${a.y + 28}" x2="${b.x}" y2="${b.y - 28}" stroke="${colour}" stroke-width="${pulsing ? 4 : 2}" ${l.state === 'revoked' ? 'stroke-dasharray="6 4"' : ''}/>
        <text x="${mx + 6}" y="${my}" fill="${colour}" font-size="11">${esc(label)}</text>
      </g>`;
  };
  const indirectLine = (n) => {
    const a = pos.get(n.via), b = pos.get(n.id); if (!a || !b) return '';
    return `<line x1="${a.x}" y1="${a.y + 28}" x2="${b.x}" y2="${b.y - 28}" stroke="#6b7280" stroke-width="1" stroke-dasharray="2 4"/>`;
  };

  const svg = `
    <style>
      .noc-pulse line { animation: nocPulse ${POLL_MS}ms ease-out 1; }
      @keyframes nocPulse { 0% { stroke-opacity: 1; stroke-width: 6; } 100% { stroke-opacity: .9; stroke-width: 2; } }
    </style>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(t('noc.graph_label'))}" style="max-width:100%">
      ${data.links.map(edgeLine).join('')}
      ${indirect.map(indirectLine).join('')}
      ${parents.map((n) => nodeBox(n, 'parent')).join('')}
      ${nodeBox(data.self, 'self')}
      ${children.map((n) => nodeBox(n, 'child')).join('')}
      ${indirect.map((n) => nodeBox(n, 'indirect')).join('')}
    </svg>`;

  // Accessible list of the same nodes, always rendered (and the whole view if SVG is unavailable).
  const listItem = (n, kind) => `<li><strong>${esc(n.name || short(n.id))}</strong> — ${esc(kind)}${n.screens ? `; screens ${n.screens.online ?? 0}/${n.screens.total ?? 0} online` : ''}</li>`;
  const list = `
    <details style="margin-top:12px"><summary style="cursor:pointer;color:var(--text-muted);font-size:12px">List view</summary>
      <ul style="font-size:13px">
        ${listItem(data.self, 'this server')}
        ${parents.map((n) => listItem(n, 'parent — ' + (n.roles || []).map(roleLabel).join(', '))).join('')}
        ${children.map((n) => listItem(n, 'child — ' + (n.capabilitiesHere || []).map(roleLabel).join(', '))).join('')}
        ${indirect.map((n) => listItem(n, `${n.hops} hop(s) via ${short(n.via)}`)).join('')}
        ${data.links.map((l) => `<li>link ${short(l.from)} → ${short(l.to)}: ${esc(l.state)}${l.lag_s !== undefined ? `, lag ${l.lag_s == null ? 'unknown' : l.lag_s + ' s'}` : ''}${l.lastError ? `, ${esc(l.lastError)}` : ''}</li>`).join('')}
      </ul>
    </details>`;

  const supportsSvg = typeof document.createElementNS === 'function';
  body.innerHTML = `
    <div class="settings-section">${supportsSvg ? svg : ''}${list}</div>
    <div id="nocDetail" class="settings-section" style="margin-top:16px">${detailHtml(data)}</div>`;

  body.querySelectorAll('.noc-node').forEach((g) => g.addEventListener('click', () => { selected = g.dataset.node; draw(data); }));
  wireDetail(body, data);
}

/* ------------------------------ detail panel ------------------------------ */

function detailHtml(data) {
  if (!selected) return '<p style="color:var(--text-muted);font-size:13px">Select a server for its links and counters.</p>';
  const n = [data.self, ...data.nodes, ...(data.indirect || [])].find((x) => x.id === selected);
  if (!n) return '';
  const links = data.links.filter((l) => l.from === n.id || l.to === n.id);
  const kv = (k, v) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:2px 0"><span style="color:var(--text-muted)">${esc(k)}</span><span>${esc(String(v))}</span></div>`;
  const linkCard = (l) => {
    const colour = STATE_COLOUR[l.state] || STATE_COLOUR.unknown;
    const rows = [];
    rows.push(kv('state', l.state));
    if (l.direction === 'down') {
      rows.push(kv('lag', l.lag_s == null ? 'unknown' : `${l.lag_s} s`));
      rows.push(kv('phase', l.phase || '—'));
      rows.push(kv('applied rev', l.lastAppliedRev ?? '—'));
      if (l.error) rows.push(kv('error', l.error));
      if (l.players) { rows.push(kv('outbox depth', l.players.pending)); rows.push(kv('outbox oldest', `${l.players.oldest_age_s} s`)); rows.push(kv('events applied', l.players.sent ?? 0)); rows.push(kv('expired / refused at cap', `${l.players.expired} / ${l.players.refused_at_cap}`)); if (l.players.last_error) rows.push(kv('outbox error', l.players.last_error)); }
      if (l.cache) { rows.push(kv('cache', `${fmtBytes(l.cache.bytes)} of ${fmtBytes(l.cache.cap_bytes)} (${l.cache.files} files)`)); rows.push(kv('pinned', fmtBytes(l.cache.pinned_bytes))); rows.push(kv('stored this run', l.cache.stored ?? 0)); if (l.cache.last_error) rows.push(kv('cache error', l.cache.last_error)); }
      rows.push(kv('commands delivered here', l.movement.relays_delivered ?? 0));
    } else {
      rows.push(kv('acked rev / head', `${l.ackedRev ?? '—'} / ${l.headRev ?? '—'}`));
      rows.push(kv('commands relayed up', l.movement.relayed ?? 0));
      if (l.movement.buffered != null) rows.push(kv('buffered upward', l.movement.buffered));
      if (l.lastError) rows.push(kv('last error', l.lastError));
    }
    const other = l.direction === 'down' ? l.from : l.to;
    return `
      <div style="border:1px solid ${colour};border-radius:8px;padding:10px;min-width:260px;flex:1">
        <div style="font-size:12px;margin-bottom:6px"><strong>${esc(l.direction === 'down' ? 'reports to this server' : 'this server reports to')}</strong> · ${esc(short(other))}</div>
        ${rows.join('')}
        ${l.direction === 'down' && l.state !== 'revoked' ? `<button class="btn btn-secondary btn-sm" style="margin-top:8px" data-disconnect="${esc(other)}">Disconnect</button>` : ''}
      </div>`;
  };
  const sc = n.screens;
  const screens = sc ? `<p style="font-size:12px;margin:6px 0">Screens: <strong>${sc.online ?? 0}</strong> online of <strong>${sc.total ?? 0}</strong>${sc.stale ? `, ${sc.stale} stale` : ''}${sc.attachedHere ? `, ${sc.attachedHere} attached here` : ''}${sc.attachedElsewhere ? `, ${sc.attachedElsewhere} attached to a replica` : ''}${(sc.total || 0) > DEVICE_LIST_MAX ? ` — <a href="#/servers">fleet view</a> for the list` : (sc.total ? ` — <a href="#/devices">displays</a>` : '')}</p>` : '';
  return `
    <h3 style="margin-top:0">${esc(n.name || short(n.id))} <span style="color:var(--text-muted);font-size:12px;font-weight:normal">${esc(n.id)}</span></h3>
    ${screens}
    <div style="display:flex;gap:12px;flex-wrap:wrap">${links.map(linkCard).join('') || '<span style="color:var(--text-muted);font-size:12px">No direct link — reached through another server.</span>'}</div>`;
}

function wireDetail(body, data) {
  body.querySelectorAll('[data-disconnect]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nodeId = btn.dataset.disconnect;
      // The same consent copy as Servers → Topology → Disconnect: what stays, what goes, what stops.
      if (!window.confirm('Disconnect this server?\n\nIt stops reporting here and stops being served ' +
        'from here. Copied workspaces are kept read-only and no longer updated; media files cached ' +
        'for it are removed; screens already attached keep playing what they have and no new screen ' +
        'is accepted for those workspaces. The other server sees the link refused at its next connection.')) return;
      try {
        const r = await api.delete(`/mesh/links/${encodeURIComponent(nodeId)}`);
        showToast(r.summary || 'Disconnected.', 'success');
        await tick();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });
}
