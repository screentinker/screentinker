import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../components/toast.js';

/*
 * Servers — the connected servers themselves: their screens, the shape of the graph, and pairing.
 *
 * ⚠️ ALERTS AND THE UPTIME REPORT USED TO LIVE HERE AND DELIBERATELY DO NOT ANY MORE.
 *
 * A mesh-only alert inbox is a second place to look for one question — "what is wrong right now" —
 * and the moment there are two, the one an operator does not have open is the one with the answer.
 * Alerts belong on ONE screen that happens to include remote sites (Activity). The uptime report is
 * a report, and Reports is where somebody goes looking for one; filing it under Servers means you
 * have to already know the feature is mesh-shaped in order to find it.
 *
 * ⚠️ NODES ARE NOT SCREENS. A server is not a display and does not belong in the Displays list.
 * Remote DEVICES are a different matter — those now appear under their own org in the ordinary
 * Displays view, because to an operator a screen is a screen wherever it is plugged in.
 *
 * ⚠️ EVERY REMOTE ROW SHOWS ITS AGE. This screen reports on machines over links that fail
 * independently of them, so "online" without "as of when" is a claim the reader cannot check.
 */

let state = {
  tab: 'fleet',
  nodes: [], devices: [], total: 0, search: '', offset: 0, limit: 50,
};

/* live | stale | down | unknown → the dot, the word, and what it means. */
const STATUS_UI = {
  live:    { dot: '#22c55e', label: 'Online' },
  down:    { dot: '#ef4444', label: 'Offline' },
  // ⚠️ Amber, NOT red. Red says "this screen is broken"; amber says "we cannot currently see it".
  // Sending an engineer to a working site is the failure this colour exists to prevent.
  stale:   { dot: '#f59e0b', label: 'Last known' },
  unknown: { dot: '#94a3b8', label: 'Not reported' },
};

function ago(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const hhmm = (sec) => (sec == null ? '' : new Date(sec * 1000).toLocaleString());

/*
 * ⚠️ A node id is a UUID, and a full one in every row is unreadable — it pushes the columns an
 * operator actually reads off the screen and gives nothing back, because nobody distinguishes two
 * UUIDs by eye. Shortened for display with the full value on hover, so it stays recoverable when
 * somebody genuinely needs it. Not a CSS ellipsis: that hides WHICH end was kept, and the leading
 * characters are the half people compare.
 */
const shortId = (id) => (id ? String(id).slice(0, 8) : '');
const idBadge = (id) => (id
  ? `<span class="badge" title="${esc(id)}" style="font-family:monospace">${esc(shortId(id))}</span>`
  : '<span style="color:var(--text-muted)">—</span>');

/*
 * ⚠️ THE HOUSE TABLE STYLE, not an invented class. This view shipped using `class="data-table"`,
 * which exists in no stylesheet — so every table rendered completely unstyled: columns bunched
 * against the left edge, no padding, no header rule, two thirds of the width unused. The
 * source-level tests could not see it, because the markup was perfectly well-formed; it just
 * referred to a class nobody had written.
 *
 * Every other view wraps a table in `.table-wrap` (which supplies only horizontal scroll) and
 * styles it inline. Matching that is what makes this screen look like the rest of the app.
 */
const TH = 'padding:8px;text-align:left;color:var(--text-muted);font-weight:600;white-space:nowrap';
const TD = 'padding:8px;vertical-align:middle';
const TABLE_S = 'width:100%;border-collapse:collapse;font-size:13px;min-width:520px';
const ROW = 'border-bottom:1px solid var(--border)';

const table = (headers, rowsHtml, empty = 'Nothing to show.') => `
  <div class="table-wrap">
    <table style="${TABLE_S}">
      <thead><tr style="${ROW}">
        ${headers.map((h) => `<th style="${TH}">${esc(h)}</th>`).join('')}
      </tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${headers.length}"
        style="padding:16px;text-align:center;color:var(--text-muted)">${esc(empty)}</td></tr>`}</tbody>
    </table>
  </div>`;

function statusCell(d) {
  const ui = STATUS_UI[d.status] || STATUS_UI.unknown;
  return `
    <span class="status-dot" style="background:${ui.dot};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>
    <span>${esc(ui.label)}</span>
    <!-- ⚠️ The age sits on EVERY row, not only stale ones: a green dot from ninety minutes ago is a
         lie by omission, and the reader has no other way to tell. -->
    <span style="color:var(--text-muted);font-size:11px;margin-left:6px">${esc(ago(d.asOfAgeSec))}</span>`;
}

function nodeCard(n) {
  const online = n.devicesOnline == null
    // ⚠️ "—", never 0. Zero is a measurement; not knowing is not, and 0/40 tells an operator the
    // whole site is dark when the truth is that we lost contact with the observer.
    ? `<span title="This server is not currently reachable, so its screen count is the last one received">—</span>`
    : `${n.devicesOnline}`;
  return `
    <div class="info-card">
      <div class="info-card-label" title="${esc(n.nodeId || '')}"
           style="font-family:monospace">${esc(shortId(n.nodeId))}</div>
      <div class="info-card-value">${online} / ${n.devicesTotal}</div>
      <div style="font-size:11px;color:var(--text-muted)">
        ${n.version ? esc(n.version) : ''}
        ${n.stale ? ' · <span style="color:var(--warning,#f59e0b)">not reachable</span>' : ''}
        ${n.openAlerts ? ` · ${n.openAlerts} open` : ''}
      </div>
    </div>`;
}

/*
 * ⚠️ NO "OPEN ON ITS SERVER" LINK, deliberately removed. It was what made a read-only hub useful
 * while remote objects were a dead end here — but sending an operator to another server, under a
 * different login, to act on something they are already looking at is a worse answer than letting
 * them act where they are. Remote orgs are selectable locally now and writes are relayed to the
 * server that owns the screen, so the link would only be a second, worse path to the same thing —
 * and the one people click first, because it is right there on the row.
 */
function deviceRow(d) {
  return `
    <tr style="${ROW}">
      <td style="${TD}">${d.name ? esc(d.name)
        // A health-only grant sends no name. Saying so beats an empty cell that reads as a bug.
        : '<span style="color:var(--text-muted);font-style:italic">not shared</span>'}</td>
      <!-- ⚠️ The origin server is its OWN column, never concatenated into the name. Folding it in
           ("Lobby (Acme)") breaks sort and search for every row at once. -->
      <td style="${TD}">${idBadge(d.originNodeId)}</td>
      <td style="${TD}">${statusCell(d)}</td>
    </tr>`;
}

const TABS = [
  ['fleet', 'Screens'],
  ['topology', 'Topology'],
  /*
   * ⚠️ WHO MAY ACT ON WHICH CUSTOMER. Platform staff only, and hidden entirely otherwise — an
   * ordinary technician has no business seeing the shape of the client list, only the clients they
   * were named on.
   */
  ['clients', 'Clients & access'],
  ['connect', 'Reporting upward'],
];

export async function render(container) {
  /*
   * ⚠️ REMEMBERED, NOT REDISCOVERED. Re-rendering after enrolling used to look the container up with
   * `panel.closest('#viewContainer')` — an id that does not exist anywhere in this app; the real one
   * is `#app`. closest() returned null, the `|| document.body` fallback took over, and render()
   * replaced the ENTIRE PAGE with this view: sidebar, banners and all. It looked like the app had
   * half-reloaded, and only a hard refresh put it back.
   *
   * A fallback that "works" by targeting something enormous is worse than no fallback: it turns a
   * wrong selector into a plausible-looking screen instead of an error anybody would notice.
   */
  state._container = container;
  /*
   * ⚠️ TWO DIFFERENT ACTIONS THAT WERE WRONGLY ONE TAB.
   *
   * Handing out a pairing code (this server accepting an observer) and reporting upward (this
   * server becoming one) are opposite directions, gated by different flags, and used by different
   * people at different times. Bundling them meant a hub — which can only ever do the first — grew
   * a "Connect" tab whose second half read "this server is not configured for that".
   *
   * So: minting is a HEADER ACTION, the way adding a display is on Displays, because it is the
   * ordinary next thing to do on this page. The tab is now only the report-upward side, and appears
   * only when MESH_ALLOW_UPLINK is on — or when an uplink already exists, which is NOT optional: a
   * link that exists must stay visible and severable from below, or turning the flag off afterwards
   * would be a way to hide an MSP relationship from the client subject to it.
   */
  let connect = { canEnroll: false, canMint: false, uplinks: [] };
  try { connect = await api.get('/mesh/capabilities'); } catch (e) { /* enrollment not mounted */ }
  const showConnect = connect.canEnroll || (connect.uplinks || []).length > 0;
  // Same source the admin views read. The tab is a convenience: every route behind it re-checks
  // platform staff server-side, so hiding it is about not offering what cannot be used.
  const meRole = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role; } catch (e) { return null; }
  })();
  const isStaff = ['platform_admin', 'platform_operator'].includes(meRole);
  /*
   * ⚠️ NARROWER THAN isStaff, ON PURPOSE. The route behind Rename is requireInstanceOwner
   * (platform_admin only), the same tier as minting a pairing code, because this name is displayed
   * on every peer's dashboard - including another organisation's. Offering the button to an
   * operator whose PUT will 403 is how a UI teaches people to distrust it.
   */
  const isOwner = meRole === 'platform_admin';
  /*
   * ⚠️ THE HUB TABS ARE HIDDEN ON A NODE THAT IS NOT A HUB.
   *
   * Screens and Topology read /api/mesh/nodes and /api/mesh/topology, and those routes exist only
   * where MESH_ACCEPT_ENROLLMENT is set — a node that hosts nobody does not mount them at all,
   * deliberately (I1: an install that never set the flag should not be able to tell the mesh
   * exists). So on a leaf site both tabs rendered "Could not load: Not found", which reads as a
   * broken product rather than a feature that does not apply.
   *
   * The remaining tab is the one that does apply: what this server reports UPWARD.
   */
  const isHub = !!connect.canMint;
  const tabs = TABS.filter(([id]) => {
    if (id === 'connect') return showConnect;
    if (id === 'clients') return isStaff && isHub;
    if (id === 'fleet' || id === 'topology') return isHub;
    return true;
  });
  // A leaf's landing tab is its uplink, since the hub views are not there to fall back to.
  if (!isHub && (state.tab === 'fleet' || state.tab === 'topology')) {
    state.tab = showConnect ? 'connect' : 'fleet';
  }
  if (state.tab === 'connect' && !showConnect) state.tab = 'fleet';
  if (state.tab === 'clients' && !(isStaff && connect.canMint)) state.tab = 'fleet';

  container.innerHTML = `
    <div class="page-header">
      <div><h1>${esc(t('nav.servers'))}</h1>
        <div class="subtitle">Other ScreenTinker servers connected to this one.</div></div>
      ${connect.canMint ? `
        <button class="btn btn-primary" id="connectServerBtn">+ Connect a server</button>` : ''}
    </div>
    <!--
      ⚠️ THIS SERVER'S OWN NAME, IN THE HEADER, ON EVERY TAB.
      Not tucked into the pairing panel: on a LEAF there is no pairing panel and no hub tabs, and a
      leaf is where the name matters most - it is what the MSP's dashboard calls this site. Under
      the title is the one place present in both shapes of this page.
    -->
    <div id="selfIdentity" class="settings-section"
         style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="color:var(--text-muted);font-size:13px">This server is</span>
      <strong id="selfName" style="font-size:14px">${esc(connect.nodeName || 'unnamed')}</strong>
      ${connect.nodeId ? idBadge(connect.nodeId) : ''}
      ${connect.nodeNameIsDefault ? `
        <span style="color:var(--text-muted);font-size:12px">
          &mdash; taken from the hostname; peers show this name</span>` : ''}
      ${isOwner ? `
        <button class="btn btn-secondary btn-sm" id="renameSelfBtn" style="margin-left:auto">
          Rename</button>` : ''}
    </div>
    <div id="renameSelfPanel"></div>
    <div id="mintPanel"></div>
    <div id="serversTabs" style="display:flex;gap:4px;margin-bottom:16px">
      ${tabs.map(([id, label]) => `
        <button class="btn btn-sm ${state.tab === id ? 'btn-primary' : 'btn-secondary'}"
                data-tab="${id}">${esc(label)}</button>`).join('')}
    </div>
    <div id="serversPanel"></div>`;

  container.querySelector('#serversTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    render(container);
  });

  container.querySelector('#renameSelfBtn')?.addEventListener('click', () => {
    const host = container.querySelector('#renameSelfPanel');
    if (host.innerHTML) { host.innerHTML = ''; return; }   // toggle, never stack a second copy
    host.innerHTML = `
      <div class="settings-section" style="margin-bottom:16px">
        <label style="display:block;font-size:13px;margin-bottom:6px">What should this server be
          called?</label>
        <!--
          ⚠️ maxlength MATCHES THE 60 THE SERVER ENFORCES. A field that accepts more than the
          setter stores would silently truncate an operator's name, and they would find out from
          somebody else's dashboard.
        -->
        <input class="input" id="renameSelfInput" maxlength="60" style="max-width:320px"
               value="${esc(connect.nodeName || '')}">
        <p style="color:var(--text-muted);font-size:12px;margin:8px 0 0">
          Every server this one reports to will show this name. It reaches them on the next report,
          not instantly, and it changes nothing about what they are allowed to see.</p>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary btn-sm" id="renameSelfSave">Save</button>
          <span id="renameSelfMsg" style="font-size:12px"></span>
        </div>
      </div>`;
    const input = host.querySelector('#renameSelfInput');
    const msg = host.querySelector('#renameSelfMsg');
    input.focus();
    input.select();

    const save = async () => {
      const name = input.value.trim();
      // Refused here as well as on the server: a round trip to be told the field is empty is a
      // worse answer than not making it.
      if (!name) { msg.textContent = 'A server needs a name.'; msg.style.color = 'var(--danger)'; return; }
      msg.textContent = 'Saving...';
      msg.style.color = 'var(--text-muted)';
      try {
        await api.put('/mesh/identity', { name });
        // Re-render from the top so the header, and anything else reading the name, agree.
        render(container);
      } catch (e) {
        msg.textContent = (e && e.message) || 'Could not save the name.';
        msg.style.color = 'var(--danger)';
      }
    };
    host.querySelector('#renameSelfSave').addEventListener('click', save);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
  });

  container.querySelector('#connectServerBtn')?.addEventListener('click', () => {
    const host = container.querySelector('#mintPanel');
    // Toggle: a second click puts it away rather than stacking another copy.
    if (host.innerHTML) { host.innerHTML = ''; return; }
    renderMintPanel(host, connect);
  });

  const panel = container.querySelector('#serversPanel');
  if (state.tab === 'topology') return renderTopology(panel);
  if (state.tab === 'clients') return renderClients(panel);
  if (state.tab === 'connect') return renderConnect(panel, connect);
  return renderFleet(panel);
}


