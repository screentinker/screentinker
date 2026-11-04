/*
 * 3.0 content requests — the public page (server: routes/request-public.js, lib/content-requests.js).
 *
 *   /r/<code>           the form: pass its gate (name + email, an emailed code, or SSO), fill it in,
 *                       upload (resumable, 1 MiB chunks the server sizes), get a reference + status link
 *   /r/status#<token>   the status of one request; the token stays in the fragment, so it never
 *                       reaches a server log, and is POSTed to the API in a body
 *
 * No account, no dashboard chrome. Everything the server sends is rendered with textContent or esc().
 * The gate's ticket lives in sessionStorage (this tab only) so a reload does not lose the form.
 */
import { t } from './i18n.js';
import { esc } from './utils.js';

const API = '/api/public/requests';
const root = document.getElementById('root');
const brandEl = document.getElementById('brand');
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* */ } },
};

async function call(method, path, { body, ticket, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (ticket) h['X-Request-Ticket'] = ticket;
  let payload;
  if (raw) { h['Content-Type'] = 'application/octet-stream'; payload = raw; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers: h, body: payload, credentials: 'omit', cache: 'no-store' });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error((json && json.error) || t('creq.pub.err_generic'));
    e.status = res.status; e.code = json && json.code; e.data = json || {};
    throw e;
  }
  return json || {};
}

function applyBrand(b) {
  if (!b) return;
  if (b.primary_color) document.documentElement.style.setProperty('--accent', b.primary_color);
  brandEl.textContent = '';
  if (b.logo_url) {
    const img = document.createElement('img');
    img.src = b.logo_url; img.alt = b.name || ''; img.referrerPolicy = 'no-referrer';
    brandEl.appendChild(img);
  } else if (b.name) {
    const s = document.createElement('span'); s.textContent = b.name; brandEl.appendChild(s);
  }
  window.__ST_BRAND_NAME = b.name || 'ScreenTinker';
  if (!b.hide_branding) {
    const f = document.createElement('div');
    f.className = 'footer';
    f.textContent = t('creq.pub.powered');
    document.body.appendChild(f);
  }
}

function card(html) {
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = html;
  return div;
}
function show(...cards) {
  root.querySelectorAll('.card').forEach((c) => c.remove());
  for (const c of cards) root.appendChild(c);
}
function message(host, text, kind = 'err') {
  let m = host.querySelector('.msg');
  if (!m) { m = document.createElement('div'); host.appendChild(m); }
  m.className = `msg ${kind}`;
  m.textContent = text;
  m.hidden = !text;
}

/** A refusal from the server, in the requester's language where we know the code. */
function explain(e) {
  // By code, with the numbers the server sends alongside, so a refusal reads in the requester's language.
  const d = e.data || {};
  const known = {
    rate_limited: ['creq.pub.err_rate'], locked_out: ['creq.pub.err_rate'], too_many_codes: ['creq.pub.err_rate'], ticket_invalid: ['creq.pub.err_ticket'],
    markup_not_allowed: ['creq.pub.err_markup'], form_quota: ['creq.pub.err_quota'], email_quota: ['creq.pub.err_quota'], ip_quota: ['creq.pub.err_quota'],
    type_not_allowed: ['creq.pub.err_type'], bad_code: ['creq.pub.err_code'], domain_not_allowed: ['creq.pub.err_domain'], bad_email: ['creq.pub.err_email'],
    too_small: ['creq.pub.err_too_small', d], wrong_aspect: ['creq.pub.err_aspect', d], too_long: ['creq.pub.err_too_long', d],
    too_large: ['creq.pub.rule_size', { mb: d.max_mb }], lead_time: ['creq.pub.err_lead', d], window_too_long: ['creq.pub.err_window', d],
    unreadable: ['creq.pub.err_unreadable'], target_not_allowed: ['creq.pub.err_targets'], form_paused: ['creq.pub.paused'], form_closed: ['creq.pub.closed'],
    storage_full: ['creq.pub.err_storage'], not_found: ['creq.pub.not_found'],
    bad_url: ['creq.pub.err_url'], url_not_allowed: ['creq.pub.err_url_not_allowed'],
    url_domain_not_allowed: ['creq.pub.url_domains', { domains: (d.domains || []).join(', ') }],
  }[e.code];
  return known ? t(known[0], known[1]) : (e.message || t('creq.pub.err_generic'));
}

