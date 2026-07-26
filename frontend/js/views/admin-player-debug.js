// Admin view for the player_debug_logs telemetry sink. Platform-admin only.
// Mounted at #/admin/player-debug. Reads from /api/player-debug/list,
// /api/player-debug/summary, /api/player-debug/older-than (DELETE).
//
// Server-side pagination - we never render all 10k rows at once. Page param
// in the URL hash so refresh preserves position.
//
// IMPORTANT: device_id is whatever the player POSTed. The submitter is
// unauthenticated by design (so unpaired players can also send), which means
// device_id is self-reported, NOT server-verified. Surfaced via column label
// "device_id (self-reported)" and the help-text caption below the filters.

import { isPlatformAdmin } from '../utils.js';
import { showToast } from '../components/toast.js';

const headers = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });
const API = (url, opts = {}) => fetch('/api' + url, { headers: headers(), ...opts });

// Parse a query string from a hash like '#/admin/player-debug?page=2&ua=Tizen'.
// Returns a plain object - no URLSearchParams since the hash format isn't
// a standard URL.
function parseHashParams() {
  const h = window.location.hash || '';
  const qi = h.indexOf('?');
  if (qi < 0) return {};
  const out = {};
  const qs = h.substring(qi + 1);
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq >= 0 ? part.substring(0, eq) : part;
    const v = eq >= 0 ? part.substring(eq + 1) : '';
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function setHashParams(updates) {
  const base = '#/admin/player-debug';
  const merged = { ...parseHashParams(), ...updates };
  // Strip empty values so the URL stays tidy
  const pairs = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v == null || v === '') continue;
    pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  // Replace, don't push - we don't want every filter keystroke in browser history
  history.replaceState(null, '', pairs.length ? base + '?' + pairs.join('&') : base);
}

