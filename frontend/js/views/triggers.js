import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';

/*
 * Triggers — externally-fired interrupt content. docs/triggers-design.md.
 *
 * ⚠️ ASSIGNMENT IS THE POINT OF THIS SCREEN, not decoration. A trigger assigned to a screen is what
 * makes that screen download and PIN the target playlist's media, and pinned media is the only kind
 * that survives with the WAN down — which is the entire feature. An unassigned trigger is a row in a
 * database that will never fire anywhere.
 */

let cache = { triggers: [], playlists: [], devices: [], groups: [] };

function modeLabel(m) {
  return m === 'until_cleared' ? t('trigger.mode_until_cleared') : t('trigger.mode_once');
}

/*
 * ⚠️ THE STUCK-SCREEN CONFIGURATION, named where it is created.
 *
 * A clear is a single unacked datagram. On UDP, if it drops or the sender dies mid-alarm, an
 * until_cleared overlay holds forever and someone drives to the site. A lease renews on the
 * sender's own re-assert and expires if it stops, so it is the backstop — but it is opt-in, which
 * means the dangerous combination is reachable and has to be visible rather than merely documented.
 */
function leaseRisk(tr) {
  return tr.mode === 'until_cleared' && tr.source_udp && (tr.lease_sec == null || tr.lease_sec === '');
}

function targetName(tr) {
  const pl = cache.playlists.find(p => p.id === tr.target_ref);
  return pl ? pl.name : t('trigger.target_missing');
}

function assignmentSummary(tr) {
  const a = tr.assignments || [];
  if (!a.length) return `<span class="badge badge-warn">${esc(t('trigger.unassigned'))}</span>`;
  const names = a.map((x) => {
    const list = x.target_type === 'device' ? cache.devices : cache.groups;
    const hit = list.find(i => i.id === x.target_id);
    return esc(hit ? hit.name : x.target_id.slice(0, 8));
  });
  return names.join(', ');
}

function rowHtml(tr) {
  const risk = leaseRisk(tr);
  return `
    <tr data-id="${esc(tr.id)}">
      <td>
        <strong>${esc(tr.name)}</strong>
        ${tr.enabled ? '' : `<span class="badge">${esc(t('trigger.disabled'))}</span>`}
      </td>
      <td><code>${esc(tr.match_token)}</code>${tr.clear_token ? ` / <code>${esc(tr.clear_token)}</code>` : ''}</td>
      <td>${esc(targetName(tr))}</td>
      <td>${esc(modeLabel(tr.mode))}${risk ? ` <span class="badge badge-warn" title="${esc(t('trigger.lease_risk'))}">${esc(t('trigger.no_lease'))}</span>` : ''}</td>
      <td>${tr.source_http ? 'HTTP' : ''}${tr.source_http && tr.source_udp ? ' + ' : ''}${tr.source_udp ? 'UDP' : ''}</td>
      <td>${tr.priority}</td>
      <td>${assignmentSummary(tr)}</td>
      <td class="actions">
        <button class="btn btn-sm" data-act="edit">${esc(t('common.edit'))}</button>
        <button class="btn btn-sm btn-danger" data-act="del">${esc(t('common.delete'))}</button>
      </td>
    </tr>`;
}