// ─── status page ─────────────────────────────────────────────────────────────────────────────

const STATE_KEYS = {
  pending: 'creq.state.pending', approved: 'creq.state.approved', scheduled: 'creq.state.scheduled', live: 'creq.state.live',
  ended: 'creq.state.ended', rejected: 'creq.state.rejected', cancelled: 'creq.state.cancelled',
};

async function renderStatus(tok) {
  document.title = t('creq.pub.status_title');
  if (!tok) { show(card(`<h1>${esc(t('creq.pub.status_title'))}</h1><p class="intro">${esc(t('creq.pub.status_missing'))}</p>`)); return; }
  let s;
  try { s = await call('POST', '/status', { body: { token: tok } }); } catch (e) {
    show(card(`<h1>${esc(t('creq.pub.status_title'))}</h1><p class="intro">${esc(explain(e))}</p>`)); return;
  }
  applyBrand(s.brand);
  const c = card(`
    <h1>${esc(s.title)}</h1>
    <span class="state ${esc(s.state)}">${esc(t(STATE_KEYS[s.state] || 'creq.state.pending'))}</span>
    <p class="intro" style="margin-top:12px">${esc(t('creq.pub.status_explain.' + s.state))}</p>
    ${s.reason ? `<div class="msg err" style="white-space:pre-wrap">${esc(t('creq.pub.reason'))}: ${esc(s.reason)}</div>` : ''}
    <dl>
      <dt>${esc(t('creq.pub.reference'))}</dt><dd>${esc(s.ref)}</dd>
      ${s.form_title ? `<dt>${esc(t('creq.pub.form'))}</dt><dd>${esc(s.form_title)}</dd>` : ''}
      <dt>${esc(t('creq.pub.dates'))}</dt><dd>${esc(t('creq.pub.date_range', { start: s.start_date, end: s.end_date }))}</dd>
      <dt>${esc(t('creq.pub.where'))}</dt><dd>${esc((s.targets || []).join(', '))}</dd>
      <dt>${esc(t('creq.pub.sent'))}</dt><dd>${esc(new Date(s.submitted_at * 1000).toLocaleString())}</dd>
    </dl>
    ${s.can_cancel ? `<button type="button" class="secondary" data-cancel>${esc(t('creq.pub.withdraw'))}</button>` : ''}`);
  show(c);
  const b = c.querySelector('[data-cancel]');
  if (b) b.addEventListener('click', async () => {
    if (!confirm(t('creq.pub.withdraw_confirm'))) return;
    b.disabled = true;
    try { await call('POST', '/status/cancel', { body: { token: tok } }); renderStatus(tok); }
    catch (e) { b.disabled = false; message(c, explain(e)); }
  });
}

// ─── the form ────────────────────────────────────────────────────────────────────────────────

let form = null;
let code = '';
const ticketKey = () => `creq.ticket.${code}`;