// Pretty-print JSON for the expanded-row display. Returns the original string
// if parsing fails so we don't lose data when the field isn't JSON-shaped.
function prettyJson(s) {
  if (s == null || s === '') return '(empty)';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return String(s);
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(unixSec) {
  if (!unixSec) return '';
  try { return new Date(unixSec * 1000).toLocaleString(); } catch { return String(unixSec); }
}

function uaShort(ua) {
  if (!ua) return '';
  // Keep just the part most useful for at-a-glance scanning. Full UA in the
  // expanded row.
  return ua.length > 60 ? ua.substring(0, 60) + '...' : ua;
}

export async function render(container) {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  if (!isPlatformAdmin(user)) {
    container.innerHTML = '<div class="empty-state"><h3>Access denied</h3><p>Platform-admin role required.</p></div>';
    return;
  }

  const params = parseHashParams();
  const currentPage = parseInt(params.page) || 1;
  const currentUa = params.ua || '';
  const currentSince = params.since || '';
  const currentUntil = params.until || '';
  const currentHasError = params.has_error === '1';

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Player Debug Logs</h1>
        <div class="subtitle">Captured errors and state from player clients. Mostly smart TVs we can't reach with devtools.</div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Summary</h3>
      <div id="pdSummary" style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary)">Loading...</div>
    </div>

    <div class="settings-section">
      <h3>Filters</h3>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">User agent contains</label>
          <input class="input" id="pdFilterUa" value="${esc(currentUa)}" placeholder="Tizen, WebOS, AFTS..." style="width:220px">
        </div>
        <div>
          <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Since (YYYY-MM-DD)</label>
          <input class="input" id="pdFilterSince" value="${esc(currentSince)}" placeholder="2026-05-01" style="width:140px">
        </div>
        <div>
          <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Until (YYYY-MM-DD)</label>
          <input class="input" id="pdFilterUntil" value="${esc(currentUntil)}" placeholder="2026-05-31" style="width:140px">
        </div>
        <div>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
            <input type="checkbox" id="pdFilterHasError" ${currentHasError ? 'checked' : ''}> Has error data
          </label>
        </div>
        <button class="btn btn-primary btn-sm" id="pdApplyFilters">Apply</button>
        <button class="btn btn-secondary btn-sm" id="pdClearFilters">Clear</button>
        <div style="flex:1"></div>
        <button class="btn btn-danger btn-sm" id="pdDeleteOld">Delete older than 30 days</button>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:10px">
        Note: <code>device_id</code> is self-reported by the player and is not server-verified. The submission endpoint is unauthenticated by design so unpaired players can also report errors.
      </div>
    </div>

    <div class="settings-section">
      <h3>Logs <span id="pdRowMeta" style="font-size:13px;color:var(--text-muted);font-weight:400"></span></h3>
      <div id="pdList"><p style="color:var(--text-muted)">Loading...</p></div>
      <div id="pdPagination" style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:14px"></div>
    </div>
  `;

  // ---- handlers ----
  document.getElementById('pdApplyFilters').onclick = () => {
    const ua = document.getElementById('pdFilterUa').value.trim();
    const since = document.getElementById('pdFilterSince').value.trim();
    const until = document.getElementById('pdFilterUntil').value.trim();
    const hasError = document.getElementById('pdFilterHasError').checked ? '1' : '';
    setHashParams({ page: 1, ua, since, until, has_error: hasError });
    loadList();
  };
  document.getElementById('pdClearFilters').onclick = () => {
    document.getElementById('pdFilterUa').value = '';
    document.getElementById('pdFilterSince').value = '';
    document.getElementById('pdFilterUntil').value = '';
    document.getElementById('pdFilterHasError').checked = false;
    setHashParams({ page: 1, ua: '', since: '', until: '', has_error: '' });
    loadList();
  };
  document.getElementById('pdDeleteOld').onclick = async () => {
    if (!confirm('Delete all logs older than 30 days? This cannot be undone.')) return;
    try {
      const res = await API('/player-debug/older-than?days=30', { method: 'DELETE' });
      const data = await res.json();
      showToast(`Deleted ${data.deleted} log${data.deleted === 1 ? '' : 's'} older than 30 days`, 'success');
      loadSummary();
      loadList();
    } catch (err) {
      showToast('Delete failed: ' + (err.message || err), 'error');
    }
  };

  loadSummary();
  loadList();
}

async function loadSummary() {
  const el = document.getElementById('pdSummary');
  if (!el) return;
  try {
    const res = await API('/player-debug/summary');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const families = [
      ['Tizen', data.byFamily.tizen, '#e65c00'],
      ['WebOS', data.byFamily.webos, '#a3e635'],
      ['Fire TV', data.byFamily.fire_tv, '#f97316'],
      ['Bravia', data.byFamily.bravia, '#a855f7'],
      ['Edge', data.byFamily.edge, '#06b6d4'],
      ['Chrome', data.byFamily.chrome, '#fbbf24'],
      ['Firefox', data.byFamily.firefox, '#ef4444'],
      ['Safari', data.byFamily.safari, '#64748b'],
      ['Other', data.byFamily.other, '#94a3b8'],
    ];
    el.innerHTML = `
      <div style="font-weight:600;color:var(--text-primary)">Total: ${data.total}</div>
      ${families.map(([name, count, color]) => `
        <div style="display:flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color}"></span>
          <span>${name}: <strong style="color:var(--text-primary)">${count}</strong></span>
        </div>
      `).join('')}
    `;
  } catch (err) {
    el.innerHTML = '<span style="color:var(--danger)">Failed to load summary: ' + esc(err.message || err) + '</span>';
  }
}

function ymdToUnix(s, endOfDay) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return '';
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return Math.floor(dt.getTime() / 1000);
}

async function loadList() {
  const el = document.getElementById('pdList');
  const meta = document.getElementById('pdRowMeta');
  const pag = document.getElementById('pdPagination');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text-muted)">Loading...</p>';

  const params = parseHashParams();
  const page = Math.max(1, parseInt(params.page) || 1);
  const limit = 50;
  const qs = new URLSearchParams();
  qs.set('page', page);
  qs.set('limit', limit);
  if (params.ua) qs.set('ua_contains', params.ua);
  const since = ymdToUnix(params.since, false);
  const until = ymdToUnix(params.until, true);
  if (since) qs.set('since', since);
  if (until) qs.set('until', until);
  if (params.has_error === '1') qs.set('has_error', '1');

  try {
    const res = await API('/player-debug/list?' + qs.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
    meta.textContent = `(${data.total} total, page ${data.page} of ${totalPages})`;

    if (data.rows.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:14px 0">No logs match the current filters.</p>';
    } else {
      el.innerHTML = `
        <div class="table-wrap">
          <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:960px">
            <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
              <th style="padding:8px;width:50px">ID</th>
              <th style="padding:8px;width:140px">Time</th>
              <th style="padding:8px;width:180px" title="Self-reported by the player; not server-verified.">device_id (self-reported)</th>
              <th style="padding:8px;width:130px">IP</th>
              <th style="padding:8px">User agent</th>
              <th style="padding:8px;width:130px">Fingerprint</th>
              <th style="padding:8px;width:80px"></th>
            </tr></thead>
            <tbody>
              ${data.rows.map(r => `
                <tr style="border-bottom:1px solid var(--border-light)" data-row-id="${r.id}">
                  <td style="padding:8px;font-family:monospace;color:var(--text-muted)">${r.id}</td>
                  <td style="padding:8px;font-size:12px">${esc(fmtTime(r.created_at))}</td>
                  <td style="padding:8px;font-family:monospace;font-size:11px;color:var(--text-secondary)">${esc(r.device_id || '(none)')}</td>
                  <td style="padding:8px;font-family:monospace;font-size:12px;color:var(--text-secondary)">${esc(r.ip || '')}</td>
                  <td style="padding:8px;font-size:12px;color:var(--text-secondary)">${esc(uaShort(r.user_agent))}</td>
                  <td style="padding:8px;font-family:monospace;font-size:11px;color:var(--text-muted)">${esc(r.error_fingerprint || '')}</td>
                  <td style="padding:8px;text-align:right">
                    <button class="btn btn-secondary btn-sm" data-expand="${r.id}" style="font-size:11px;padding:2px 8px">Expand</button>
                  </td>
                </tr>
                <tr style="display:none" data-expanded-for="${r.id}">
                  <td colspan="7" style="padding:12px 16px;background:var(--bg-input)">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                      <div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">URL</div>
                        <div style="font-family:monospace;font-size:11px;color:var(--text-secondary);word-break:break-all;margin-bottom:10px">${esc(r.url || '(none)')}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Full User Agent</div>
                        <div style="font-family:monospace;font-size:11px;color:var(--text-secondary);word-break:break-all;margin-bottom:10px">${esc(r.user_agent || '(none)')}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">error_data</div>
                        <pre style="margin:0;padding:8px;background:var(--bg-primary);border-radius:4px;font-family:monospace;font-size:11px;color:var(--text-secondary);overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-word">${esc(prettyJson(r.error_data))}</pre>
                      </div>
                      <div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">context</div>
                        <pre style="margin:0;padding:8px;background:var(--bg-primary);border-radius:4px;font-family:monospace;font-size:11px;color:var(--text-secondary);overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word">${esc(prettyJson(r.context))}</pre>
                      </div>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      el.querySelectorAll('button[data-expand]').forEach(btn => {
        btn.onclick = () => {
          const id = btn.getAttribute('data-expand');
          const exp = el.querySelector(`tr[data-expanded-for="${id}"]`);
          if (exp) {
            const visible = exp.style.display !== 'none';
            exp.style.display = visible ? 'none' : '';
            btn.textContent = visible ? 'Expand' : 'Collapse';
          }
        };
      });
    }

    // ---- pagination ----
    pag.innerHTML = '';
    if (totalPages > 1) {
      const prev = document.createElement('button');
      prev.className = 'btn btn-secondary btn-sm';
      prev.textContent = '< Prev';
      prev.disabled = page <= 1;
      prev.onclick = () => { setHashParams({ page: page - 1 }); loadList(); };
      pag.appendChild(prev);

      const indicator = document.createElement('span');
      indicator.style.cssText = 'padding:0 12px;font-size:13px;color:var(--text-muted)';
      indicator.textContent = `Page ${page} of ${totalPages}`;
      pag.appendChild(indicator);

      const next = document.createElement('button');
      next.className = 'btn btn-secondary btn-sm';
      next.textContent = 'Next >';
      next.disabled = page >= totalPages;
      next.onclick = () => { setHashParams({ page: page + 1 }); loadList(); };
      pag.appendChild(next);
    }
  } catch (err) {
    el.innerHTML = '<p style="color:var(--danger)">Failed to load: ' + esc(err.message || err) + '</p>';
  }
}
