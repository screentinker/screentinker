/*
 * Microsoft 365 (server/routes/m365.js, docs/cloud-documents.md).
 *
 *   mountM365Settings  Settings card: the organization's own Entra app (tenant, client ID, secret).
 *                      Org owners and admins only — the server answers can_manage:false to everyone
 *                      else and the card stays hidden.
 *   openCloudFolders   Content library: SharePoint/OneDrive folders synced into this workspace.
 *
 * ⚠️ THE SECRET IS WRITE-ONLY. The form sends it; nothing the server returns contains it. A save with
 * the secret field left empty keeps the stored one.
 *
 * Escaping follows the SPA rule: values are stored raw and esc()'d where they are rendered.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';

const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : 'never');

export async function mountM365Settings(host) {
  if (!host) return;
  let app;
  try { app = await api.get('/m365/app'); } catch (_) { host.style.display = 'none'; return; }
  if (!app.can_manage) { host.style.display = 'none'; return; }
  host.style.display = '';
  render();

  function render() {
    const status = !app.configured ? '<span style="color:var(--text-muted)">Not set up</span>'
      : app.last_test_ok === true ? `<span style="color:var(--success,#15803d)">Working — tested ${esc(when(app.last_test_at))}</span>`
      : app.last_test_ok === false ? `<span style="color:var(--danger,#b91c1c)">Test failed: ${esc(app.last_error || '')}</span>`
      : '<span style="color:var(--text-muted)">Saved, not tested yet</span>';
    host.innerHTML = `
      <h3>Microsoft 365</h3>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px">
        Connect your organization's own Microsoft Entra app to sync SharePoint and OneDrive folders into the content library.
        Register an app in your tenant, give it the <strong>Files.Read.All</strong> (or <strong>Sites.Selected</strong>) application permission with admin consent, and create a client secret.
        See docs/cloud-documents.md.</p>
      <div style="font-size:13px;margin-bottom:10px">${status}</div>
      <div style="display:grid;gap:10px;max-width:560px">
        <div class="form-group"><label>Directory (tenant) ID</label>
          <input type="text" class="input" data-m="tenant_id" value="${esc(app.tenant_id || '')}" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false"></div>
        <div class="form-group"><label>Application (client) ID</label>
          <input type="text" class="input" data-m="client_id" value="${esc(app.client_id || '')}" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false"></div>
        <div class="form-group"><label>Client secret value</label>
          <input type="password" class="input" data-m="client_secret" autocomplete="new-password" placeholder="${app.has_client_secret ? 'A secret is set — leave empty to keep it' : 'Paste the secret VALUE (not its ID)'}"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-m-act="save">Save</button>
          ${app.configured ? '<button class="btn btn-secondary btn-sm" data-m-act="test">Test connection</button><button class="btn btn-danger btn-sm" data-m-act="remove">Remove</button>' : ''}
        </div>
      </div>`;
    host.querySelector('[data-m-act="save"]').addEventListener('click', save);
    host.querySelector('[data-m-act="test"]')?.addEventListener('click', test);
    host.querySelector('[data-m-act="remove"]')?.addEventListener('click', remove);
  }

  const field = (k) => host.querySelector(`[data-m="${k}"]`)?.value.trim() || '';

  async function save() {
    const body = { tenant_id: field('tenant_id'), client_id: field('client_id') };
    const secret = host.querySelector('[data-m="client_secret"]').value;
    if (secret) body.client_secret = secret;
    try {
      app = await api.put('/m365/app', body);
      showToast('Microsoft 365 saved', 'success');
      render();
      await test();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function test() {
    try {
      const r = await api.post('/m365/app/test', {});
      showToast(r.ok ? 'Microsoft accepted the app credentials' : r.error, r.ok ? 'success' : 'error');
      app = await api.get('/m365/app');
      render();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function remove() {
    if (!confirm('Remove the Microsoft 365 app? Folder syncs stop until it is set up again. Files already synced stay in the library.')) return;
    try { await api.delete('/m365/app'); app = { configured: false, can_manage: true }; render(); showToast('Microsoft 365 removed', 'success'); }
    catch (err) { showToast(err.message, 'error'); }
  }
}

/* ============================== folder syncs ============================== */

function summaryLine(f) {
  const s = f.last_summary;
  if (!f.last_sync_at) return 'Waiting for the first sync…';
  if (f.last_status === 'error') return `Last sync failed: ${f.last_error || 'unknown error'}`;
  if (!s) return `Synced ${when(f.last_sync_at)}`;
  const bits = [];
  if (s.added) bits.push(`${s.added} added`);
  if (s.updated) bits.push(`${s.updated} updated`);
  if (s.removed) bits.push(`${s.removed} removed`);
  if (s.skipped_other) bits.push(`${s.skipped_other} not media (skipped)`);
  if (s.skipped_too_large) bits.push(`${s.skipped_too_large} too large`);
  if (s.failed) bits.push(`${s.failed} failed`);
  if (s.playlist === 'pending_review') bits.push('playlist waiting for review');
  return `Synced ${when(f.last_sync_at)}${bits.length ? ' — ' + bits.join(', ') : ' — no changes'}`;
}