async function renderForm() {
  try { form = await call('GET', `/form/${encodeURIComponent(code)}`); } catch (e) {
    show(card(`<h1>${esc(t('creq.pub.not_found_title'))}</h1><p class="intro">${esc(e.status === 404 ? t('creq.pub.not_found') : explain(e))}</p>`)); return;
  }
  applyBrand(form.brand);
  document.title = form.title;
  if (form.status !== 'open') {
    show(card(`<h1>${esc(form.title)}</h1><p class="intro">${esc(t(form.status === 'paused' ? 'creq.pub.paused' : 'creq.pub.closed'))}</p>`)); return;
  }
  // Coming back from SSO: the ticket (or the reason it failed) is in the fragment. Take it and clear it.
  const frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get('ticket')) {
    store.set(ticketKey(), { ticket: frag.get('ticket'), name: frag.get('name') || '', email: frag.get('email') || '', at: Date.now() });
    history.replaceState(null, '', location.pathname);
  }
  const ssoError = frag.get('sso_error');
  if (ssoError) history.replaceState(null, '', location.pathname);
  const saved = store.get(ticketKey());
  if (saved && saved.ticket && Date.now() - saved.at < 110 * 60 * 1000) return renderRequest(saved);
  renderGate(ssoError);
}

function header() {
  return card(`<h1>${esc(form.title)}</h1>${form.intro ? `<p class="intro">${esc(form.intro)}</p>` : ''}`);
}

function renderGate(ssoError) {
  const mode = form.access_mode;
  if (mode === 'sso') {
    const c = card(`<h2>${esc(t('creq.pub.sso_title'))}</h2><p class="intro">${esc(t('creq.pub.sso_body'))}</p>
      <button type="button" data-sso ${form.sso_available ? '' : 'disabled'}>${esc(t('creq.pub.sso_button'))}</button>`);
    show(header(), c);
    if (!form.sso_available) message(c, t('creq.pub.sso_unavailable'));
    if (ssoError) message(c, t('creq.pub.sso_failed', { reason: ssoError.replace(/[^a-z_]/g, '') }));
    c.querySelector('[data-sso]').addEventListener('click', () => { location.href = `${API}/form/${encodeURIComponent(code)}/sso`; });
    return;
  }
  const domains = (form.allowed_domains || []).map((d) => '@' + d).join(', ');
  const c = card(`
    <h2>${esc(t('creq.pub.who_title'))}</h2>
    <label for="rqName">${esc(t('creq.pub.name'))}</label><input id="rqName" type="text" autocomplete="name" maxlength="80">
    <label for="rqEmail">${esc(t('creq.pub.email'))}${domains ? `<div class="hint">${esc(t('creq.pub.email_domains', { domains }))}</div>` : ''}</label>
    <input id="rqEmail" type="email" autocomplete="email" inputmode="email" maxlength="254">
    <div data-code hidden>
      <label for="rqCode">${esc(t('creq.pub.code'))}<div class="hint">${esc(t('creq.pub.code_hint'))}</div></label>
      <input id="rqCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
    </div>
    <button type="button" data-go>${esc(t(mode === 'email' ? 'creq.pub.send_code' : 'creq.pub.continue'))}</button>`);
  show(header(), c);
  if (mode === 'email' && !form.email_available) message(c, t('creq.pub.email_unavailable'));
  const go = c.querySelector('[data-go]');
  let codeSent = false;
  go.addEventListener('click', async () => {
    const name = c.querySelector('#rqName').value.trim();
    const email = c.querySelector('#rqEmail').value.trim();
    message(c, '');
    if (!name || !email) { message(c, t('creq.pub.err_who')); return; }
    go.disabled = true;
    try {
      if (mode === 'link') {
        const out = await call('POST', `/form/${encodeURIComponent(code)}/start`, { body: { name, email } });
        const s = { ticket: out.ticket, name: out.name, email: out.email, at: Date.now() };
        store.set(ticketKey(), s); renderRequest(s); return;
      }
      if (!codeSent) {
        await call('POST', `/form/${encodeURIComponent(code)}/verify`, { body: { name, email } });
        codeSent = true;
        c.querySelector('[data-code]').hidden = false;
        go.textContent = t('creq.pub.verify');
        message(c, t('creq.pub.code_sent', { email }), 'ok');
        c.querySelector('#rqCode').focus();
      } else {
        const out = await call('POST', `/form/${encodeURIComponent(code)}/verify/confirm`, { body: { email, code: c.querySelector('#rqCode').value.trim() } });
        const s = { ticket: out.ticket, name: out.name, email: out.email, at: Date.now() };
        store.set(ticketKey(), s); renderRequest(s); return;
      }
    } catch (e) { message(c, explain(e)); }
    go.disabled = false;
  });
}

