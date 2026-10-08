import { api, getAuthHeaders } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * Social feeds (server: routes/social.js, lib/social/*). A feed collects posts from up to 10
 * sources; a Social wall widget shows one. This page creates feeds and is the moderation queue.
 *
 * Post text and names come from strangers on the internet: they are esc()'d here like everything
 * else, and images come from this server's cache (fetched with the session, shown as blob URLs).
 */

const NETWORK_LABELS = {
  instagram: () => t('social.kind_instagram'), facebook: () => t('social.kind_facebook'), youtube: () => t('social.kind_youtube'),
  x: () => t('social.kind_x'), bluesky: () => t('social.kind_bluesky'), mastodon: () => t('social.kind_mastodon'),
};
const KIND_LABELS = {
  own: () => t('social.src_own'), hashtag: () => t('social.src_hashtag'), page: () => t('social.src_page'), channel: () => t('social.src_channel'),
  playlist: () => t('social.src_playlist'), account: () => t('social.src_account'), search: () => t('social.src_search'),
};
const VALUE_PH = {
  'instagram:hashtag': 'coffee', 'facebook:page': '', 'youtube:channel': '@YourChannel', 'youtube:playlist': 'PL…',
  'x:account': 'yourbrand', 'x:search': '#yourevent', 'bluesky:account': 'yourbrand.bsky.social', 'bluesky:search': '#yourevent',
  'mastodon:account': 'yourbrand', 'mastodon:hashtag': 'yourevent',
};
const NEEDS_CONN = ['instagram', 'facebook', 'youtube', 'x'];

let state = { feeds: [], connections: [], kinds: {}, canEdit: false, open: null, tab: 'pending', blobs: [] };

function releaseBlobs() { state.blobs.forEach((u) => URL.revokeObjectURL(u)); state.blobs = []; }

export function cleanup() { releaseBlobs(); }

export async function render(app) {
  releaseBlobs();
  app.innerHTML = `<div class="view"><h1>${esc(t('nav.social'))}</h1><p class="muted">${esc(t('social.intro'))}</p><div id="socBody"></div></div>`;
  const body = document.getElementById('socBody');
  try {
    const [f, c] = await Promise.all([api.get('/social/feeds'), api.get('/social/connections')]);
    state.feeds = f.feeds || []; state.kinds = f.networks || {}; state.canEdit = !!f.can_edit; state.connections = c.connections || [];
  } catch (e) { body.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  body.innerHTML = `${state.canEdit ? `<div class="toolbar"><button class="btn btn-primary" id="socNew">${esc(t('social.new_feed'))}</button></div>` : ''}
    ${state.feeds.length ? state.feeds.map(feedCard).join('') : `<p class="muted">${esc(t('social.no_feeds'))}</p>`}`;
  document.getElementById('socNew')?.addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('[data-feed]').forEach((el) => {
    const feed = state.feeds.find((x) => x.id === el.dataset.feed);
    el.querySelector('[data-act="edit"]')?.addEventListener('click', () => openForm(app, feed));
    el.querySelector('[data-act="refresh"]')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      // The fetch answers 200 even when a source failed (the others' posts still count), with the
      // failures in `errors`. Those are named in the toast and stay on the card (last_error, redrawn
      // by render()), so the success toast is only for a clean fetch.
      try {
        const r = await api.post(`/social/feeds/${feed.id}/refresh`, {});
        const errs = Array.isArray(r.errors) ? r.errors : [];
        if (errs.length) {
          const list = errs.map((e) => `${NETWORK_LABELS[e.network] ? NETWORK_LABELS[e.network]() : e.network}${e.value ? ` (${e.value})` : ''}: ${e.error}`).join('; ');
          showToast(t('social.refresh_errors', { n: r.added || 0, errors: list }), 'error', 10000);
        } else showToast(t('social.refreshed', { n: r.added || 0 }), 'success');
        render(app);
      }
      catch (e) { showToast(e.message, 'error'); ev.target.disabled = false; }
    });
    el.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      if (!confirm(t('social.confirm_delete_feed'))) return;
      try { await api.delete(`/social/feeds/${feed.id}`); }
      catch (e) {
        if (e.status !== 409 || !confirm(e.message)) { if (e.status !== 409) showToast(e.message, 'error'); return; }
        try { await api.delete(`/social/feeds/${feed.id}?force=1`); } catch (e2) { showToast(e2.message, 'error'); return; }
      }
      render(app);
    });
    el.querySelector('[data-act="queue"]')?.addEventListener('click', () => {
      state.open = state.open === feed.id ? null : feed.id;
      state.tab = feed.counts.pending ? 'pending' : 'approved';
      render(app);
    });
    if (state.open === feed.id) loadQueue(app, feed, el.querySelector('.soc-queue'));
  });
}