/** The SharePoint/OneDrive folders panel, as a modal over the content library. `onChange` reloads the library. */
export async function openCloudFolders({ onChange } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';
  overlay.innerHTML = `<div class="modal" style="width:100%;max-width:760px;max-height:90vh;overflow:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0">SharePoint &amp; OneDrive folders</h3>
      <button class="btn btn-secondary btn-sm" data-cf="close">Close</button>
    </div>
    <p style="color:var(--text-muted);font-size:12px;margin:0 0 12px">Images, videos and audio in a folder are added to the library and kept up to date — changed files are replaced, removed files are taken out. PowerPoint, Word and Excel files are not synced: show them with a <strong>Cloud document</strong> widget and the file's Embed link.</p>
    <div data-cf="body">Loading…</div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-cf="close"]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const body = overlay.querySelector('[data-cf="body"]');

  let app = { configured: false };
  let list = [];
  async function load() {
    try {
      [app, list] = await Promise.all([api.get('/m365/app'), api.get('/m365/folders')]);
    } catch (err) { body.innerHTML = `<p style="color:var(--danger,#b91c1c)">${esc(err.message)}</p>`; return; }
    render();
  }

  function render() {
    const setup = app.configured ? '' : `<div style="padding:10px;border:1px dashed var(--border);border-radius:6px;margin-bottom:12px;font-size:13px">
      Microsoft 365 is not set up for your organization yet. ${app.can_manage ? 'Add your app in <strong>Settings → Microsoft 365</strong>.' : 'Ask an organization admin to add it in Settings → Microsoft 365.'}</div>`;
    const rows = list.map((f) => `
      <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start">
          <div style="min-width:0;flex:1">
            <strong>${esc(f.name)}</strong>${f.enabled ? '' : ' <span style="font-size:11px;color:var(--text-muted)">— paused</span>'}
            <div style="font-size:12px;color:var(--text-muted);word-break:break-all">${esc(f.web_url || f.share_url)}</div>
            <div style="font-size:12px;margin-top:4px;color:${f.last_status === 'error' ? 'var(--danger,#b91c1c)' : f.last_status === 'partial' ? 'var(--warning,#b45309)' : 'var(--text-secondary)'}">${esc(summaryLine(f))}</div>
            ${f.last_summary && f.last_summary.errors && f.last_summary.errors.length ? `<details style="font-size:12px;margin-top:4px"><summary>Details</summary>${f.last_summary.errors.map((e) => `<div>${esc(e)}</div>`).join('')}</details>` : ''}
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${f.file_count} file${f.file_count === 1 ? '' : 's'} · every ${f.interval_min} min${f.auto_playlist ? ' · keeps a playlist' : ''}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" data-cf-sync="${esc(f.id)}">Sync now</button>
            <button class="btn btn-secondary btn-sm" data-cf-toggle="${esc(f.id)}" data-on="${f.enabled ? 1 : 0}">${f.enabled ? 'Pause' : 'Resume'}</button>
            <button class="btn btn-danger btn-sm" data-cf-del="${esc(f.id)}">Stop syncing</button>
          </div>
        </div>
      </div>`).join('');
    body.innerHTML = `${setup}${rows || '<p style="color:var(--text-muted);font-size:13px">No folders yet.</p>'}
      ${app.configured ? `<details style="margin-top:12px" ${list.length ? '' : 'open'}><summary style="cursor:pointer;font-size:13px">Add a folder</summary>
        <div style="display:grid;gap:10px;margin-top:10px">
          <div class="form-group"><label>Folder sharing link</label>
            <input type="url" class="input" data-cf-f="share_url" placeholder="https://contoso.sharepoint.com/:f:/s/…" spellcheck="false">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">In SharePoint or OneDrive, select the folder → Share → Copy link. The app must have access to that site.</div></div>
          <div class="form-group"><label>Name (optional)</label><input type="text" class="input" data-cf-f="name" placeholder="The folder's own name"></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="form-group" style="flex:1;min-width:140px"><label>Sync every (minutes)</label><input type="number" class="input" data-cf-f="interval_min" min="5" max="1440" value="15"></div>
            <div class="form-group" style="flex:1;min-width:140px"><label>Seconds per image</label><input type="number" class="input" data-cf-f="default_duration_sec" min="1" value="10"></div>
          </div>
          <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" data-cf-f="auto_playlist" checked> Keep a playlist of the folder, in file-name order</label>
          <div><button class="btn btn-primary btn-sm" data-cf="add">Add folder</button></div>
        </div></details>` : ''}`;

    body.querySelector('[data-cf="add"]')?.addEventListener('click', add);
    body.querySelectorAll('[data-cf-sync]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Syncing…';
      try { await api.post(`/m365/folders/${b.dataset.cfSync}/sync`, {}); if (onChange) onChange(); }
      catch (err) { showToast(err.message, 'error'); }
      await load();
    }));
    body.querySelectorAll('[data-cf-toggle]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.put(`/m365/folders/${b.dataset.cfToggle}`, { enabled: b.dataset.on !== '1' }); } catch (err) { showToast(err.message, 'error'); }
      await load();
    }));
    body.querySelectorAll('[data-cf-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Stop syncing this folder? The files already in the library, and its playlist, are kept.')) return;
      try { await api.delete(`/m365/folders/${b.dataset.cfDel}`); } catch (err) { showToast(err.message, 'error'); }
      await load();
    }));
  }

  async function add() {
    const v = (k) => body.querySelector(`[data-cf-f="${k}"]`);
    const payload = {
      share_url: v('share_url').value.trim(),
      name: v('name').value.trim() || undefined,
      interval_min: parseInt(v('interval_min').value, 10) || 15,
      default_duration_sec: parseInt(v('default_duration_sec').value, 10) || 10,
      auto_playlist: v('auto_playlist').checked,
    };
    if (!payload.share_url) { showToast('Paste the folder\'s sharing link', 'error'); return; }
    const btn = body.querySelector('[data-cf="add"]');
    btn.disabled = true; btn.textContent = 'Checking the folder…';
    try {
      await api.post('/m365/folders', payload);
      showToast('Folder added — the first sync has started', 'success');
      await load();
      // The first sync runs in the background; look again shortly so its outcome appears.
      setTimeout(() => { if (document.body.contains(overlay)) { load(); if (onChange) onChange(); } }, 4000);
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Add folder';
    }
  }

  load();
}