function rulesText() {
  const r = form.file_rules || {};
  const parts = [];
  const kinds = (r.kinds || []).filter((k) => k !== 'web').map((k) => t('creq.kind.' + k)).join(t('creq.pub.or'));
  if (kinds) parts.push(kinds);
  if (r.max_mb) parts.push(t('creq.pub.rule_size', { mb: r.max_mb }));
  if (r.min_width && r.min_height) parts.push(t('creq.pub.rule_min', { w: r.min_width, h: r.min_height }));
  else if (r.min_width) parts.push(t('creq.pub.rule_min_w', { w: r.min_width }));
  else if (r.min_height) parts.push(t('creq.pub.rule_min_h', { h: r.min_height }));
  if (r.aspect) parts.push(t('creq.pub.rule_aspect', { aspect: r.aspect }));
  if (r.max_video_sec && (r.kinds || []).includes('video')) parts.push(t('creq.pub.rule_video', { sec: r.max_video_sec }));
  return parts.join(' · ');
}

function renderRequest(who) {
  const f = form.fields || {};
  const opt = (mode) => (mode === 'required' ? '' : ` <span class="hint">(${esc(t('creq.pub.optional'))})</span>`);
  const kinds = form.file_rules.kinds || [];
  const fileKinds = kinds.filter((k) => k !== 'web');
  // #792: a form may take a website as well as (or instead of) a file. With both, the requester picks.
  const takesWeb = kinds.includes('web');
  const takesFile = fileKinds.length > 0;
  const webDomains = form.file_rules.web_domains || [];
  const accept = fileKinds.map((k) => (k === 'image' ? 'image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp' : 'video/mp4,video/webm,video/quicktime')).join(',');
  const c = card(`
    <h2>${esc(t('creq.pub.request_title'))}</h2>
    <p class="hint">${esc(t('creq.pub.signed_as', { name: who.name || who.email, email: who.email }))} <a href="#" data-switch>${esc(t('creq.pub.not_you'))}</a></p>
    <label for="rqTitle">${esc(t('creq.pub.what'))}</label><input id="rqTitle" type="text" maxlength="120">
    <label>${esc(t('creq.pub.where_q'))}</label>
    <div class="choices" data-targets>${form.targets.map((tg) => `<label class="choice"><input type="checkbox" value="${esc(tg.id)}" ${form.targets.length === 1 ? 'checked' : ''}> ${esc(tg.label)}</label>`).join('')}</div>
    <div class="row">
      <div><label for="rqStart">${esc(t('creq.pub.start'))}</label><input id="rqStart" type="date" min="${esc(form.earliest_start)}" value="${esc(form.earliest_start)}"></div>
      <div><label for="rqEnd">${esc(t('creq.pub.end'))}</label><input id="rqEnd" type="date" min="${esc(form.earliest_start)}"></div>
    </div>
    ${form.lead_days ? `<p class="hint">${esc(t('creq.pub.lead', { n: form.lead_days, date: form.earliest_start }))}</p>` : ''}
    ${f.audience !== 'off' ? `<label for="rqAudience">${esc(t('creq.pub.audience'))}${opt(f.audience)}</label><input id="rqAudience" type="text" maxlength="300">` : ''}
    ${f.notes !== 'off' ? `<label for="rqNotes">${esc(t('creq.pub.notes'))}${opt(f.notes)}</label><textarea id="rqNotes" maxlength="2000"></textarea>` : ''}
    ${takesWeb && takesFile ? `<label>${esc(t('creq.pub.send_what'))}</label>
    <div class="choices"><label class="choice"><input type="radio" name="rqKind" value="file" checked> ${esc(t('creq.pub.send_file'))}</label><label class="choice"><input type="radio" name="rqKind" value="web"> ${esc(t('creq.pub.send_web'))}</label></div>` : ''}
    ${takesFile ? `<div data-part="file"><label for="rqFile">${esc(t('creq.pub.file'))}<div class="hint">${esc(rulesText())}</div></label>
    <input id="rqFile" type="file" accept="${esc(accept)}"></div>` : ''}
    ${takesWeb ? `<div data-part="web" ${takesFile ? 'hidden' : ''}><label for="rqUrl">${esc(t('creq.pub.url'))}<div class="hint">${esc(webDomains.length ? t('creq.pub.url_domains', { domains: webDomains.join(', ') }) : t('creq.pub.url_hint'))}</div></label>
    <input id="rqUrl" type="url" inputmode="url" maxlength="2048" placeholder="https://"></div>` : ''}
    <div class="bar" hidden><div></div></div>
    <button type="button" data-submit>${esc(t('creq.pub.submit'))}</button>`);
  show(header(), c);
  c.querySelector('[data-switch]').addEventListener('click', (e) => { e.preventDefault(); store.del(ticketKey()); renderGate(); });
  const btn = c.querySelector('[data-submit]');
  const bar = c.querySelector('.bar'), fill = bar.firstElementChild;
  const sendingWeb = () => (takesWeb && takesFile ? (c.querySelector('input[name="rqKind"]:checked') || {}).value === 'web' : takesWeb);
  c.querySelectorAll('input[name="rqKind"]').forEach((r) => r.addEventListener('change', () => {
    c.querySelector('[data-part="file"]').hidden = sendingWeb();
    c.querySelector('[data-part="web"]').hidden = !sendingWeb();
  }));
  btn.addEventListener('click', async () => {
    message(c, '');
    const val = (id) => { const el = c.querySelector(id); return el ? el.value.trim() : ''; };
    const web = sendingWeb();
    const fileEl = c.querySelector('#rqFile');
    const file = !web && fileEl ? fileEl.files[0] : null;
    const targets = [...c.querySelectorAll('[data-targets] input:checked')].map((i) => i.value);
    const body = { title: val('#rqTitle'), start_date: val('#rqStart'), end_date: val('#rqEnd'), targets, audience: val('#rqAudience'), notes: val('#rqNotes') };
    if (!body.title) { message(c, t('creq.pub.err_title')); return; }
    if (!targets.length) { message(c, t('creq.pub.err_targets_none')); return; }
    if (!body.start_date || !body.end_date) { message(c, t('creq.pub.err_dates')); return; }
    if (web) {
      const url = val('#rqUrl');
      let ok = false;
      try { ok = /^https?:$/.test(new URL(url).protocol); } catch { ok = false; }
      if (!ok) { message(c, t('creq.pub.err_url')); return; }
      btn.disabled = true;
      btn.textContent = t('creq.pub.sending');
      try {
        renderDone(await call('POST', `/form/${encodeURIComponent(code)}/submit`, { body: { ...body, url }, ticket: who.ticket }));
      } catch (e) {
        if (e.code === 'ticket_invalid') { store.del(ticketKey()); renderGate(); return; }
        message(c, explain(e));
        btn.disabled = false; btn.textContent = t('creq.pub.submit');
      }
      return;
    }
    if (!file) { message(c, t('creq.pub.err_file')); return; }
    if (form.file_rules.max_mb && file.size > form.file_rules.max_mb * 1048576) { message(c, t('creq.pub.rule_size', { mb: form.file_rules.max_mb })); return; }
    btn.disabled = true;
    bar.hidden = false;
    try {
      const id = await uploadFile(who.ticket, file, (p) => { fill.style.width = `${Math.round(p * 100)}%`; btn.textContent = t('creq.pub.uploading', { pct: Math.round(p * 100) }); });
      btn.textContent = t('creq.pub.sending');
      const out = await call('POST', `/form/${encodeURIComponent(code)}/submit`, { body: { ...body, upload_id: id }, ticket: who.ticket });
      store.del(`creq.upload.${code}`);
      renderDone(out);
    } catch (e) {
      if (e.code === 'ticket_invalid') { store.del(ticketKey()); renderGate(); return; }
      // A refused file is gone on the server; forget it so the next try starts clean.
      if (['type_not_allowed', 'too_small', 'wrong_aspect', 'too_long', 'unreadable', 'too_large'].includes(e.code)) store.del(`creq.upload.${code}`);
      message(c, explain(e));
      btn.disabled = false; btn.textContent = t('creq.pub.submit');
    }
  });
}