function sourceLine(s) {
  const net = NETWORK_LABELS[s.network] ? NETWORK_LABELS[s.network]() : s.network;
  const kind = KIND_LABELS[s.kind] ? KIND_LABELS[s.kind]() : s.kind;
  return `${net} · ${kind}${s.value ? ` · ${s.value}` : ''}${s.instance ? ` @ ${s.instance}` : ''}`;
}

function feedCard(f) {
  const errs = Array.isArray(f.last_error) ? f.last_error : [];
  return `<div class="card" data-feed="${esc(f.id)}" style="margin-bottom:12px;padding:16px">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${esc(f.name)}</strong>
          <span class="muted" style="font-size:12px">${esc(f.moderation === 'approve' ? t('social.mode_approve') : t('social.mode_auto'))}</span>
          ${f.enabled ? '' : `<span class="muted" style="font-size:12px">${esc(t('social.off'))}</span>`}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">${f.sources.map((s) => esc(sourceLine(s))).join('<br>')}</div>
        <div style="font-size:13px;margin-top:6px">${esc(tn('social.n_shown', f.counts.approved))}${f.counts.pending ? ` · <strong>${esc(tn('social.n_pending', f.counts.pending))}</strong>` : ''}${f.counts.hidden ? ` · ${esc(tn('social.n_hidden', f.counts.hidden))}` : ''}
          ${f.last_fetch_at ? `<span class="muted"> · ${esc(t('social.fetched', { time: new Date(f.last_fetch_at * 1000).toLocaleTimeString() }))}</span>` : ''}</div>
        ${errs.map((e) => `<div style="font-size:12px;color:var(--danger,#b91c1c);margin-top:2px;overflow-wrap:anywhere">${esc(NETWORK_LABELS[e.network] ? NETWORK_LABELS[e.network]() : e.network)}${e.value ? ` (${esc(e.value)})` : ''}: ${esc(e.error)}</div>`).join('')}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start">
        <button class="btn btn-secondary btn-sm" data-act="queue">${esc(t('social.posts'))}</button>
        ${state.canEdit ? `<button class="btn btn-secondary btn-sm" data-act="refresh">${esc(t('social.refresh'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" data-act="del" style="color:var(--danger)">${esc(t('common.delete'))}</button>` : ''}
      </div>
    </div>
    ${state.open === f.id ? '<div class="soc-queue" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px"></div>' : ''}
  </div>`;
}

async function imageUrl(hash) {
  try {
    const r = await fetch(`/api/social/media/${encodeURIComponent(hash)}`, { headers: getAuthHeaders() });
    if (!r.ok) return null;
    const u = URL.createObjectURL(await r.blob());
    state.blobs.push(u);
    return u;
  } catch { return null; }
}

async function loadQueue(app, feed, box) {
  if (!box) return;
  const tabs = ['pending', 'approved', 'hidden'];
  const tabLabel = { pending: t('social.tab_pending'), approved: t('social.tab_approved'), hidden: t('social.tab_hidden') };
  box.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${tabs.map((k) =>
    `<button class="btn btn-sm ${state.tab === k ? 'btn-primary' : 'btn-secondary'}" data-tab="${k}">${esc(tabLabel[k])} (${feed.counts[k] || 0})</button>`).join('')}</div>
    <div class="soc-posts muted" style="font-size:13px">${esc(t('social.loading'))}</div>`;
  box.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; loadQueue(app, feed, box); }));
  let posts = [];
  try { posts = (await api.get(`/social/feeds/${feed.id}/posts?status=${state.tab}`)).posts || []; }
  catch (e) { box.querySelector('.soc-posts').textContent = e.message; return; }
  const list = box.querySelector('.soc-posts');
  list.classList.remove('muted');
  if (!posts.length) { list.innerHTML = `<p class="muted">${esc(t('social.queue_empty'))}</p>`; return; }
  list.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px';
  list.innerHTML = posts.map((p) => `<div data-key="${esc(p.key)}" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column;min-width:0">
      ${p.media.length ? `<div style="aspect-ratio:16/10;background:#000"><img data-hash="${esc(p.media[0])}" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></div>` : ''}
      <div style="padding:8px;font-size:12px;flex:1;min-width:0">
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.author_name || p.author_handle || '')} <span class="muted">· ${esc(NETWORK_LABELS[p.network] ? NETWORK_LABELS[p.network]() : p.network)}</span></div>
        <div style="margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:7.5em;overflow:hidden">${esc(p.text || (p.hidden_reason === 'blocklist' ? t('social.blocked_text') : ''))}</div>
        <div class="muted" style="margin-top:4px">${esc(new Date(p.posted_at * 1000).toLocaleString())}${p.permalink ? ` · <a href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer">${esc(t('social.open_post'))}</a>` : ''}</div>
      </div>
      ${state.canEdit ? `<div style="display:flex;gap:6px;padding:8px;border-top:1px solid var(--border)">
        ${p.status !== 'approved' ? `<button class="btn btn-primary btn-sm" data-mod="${p.status === 'hidden' ? 'unhide' : 'approve'}">${esc(p.status === 'hidden' ? t('social.unhide') : t('social.approve'))}</button>` : ''}
        ${p.status !== 'hidden' ? `<button class="btn btn-secondary btn-sm" data-mod="hide">${esc(t('social.hide'))}</button>` : ''}
      </div>` : ''}
    </div>`).join('');
  list.querySelectorAll('img[data-hash]').forEach(async (img) => { const u = await imageUrl(img.dataset.hash); if (u) img.src = u; });
  list.querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.closest('[data-key]').dataset.key;
    try {
      const r = await api.post(`/social/feeds/${feed.id}/posts/moderate`, { key, action: b.dataset.mod });
      if (r.refetch) showToast(t('social.refetch_note'), 'info');
      render(app);
    } catch (e) { showToast(e.message, 'error'); }
  }));
}

function sourceRow(s, i) {
  const net = s.network || 'bluesky';
  const kinds = state.kinds[net] || [];
  const conns = state.connections.filter((c) => c.kind === net);
  const showValue = !(net === 'instagram' && s.kind === 'own');
  return `<div data-src="${i}" style="border:1px solid var(--border);border-radius:var(--radius);padding:10px;display:grid;gap:8px">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      <select class="input" data-s="network">${Object.keys(NETWORK_LABELS).map((k) => `<option value="${k}" ${k === net ? 'selected' : ''}>${esc(NETWORK_LABELS[k]())}</option>`).join('')}</select>
      <select class="input" data-s="kind">${kinds.map((k) => `<option value="${k}" ${k === s.kind ? 'selected' : ''}>${esc(KIND_LABELS[k] ? KIND_LABELS[k]() : k)}</option>`).join('')}</select>
      ${NEEDS_CONN.includes(net) ? `<select class="input" data-s="connection_id">${conns.length ? conns.map((c) => `<option value="${esc(c.id)}" ${c.id === s.connection_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('') : `<option value="">${esc(t('social.no_connection'))}</option>`}</select>` : ''}
      ${net === 'mastodon' ? `<input class="input" data-s="instance" value="${esc(s.instance || '')}" placeholder="mastodon.social">` : ''}
    </div>
    <div style="display:flex;gap:8px">
      ${showValue ? `<input class="input" data-s="value" style="flex:1;min-width:0" value="${esc(s.value || '')}" placeholder="${esc(VALUE_PH[`${net}:${s.kind || kinds[0]}`] || '')}">` : `<div class="muted" style="flex:1;font-size:12px;align-self:center">${esc(t('social.own_posts_hint'))}</div>`}
      <button class="btn btn-secondary btn-sm" data-s="remove" title="${esc(t('common.delete'))}">✕</button>
    </div>
    ${NEEDS_CONN.includes(net) && !conns.length ? `<div style="font-size:12px;color:var(--warning,#b45309)">${esc(t('social.needs_connection'))}</div>` : ''}
  </div>`;
}

function openForm(app, f) {
  let sources = f ? f.sources.map((s) => ({ ...s })) : [{ network: 'bluesky', kind: 'account', value: '' }];
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  overlay.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:640px;max-width:100%;max-height:92vh;overflow:auto">
    <h3 style="margin-bottom:12px">${esc(f ? t('social.edit_feed') : t('social.new_feed'))}</h3>
    <div class="form-group"><label>${esc(t('social.f_name'))}</label><input id="sfName" class="input" value="${esc(f ? f.name : '')}" placeholder="${esc(t('social.f_name_ph'))}"></div>
    <label style="display:block;font-size:13px;font-weight:600;margin:6px 0">${esc(t('social.f_sources'))}</label>
    <div id="sfSources" style="display:grid;gap:8px"></div>
    <button class="btn btn-secondary btn-sm" id="sfAdd" style="margin-top:8px">${esc(t('social.add_source'))}</button>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px">
      <div class="form-group"><label>${esc(t('social.f_moderation'))}</label><select id="sfMode" class="input">
        <option value="auto" ${!f || f.moderation === 'auto' ? 'selected' : ''}>${esc(t('social.mode_auto'))}</option>
        <option value="approve" ${f && f.moderation === 'approve' ? 'selected' : ''}>${esc(t('social.mode_approve'))}</option></select></div>
      <div class="form-group"><label>${esc(t('social.f_max_posts'))}</label><input id="sfMax" type="number" min="1" max="50" class="input" value="${esc(f ? f.max_posts : 20)}"></div>
      <div class="form-group"><label>${esc(t('social.f_max_age'))}</label><input id="sfAge" type="number" min="0" max="3650" class="input" value="${esc(f ? f.max_age_days : 0)}"></div>
      <div class="form-group"><label>${esc(t('social.f_refresh'))}</label><input id="sfRefresh" type="number" min="5" max="1440" class="input" value="${esc(f ? f.refresh_min : 10)}"></div>
    </div>
    <div class="form-group"><label>${esc(t('social.f_blocklist'))}</label><textarea id="sfBlock" class="input" rows="2" placeholder="${esc(t('social.f_blocklist_ph'))}">${esc(f ? f.blocklist.join(', ') : '')}</textarea></div>
    <label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="sfMedia" ${f && f.require_media ? 'checked' : ''}> ${esc(t('social.f_require_media'))}</label>
    ${f ? `<label style="display:flex;gap:8px;font-size:13px;margin-top:6px"><input type="checkbox" id="sfEnabled" ${f.enabled ? 'checked' : ''}> ${esc(t('social.f_enabled'))}</label>` : ''}
    <div id="sfError" style="color:var(--danger);font-size:13px;min-height:18px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-secondary" id="sfCancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn-primary" id="sfSave">${esc(t('common.save'))}</button></div></div>`;
  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector('#' + id);
  const box = $('sfSources');
  function readSources() {
    box.querySelectorAll('[data-src]').forEach((row) => {
      const s = sources[Number(row.dataset.src)];
      row.querySelectorAll('[data-s]').forEach((el) => { if (el.tagName !== 'BUTTON') s[el.dataset.s] = el.value.trim(); });
    });
  }
  function drawSources() {
    box.innerHTML = sources.map(sourceRow).join('');
    box.querySelectorAll('[data-src]').forEach((row) => {
      const i = Number(row.dataset.src);
      row.querySelector('[data-s="network"]').addEventListener('change', (e) => {
        readSources();
        const net = e.target.value;
        const conn = state.connections.find((c) => c.kind === net);
        sources[i] = { network: net, kind: (state.kinds[net] || [])[0], value: '', connection_id: conn ? conn.id : undefined };
        drawSources();
      });
      row.querySelector('[data-s="kind"]').addEventListener('change', () => { readSources(); drawSources(); });
      row.querySelector('[data-s="remove"]').addEventListener('click', () => { readSources(); sources.splice(i, 1); drawSources(); });
    });
  }
  drawSources();
  $('sfAdd').addEventListener('click', () => { readSources(); if (sources.length < 10) sources.push({ network: 'bluesky', kind: 'account', value: '' }); drawSources(); });
  $('sfCancel').addEventListener('click', () => overlay.remove());
  $('sfSave').addEventListener('click', async () => {
    readSources();
    const body = {
      name: $('sfName').value.trim(), sources, moderation: $('sfMode').value, max_posts: Number($('sfMax').value),
      max_age_days: Number($('sfAge').value), refresh_min: Number($('sfRefresh').value), blocklist: $('sfBlock').value, require_media: $('sfMedia').checked,
    };
    if ($('sfEnabled')) body.enabled = $('sfEnabled').checked;
    try {
      if (f) await api.put(`/social/feeds/${f.id}`, body); else await api.post('/social/feeds', body);
      overlay.remove(); render(app);
    } catch (e) { $('sfError').textContent = e.message; }
  });
}
