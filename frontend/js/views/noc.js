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
// Screens in the drawer are capped SERVER-side at 50 rows (stale first) with an "and N more"
// pointing at the Displays list — never one DOM node per screen for a big node.

let timer = null;
let active = false;
let host = null;
let last = null;          // previous sample, for pulses
let selected = null;      // node id
let selectedData = null;  // the selected node's screens + alerts; re-asked on the tick for THAT node only
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
  host = null; last = null; selected = null; selectedData = null; pulses.clear();
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
  // The drawer ages with the graph: while a node is selected, its screen table is re-asked on the
  // same tick — ONE extra bounded query for the one selected node, never for every node. Otherwise
  // "seen 3h" would sit frozen under a link that pulses, which is the one lie this page could tell.
  if (selected) await loadSelected(selected);
  draw(data);
}

/*
 * A link ticks when its APPLIED REVISION or its OUTBOX DEPTH changed between polls — the two
 * numbers that mean rows or events actually crossed it. Not last_sync_at (a heartbeat on an idle
 * link), not a cache counter (bytes, not the link).
 */
function detectMovement(data) {
  if (!last) return;
  const prev = new Map(last.links.map((l) => [l.edgeId, l]));
  for (const l of data.links) {
    const p = prev.get(l.edgeId);
    if (!p) continue;
    const rev = (x) => (x.direction === 'down' ? x.lastAppliedRev : x.ackedRev);
    const depth = (x) => (x.players ? x.players.pending : (x.movement && x.movement.buffered) || 0);
    if (rev(l) !== rev(p) || depth(l) !== depth(p)) pulses.set(l.edgeId, Date.now() + POLL_MS);
  }
}

/** The selected node's screens and alerts: one bounded request, on selection and on each tick while selected. */
async function loadSelected(nodeId) {
  if (!nodeId) { selectedData = null; return; }
  try {
    const r = await api.get(`/mesh/noc?node=${encodeURIComponent(nodeId)}`);
    selectedData = r.selected || null;
  } catch (e) { selectedData = { id: nodeId, error: e.message, screens: [], alerts: [], more: 0 }; }
}

/* ------------------------------ layout + draw ------------------------------ */

const STATE_COLOUR = { connected: '#22c55e', lagging: '#f59e0b', down: '#ef4444', revoked: '#6b7280', unknown: '#6b7280' };
const roleLabel = (r) => ({ 'serves-dashboard': 'dashboard', 'terminates-players': 'players', 'caches-content': 'cache',
                            'relays-for-subtree': 'relay', 'redistributes-content': 'redistributes' }[r] || r);
