/*
 * "Where media is stored" (server/routes/storage-profiles.js, docs/storage.md). Three levels:
 *
 *   instance      Platform → System (mountInstanceStorage): the profile every organization without
 *                 its own storage uses. Platform admins only. The server's environment wins over it.
 *   organization  Settings (mountStorageSettings): the org's shared profiles and its default. Org
 *                 owners and admins.
 *   workspace     the same Settings card: where THIS workspace's new uploads go (follow the
 *                 organization, or a profile of its own). Org admins always; workspace admins only
 *                 when the organization allows it — otherwise the server answers 403 and the card
 *                 is not shown.
 *
 * ⚠️ SECRETS ARE WRITE-ONLY. The form sends a key; nothing the server returns contains one. An
 * edit with the key fields left blank keeps the stored key. Stored keys are encrypted with this
 * server's JWT secret, so a changed JWT_SECRET means re-entering them — the card says so on any
 * profile whose key no longer decrypts.
 *
 * Escaping follows the SPA rule: values are stored raw and esc()'d where they are rendered.
 */
import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';

const BASE = '/storage-profiles';
const PROVIDERS = { s3: 'S3 / S3-compatible', azure: 'Azure Blob', local: 'Local disk' };
const SCOPE_LABEL = { instance: 'Instance', organization: 'Organization', workspace: 'Workspace' };