/* ===================== clients & access ===================== */

/*
 * ⚠️ WITHOUT THIS THE WRITE PATH IS UNREACHABLE.
 *
 * canWriteToNode resolves a role through mesh_clients / mesh_client_access, and until the routes
 * behind this page existed nothing in the product could create a row in either table — so the check
 * could never pass, for anybody, on any install. A permission model with no way to grant permission
 * refuses everyone, and it looks exactly like a bug in the transport.
 *
 * Two separate decisions on one page, deliberately not merged:
 *   which customer a linked server belongs to  — filing
 *   which of OUR staff may act on that customer — authority
 * They have different blast radii. Filing a server under the wrong client shows somebody data they
 * should not see; naming somebody publisher lets them change a hospital's screens.
 */
async function renderClients(panel) {
  panel.innerHTML = '<div style="color:var(--text-muted)">Loading…</div>';
  let clients = []; let nodes = []; let users = []; let orgs = [];
  try {
    [clients, nodes, users, orgs] = await Promise.all([
      api.get('/mesh/clients'),
      api.get('/mesh/nodes').then((r) => r.nodes || []),
      api.getUsers().catch(() => []),
      // Carries what each child has ANNOUNCED it will accept — writable, and how much storage is
      // left. Never what this hub decided for itself.
      api.get('/mesh/orgs').then((r) => r.orgs || r || []).catch(() => []),
    ]);
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    return;
  }

  const unassigned = nodes.filter((n) => !n.clientId);

  panel.innerHTML = `
    ${(orgs || []).filter((o) => o.writable).length > 1 ? `
    <div class="settings-section">
      <h3 style="margin-top:0">Send content to several customers</h3>
      <!-- ⚠️ Only offered when more than one customer has actually granted it. Showing a
           multi-send with one eligible target is a control that cannot do anything the single
           send does not, and the single send is where an operator already is. -->
      <p style="color:var(--text-muted);font-size:12px;margin:0 0 10px">
        One campaign, several sites. Each server fetches it itself and checks its own permission —
        this is a shortcut for you, not extra access.
      </p>
      <div id="batchTargets" style="max-height:160px;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:6px">
        ${(orgs || []).filter((o) => o.writable).map((o) => `
          <label style="display:block;font-size:13px;margin:2px 0">
            <input type="checkbox" data-batch-target="${esc(o.nodeId)}" data-ws="${esc(o.workspaceId || '')}">
            ${esc(o.name)} <span style="color:var(--text-muted)">${esc(o.serverName || '')}</span>
          </label>`).join('')}
      </div>
      <div id="batchContent" style="margin-top:8px"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-secondary btn-sm" id="batchPick">Choose content…</button>
        <button class="btn btn-secondary btn-sm" id="batchSend">Send to selected</button>
        <span id="batchOut" style="font-size:12px"></span>
      </div>
      <div id="batchResults" style="margin-top:8px;font-size:12px"></div>
    </div>` : ''}

    <div class="settings-section">
      <h3 style="margin-top:0">Customers</h3>
      <p style="color:var(--text-muted);font-size:12px;margin:0 0 10px">
        A customer groups the servers you look after for one organisation. Your staff see the
        customers they are named on and no others.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="newClientName" class="input" placeholder="Customer name" style="max-width:260px">
        <button class="btn btn-secondary btn-sm" id="addClientBtn">Add customer</button>
      </div>
      <div id="clientOut" style="margin-top:8px"></div>
    </div>

    ${unassigned.length ? `
    <div class="settings-section" style="margin-top:16px">
      <h3 style="margin-top:0">Servers not filed under a customer</h3>
      <!-- ⚠️ Called out rather than left in a list, because an unfiled server is writable by NOBODY
           — which is the right default, and an invisible one if the page does not say so. -->
      <p style="color:var(--text-muted);font-size:12px;margin:0 0 8px">
        These report to you but belong to no customer yet, so nobody can act on them.
      </p>
      ${unassigned.map((n) => `
        <div style="display:flex;gap:8px;align-items:center;padding:6px 0">
          <span style="flex:1">${esc(n.serverName || n.nodeId)}</span>
          <select class="input" data-assign-node="${esc(n.nodeId)}" style="max-width:220px">
            <option value="">— choose a customer —</option>
            ${clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>`).join('')}
    </div>` : ''}

    ${clients.map((c) => `
      <div class="settings-section" style="margin-top:16px">
        <h3 style="margin-top:0">${esc(c.name)}</h3>
        <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">
          ${c.nodes.length ? `${c.nodes.length} server${c.nodes.length === 1 ? '' : 's'}` : 'No servers filed here yet'}
        </div>

        ${c.nodes.map((nodeId) => {
          const org = (orgs || []).find((o) => o.nodeId === nodeId) || {};
          const spaces = (orgs || []).filter((o) => o.nodeId === nodeId);
          const remaining = org.writeOffer && typeof org.writeOffer.bytesBudget === 'number'
            ? ` — ${fmtBytes(org.writeOffer.bytesRemaining)} of storage left`
            : '';
          return `
          <div style="padding:6px 0;border-top:1px solid var(--border)">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="flex:1">${esc(org.serverName || nodeId)}</span>
              ${org.writable
                /* ⚠️ Offered only when the CUSTOMER has granted it. The button's absence is the
                   honest state — an operator who can press it and always be refused learns
                   nothing, because the refusal is deliberately indistinguishable from "no such
                   thing". */
                ? `<button class="btn btn-secondary btn-sm" data-send-to="${esc(nodeId)}">Send content</button>`
                : '<span class="badge">read-only — they have not granted changes</span>'}
            </div>
            <div style="color:var(--text-muted);font-size:12px">
              ${org.writable ? `You may change playlists on this server${remaining}.` : ''}
            </div>
            <div data-send-panel="${esc(nodeId)}" style="margin-top:8px"></div>
          </div>`;
        }).join('')}

        ${c.access.length ? c.access.map((a) => `
          <div style="display:flex;gap:8px;align-items:center;padding:4px 0">
            <span style="flex:1">${esc(a.name || a.email || a.user_id)}</span>
            <span class="badge">${esc(a.role)}</span>
            <button class="btn btn-secondary btn-sm"
                    data-revoke-access="${esc(c.id)}" data-user="${esc(a.user_id)}">Remove</button>
          </div>`).join('')
          : '<div style="color:var(--text-muted);font-size:12px">Nobody is named on this customer.</div>'}

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
          <select class="input" data-grant-user="${esc(c.id)}" style="max-width:240px">
            <option value="">— choose a colleague —</option>
            ${users.map((u) => `<option value="${esc(u.id)}">${esc(u.name || u.email)}</option>`).join('')}
          </select>
          <select class="input" data-grant-role="${esc(c.id)}" style="max-width:180px">
            <option value="viewer">viewer — see their data</option>
            <option value="manager">manager — manage the link</option>
            <option value="publisher">publisher — change their screens</option>
          </select>
          <button class="btn btn-secondary btn-sm" data-grant="${esc(c.id)}">Add</button>
        </div>
        <!-- ⚠️ Says the two things about publisher that are easy to get wrong, on the control that
             grants it: it does not inherit down a hierarchy, and it is still the customer's call. -->
        <div style="color:var(--text-muted);font-size:12px;margin-top:6px">
          Publisher is never inherited — it must be granted on this customer directly. Even then,
          the customer's own server decides what it accepts, and can revoke at any time.
        </div>
        <div data-client-out="${esc(c.id)}" style="margin-top:8px"></div>
      </div>`).join('')}`;

  const reload = () => renderClients(panel);

  panel.querySelector('#batchPick')?.addEventListener('click', async () => {
    const host = panel.querySelector('#batchContent');
    if (host.innerHTML) { host.innerHTML = ''; return; }
    host.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Loading your content…</div>';
    let mine = [];
    try { mine = await api.get('/content'); } catch (e) { mine = []; }
    host.innerHTML = mine.length
      ? `<div style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:6px">
           ${mine.map((c) => `
             <label style="display:block;font-size:13px;margin:2px 0">
               <input type="checkbox" data-batch-item="${esc(c.id)}"> ${esc(c.filename)}
               <span style="color:var(--text-muted)">${esc(fmtBytes(c.file_size || 0))}</span>
             </label>`).join('')}
         </div>`
      : '<div style="color:var(--text-muted);font-size:12px">Your library is empty.</div>';
  });

  panel.querySelector('#batchSend')?.addEventListener('click', async () => {
    const out = panel.querySelector('#batchOut');
    const results = panel.querySelector('#batchResults');
    const targets = [...panel.querySelectorAll('input[data-batch-target]:checked')]
      .map((c) => ({ node_id: c.dataset.batchTarget, workspace_id: c.dataset.ws }));
    const contentIds = [...panel.querySelectorAll('input[data-batch-item]:checked')]
      .map((c) => c.dataset.batchItem);
    if (!targets.length) { out.textContent = 'Choose which customers to send to.'; return; }
    if (!contentIds.length) { out.textContent = 'Choose some content first.'; return; }

    out.textContent = `Sending to ${targets.length}…`;
    results.innerHTML = '';
    try {
      const r = await api.post('/mesh/content', { targets, content_ids: contentIds });
      out.textContent = `${r.sent} sent${r.failed ? `, ${r.failed} failed` : ''}.`;
      /*
       * ⚠️ Listed per customer, always — including on full success. Across forty sites a few will
       * be offline, and "38 sent" without naming the other two leaves the operator to either
       * re-send to everyone or guess. Naming them is the only version they can act on.
       */
      results.innerHTML = (r.results || []).map((x) => `
        <div style="padding:2px 0">
          <span class="badge">${x.ok ? 'sent' : 'failed'}</span>
          ${esc(x.nodeId)}${x.ok
            ? ` — ${x.stored} stored${x.alreadyHeld ? `, ${x.alreadyHeld} already there` : ''}`
            : ` — ${esc(x.reason || 'no reason given')}`}
        </div>`).join('');
    } catch (e) {
      out.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
    }
  });

  panel.querySelector('#addClientBtn')?.addEventListener('click', async () => {
    const name = panel.querySelector('#newClientName').value.trim();
    const out = panel.querySelector('#clientOut');
    if (!name) { out.textContent = 'Give the customer a name.'; return; }
    try { await api.post('/mesh/clients', { name }); reload(); }
    catch (e) { out.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
  });

  panel.querySelectorAll('[data-assign-node]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      try {
        await api.put(
          `/mesh/clients/${encodeURIComponent(sel.value)}/nodes/${encodeURIComponent(sel.dataset.assignNode)}`, {});
        showToast('Filed.');
        reload();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });

  panel.querySelectorAll('[data-grant]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.grant;
      const user = panel.querySelector(`[data-grant-user="${CSS.escape(id)}"]`).value;
      const role = panel.querySelector(`[data-grant-role="${CSS.escape(id)}"]`).value;
      const out = panel.querySelector(`[data-client-out="${CSS.escape(id)}"]`);
      if (!user) { out.textContent = 'Choose a colleague first.'; return; }
      try { await api.put(`/mesh/clients/${encodeURIComponent(id)}/access`, { user_id: user, role }); reload(); }
      catch (e) { out.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
    });
  });

  /*
   * ⚠️ SENDING CONTENT IS TWO CHOICES, AND BOTH HAVE TO BE MADE EXPLICITLY.
   *
   * Which files, and which of the CUSTOMER's workspaces they are for. The second is not a detail:
   * a server may hold several customers' workspaces, and depositing a campaign in the wrong one
   * puts one client's material on another client's screens. The child re-checks it against its own
   * grant and refuses if it is outside — but "the far end will catch it" is not a reason to make it
   * easy to get wrong here.
   */
  panel.querySelectorAll('[data-send-to]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nodeId = btn.dataset.sendTo;
      const host = panel.querySelector(`[data-send-panel="${CSS.escape(nodeId)}"]`);
      if (host.innerHTML) { host.innerHTML = ''; return; }   // toggle

      host.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Loading your content…</div>';
      let mine = [];
      try { mine = await api.get('/content'); } catch (e) { mine = []; }
      // Remote and YouTube items travel as rows with no bytes; uploads are the interesting case.
      const spaces = (orgs || []).filter((o) => o.nodeId === nodeId);

      host.innerHTML = `
        <div style="border:1px solid var(--border);border-radius:6px;padding:10px">
          <label style="display:block;font-size:13px;margin-bottom:8px">
            Into which of their workspaces
            <select class="input" data-send-ws style="max-width:280px;margin-left:8px">
              ${spaces.map((o) => `<option value="${esc(o.workspaceId || '')}">${esc(o.name)}</option>`).join('')}
            </select>
          </label>
          ${mine.length ? `
            <div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:6px">
              ${mine.map((c) => `
                <label style="display:block;font-size:13px;margin:2px 0">
                  <input type="checkbox" data-send-item="${esc(c.id)}"> ${esc(c.filename)}
                  <span style="color:var(--text-muted)">${esc(fmtBytes(c.file_size || 0))}</span>
                </label>`).join('')}
            </div>`
            : '<div style="color:var(--text-muted);font-size:12px">Your library is empty.</div>'}
          <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
            <button class="btn btn-secondary btn-sm" data-send-go="${esc(nodeId)}">Send</button>
            <span data-send-out style="font-size:12px"></span>
          </div>
          <!-- ⚠️ Says the two things an operator cannot see from here: transfers are slow by
               nature over these links, and the customer's server has the final say. -->
          <div style="color:var(--text-muted);font-size:12px;margin-top:6px">
            Large files can take a while — their server fetches them itself and resumes if the link
            drops. It will refuse anything beyond the storage they have granted.
          </div>
        </div>`;

      host.querySelector('[data-send-go]').addEventListener('click', async () => {
        const out = host.querySelector('[data-send-out]');
        const ids = [...host.querySelectorAll('input[data-send-item]:checked')].map((c) => c.dataset.sendItem);
        const ws = host.querySelector('[data-send-ws]')?.value;
        if (!ids.length) { out.textContent = 'Choose some content first.'; return; }
        if (!ws) { out.textContent = 'Choose a workspace on their server.'; return; }
        out.textContent = 'Sending…';
        try {
          const r = await api.post(`/mesh/content/${encodeURIComponent(nodeId)}`,
                                   { content_ids: ids, workspace_id: ws });
          /*
           * ⚠️ Reported per item. "Mostly worked" is the answer that gets a playlist published with
           * a hole in it, and the operator is not standing in front of the screen.
           */
          const stored = (r.stored || []).length;
          const held = (r.alreadyHeld || []).length;
          out.textContent = `Sent ${stored} file(s)${held ? `, ${held} already there` : ''}.`;
          showToast('Content sent.');
        } catch (e) {
          out.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
        }
      });
    });
  });

  panel.querySelectorAll('[data-revoke-access]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      // An empty role removes the row — the same shape as revoking a write grant with an empty
      // category list, so "take it away" never means "sever something else".
      try {
        await api.put(`/mesh/clients/${encodeURIComponent(btn.dataset.revokeAccess)}/access`,
                      { user_id: btn.dataset.user, role: '' });
        reload();
      } catch (e) { showToast(e.message, 'error'); }
    });
  });
}