/*
 * Resumable upload. The server owns the offset (it is the size of the bytes on its disk), so after a
 * dropped connection the client asks where it is and carries on; a reload resumes the same file if
 * the same file is picked again (same name, size and modified time).
 */
async function uploadFile(ticket, file, progress) {
  const key = `creq.upload.${code}`;
  const sig = `${file.name}|${file.size}|${file.lastModified}`;
  let id = null, offset = 0, chunk = form.chunk_size || 1048576;
  const prev = store.get(key);
  if (prev && prev.sig === sig) {
    try { const s = await call('GET', `/form/${encodeURIComponent(code)}/uploads/${prev.id}`, { ticket }); id = prev.id; offset = s.offset; chunk = s.chunk_size || chunk; } catch { id = null; }
  }
  if (!id) {
    const s = await call('POST', `/form/${encodeURIComponent(code)}/uploads`, { body: { filename: file.name, size: file.size }, ticket });
    id = s.id; offset = 0; chunk = s.chunk_size || chunk;
    store.set(key, { id, sig });
  }
  let failures = 0;
  while (offset < file.size) {
    progress(offset / file.size);
    try {
      const out = await call('PATCH', `/form/${encodeURIComponent(code)}/uploads/${id}`, { raw: file.slice(offset, offset + chunk), ticket, headers: { 'Upload-Offset': String(offset) } });
      offset = out.offset; failures = 0;
    } catch (e) {
      if (e.status && e.status !== 409 && e.status < 500 && e.status !== 429) throw e;
      if (++failures > 8) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** failures)));
      if (e.status === 409 && e.data && Number.isFinite(e.data.offset)) offset = e.data.offset;
      else { try { offset = (await call('GET', `/form/${encodeURIComponent(code)}/uploads/${id}`, { ticket })).offset; } catch { /* retry */ } }
    }
  }
  progress(1);
  return id;
}