function formHtml(tr) {
  const isNew = !tr.id;
  const opt = (list, sel) => list.map(x =>
    `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('');

  /*
   * ⚠️ ONLY PLAYLISTS THAT CAN ACTUALLY FIRE.
   *
   * The server refuses to save a trigger pointing at a playlist with no published snapshot, and it
   * is right to: deviceSocket uses the same guard, so such a trigger would sync with `items: []`
   * and render nothing, forever, silently. But the dropdown offered every playlist, so the normal
   * way to meet that rule was to fill the whole form, press Save, and be told no.
   *
   * Offering a choice the server will reject is the wrong order. An unpublished playlist is not a
   * valid answer to "what should this show", so it is not in the list.
   *
   * ⚠️ EXCEPT the one already saved on THIS trigger. A playlist can be unpublished after a trigger
   * was pointed at it, and dropping it from the list would silently re-point that trigger at
   * whatever happens to be first the next time somebody opens the form to change its name.
   */
  const firable = cache.playlists.filter((x) => x.published_snapshot || x.id === tr.target_ref);
  const unpublishedCount = cache.playlists.length - firable.length;
  const assigned = new Set((tr.assignments || []).map(a => `${a.target_type}:${a.target_id}`));
  const checks = (list, type) => list.map(x => `
      <label class="check">
        <input type="checkbox" data-assign="${type}:${esc(x.id)}"
               ${assigned.has(`${type}:${x.id}`) ? 'checked' : ''}> ${esc(x.name)}
      </label>`).join('') || `<p class="muted">${esc(t('trigger.none_available'))}</p>`;

  /*
   * ⚠️ `.modal-overlay`, NOT `.modal-backdrop`. This dialog spent its whole life using a class name
   * that is not defined anywhere in main.css, so it got no fixed positioning, no centering and no
   * dimming — it rendered as a bare stack of labels appended to the end of the page. Nothing
   * errored, and every field worked, which is why it survived: it looked like an unfinished feature
   * rather than one wrong word.
   */
  const field = (id, label, control, hint, hintId) =>
    `<div class="form-group">
       <label for="${id}">${esc(label)}</label>
       ${control}
       ${hint ? `<div class="tg-hint"${hintId ? ` id="${hintId}"` : ''}>${esc(hint)}</div>` : ''}
     </div>`;

  const section = (title, inner, blurb) =>
    `<section class="tg-section">
       <h4 class="tg-legend">${esc(title)}</h4>
       ${blurb ? `<p class="tg-blurb">${esc(blurb)}</p>` : ''}
       ${inner}
     </section>`;

  return `
  <div class="modal-overlay" id="trigModal">
    <div class="modal tg-modal">
      <div class="modal-header">
        <h3>${esc(isNew ? t('trigger.new') : t('trigger.edit'))}</h3>
        <button class="btn-icon" type="button" id="tgClose" aria-label="${esc(t('common.close'))}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="modal-body">
        ${section(t('trigger.sec_identity'),
          field('tgName', t('trigger.name'),
            `<input class="input" id="tgName" value="${esc(tr.name || '')}" maxlength="200">`))}

        ${section(t('trigger.sec_match'),
          field('tgToken', t('trigger.match_token'),
            `<input class="input" id="tgToken" value="${esc(tr.match_token || '')}" maxlength="64">`,
            t('trigger.token_hint'))
          + field('tgClear', t('trigger.clear_token'),
            `<input class="input" id="tgClear" value="${esc(tr.clear_token || '')}" maxlength="64">`)
          + `<div class="tg-sources">
               <label class="tg-check"><input type="checkbox" id="tgHttp" ${tr.source_http === false ? '' : 'checked'}> HTTP</label>
               <label class="tg-check"><input type="checkbox" id="tgUdp" ${tr.source_udp ? 'checked' : ''}> UDP</label>
             </div>`)}

        ${section(t('trigger.sec_shows'),
          (firable.length
            ? field('tgTarget', t('trigger.target'),
                `<select class="input" id="tgTarget">${opt(firable, tr.target_ref)}</select>`,
                t('trigger.target_hint'))
            /*
             * A disabled empty select with a hint underneath reads as a broken form. If nothing can
             * be chosen, say why and what to do — the operator has playlists, they are just not
             * published yet, and nothing else on this screen would tell them that.
             */
            : `<div class="tg-empty">${esc(t('trigger.no_published'))}</div>`)
          + (unpublishedCount > 0 && firable.length
            ? `<div class="tg-hint">${esc(tn('trigger.unpublished_hidden', unpublishedCount))}</div>`
            : ''))}

        ${section(t('trigger.sec_behaviour'),
          field('tgMode', t('trigger.mode'),
            `<select class="input" id="tgMode">
               <option value="once"${tr.mode === 'once' ? ' selected' : ''}>${esc(t('trigger.mode_once'))}</option>
               <option value="until_cleared"${tr.mode === 'until_cleared' ? ' selected' : ''}>${esc(t('trigger.mode_until_cleared'))}</option>
             </select>`)
          + `<div class="tg-row">
               ${field('tgMaxDur', t('trigger.max_duration'),
                 `<input class="input" id="tgMaxDur" type="number" min="0" max="86400" value="${tr.max_duration_sec || 0}">`,
                 t('trigger.max_duration_hint'))}
               ${field('tgLease', t('trigger.lease'),
                 `<input class="input" id="tgLease" type="number" min="5" max="86400" value="${tr.lease_sec == null ? '' : tr.lease_sec}">`,
                 t('trigger.lease_hint'), 'tgLeaseHint')}
             </div>`
          + field('tgPriority', t('trigger.priority'),
            `<input class="input" id="tgPriority" type="number" min="-1000" max="1000" value="${tr.priority || 0}">`))}

        ${section(t('trigger.assign'),
          `<div class="assign-grid">
             <div><h5 class="tg-col">${esc(t('nav.displays'))}</h5>${checks(cache.devices, 'device')}</div>
             <div><h5 class="tg-col">${esc(t('trigger.groups'))}</h5>${checks(cache.groups, 'group')}</div>
           </div>`,
          t('trigger.assign_hint'))}
      </div>

      <div class="modal-footer">
        <label class="tg-check tg-enabled"><input type="checkbox" id="tgEnabled" ${tr.enabled === 0 ? '' : 'checked'}> ${esc(t('trigger.enabled'))}</label>
        <button class="btn btn-secondary" type="button" id="tgCancel">${esc(t('common.cancel'))}</button>
        <button class="btn btn-primary" type="button" id="tgSave">${esc(t('common.save'))}</button>
      </div>
    </div>
  </div>`;
}

function collect() {
  const mode = document.getElementById('tgMode').value;
  const leaseRaw = document.getElementById('tgLease').value;
  const assignments = [...document.querySelectorAll('[data-assign]')]
    .filter(el => el.checked)
    .map(el => {
      const [target_type, target_id] = el.dataset.assign.split(':');
      return { target_type, target_id };
    });
  return {
    name: document.getElementById('tgName').value.trim(),
    match_token: document.getElementById('tgToken').value.trim(),
    clear_token: document.getElementById('tgClear').value.trim() || null,
    target_kind: 'playlist',
    /*
     * ⚠️ The select is ABSENT when no playlist is publishable — see formHtml. Reading `.value` off
     * null here would throw inside the click handler, which a green suite cannot see: the button
     * would simply do nothing, with the operator watching a form that will not save and no error.
     * Save is disabled in that state; this is the second lock on the same door.
     */
    target_ref: document.getElementById('tgTarget')?.value || null,
    mode,
    max_duration_sec: Number(document.getElementById('tgMaxDur').value) || 0,
    // Sent only when it applies; the server refuses lease_sec on a `once` trigger rather than
    // storing a field that could never fire.
    lease_sec: mode === 'until_cleared' && leaseRaw !== '' ? Number(leaseRaw) : null,
    priority: Number(document.getElementById('tgPriority').value) || 0,
    source_http: document.getElementById('tgHttp').checked,
    source_udp: document.getElementById('tgUdp').checked,
    enabled: document.getElementById('tgEnabled').checked,
    assignments,
  };
}

function openForm(app, tr) {
  const host = document.createElement('div');
  host.innerHTML = formHtml(tr || {});
  document.body.appendChild(host);

  /*
   * ⚠️ PREFILL THE LEASE FOR UDP, do not silently default it. The stored meaning of "unset" stays
   * "hold indefinitely" — this only makes the safe value the one an operator has to REMOVE rather
   * than the one they have to know to look for.
   */
  const udp = document.getElementById('tgUdp');
  const lease = document.getElementById('tgLease');
  const mode = document.getElementById('tgMode');
  const syncLease = () => {
    const risky = mode.value === 'until_cleared' && udp.checked;
    if (risky && lease.value === '' && !tr?.id) lease.value = '90';
    document.getElementById('tgLeaseHint').textContent =
      risky && lease.value === '' ? t('trigger.lease_risk') : t('trigger.lease_hint');
    lease.disabled = mode.value !== 'until_cleared';
  };
  udp.addEventListener('change', syncLease);
  mode.addEventListener('change', syncLease);
  lease.addEventListener('input', syncLease);
  syncLease();

  /*
   * ⚠️ EVERY WAY OUT, and the listener is removed with the dialog.
   *
   * Cancel was the only exit: no close button (there was no header to put one in), no Escape, and
   * clicking the backdrop did nothing because there was no backdrop. The keydown is on document, so
   * it MUST be detached in close() — a dialog opened and dismissed twenty times otherwise leaves
   * twenty handlers behind, and the last one closes a dialog that is no longer on screen.
   */
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    host.remove();
  };
  document.addEventListener('keydown', onKey);
  document.getElementById('tgClose').addEventListener('click', close);
  // The overlay itself, but not a click that started inside the dialog — otherwise selecting text
  // in a field and releasing outside it closes the form and discards the edit.
  document.getElementById('trigModal').addEventListener('mousedown', (ev) => {
    if (ev.target.id === 'trigModal') close();
  });
  /*
   * Nothing publishable to point at: Save cannot succeed, so it does not invite the attempt. The
   * server would refuse anyway — this just puts the refusal before the work rather than after it.
   */
  const targetSel = document.getElementById('tgTarget');
  if (!targetSel) {
    const save = document.getElementById('tgSave');
    save.disabled = true;
    save.title = t('trigger.no_published');
  }

  document.getElementById('tgCancel').addEventListener('click', close);
  document.getElementById('tgSave').addEventListener('click', async () => {
    const body = collect();
    try {
      if (tr && tr.id) await api.put(`/triggers/${tr.id}`, body);
      else await api.post('/triggers', body);
      close();
      showToast(t('trigger.saved'), 'success');
      render(app);
    } catch (e) {
      // The server's message is the useful one — it names the actual rule (token charset, a
      // cross-workspace playlist, a duplicate token) far better than anything generic here.
      showToast((e && e.message) || t('common.error'), 'error');
    }
  });
}

export async function render(app) {
  app.innerHTML = `<div class="view"><h1>${esc(t('nav.triggers'))}</h1>
    <p class="muted">${esc(t('trigger.intro'))}</p><div id="trigBody"></div></div>`;
  const body = document.getElementById('trigBody');

  try {
    const [trg, pls, devs, grps] = await Promise.all([
      api.get('/triggers'), api.get('/playlists'), api.get('/devices'), api.get('/groups'),
    ]);
    cache = {
      triggers: trg.triggers || [],
      playlists: Array.isArray(pls) ? pls : (pls.playlists || []),
      devices: Array.isArray(devs) ? devs : (devs.devices || []),
      groups: Array.isArray(grps) ? grps : (grps.groups || []),
    };
  } catch (e) {
    body.innerHTML = `<p class="error">${esc((e && e.message) || t('common.error'))}</p>`;
    return;
  }

  const risky = cache.triggers.filter(leaseRisk).length;
  body.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-primary" id="tgNew">${esc(t('trigger.new'))}</button>
    </div>
    ${risky ? `<div class="banner banner-warn">${esc(t('trigger.lease_risk_banner'))}</div>` : ''}
    ${cache.triggers.length ? `
    <table class="table">
      <thead><tr>
        <th>${esc(t('trigger.name'))}</th><th>${esc(t('trigger.tokens'))}</th>
        <th>${esc(t('trigger.target'))}</th><th>${esc(t('trigger.mode'))}</th>
        <th>${esc(t('trigger.sources'))}</th><th>${esc(t('trigger.priority'))}</th>
        <th>${esc(t('trigger.assigned'))}</th><th></th>
      </tr></thead>
      <tbody>${cache.triggers.map(rowHtml).join('')}</tbody>
    </table>` : `<p class="muted">${esc(t('trigger.empty'))}</p>`}`;

  document.getElementById('tgNew').addEventListener('click', () => openForm(app, null));
  body.querySelectorAll('tr[data-id]').forEach((row) => {
    const tr = cache.triggers.find(x => x.id === row.dataset.id);
    row.querySelector('[data-act="edit"]')?.addEventListener('click', () => openForm(app, tr));
    row.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      if (!confirm(t('trigger.confirm_delete'))) return;
      try { await api.delete(`/triggers/${tr.id}`); showToast(t('trigger.deleted'), 'success'); render(app); }
      catch (e) { showToast((e && e.message) || t('common.error'), 'error'); }
    });
  });
}