/** What a node IS in this graph, one word: primary / replica / hub / relay. Two servers with the same hostname must not look alike. */
function roleOf(n, kind, data) {
  if (kind === 'self') return (n.roles || []).includes('replica') ? 'replica' : (n.roles || []).includes('primary') ? 'primary' : (n.roles || [])[0] || 'server';
  if (kind === 'parent') return (n.roles || []).includes('serves-dashboard') ? 'replica' : 'hub';
  if (kind === 'child') return (n.grant || []).includes('workspace-replication') ? 'primary' : 'site';
  return `${n.hops} hop(s)`;
}
const ageLabel = (sec) => (sec == null ? 'never' : sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86400)}d`);
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
  const W = Math.max(720, Math.max(parents.length, children.length, 1) * 230 + 80);
  const rows = 2 + (parents.length ? 1 : 0) + (indirect.length ? 1 : 0);
  const H = 140 * rows + 40;
  const pos = new Map();
  let y = 70;
  const place = (list, yy) => list.forEach((n, i) => pos.set(n.id, { x: 40 + (W - 80) * ((i + 0.5) / list.length), y: yy }));
  if (parents.length) { place(parents, y); y += 140; }
  pos.set(data.self.id, { x: W / 2, y }); y += 140;
  place(children, y); y += 140;
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
        <text x="10" y="20" fill="var(--text,#e5e7eb)" font-size="13" font-weight="600">${esc((n.name || short(n.id)).slice(0, 16))} <tspan fill="var(--text-muted,#9ca3af)" font-weight="400" font-size="11">${esc(short(n.id))} · ${esc(roleOf(n, kind, data))}${kind === 'self' ? ' · this server' : ''}</tspan></text>
        <text x="10" y="36" fill="var(--text-muted,#9ca3af)" font-size="11">${esc(roles.map(roleLabel).join(' · ') || (kind === 'indirect' ? 'reached through a child' : ''))}</text>
        <text x="10" y="50" fill="var(--text-muted,#9ca3af)" font-size="11">${esc(line2)}</text>
      </g>`;
  };
  const edgeLine = (l) => {
    const a = pos.get(l.from), b = pos.get(l.to); if (!a || !b) return '';
    const colour = STATE_COLOUR[l.state] || STATE_COLOUR.unknown;
    const pulsing = (pulses.get(l.edgeId) || 0) > Date.now();
    // "copy lag" = age of the last APPLIED change-log revision on this replica; it is unknown (not
    // zero) when the link is down. The state word is separate so a healthy-looking number can never
    // stand in for a dead link.
    const label = l.direction === 'down'
      ? `${l.state} · copy lag ${l.state === 'down' || l.lag_s == null ? '?' : `${l.lag_s}s`}${l.players ? ` · outbox ${l.players.pending}` : ''}`
      : `${l.state}${l.ackedRev != null && l.headRev != null ? ` · acked ${l.ackedRev}/${l.headRev}` : ''}`;
    // The caption sits near the LOWER end of the line (the child's box), where nine fan-in links
    // are spread apart; at the midpoint they all cross the same few pixels.
    const lower = a.y > b.y ? a : b, upper = a.y > b.y ? b : a;
    const tx = upper.x + (lower.x - upper.x) * 0.82, ty = upper.y + 28 + ((lower.y - 28) - (upper.y + 28)) * 0.82;
    return `
      <g class="noc-edge${pulsing ? ' noc-pulse' : ''}" data-edge="${esc(l.edgeId)}">
        <line x1="${a.x}" y1="${a.y + 28}" x2="${b.x}" y2="${b.y - 28}" stroke="${colour}" stroke-width="${pulsing ? 4 : 2}" ${l.state === 'revoked' ? 'stroke-dasharray="6 4"' : ''}/>
        <text x="${tx}" y="${ty - 4}" fill="${colour}" font-size="10" text-anchor="middle">${esc(label)}</text>
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

  body.querySelectorAll('.noc-node').forEach((g) => g.addEventListener('click', async () => {
    if (selected !== g.dataset.node) { selected = g.dataset.node; selectedData = null; draw(data); await loadSelected(selected); }
    draw(last || data);
  }));
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
      rows.push(kv('copy lag (age of last applied change)', l.state === 'down' || l.lag_s == null ? 'unknown' : `${l.lag_s} s`));
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
  const counts = sc ? `<p style="font-size:12px;margin:6px 0">Screens: <strong>${sc.online ?? 0}</strong> online of <strong>${sc.total ?? 0}</strong>${sc.stale ? `, ${sc.stale} stale` : ''}${sc.attachedHere ? `, ${sc.attachedHere} attached here` : ''}${sc.attachedElsewhere ? `, ${sc.attachedElsewhere} attached to a replica` : ''}</p>` : '';
  const sd = selectedData && selectedData.id === n.id ? selectedData : null;
  const TDS = 'padding:4px 8px;border-bottom:1px solid var(--border);font-size:12px;text-align:left';
  const screenRows = sd && sd.screens.length ? `
    <table style="width:100%;border-collapse:collapse;margin-top:6px">
      <thead><tr>
        <th style="${TDS}">Screen</th><th style="${TDS}">Status</th><th style="${TDS}">Seen</th><th style="${TDS}">Attached</th><th style="${TDS}">Playlist</th>
      </tr></thead>
      <tbody>${sd.screens.map((d) => `
        <tr>
          <td style="${TDS}">${esc(d.name)}</td>
          <td style="${TDS};color:${d.status === 'online' ? '#22c55e' : '#ef4444'}">${esc(d.status)}</td>
          <td style="${TDS}" title="seconds since the last heartbeat or device summary">${esc(ageLabel(d.seen_s))}</td>
          <td style="${TDS}">${esc(d.attached === 'here' ? 'here' : d.attached === 'primary' ? 'primary' : short(d.attached))}</td>
          <td style="${TDS};color:var(--text-muted)">${esc(d.playlist || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${sd.more ? `<p style="font-size:12px;color:var(--text-muted);margin:6px 0">…and ${sd.more} more — <a href="#/devices">the Displays list</a>.</p>` : ''}
    <p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">Stale first. As of ${new Date(sd.asOf * 1000).toLocaleTimeString()}; refreshes with the graph while this server is selected.</p>`
    : (sd ? `<p style="font-size:12px;color:var(--text-muted)">${sd.error ? esc(sd.error) : 'No screens on this node.'}</p>` : '<p style="font-size:12px;color:var(--text-muted)">Loading screens…</p>');
  const alertRows = sd && sd.alerts && sd.alerts.length ? `
    <h4 style="margin:12px 0 4px;font-size:13px">Last alerts</h4>
    <ul style="font-size:12px;margin:0;padding-left:18px">${sd.alerts.map((a) => `<li>${esc(a.metric)} <span style="color:var(--text-muted)">(${esc(a.severity || '')}${a.device ? `, ${esc(a.device)}` : ''}) ${esc(ageLabel(Math.max(0, Math.floor(Date.now() / 1000) - (a.opened_at || 0))))} ago${a.closed_at ? ', closed' : ''}</span></li>`).join('')}</ul>` : '';
  return `
    <h3 style="margin-top:0">${esc(n.name || short(n.id))} <span style="color:var(--text-muted);font-size:12px;font-weight:normal">${esc(n.id)} · ${esc(n === data.self && (n.roles || []).length ? n.roles.join(' · ') : roleOf(n, n === data.self ? 'self' : n.kind, data))}</span></h3>
    ${counts}
    ${screenRows}
    ${alertRows}
    <h4 style="margin:12px 0 4px;font-size:13px">Links</h4>
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