/* ===================== the fleet ===================== */

async function renderFleet(panel) {
  panel.innerHTML = `
    <div id="serversRollup" class="info-grid"></div>
    <div class="settings-section" style="margin-top:16px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input id="serverSearch" class="input" placeholder="Search screens across all servers"
               style="max-width:340px" value="${esc(state.search)}">
        <span id="serversCount" style="color:var(--text-muted);font-size:12px"></span>
      </div>
      <div id="serversNote" style="color:var(--text-muted);font-size:12px;margin-bottom:8px"></div>
      <div id="serversTable"></div>
      <div id="serversPager" style="margin-top:12px;display:flex;gap:8px"></div>
    </div>`;

  panel.querySelector('#serverSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    state.offset = 0;              // a new search starts at the beginning, not mid-fleet
    clearTimeout(state._t);
    // Debounced: the query is server-side and bounded, so a keystroke per request is real load on
    // the hub for a term the operator has not finished typing.
    state._t = setTimeout(() => loadFleet(panel), 250);
  });

  await loadFleet(panel);
}

async function loadFleet(panel) {
  try {
    const [nodes, devices] = await Promise.all([
      api.get('/mesh/nodes'),
      api.get(`/mesh/devices?search=${encodeURIComponent(state.search)}` +
              `&limit=${state.limit}&offset=${state.offset}`),
    ]);
    state.nodes = nodes.nodes || [];
    state.devices = devices.devices || [];
    state.total = devices.total || 0;

    panel.querySelector('#serversRollup').innerHTML =
      state.nodes.map(nodeCard).join('') ||
      '<p style="color:var(--text-muted)">No servers are connected to this one yet.</p>';

    panel.querySelector('#serversTable').innerHTML =
      table(['Screen', 'Server', 'Status'], state.devices.map(deviceRow).join(''), 'No screens matched.');

    panel.querySelector('#serversCount').textContent =
      state.total ? `${state.total} screen${state.total === 1 ? '' : 's'}` : '';

    // ⚠️ The search caveat is rendered when the server sends one: a health-only grant has no names
    // to match, and without saying so the empty result reads as a broken search.
    panel.querySelector('#serversNote').textContent = devices.searchNote || '';

    renderPager(panel);
  } catch (e) {
    panel.querySelector('#serversTable').innerHTML =
      `<p style="color:var(--text-muted)">Could not load: ${esc(e.message || 'unknown error')}</p>`;
  }
}