export async function mountStorageSettings(host) {
  if (!host) return;
  let data;
  try { data = await api.get(BASE); } catch (_) { host.style.display = 'none'; return; }
  host.style.display = '';
  host.innerHTML = '<h3>Where media is stored</h3><div data-st="body"></div>';
  const body = host.querySelector('[data-st="body"]');
  render();

  async function reload() {
    try { data = await api.get(BASE); } catch (err) { showToast(err.message, 'error'); return; }
    render();
  }

  function render() {
    const { profiles, settings } = data;
    const orgAdmin = !!settings.can_manage_org;
    const ws = settings.workspace;
    const writable = profiles.filter((p) => p.mode === 'rw' && !p.credentials_unreadable);
    // The org default may only be an org-wide profile; a workspace's own profile is never an option there.
    const orgChoices = writable.filter((p) => p.scope !== 'workspace');
    const wsChoices = writable.filter((p) => p.usable_here);
    const m = settings.migration && ['copying', 'ready_to_commit', 'committed', 'draining'].includes(settings.migration.state) ? settings.migration : null;
    // Choices lock only while a copy is in flight — the same rule the server applies. After the
    // switch, old copies awaiting removal do not stop anyone changing where NEW uploads go.
    const locked = !!(m && ['copying', 'ready_to_commit'].includes(m.state));
    body.innerHTML = `
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">A workspace stores new uploads in its own choice if it has one, otherwise in the organization's, otherwise in this server's instance default. Changing a choice affects new uploads only; use <em>Move media here</em> to move existing files. Screens keep playing from whichever stored copy answers while that runs.</p>

      ${orgAdmin ? `
      <div class="form-group">
        <label for="stDefault">Organization: new uploads go to</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="stDefault" class="input" style="min-width:240px" ${locked ? 'disabled' : ''}>
            <option value="">Instance default (${esc(nameOf(settings.instance_default_id))})</option>
            ${orgChoices.map((p) => `<option value="${esc(p.id)}" ${settings.org_override === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(PROVIDERS[p.provider] || p.provider)}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-secondary btn-sm" id="stSaveDefault" ${locked ? 'disabled' : ''}>Save</button>
        </div>
        ${locked ? '<div style="font-size:12px;color:var(--text-muted)">Locked while a copy is in progress.</div>' : ''}
        <label style="display:block;margin-top:8px;font-size:13px"><input type="checkbox" id="stWsChoice" ${settings.workspace_choice ? 'checked' : ''}> Workspace admins may choose their own workspace's storage</label>
        <div style="font-size:12px;color:var(--text-muted)">Off by default: where a workspace's media lives is the organization's decision. Organization admins can always set it below.</div>
      </div>` : ''}

      ${ws ? `
      <div class="form-group">
        <label for="stWsDefault">This workspace${ws.name ? ` (${esc(ws.name)})` : ''}: new uploads go to</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="stWsDefault" class="input" style="min-width:240px" ${locked ? 'disabled' : ''}>
            <option value="">Follow the organization (${esc(nameOf(settings.default_profile_id))})</option>
            ${wsChoices.map((p) => `<option value="${esc(p.id)}" ${ws.override === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(SCOPE_LABEL[p.scope] || '')} ${esc(PROVIDERS[p.provider] || p.provider)}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-secondary btn-sm" id="stSaveWs" ${locked ? 'disabled' : ''}>Save</button>
        </div>
        ${ws.override_unusable ? `<div style="font-size:12px;color:var(--danger, #e05252)">The chosen profile can't take uploads right now (deleted, read-only, or its key must be re-entered), so new uploads go to ${esc(nameOf(ws.effective_profile_id))}.</div>` : ''}
        ${ws.override && !ws.override_unusable ? '<div style="font-size:12px;color:var(--text-muted)">This workspace has its own storage, so organization-wide moves leave it alone.</div>' : ''}
      </div>` : ''}

      <div class="form-group">
        <label for="stDirect">Screens in this workspace may download from the bucket directly</label>
        <select id="stDirect" class="input" style="width:240px">
          <option value="" ${settings.workspace_direct_fetch == null ? 'selected' : ''}>Default (yes, when the bucket has a public endpoint)</option>
          <option value="1" ${settings.workspace_direct_fetch === true ? 'selected' : ''}>Yes</option>
          <option value="0" ${settings.workspace_direct_fetch === false ? 'selected' : ''}>No — always through this server</option>
        </select>
        <div style="font-size:12px;color:var(--text-muted)">"No" is the setting for screens on a network that cannot reach the bucket. They are then served by this server, which reads the bucket for them.</div>
      </div>

      ${m ? migrationPanel(m) : ''}

      <div class="table-wrap" style="margin-top:8px"><table class="corp-table">
        <thead><tr><th>Name</th><th>Level</th><th>Type</th><th>Bucket</th><th>Mode</th><th>Files</th><th></th></tr></thead>
        <tbody>${profiles.map((p) => row(p, orgAdmin, !!ws)).join('')}</tbody>
      </table></div>
      <div style="margin-top:10px"><button type="button" class="btn btn-secondary btn-sm" id="stAdd">Add storage profile</button></div>
      <div id="stForm"></div>
      <div id="stBrowse"></div>`;

    const on = (sel, ev, fn) => { const el = body.querySelector(sel); if (el) el.addEventListener(ev, fn); };
    on('#stSaveDefault', 'click', async () => {
      const v = body.querySelector('#stDefault').value || null;
      try { await api.put(`${BASE}/settings/current`, { default_profile_id: v }); showToast('Saved: new uploads only — existing files stay where they are', 'success'); reload(); }
      catch (err) { showToast(err.message, 'error'); }
    });
    on('#stWsChoice', 'change', async (e) => {
      try { await api.put(`${BASE}/settings/current`, { workspace_choice: e.target.checked }); showToast('Saved', 'success'); reload(); }
      catch (err) { showToast(err.message, 'error'); e.target.checked = !e.target.checked; }
    });
    on('#stSaveWs', 'click', async () => {
      const v = body.querySelector('#stWsDefault').value || null;
      try { await api.put(`${BASE}/settings/current`, { workspace_profile_id: v }); showToast('Saved: new uploads only — existing files stay where they are', 'success'); reload(); }
      catch (err) { showToast(err.message, 'error'); }
    });
    on('#stDirect', 'change', async (e) => {
      const v = e.target.value === '' ? null : e.target.value === '1';
      try { await api.put(`${BASE}/settings/current`, { workspace_direct_fetch: v }); showToast('Saved', 'success'); }
      catch (err) { showToast(err.message, 'error'); }
    });
    on('#stAdd', 'click', () => openForm(body.querySelector('#stForm'), null, {
      canPrivate: settings.can_allow_private,
      scopes: orgAdmin
        ? [{ value: 'organization', label: 'Organization — every workspace in it may use it' }, ...(ws ? [{ value: 'workspace', label: `This workspace only${ws.name ? ` (${ws.name})` : ''}` }] : [])]
        : [{ value: 'workspace', label: `This workspace only${ws && ws.name ? ` (${ws.name})` : ''}` }],
      onSaved: reload,
    }));
    body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, b.dataset.id)));
  }

  function nameOf(id) { const p = data.profiles.find((x) => x.id === id); return p ? p.name : id; }

  function row(p, orgAdmin, inWorkspace) {
    const btn = (act, label, cls = 'btn-secondary') => `<button type="button" class="btn ${cls} btn-sm" data-act="${act}" data-id="${esc(p.id)}">${label}</button>`;
    const where = p.provider === 'local' ? '—' : `${esc(p.bucket || '')}${p.prefix ? `/<span style="color:var(--text-muted)">${esc(p.prefix)}</span>` : ''}${p.endpoint ? `<div style="font-size:11px;color:var(--text-muted)">${esc(p.endpoint)}</div>` : ''}`;
    const warn = p.credentials_unreadable ? '<div style="font-size:11px;color:var(--danger, #e05252)">Key unreadable — this server\'s JWT secret changed. Edit and re-enter it.</div>' : '';
    const key = p.provider !== 'local' && p.hint ? `<div style="font-size:11px;color:var(--text-muted)">key …${esc(p.hint)}</div>` : '';
    const level = p.scope === 'workspace' ? `Workspace${p.workspace_name ? `: ${esc(p.workspace_name)}` : ''}` : esc(SCOPE_LABEL[p.scope] || '');
    const movable = p.mode === 'rw' && !p.credentials_unreadable;
    return `<tr>
      <td>${esc(p.name)}${p.from_env ? ' <span style="font-size:11px;color:var(--text-muted)">(server config)</span>' : ''}${key}${warn}</td>
      <td style="font-size:12px">${level}</td>
      <td>${esc(PROVIDERS[p.provider] || p.provider)}</td>
      <td>${where}</td>
      <td>${p.mode === 'ro' ? 'read-only' : 'read/write'}</td>
      <td>${esc(String(p.in_use || 0))}</td>
      <td><div class="storage-row-actions">
        ${p.provider !== 'local' ? btn('test', 'Test') : ''}
        ${p.provider !== 'local' && (orgAdmin || p.usable_here) ? btn('browse', 'Browse') : ''}
        ${movable && orgAdmin && p.scope !== 'workspace' ? btn('migrate', 'Move organization here') : ''}
        ${movable && inWorkspace && p.usable_here ? btn('migrate-ws', 'Move this workspace here') : ''}
        ${p.editable ? btn('edit', 'Edit') : ''}
        ${p.editable ? btn('delete', 'Delete', 'btn-danger') : ''}
      </div></td></tr>`;
  }

  function migrationPanel(m) {
    const pct = m.total ? Math.round(((m.verified + m.failed) / m.total) * 100) : 100;
    const label = { copying: 'Copying', ready_to_commit: 'Copied — not switched yet', committed: 'Switched — old copies still kept', draining: 'Removing old copies' }[m.state] || m.state;
    const scope = m.workspace_id ? (data.settings.workspace && data.settings.workspace.id === m.workspace_id ? 'this workspace' : 'one workspace') : 'the organization';
    return `<div class="settings-subsection" style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin:8px 0">
      <div style="font-weight:500">${esc(label)}: ${esc(scope)} to ${esc(nameOf(m.target_profile_id))}</div>
      <div style="font-size:12px;color:var(--text-muted);margin:4px 0">${esc(String(m.verified))} of ${esc(String(m.total))} verified (${esc(String(pct))}%)${m.failed ? `, <span style="color:var(--danger, #e05252)">${esc(String(m.failed))} failed</span>` : ''}${m.last_error ? ` — last error: ${esc(m.last_error)}` : ''}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${m.state === 'copying' || m.state === 'ready_to_commit'
        ? 'Screens are still served from the current copies. <em>Switch</em> makes the new copies primary; the old ones stay readable until you remove them.'
        : 'Reads prefer the new copies. The old copies are still served if the new ones fail, until you remove them.'}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${m.state === 'ready_to_commit' ? `<button type="button" class="btn btn-primary btn-sm" data-act="commit" data-id="${esc(m.target_profile_id)}">Switch to the new copies</button>` : ''}
        ${m.state === 'committed' || m.state === 'draining' ? `<button type="button" class="btn btn-danger btn-sm" data-act="drain" data-id="${esc(m.target_profile_id)}">Remove old copies</button>` : ''}
        <button type="button" class="btn btn-secondary btn-sm" data-act="abort" data-id="${esc(m.target_profile_id)}">Stop and keep current copies</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="refresh" data-id="">Refresh</button>
      </div></div>`;
  }

  async function act(what, id) {
    const p = data.profiles.find((x) => x.id === id);
    try {
      if (what === 'refresh') return reload();
      if (what === 'test') return testProfile(id);
      if (what === 'edit') return openForm(body.querySelector('#stForm'), p, { canPrivate: data.settings.can_allow_private, onSaved: reload });
      if (what === 'browse') return openBrowser(p, '');
      if (what === 'delete') {
        if (!window.confirm(`Delete the storage profile "${p.name}"? Files are not touched; a profile that still holds files cannot be deleted.`)) return;
        await api.delete(`${BASE}/${encodeURIComponent(id)}`); showToast('Deleted', 'success'); return reload();
      }
      if (what === 'migrate' || what === 'migrate-ws') {
        const wsMove = what === 'migrate-ws';
        const whose = wsMove ? 'this workspace' : 'this organization (workspaces with their own storage are left alone)';
        if (!window.confirm(`Copy every file in ${whose} to "${p.name}"? Nothing is switched or removed until you choose to; screens keep playing throughout.`)) return;
        await api.post(`${BASE}/${encodeURIComponent(id)}/migrate`, wsMove ? { scope: 'workspace' } : {}); showToast('Copy started', 'success'); return reload();
      }
      if (what === 'commit') { await api.post(`${BASE}/${encodeURIComponent(id)}/migrate/commit`, {}); showToast('Switched. Old copies are kept until you remove them.', 'success'); return reload(); }
      if (what === 'drain') {
        if (!window.confirm('Remove the old copies? Only copies ScreenTinker wrote are removed, and only where another ready copy exists. This cannot be undone.')) return;
        const r = await api.post(`${BASE}/${encodeURIComponent(id)}/migrate/drain`, {});
        showToast(`Removed ${r.drained.deleted} old cop${r.drained.deleted === 1 ? 'y' : 'ies'}`, 'success'); return reload();
      }
      if (what === 'abort') { await api.post(`${BASE}/${encodeURIComponent(id)}/migrate/abort`, {}); showToast('Stopped. Every existing copy was kept.', 'success'); return reload(); }
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function openBrowser(p, prefix, cursor = null) {
    const box = body.querySelector('#stBrowse');
    box.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Listing…</p>';
    let page;
    try { page = await api.get(`${BASE}/${encodeURIComponent(p.id)}/objects?prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); }
    catch (err) { box.innerHTML = `<p style="color:var(--danger);font-size:13px">${esc(err.message)}</p>`; return; }
    const up = prefix.replace(/[^/]+\/$/, '');
    box.innerHTML = `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-top:12px">
      <h4 style="margin-bottom:8px">${esc(p.name)}: /${esc(prefix)}</h4>
      ${prefix ? `<button type="button" class="btn btn-secondary btn-sm" data-dir="${esc(up)}">↑ Up</button>` : ''}
      <div class="table-wrap" style="margin-top:6px"><table class="corp-table"><tbody>
        ${page.folders.map((f) => `<tr><td colspan="3"><a href="#" data-dir="${esc(f)}">📁 ${esc(f.slice(prefix.length))}</a></td></tr>`).join('')}
        ${page.objects.map((o) => `<tr><td><label><input type="checkbox" data-key="${esc(o.key)}" ${o.importable ? '' : 'disabled'}> ${esc(o.key.slice(prefix.length))}</label>${o.st_internal ? ' <span style="font-size:11px;color:var(--text-muted)">(ScreenTinker)</span>' : ''}</td><td style="font-size:12px">${esc(fmtSize(o.size))}</td><td style="font-size:11px;color:var(--text-muted)">${o.importable ? '' : 'not a media type'}</td></tr>`).join('')}
        ${!page.folders.length && !page.objects.length ? '<tr><td style="color:var(--text-muted);font-size:13px">Empty.</td></tr>' : ''}
      </tbody></table></div>
      ${page.cursor ? '<button type="button" class="btn btn-secondary btn-sm" data-next="1">Next page</button>' : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <select id="sbMode" class="input" style="width:auto">
          <option value="reference">Reference — play it from this bucket; never modified</option>
          <option value="copy">Copy — store it in this workspace's own storage</option>
        </select>
        <button type="button" class="btn btn-primary btn-sm" id="sbImport">Import selected</button>
        <button type="button" class="btn btn-secondary btn-sm" id="sbClose">Close</button>
      </div></div>`;
    box.querySelectorAll('[data-dir]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openBrowser(p, a.dataset.dir); }));
    const next = box.querySelector('[data-next]');
    if (next) next.addEventListener('click', () => openBrowser(p, prefix, page.cursor));
    box.querySelector('#sbClose').addEventListener('click', () => { box.innerHTML = ''; });
    box.querySelector('#sbImport').addEventListener('click', async () => {
      const keys = [...box.querySelectorAll('input[data-key]:checked')].map((el) => el.dataset.key);
      if (!keys.length) return showToast('Select at least one file', 'error');
      try {
        const r = await api.post(`${BASE}/${encodeURIComponent(p.id)}/import`, { keys, mode: box.querySelector('#sbMode').value });
        showToast(`Imported ${r.imported.length}${r.errors.length ? `; ${r.errors.length} refused: ${r.errors[0].error}` : ''}`, r.errors.length ? 'error' : 'success');
        reload();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
}

/*
 * Platform → System: the instance level. One profile at most (the server enforces it). When the
 * server's environment sets STORAGE_PROVIDER that wins, and the card says the stored profile is
 * inactive rather than letting anyone edit it believing it applies.
 */
export async function mountInstanceStorage(host) {
  if (!host) return;
  let data;
  const load = async () => {
    try { data = await api.get(`${BASE}/instance`); } catch (err) { host.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${esc(err.message)}</p>`; return false; }
    return true;
  };
  if (!(await load())) return;
  const render = () => {
    const p = data.profile;
    const env = data.env;
    host.innerHTML = `
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:10px">Where media goes for every organization that has not chosen its own storage (${esc(String(data.orgs_following))} organization${data.orgs_following === 1 ? '' : 's'} currently follow${data.orgs_following === 1 ? 's' : ''} it). Each organization, and each workspace, can still choose its own under Settings.</p>
      ${env ? `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-bottom:10px;font-size:13px">
        <strong>Set by the server's environment:</strong> ${esc(PROVIDERS[env.provider] || env.provider)}${env.bucket ? ` — ${esc(env.bucket)}` : ''}${env.endpoint ? ` <span style="color:var(--text-muted)">(${esc(env.endpoint)})</span>` : ''}.
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">STORAGE_PROVIDER is set, so it is the instance default${p ? ' and the profile below is <strong>not in effect</strong>' : ''}. Unset it and restart to manage the instance default here.</div></div>` : ''}
      ${p ? `<div class="table-wrap"><table class="corp-table"><thead><tr><th>Name</th><th>Type</th><th>Bucket</th><th>Files</th><th></th></tr></thead><tbody><tr>
          <td>${esc(p.name)}${p.active ? ' <span style="font-size:11px;color:var(--success)">in effect</span>' : ''}${p.hint ? `<div style="font-size:11px;color:var(--text-muted)">key …${esc(p.hint)}</div>` : ''}${p.credentials_unreadable ? '<div style="font-size:11px;color:var(--danger, #e05252)">Key unreadable — re-enter it.</div>' : ''}</td>
          <td>${esc(PROVIDERS[p.provider] || p.provider)}</td>
          <td>${esc(p.bucket || '')}${p.endpoint ? `<div style="font-size:11px;color:var(--text-muted)">${esc(p.endpoint)}</div>` : ''}</td>
          <td>${esc(String(p.in_use || 0))}</td>
          <td style="white-space:nowrap">
            <button type="button" class="btn btn-secondary btn-sm" data-iact="test">Test</button>
            <button type="button" class="btn btn-secondary btn-sm" data-iact="edit">Edit</button>
            <button type="button" class="btn btn-danger btn-sm" data-iact="delete">Delete</button>
          </td></tr></tbody></table></div>`
        : `<p style="font-size:13px">${env ? '' : 'No instance storage profile: media is stored on this server\'s local disk.'}</p>
           <button type="button" class="btn btn-secondary btn-sm" data-iact="add">Add instance storage</button>`}
      <div data-iform></div>`;
    host.querySelectorAll('[data-iact]').forEach((b) => b.addEventListener('click', async () => {
      const box = host.querySelector('[data-iform]');
      const refresh = async () => { if (await load()) render(); };
      try {
        if (b.dataset.iact === 'add') return openForm(box, null, { canPrivate: true, extraPayload: { scope: 'instance' }, onSaved: refresh });
        if (b.dataset.iact === 'edit') return openForm(box, p, { canPrivate: true, onSaved: refresh });
        if (b.dataset.iact === 'test') return testProfile(p.id);
        if (b.dataset.iact === 'delete') {
          if (!window.confirm(`Delete the instance storage profile "${p.name}"? Organizations that follow the instance default go back to local disk for new uploads. A profile that still holds files cannot be deleted.`)) return;
          await api.delete(`${BASE}/${encodeURIComponent(p.id)}`); showToast('Deleted', 'success'); return refresh();
        }
      } catch (err) { showToast(err.message, 'error'); }
    }));
  };
  render();
}

async function testProfile(id) {
  try {
    const r = await api.post(`${BASE}/${encodeURIComponent(id)}/test`, {});
    showToast(r.ok ? 'Connected' : `${r.message} (${r.code})`, r.ok ? 'success' : 'error');
  } catch (err) { showToast(err.message, 'error'); }
}

/**
 * The add/edit form. `scopes` (add only) offers where the new profile belongs; `extraPayload` is
 * merged into the request (the instance card passes { scope: 'instance' }).
 */
function openForm(box, p, { canPrivate = false, scopes = null, extraPayload = null, onSaved } = {}) {
  const provider = p ? p.provider : 's3';
  const v = (k) => esc(p && p[k] != null ? p[k] : '');
  box.innerHTML = `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-top:12px">
    <h4 style="margin-bottom:8px">${p ? `Edit “${esc(p.name)}”` : 'Add storage profile'}</h4>
    ${!p && scopes && scopes.length > 1 ? `<div class="form-group"><label>Belongs to</label>
      <select id="sfScope" class="input" style="width:auto">${scopes.map((s) => `<option value="${esc(s.value)}">${esc(s.label)}</option>`).join('')}</select></div>` : ''}
    <div class="form-group"><label>Type</label>
      <select id="sfProvider" class="input" style="width:240px" ${p ? 'disabled' : ''}>
        <option value="s3" ${provider === 's3' ? 'selected' : ''}>S3 / S3-compatible (AWS, MinIO, R2, B2, Wasabi, Spaces…)</option>
        <option value="azure" ${provider === 'azure' ? 'selected' : ''}>Azure Blob</option>
      </select></div>
    <div class="form-group"><label>Name</label><input id="sfName" class="input" value="${esc(p ? p.name : '')}" maxlength="80"></div>
    <div class="form-group"><label data-only="s3">Bucket</label><label data-only="azure">Container</label><input id="sfBucket" class="input" value="${v('bucket')}"></div>
    <div class="form-group"><label>Endpoint <span style="font-size:11px;color:var(--text-muted)" data-only="s3">(blank = AWS)</span><span style="font-size:11px;color:var(--text-muted)" data-only="azure">(blank = Azure public cloud; Azurite / sovereign cloud account URL)</span></label><input id="sfEndpoint" class="input" value="${v('endpoint')}" placeholder="https://minio.example.com:9000"></div>
    <div class="form-group"><label>Public endpoint <span style="font-size:11px;color:var(--text-muted)">(the name screens can reach; blank with a custom endpoint = screens are served through this server)</span></label><input id="sfPublic" class="input" value="${v('public_endpoint')}"></div>
    <div class="form-group" data-only="s3"><label>Public base URL <span style="font-size:11px;color:var(--text-muted)">(optional CDN in front of a public-read bucket; unsigned)</span></label><input id="sfPublicBase" class="input" value="${v('public_base_url')}"></div>
    <div class="form-group" data-only="s3"><label>Region <span style="font-size:11px;color:var(--text-muted)">(blank = us-east-1; R2 uses auto)</span></label><input id="sfRegion" class="input" value="${v('region')}" style="width:180px"></div>
    <div class="form-group" data-only="s3"><label>Addressing</label>
      <select id="sfPathStyle" class="input" style="width:240px">
        <option value="" ${p && p.force_path_style != null ? '' : 'selected'}>Automatic (path-style with a custom endpoint)</option>
        <option value="1" ${p && p.force_path_style === true ? 'selected' : ''}>Path-style</option>
        <option value="0" ${p && p.force_path_style === false ? 'selected' : ''}>Virtual-hosted</option>
      </select></div>
    <div class="form-group"><label>Prefix <span style="font-size:11px;color:var(--text-muted)">(optional folder inside the bucket)</span></label><input id="sfPrefix" class="input" value="${v('prefix')}"></div>
    <div class="form-group"><label>Mode</label>
      <select id="sfMode" class="input" style="width:240px">
        <option value="rw" ${!p || p.mode === 'rw' ? 'selected' : ''}>Read/write — uploads may be stored here (under st/ only)</option>
        <option value="ro" ${p && p.mode === 'ro' ? 'selected' : ''}>Read-only — attach an existing bucket and import from it</option>
      </select></div>
    <div class="form-group"><label>Read priority <span style="font-size:11px;color:var(--text-muted)">(lower is tried first when a file has several copies; local disk is 0)</span></label><input id="sfPriority" class="input" type="number" value="${p ? esc(String(p.read_priority)) : '100'}" style="width:100px"></div>
    <label style="display:block;margin-bottom:6px"><input type="checkbox" id="sfPresign" ${!p || p.presign ? 'checked' : ''}> Let screens download directly with short-lived links (when the endpoint is reachable)</label>
    ${canPrivate ? `<label style="display:block;margin-bottom:6px"><input type="checkbox" id="sfPrivate" ${p && p.allow_private ? 'checked' : ''}> The endpoint is on this host or a private network (e.g. MinIO beside this server)</label>` : ''}
    <div data-only="s3">
      <div class="form-group"><label>Access key ID</label><input id="sfKeyId" class="input" autocomplete="off" placeholder="${p ? 'unchanged — leave blank to keep' : ''}"></div>
      <div class="form-group"><label>Secret access key</label><input id="sfSecret" class="input" type="password" autocomplete="new-password" placeholder="${p ? 'unchanged — leave blank to keep' : ''}"></div>
    </div>
    <div data-only="azure">
      <div class="form-group"><label>Connection string <span style="font-size:11px;color:var(--text-muted)">(or the account fields below)</span></label><input id="sfConn" class="input" type="password" autocomplete="new-password" placeholder="${p ? 'unchanged — leave blank to keep' : ''}"></div>
      <div class="form-group"><label>Account name</label><input id="sfAccount" class="input" autocomplete="off"></div>
      <div class="form-group"><label>Account key</label><input id="sfAccountKey" class="input" type="password" autocomplete="new-password"></div>
      <div class="form-group"><label>SAS token <span style="font-size:11px;color:var(--text-muted)">(with a SAS only, screens are always served through this server)</span></label><input id="sfSas" class="input" type="password" autocomplete="new-password"></div>
    </div>
    <p style="font-size:11px;color:var(--text-muted)">Keys are encrypted with this server's JWT secret and are never shown again. If that secret changes, re-enter them here.</p>
    <div style="display:flex;gap:8px"><button type="button" class="btn btn-primary btn-sm" id="sfSave">${p ? 'Save' : 'Add'}</button><button type="button" class="btn btn-secondary btn-sm" id="sfCancel">Cancel</button></div>
  </div>`;
  const showFor = () => {
    const prov = box.querySelector('#sfProvider').value;
    box.querySelectorAll('[data-only]').forEach((el) => { el.style.display = el.dataset.only === prov ? '' : 'none'; });
  };
  showFor();
  box.querySelector('#sfProvider').addEventListener('change', showFor);
  box.querySelector('#sfCancel').addEventListener('click', () => { box.innerHTML = ''; });
  box.querySelector('#sfSave').addEventListener('click', async () => {
    const val = (sel) => { const el = box.querySelector(sel); return el ? el.value.trim() : ''; };
    const prov = box.querySelector('#sfProvider').value;
    const payload = {
      provider: prov, name: val('#sfName'), bucket: val('#sfBucket'), endpoint: val('#sfEndpoint'), public_endpoint: val('#sfPublic'),
      prefix: val('#sfPrefix'), mode: val('#sfMode'), read_priority: Number(val('#sfPriority') || 0),
      presign: box.querySelector('#sfPresign').checked,
      ...(extraPayload || {}),
    };
    if (!p && scopes && scopes.length) payload.scope = (box.querySelector('#sfScope') || {}).value || scopes[0].value;
    const priv = box.querySelector('#sfPrivate');
    if (priv) payload.allow_private = priv.checked;
    if (prov === 's3') {
      payload.public_base_url = val('#sfPublicBase'); payload.region = val('#sfRegion');
      const ps = val('#sfPathStyle'); payload.force_path_style = ps === '' ? null : ps === '1';
      if (val('#sfKeyId') || val('#sfSecret')) payload.credentials = { accessKeyId: val('#sfKeyId'), secretAccessKey: val('#sfSecret') };
    } else {
      const c = { connectionString: val('#sfConn'), accountName: val('#sfAccount'), accountKey: val('#sfAccountKey'), sasToken: val('#sfSas') };
      if (Object.values(c).some(Boolean)) payload.credentials = c;
    }
    try {
      if (p) await api.put(`${BASE}/${encodeURIComponent(p.id)}`, payload);
      else await api.post(BASE, payload);
      showToast('Saved', 'success');
      box.innerHTML = '';
      if (onSaved) onSaved();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