function renderDone(out) {
  const link = `${location.origin}${out.status_path}`;
  const c = card(`
    <h2>${esc(t('creq.pub.done_title'))}</h2>
    <p class="intro">${esc(t('creq.pub.done_body'))}</p>
    <div class="ref">${esc(out.ref)}</div>
    <label>${esc(t('creq.pub.status_link'))}<div class="hint">${esc(t('creq.pub.status_link_hint'))}</div></label>
    <div class="link" data-link></div>
    <button type="button" data-copy>${esc(t('creq.pub.copy_link'))}</button>
    <button type="button" class="secondary" data-another>${esc(t('creq.pub.another'))}</button>`);
  c.querySelector('[data-link]').textContent = link;
  show(header(), c);
  c.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); message(c, t('creq.pub.copied'), 'ok'); } catch { message(c, link, 'ok'); }
  });
  c.querySelector('[data-another]').addEventListener('click', () => { const s = store.get(ticketKey()); if (s) renderRequest(s); else renderGate(); });
}

// ─── entry ───────────────────────────────────────────────────────────────────────────────────

document.getElementById('loading').textContent = t('common.loading');
const parts = location.pathname.split('/').filter(Boolean);
if (parts[0] === 'r' && parts[1] === 'status') {
  const tok = location.hash.slice(1);
  renderStatus(/^[A-Za-z0-9_-]{30,100}$/.test(tok) ? tok : '');
} else {
  code = parts[1] || '';
  renderForm();
}