function renderPager(panel) {
  const el = panel.querySelector('#serversPager');
  const pages = Math.ceil(state.total / state.limit);
  if (pages <= 1) { el.innerHTML = ''; return; }
  const page = Math.floor(state.offset / state.limit) + 1;
  el.innerHTML = `
    <button class="btn btn-secondary btn-sm" ${state.offset === 0 ? 'disabled' : ''} id="pgPrev">Previous</button>
    <span style="color:var(--text-muted);font-size:12px;align-self:center">Page ${page} of ${pages}</span>
    <button class="btn btn-secondary btn-sm" ${page >= pages ? 'disabled' : ''} id="pgNext">Next</button>`;
  el.querySelector('#pgPrev')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit); loadFleet(panel);
  });
  el.querySelector('#pgNext')?.addEventListener('click', () => {
    state.offset += state.limit; loadFleet(panel);
  });
}

/* ===================== the topology ===================== */

async function renderTopology(panel) {
  panel.innerHTML = '<p style="color:var(--text-muted)">Loading topology…</p>';
  let data;
  try {
    data = await api.get('/mesh/topology');
  } catch (e) {
    panel.innerHTML = `<p style="color:var(--text-muted)">Could not load: ${esc(e.message)}</p>`;
    return;
  }

  const edges = data.edges || [];
  const indirect = data.indirect || [];
  /*
   * ⚠️ VERSION SKEW IS MEASURED AGAINST THE MOST COMMON VERSION, not against this server's. A hub
   * that has not been upgraded yet would otherwise mark its entire healthy fleet as skewed, which
   * is the fastest way to teach an operator to ignore the column.
   */
  const counts = new Map();
  for (const e of edges) if (e.peerVersion) counts.set(e.peerVersion, (counts.get(e.peerVersion) || 0) + 1);
  const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const FRESH = {
    live: ['#22c55e', 'healthy'],
    stale: ['#f59e0b', 'not reachable'],
    unknown: ['#94a3b8', 'never synced'],
  };

  /*
   * ⚠️ HOW MANY SERVERS A SCREEN'S DATA CROSSES TO REACH HERE — the question this page could not
   * answer at all.
   *
   * The table below lists this node's own links, which is the whole picture only in a two-tier
   * mesh. With a relay in the middle it looked identical to having no relay: one row saying "we are
   * paired with B", and nothing to say whether B is a site with two screens or a regional server
   * with a dozen sites behind it.
   *
   * Hops counts LINKS, not servers, because that is what people mean: 1 is somewhere you are paired
   * with directly, 2 is somewhere behind one of those. The path is shown nearest-first so it reads
   * the way you would trace it.
   */
  /*
   * ⚠️ A TREE, BECAUSE THE SHAPE IS THE POINT.
   *
   * Two tables answer "who am I paired with" and "who is further away" separately, and an operator
   * then has to hold the structure in their head to see that C sits under B while D sits beside it.
   * That is precisely the thing they came to this page to find out, so the page should draw it.
   *
   * Built from what is already known rather than from a new query: direct edges are the first
   * level, and every indirect node hangs off whichever node relayed it. Drawn with box-drawing
   * characters rather than SVG — it survives being copied into a support ticket, reads the same in
   * a screenshot, and has no layout to get wrong at four levels deep.
   */
  const childrenOf = new Map();
  for (const e of edges) {
    if (!childrenOf.has(null)) childrenOf.set(null, []);
    childrenOf.get(null).push({ id: e.peerNodeId, freshness: e.freshness, version: e.peerVersion, hops: 1 });
  }
  for (const n of indirect) {
    const parent = n.viaNodeId || null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push({ id: n.nodeId, freshness: null, version: null, hops: n.hops });
  }

  const FRESHDOT = { live: '#22c55e', stale: '#f59e0b', unknown: '#94a3b8' };
  const treeLines = [];
  const walk = (parentId, prefix) => {
    const kids = childrenOf.get(parentId) || [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      const dot = k.freshness
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${FRESHDOT[k.freshness] || FRESHDOT.unknown};margin-right:6px"></span>`
        // A relayed node's health is its own server's business; what this node knows is the route.
        : '<span style="display:inline-block;width:8px;margin-right:6px"></span>';
      treeLines.push(`<div style="white-space:pre;line-height:1.7">` +
        `<span style="color:var(--text-muted)">${prefix}${last ? '└─ ' : '├─ '}</span>` +
        `${dot}<code>${esc(String(k.id).slice(0, 8))}</code>` +
        `<span style="color:var(--text-muted);font-size:12px">` +
        `  ${k.hops} ${k.hops === 1 ? 'hop' : 'hops'}` +
        `${k.version ? ` · ${esc(k.version)}` : ''}` +
        `${k.hops > 1 ? ' · reached through the server above' : ''}</span></div>`);
      walk(k.id, prefix + (last ? '   ' : '│  '));
    });
  };
  walk(null, '');

  const hopRows = indirect.map((n) => `
    <tr style="${ROW}">
      <td style="${TD}">${idBadge(n.nodeId)}</td>
      <td style="${TD}">
        <strong>${n.hops}</strong>
        <span style="color:var(--text-muted);font-size:12px">
          ${n.hops === 1 ? 'link — paired directly' : `links — through ${n.hops - 1} other server${n.hops > 2 ? 's' : ''}`}
        </span>
      </td>
      <td style="${TD};font-size:12px">
        this server → ${[...(n.path || [])].map((id, i) => (i === (n.path.length - 1)
          ? `<strong>${esc(String(id).slice(0, 8))}</strong>`
          : esc(String(id).slice(0, 8)))).join(' → ')}
      </td>
      <td style="${TD};font-size:12px">${esc(n.viaName || String(n.viaNodeId || '').slice(0, 8) || '—')}</td>
    </tr>`).join('');

  const rows = edges.map((e) => {
    const [colour, word] = FRESH[e.freshness] || FRESH.unknown;
    const skew = e.peerVersion && modal && e.peerVersion !== modal;
    return `
      <tr style="${ROW}">
        <td style="${TD}">${idBadge(e.peerNodeId)}</td>
        <td style="${TD}">${e.clientId ? esc(e.clientId)
          // Unassigned edges are visible to instance owners only; saying so beats a blank cell.
          : '<span style="color:var(--text-muted);font-style:italic">unassigned</span>'}</td>
        <td style="${TD}">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colour};margin-right:6px"></span>${esc(word)}</td>
        <td style="${TD}">${esc(e.peerVersion || '—')}
          ${skew ? '<span class="badge" style="background:var(--warning,#f59e0b)">skew</span>' : ''}</td>
        <td style="${TD};font-size:12px">${esc((e.grant || []).join(', ') || 'nothing')}</td>
        <td style="${TD};font-size:12px">${esc(e.transportDirection || '')}
          ${e.tlsVerify === false
            // ⚠️ Surfaced, not hidden. An edge with certificate checking off is a decision somebody
            // made once and nobody revisits unless a screen shows it.
            ? '<span class="badge" style="background:#ef4444">TLS unverified</span>' : ''}</td>
        <td style="${TD}">${esc(e.lastSyncAt ? hhmm(e.lastSyncAt) : 'never')}</td>
      </tr>`;
  }).join('');

  panel.innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px">
      <div><div style="color:var(--text-muted);font-size:11px">Connected servers</div>
           <div style="font-size:20px">${edges.length}</div></div>
      <!-- ⚠️ Servers BEYOND the ones this node is paired with. Counted separately because "we are
           connected to 1 server" and "there are 4 servers in this estate" are different facts, and
           conflating them is what made a relay invisible. -->
      <div><div style="color:var(--text-muted);font-size:11px">Servers further down</div>
           <div style="font-size:20px">${indirect.length}</div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Deepest path</div>
           <div style="font-size:20px">${(edges.length ? 1 : 0) && indirect.length
             ? Math.max(1, ...indirect.map((n) => n.hops)) : (edges.length ? 1 : 0)}
             <span style="font-size:12px;color:var(--text-muted)">hop(s)</span></div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Depth limit</div>
           <!-- Stated, because "why can't I add a server under that one" is otherwise an
                unanswerable question from the UI. -->
           <div style="font-size:20px">${data.depthCap ?? '—'}</div></div>
      <div><div style="color:var(--text-muted);font-size:11px">Common version</div>
           <div style="font-size:20px">${esc(modal || '—')}</div></div>
    </div>
    ${treeLines.length ? `
    <div class="settings-section">
      <h3 style="margin-top:0">The shape of this estate</h3>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">
        <div style="line-height:1.7"><strong>this server</strong></div>
        ${treeLines.join('')}
      </div>
    </div>` : ''}

    <div class="settings-section" style="margin-top:16px">
      <h3 style="margin-top:0">Servers paired with this one</h3>
      ${table(['Server', 'Client', 'Link', 'Version', 'Shares', 'Transport', 'Last sync'],
              rows, 'No servers are connected.')}
    </div>

    ${indirect.length ? `
    <div class="settings-section" style="margin-top:16px">
      <h3 style="margin-top:0">Servers reached through another server</h3>
      <!-- ⚠️ Says how it knows, because "where did this row come from" is the immediate question
           about a server you never paired with. It is not a claim anybody made — it is the route
           their data demonstrably took to arrive. -->
      <p style="color:var(--text-muted);font-size:12px;margin:0 0 10px">
        Learned from the path their reports actually travelled, not from anything they declared.
      </p>
      ${table(['Server', 'Distance', 'Route', 'Reached through'], hopRows, '')}
    </div>` : ''}`;
}

/* ===================== connecting servers ===================== */

/*
 * ⚠️ The grant vocabulary is spelled out for a HUMAN, ordered by how much it gives away. An
 * operator ticking boxes is deciding what another company may learn about their customer's
 * premises, and "health, identity, network-wan" means nothing at the moment of that decision.
 */
const GRANTS = [
  ['health', 'Whether screens are alive and how they are coping', ''],
  ['identity', 'What each screen is called and what it runs', 'Without this, screens appear as opaque ids and cannot be searched by name.'],
  ['network-lan', 'Private addresses on the local network', 'Useful for on-site support. Does not identify the site to an outsider.'],
  ['display', 'What the screen hardware is doing', ''],
  ['content-metadata', 'What is scheduled to play', ''],
  ['proof-of-play', 'Evidence that specific content played at specific times', 'Never thinned in transit, so it stays usable as evidence — and costs more bandwidth at depth.'],
  ['diagnostics', 'Why something went wrong', ''],
  ['network-wan', 'The public internet address the screens appear from', '⚠️ Locates the premises — a public address is geolocatable to a town or building.'],
  ['display-capture', 'Actual images of what is on screen', '⚠️ Screenshots may contain whatever was on the screen, including anything private behind it.'],
  // Scale-out (docs/scale-out.md). Last, because it is everything above and the content too. The
  // consent sentence about secrets stays HERE, next to the tick, not in a help page.
  ['workspace-replication', 'A complete, live copy of the shared workspaces, so this server can serve their dashboards',
    '⚠️ Everything in those workspaces — screens, playlists, content, schedules, members — is copied here and kept current. Passwords, tokens and secrets are never copied. This server becomes a read-only replica: every change made here is forwarded to the other server (PRIMARY_URL), and if that server is unreachable, changes fail while reads continue.'],
];

/*
 * Handing out a pairing code. A header action rather than a tab, because on a hub it is the
 * ordinary next thing an operator does on this page — the same reasoning as "+ Add Display".
 */
function renderMintPanel(host, caps) {
  host.innerHTML = `
    <div class="settings-section" style="margin-bottom:16px">
      <h3 style="margin-top:0">Let another server report to this one</h3>
      <!-- ⚠️ The NAME leads. It is what the other side will see in its switcher once the two are
           paired, so it is the field to read before handing a code over — not the UUID. -->
      <p style="color:var(--text-muted);font-size:12px">This server is
        <strong>${esc(caps.nodeName || 'unnamed')}</strong> ${caps.nodeId ? idBadge(caps.nodeId) : ''}.
        Generate a code, then enter it on the other server along with this one's address. The code
        can be used once and expires shortly.</p>
      <!-- ⚠️ The grant is chosen HERE, by the side giving the data — never requested by the side
           redeeming the code. Otherwise whoever holds a code could ask for everything. -->
      <div id="grantList" style="margin:12px 0">
        ${GRANTS.map(([id, summary, warn], i) => `
          <label style="display:block;margin-bottom:6px;font-size:13px">
            <input type="checkbox" value="${id}" ${i === 0 ? 'checked' : ''}>
            <strong>${esc(summary)}</strong>
            ${warn ? `<div style="margin-left:22px;color:var(--text-muted);font-size:11px">${esc(warn)}</div>` : ''}
          </label>`).join('')}
        <!-- Scale-out C2 (docs/scale-out.md). A ROLE this server takes on, not data it receives, so
             it sits apart from the grant list: only meaningful with the copy above, and only DOES
             anything once the other server's operator grants player-events on their side. -->
        <label id="terminatesPlayers" style="display:block;margin:10px 0 0 22px;font-size:13px;opacity:.55">
          <input type="checkbox" value="terminates-players" disabled>
          <strong>Also let screens connect to this server</strong>
          <div style="margin-left:22px;color:var(--text-muted);font-size:11px">Screens in the copied workspaces can be pointed at this server. They are verified by the other server (their tokens stay there), play from the copy here, and report back through this server. Needs the copy above, and the other server's operator must then allow it under "What this server may change" on their side.</div>
        </label>
      </div>
      <button class="btn btn-primary btn-sm" id="mintBtn">Generate a pairing code</button>
      <div id="mintOut" style="margin-top:12px"></div>
    </div>`;

  // The role tick follows the copy tick: no copy, nothing to terminate players from.
  const replBox = host.querySelector('#grantList input[value="workspace-replication"]');
  const termWrap = host.querySelector('#terminatesPlayers');
  const termBox = termWrap.querySelector('input');
  const syncTerm = () => { termBox.disabled = !replBox.checked; if (!replBox.checked) termBox.checked = false; termWrap.style.opacity = replBox.checked ? '1' : '.55'; };
  replBox.addEventListener('change', syncTerm); syncTerm();

  host.querySelector('#mintBtn').addEventListener('click', async () => {
    const grant = [...host.querySelectorAll('#grantList input:checked')].map((c) => c.value).filter((v) => v !== 'terminates-players');
    const out = host.querySelector('#mintOut');
    try {
      // A replication grant is what makes THIS server a replica of the other: it takes on the
      // serves-dashboard role for the code, alongside the ordinary telemetry consumer role.
      // terminates-players (C2) rides on top of that when ticked.
      const capabilities = grant.includes('workspace-replication')
        ? ['serves-dashboard', ...(termBox.checked ? ['terminates-players'] : []), 'consumes-telemetry']
        : ['consumes-telemetry'];
      const r = await api.post('/mesh/pair/code', { grant, capabilities });
      out.innerHTML = `
        <div style="font-size:28px;letter-spacing:4px;font-family:monospace">${esc(r.code)}</div>
        <div style="color:var(--text-muted);font-size:12px">
          Valid until ${esc(hhmm(r.expiresAt))}, once. The other server will see this one as
          <strong>${esc(r.nodeName || '')}</strong>.<br>It will be allowed to see:
          ${esc((r.grantDescription || r.grant || []).join(' '))}
        </div>`;
    } catch (e) {
      out.innerHTML = `<span style="color:var(--text-muted)">${esc(e.message)}</span>`;
    }
  });
}

/*
 * Which of this server's workspaces travel up the new edge.
 *
 * ⚠️ "ALL" IS THE INSTANCE OWNER'S CHOICE ALONE, and it is worded to say what it really means:
 * workspaces that do not exist yet are included too. Anyone else picks from the workspaces they
 * administer — a member must not be able to expose a colleague's workspace just because they can
 * log in to the same server.
 */
async function renderScopeBox(panel) {
  const box = panel.querySelector('#scopeBox');
  if (!box) return;
  let data;
  try { data = await api.get('/mesh/shareable-workspaces'); } catch (e) { box.innerHTML = ''; return; }

  const list = data.workspaces || [];
  if (!list.length) {
    box.innerHTML = '<p style="color:var(--text-muted);font-size:12px">' +
      'You do not administer any workspaces on this server, so there is nothing you can share.</p>';
    return;
  }

  box.innerHTML = `
    <div style="font-size:13px;margin-bottom:6px"><strong>What to share</strong></div>
    ${data.canShareAll ? `
      <label style="display:block;margin-bottom:8px;font-size:13px">
        <input type="checkbox" id="shareAll">
        Every workspace on this server
        <div style="margin-left:22px;color:var(--text-muted);font-size:11px">
          ⚠️ Includes workspaces created later. Only you can choose this.
        </div>
      </label>` : `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">
        Sharing every workspace is limited to the instance owner. These are the ones you administer.
      </p>`}
    <div id="wsList">
      ${list.map((w) => `
        <label style="display:block;margin-bottom:4px;font-size:13px">
          <input type="checkbox" data-ws="${esc(w.id)}">
          ${esc(w.name)}${w.organization_name
            ? ` <span style="color:var(--text-muted)">· ${esc(w.organization_name)}</span>` : ''}
        </label>`).join('')}
    </div>`;

  // Ticking "all" disables the individual boxes rather than hiding them: the operator can still see
  // exactly what "all" currently covers, which is the thing they are agreeing to.
  box.querySelector('#shareAll')?.addEventListener('change', (e) => {
    box.querySelectorAll('#wsList input[data-ws]').forEach((c) => {
      c.disabled = e.target.checked;
      c.parentElement.style.opacity = e.target.checked ? 0.5 : 1;
    });
  });
}


/*
 * ⚠️ THE CONSENT CONTROL. WITHOUT IT NOTHING ELSE IN THE WRITE FEATURE IS REACHABLE.
 *
 * The route that grants write access existed with no caller, and this tab rendered no trace of it,
 * so a customer who linked read-only last month saw a screen identical to the one they saw before
 * write existed. Every write on every install was refused for want of a grant nobody could give.
 *
 * Three things are stated before anything is ticked, because this is the screen where somebody
 * gives away control of their own screens:
 *   - what it currently is, in plain language, including nothing;
 *   - both costs — what can change, and how much disk it may take;
 *   - how much of that disk is already gone, which is only ever visible here.
 *
 * ⚠️ `writeBytesRemaining` is 0 rather than null when no budget is set — deliberately, so a
 * careless renderer says "0 left" rather than "unlimited". So the budget is checked FIRST and the
 * figure is not shown at all when there is none.
 */
function writeGrantBlock(u, caps) {
  const cats = caps.writeCategories || {};
  const granted = u.writeGrant || [];
  const hasBudget = typeof u.writeBytesBudget === 'number';
  const pct = hasBudget && u.writeBytesBudget > 0
    ? Math.min(100, Math.round((u.writeBytesUsed / u.writeBytesBudget) * 100)) : 0;

  const state = granted.length
    ? `<span class="badge badge-warn">can change your screens</span>`
    : `<span class="badge">read-only — this server cannot be changed from there</span>`;

  const rows = Object.entries(cats).map(([name, meta]) => {
    const unavailable = meta.available === false;
    return `
      <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;${unavailable ? 'opacity:.55' : ''}">
        <input type="checkbox" data-wcat="${esc(name)}" ${granted.includes(name) ? 'checked' : ''}
               ${unavailable ? 'disabled' : ''} style="margin-top:3px">
        <span>
          <strong>${esc(meta.summary || name)}</strong>
          ${unavailable ? ' <span class="badge">not supported yet</span>' : ''}
          <br><span style="color:var(--text-muted);font-size:12px">${esc(meta.consequence || '')}</span>
        </span>
      </label>`;
  }).join('');

  return `
    <details class="mesh-write-grant" data-edge="${esc(u.edgeId)}" style="margin-top:10px" ${granted.length ? 'open' : ''}>
      <summary style="cursor:pointer;font-size:13px">What this server may change here — ${state}</summary>

      <div style="margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:6px">
        ${granted.length ? `
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
            ${(u.writeGrantExplained || []).map((line) => esc(line)).join('<br>')}
            ${hasBudget ? `<br>Storage used: <strong>${esc(fmtBytes(u.writeBytesUsed))}</strong>
              of ${esc(fmtBytes(u.writeBytesBudget))} (${pct}%).` : ''}
          </div>` : ''}

        ${rows}

        <div data-wscope style="margin-top:10px"></div>

        <label style="display:block;margin-top:10px;font-size:13px">
          Storage it may use for content it sends you
          <input class="input" type="number" min="1" step="1" data-wbudget
                 value="${hasBudget ? Math.max(1, Math.round(u.writeBytesBudget / (1024 ** 3))) : ''}"
                 placeholder="e.g. 20" style="max-width:120px;margin-left:8px"> GB
        </label>
        <!-- ⚠️ Says why the number is compulsory. An operator asked only "whose screens" answers
             "how much of my disk" by default, and the default would be all of it. -->
        <div style="color:var(--text-muted);font-size:12px;margin-top:4px">
          Sending content means storing it here, so this is required. Lowering it never deletes
          anything on its own.
        </div>

        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" data-wsave="${esc(u.edgeId)}">Save</button>
          ${granted.length ? `<button class="btn btn-secondary btn-sm" data-wrevoke="${esc(u.edgeId)}">
             Revoke write access</button>` : ''}
        </div>
        <!-- ⚠️ Severing is a different act and says so, because "revoke" reads like "disconnect"
             and an operator who wanted only to stop the writing must not lose the reporting. -->
        <div style="color:var(--text-muted);font-size:12px;margin-top:6px">
          Revoking write access keeps the connection and keeps reporting upward. Anything already
          sent here stays until you remove it.
        </div>
        <div data-wout style="margin-top:8px"></div>
      </div>

      <!-- ⚠️ ON THE SAME PANEL AS THE GRANT, because "what did they do with it" is the second
           question every operator asks and there was nowhere to ask it. Collapsed by default: it
           is a record to consult, not a thing to read every visit. -->
      <!-- ⚠️ ITS OWN CONTROL, not folded into the write grant. This is the only consent on this page
           that concerns a server the operator has no relationship with — whoever their parent
           reports to — and agreeing to it by agreeing to something else is exactly how a consent
           screen stops being true. -->
      <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:13px">
        <input type="checkbox" data-shareup="${esc(u.edgeId)}" ${u.shareUpward ? 'checked' : ''}
               style="margin-top:3px">
        <span>
          <strong>Let this server pass your screens further up</strong><br>
          <span style="color:var(--text-muted);font-size:12px">
            If they report to a server of their own, yours will appear there too — showing what you
            already share here, attributed to this server. Off by default.
          </span>
        </span>
      </label>

      <!-- ⚠️ Next to the budget, because "18 GB of 20 GB used" is only actionable if the operator
           can see what the 18 GB IS. Without this the allowance could only go up in practice,
           however correctly the refund worked. -->
      ${hasBudget ? `
      <details class="mesh-stored" data-stored-edge="${esc(u.edgeId)}" style="margin-top:8px">
        <summary style="cursor:pointer;font-size:13px">What this server is storing here</summary>
        <div data-stored-body style="margin-top:8px;font-size:12px;color:var(--text-muted)">Loading…</div>
      </details>` : ''}

      <details class="mesh-write-log" data-log-edge="${esc(u.edgeId)}" style="margin-top:8px">
        <summary style="cursor:pointer;font-size:13px">What this server has changed here</summary>
        <div data-log-body style="margin-top:8px;font-size:12px;color:var(--text-muted)">Loading…</div>
      </details>
    </details>`;
}

/** Bytes for humans. Mirrors grants.describeBytes on the server so both sides read the same. */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return 'nothing';
  const GB = 1024 ** 3; const MB = 1024 ** 2;
  if (v >= GB) return `${Math.round((v / GB) * 10) / 10} GB`;
  if (v >= MB) return `${Math.round(v / MB)} MB`;
  return `${v} bytes`;
}

async function renderConnect(panel, caps) {
  const uplinks = caps.uplinks || [];

  panel.innerHTML = `
    <div class="settings-section">
      <h3 style="margin-top:0">This server</h3>
      <!-- ⚠️ The NAME leads and the id follows. The name is what the other side will see in its
           switcher once these two are paired, so it is the field an operator should read before
           handing a code over — not the UUID, which nobody recognises. -->
      <p style="font-size:14px;margin:0 0 4px"><strong>${esc(caps.nodeName || 'unnamed')}</strong></p>
      <p style="color:var(--text-muted);font-size:12px">Other servers will see this name.
        Its id in the mesh is
        ${caps.nodeId ? idBadge(caps.nodeId) : '<span class="badge">not assigned yet</span>'} —
        generated here and registered nowhere, since there is no central directory.</p>
    </div>

    ${caps.canEnroll ? `
    <div class="settings-section" style="margin-top:16px">
      <h3 style="margin-top:0">Report this server to another one</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="parentUrl" class="input" placeholder="https://hub.example.com" style="max-width:280px">
        <input id="pairCode" class="input" placeholder="pairing code" style="max-width:180px">
      </div>
      <!-- ⚠️ WHAT GOES UP IS CHOSEN HERE, by the side giving the data. The grant says which FIELDS
           travel; this says which WORKSPACES do, and they are different questions — an MSP watching
           one customer's screens has no business seeing another customer on the same box. -->
      <div id="scopeBox" style="margin-top:12px"></div>
      <button class="btn btn-secondary btn-sm" id="enrollBtn" style="margin-top:12px">Connect</button>
      <div id="enrollOut" style="margin-top:8px"></div>
    </div>` : ''}

    ${uplinks.length ? `
    <div class="settings-section" style="margin-top:16px">
      <h3 style="margin-top:0">This server reports to</h3>
      <!-- ⚠️ Consent from below: always listed, whatever the flags say. A link that exists must be
           visible and severable by the operator subject to it — otherwise turning MESH_ALLOW_UPLINK
           back off would be a way to hide an MSP relationship from the client. -->
      ${uplinks.map((u) => `
        <div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div><strong>${esc(u.parentName || `server ${String(u.parentNodeId || '').slice(0, 8)}`)}</strong>
            ${idBadge(u.parentNodeId)}
            ${u.revoked ? '<span class="badge">severed</span>' : ''}</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:4px">
            ${esc(u.parentUrl || '')}<br>
            Shares: ${esc((u.sharing || []).join(', ') || 'nothing')}<br>
            Workspaces: ${u.sharedWorkspaces === null || u.sharedWorkspaces === undefined
              // ⚠️ Spelled out. An empty list here would read as "nothing is shared", which is the
              // opposite of what null means.
              ? '<strong>all, including any created later</strong>'
              : esc(String(u.sharedWorkspaces.length)) + ' selected'}<br>
            Last synced: ${u.lastSyncAt ? esc(hhmm(Math.floor(u.lastSyncAt / 1000))) : 'never'}
          </div>
          ${u.revoked ? '' : writeGrantBlock(u, caps)}
          ${u.revoked ? '' :
            `<button class="btn btn-secondary btn-sm" data-sever="${esc(u.edgeId)}"
                     style="margin-top:8px">Stop reporting</button>`}
        </div>`).join('')}
    </div>` : ''}`;

  // The workspace picker, filled from what this user may actually offer.
  if (caps.canEnroll) renderScopeBox(panel);

  panel.querySelector('#enrollBtn')?.addEventListener('click', async () => {
    const out = panel.querySelector('#enrollOut');
    out.textContent = 'Connecting…';
    try {
      const shareAll = !!panel.querySelector('#shareAll')?.checked;
      const r = await api.post('/mesh/uplink', {
        parentUrl: panel.querySelector('#parentUrl').value,
        code: panel.querySelector('#pairCode').value,
        selfUrl: window.location.origin,
        shareAllWorkspaces: shareAll,
        workspaceIds: shareAll ? []
          : [...panel.querySelectorAll('#scopeBox input[data-ws]:checked')].map((c) => c.dataset.ws),
      });
      out.innerHTML = `<span style="color:var(--text-muted)">Connected to
        <strong>${esc(r.parentName || r.parentNodeId)}</strong>.</span>`;
      // Re-render the SECTION, into the container we were handed.
      setTimeout(() => { if (state._container) render(state._container); }, 1200);
    } catch (e) {
      // ⚠️ The other server's refusal text is shown VERBATIM. It is written to be actionable
      // ("codes expire and may be used once"), and replacing it with a generic failure would
      // discard the only explanation the operator is going to get.
      out.innerHTML = `<span style="color:var(--text-muted)">${esc(e.message)}</span>`;
    }
  });

  panel.querySelectorAll('[data-sever]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const r = await api.delete(`/mesh/uplink/${encodeURIComponent(btn.dataset.sever)}`);
        showToast(r.note || 'Stopped reporting.');
        renderConnect(panel, await api.get('/mesh/capabilities'));
      } catch (e) { showToast(e.message, 'error'); }
    });
  });

  /*
   * The workspace picker inside each write-grant block, filled from what THIS user may actually
   * grant. Same source as the enrolment picker — /mesh/shareable-workspaces returns only workspaces the
   * caller owns or administers, and the route re-checks that server-side, so this list is a
   * convenience rather than the enforcement.
   *
   * ⚠️ No "all workspaces" option, deliberately, and this differs from the sharing picker above.
   * Sharing all is a defensible default for visibility; writing to all — including workspaces
   * created later, which nobody has considered yet — is not something to be able to tick once.
   */
  panel.querySelectorAll('.mesh-write-grant').forEach(async (box) => {
    const holder = box.querySelector('[data-wscope]');
    if (!holder) return;
    const edgeId = box.dataset.edge;
    const current = (caps.uplinks || []).find((u) => u.edgeId === edgeId) || {};
    const chosen = new Set(current.writeWorkspaces || []);
    try {
      const r = await api.get('/mesh/shareable-workspaces');
      const list = r.workspaces || [];
      holder.innerHTML = list.length
        ? `<div style="font-size:13px;margin-bottom:4px">Which workspaces it may write to</div>` +
          list.map((w) => `
            <label style="display:block;font-size:13px;margin:2px 0">
              <input type="checkbox" data-wws="${esc(w.id)}" ${chosen.has(w.id) ? 'checked' : ''}>
              ${esc(w.name)}${w.organization_name ? ` <span style="color:var(--text-muted)">— ${esc(w.organization_name)}</span>` : ''}
            </label>`).join('')
        : '<div style="color:var(--text-muted);font-size:12px">You do not administer any workspace here.</div>';
    } catch (e) {
      holder.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Could not load workspaces.</div>';
    }
  });

  const saveGrant = async (edgeId, body, box) => {
    const out = box.querySelector('[data-wout]');
    out.textContent = 'Saving…';
    try {
      const r = await api.put(`/mesh/uplink/${encodeURIComponent(edgeId)}/write-grant`, body);
      /*
       * ⚠️ The server's own consequence lines are shown, not a local paraphrase. They are written
       * where the rule is enforced, so they cannot drift out of step with what was actually
       * granted — and this is the sentence the operator is agreeing to.
       */
      showToast(r.note || 'Saved.');
      out.innerHTML = (r.consequences || []).map((c) => `<div style="font-size:12px">${esc(c)}</div>`).join('');
      renderConnect(panel, await api.get('/mesh/capabilities'));
    } catch (e) {
      out.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
    }
  };

  /*
   * Loaded on first open rather than with the page: most visits never open it, and a customer with
   * a busy hub should not pay for a query they did not ask for on every render.
   */
  panel.querySelectorAll('[data-shareup]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        const r = await api.put(`/mesh/uplink/${encodeURIComponent(cb.dataset.shareup)}/share-upward`,
                                { allow: cb.checked });
        showToast(r.note || 'Saved.');
      } catch (e) {
        cb.checked = !cb.checked;   // put it back: the server did not accept it
        showToast(e.message, 'error');
      }
    });
  });

  panel.querySelectorAll('.mesh-stored').forEach((box) => {
    box.addEventListener('toggle', async () => {
      if (!box.open || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      const body = box.querySelector('[data-stored-body]');
      try {
        const r = await api.get(`/mesh/uplink/${encodeURIComponent(box.dataset.storedEdge)}/content`);
        const items = r.items || [];
        body.innerHTML = items.length
          ? `<div style="margin-bottom:6px">
               ${esc(fmtBytes(r.totalBytes))} stored${r.unusedBytes
                 /* Named separately because it is the number an operator can act on. */
                 ? ` — <strong>${esc(fmtBytes(r.unusedBytes))} of it is not used by any playlist</strong>` : ''}.
             </div>
             <div style="max-height:220px;overflow:auto">${items.map((i) => `
               <div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border)">
                 <span style="flex:1">${esc(i.filename || i.localId)}</span>
                 <span>${esc(fmtBytes(i.bytes))}</span>
                 <span class="badge">${i.inUse ? 'in use' : 'unused'}</span>
               </div>`).join('')}</div>
             <div style="margin-top:6px">${esc(r.note || '')}</div>`
          : `<div>That server has not stored anything here.</div>`;
      } catch (e) {
        body.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
      }
    });
  });

  panel.querySelectorAll('.mesh-write-log').forEach((box) => {
    box.addEventListener('toggle', async () => {
      if (!box.open || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      const body = box.querySelector('[data-log-body]');
      try {
        const r = await api.get(`/mesh/uplink/${encodeURIComponent(box.dataset.logEdge)}/activity`);
        const rows = r.entries || [];
        body.innerHTML = rows.length
          ? `<div style="max-height:240px;overflow:auto">${rows.map((e) => `
              <div style="padding:4px 0;border-bottom:1px solid var(--border)">
                <span class="badge">${e.applied ? 'applied' : 'refused'}</span>
                ${esc(e.what)}
                <div style="font-size:11px">${e.at ? esc(new Date(e.at).toLocaleString()) : ''}</div>
              </div>`).join('')}</div>
             <div style="margin-top:6px">${esc(r.note || '')}</div>`
          /* ⚠️ "Nothing yet" rather than an empty box — an empty panel reads as broken, and the
             answer "they have not changed anything" is a real and reassuring one. */
          : `<div>That server has not changed anything here.</div>
             <div style="margin-top:6px">${esc(r.note || '')}</div>`;
      } catch (e) {
        body.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
      }
    });
  });

  panel.querySelectorAll('[data-wsave]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = btn.closest('.mesh-write-grant');
      const categories = [...box.querySelectorAll('input[data-wcat]:checked')].map((c) => c.dataset.wcat);
      const workspaces = [...box.querySelectorAll('input[data-wws]:checked')].map((c) => c.dataset.wws);
      const gb = Number(box.querySelector('[data-wbudget]')?.value);
      saveGrant(btn.dataset.wsave, {
        categories,
        workspaces,
        // The field is GB because that is the unit an operator thinks in; the wire is bytes
        // because that is what the budget is spent in.
        ...(Number.isFinite(gb) && gb > 0 ? { bytes_budget: Math.round(gb * (1024 ** 3)) } : {}),
      }, box);
    });
  });

  panel.querySelectorAll('[data-wrevoke]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const box = btn.closest('.mesh-write-grant');
      // An empty category list is the documented way to revoke write WITHOUT severing the link —
      // the whole point of having partial revocation at all.
      saveGrant(btn.dataset.wrevoke, { categories: [] }, box);
    });
  });
}

export function cleanup() {
  clearTimeout(state._t);
  state = {
    tab: 'fleet',
    nodes: [], devices: [], total: 0, search: '', offset: 0, limit: 50,
  };
}
