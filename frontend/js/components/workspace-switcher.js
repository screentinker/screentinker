import { api } from '../api.js';
import { showToast } from './toast.js';
import { t, tn } from '../i18n.js';

// Reusable resource-count formatter. Returns localized "1 device" / "N devices"
// / "No devices" based on n. Generic so the same shape can wire users /
// playlists / schedules counts later without refactor - caller supplies the
// i18n key bases.
//   keyBase: e.g. 'switcher.devices_count' (looks up _one / _other variants via tn)
//   zeroKey: e.g. 'switcher.no_devices' (direct lookup for n === 0)
function formatResourceCount(n, keyBase, zeroKey) {
  if (n === undefined || n === null) return '';
  if (n === 0) return t(zeroKey);
  return tn(keyBase, n);
}

// Admin affordances shown beside a workspace: manage members + rename. Returns
// '' for non-admins. Shared by the single-workspace view and the multi-workspace
// dropdown items so the two never drift - #19: the single view was missing these,
// locking single-workspace users out of org settings (invite users, perms, slug).
function adminIconsHtml(w) {
  if (!w.can_admin) return '';
  return `
    <button class="workspace-switcher-members" type="button" data-members-id="${esc(w.id)}" aria-label="${t('switcher.manage_members')}" title="${t('switcher.manage_members')}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    </button>
    <button class="workspace-switcher-pencil" type="button" data-rename-id="${esc(w.id)}" aria-label="${t('switcher.rename')}" title="${t('switcher.rename')}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
      </svg>
    </button>`;
}

/*
 * May this person create a workspace?
 *
 * ⚠️ NOT `can_admin`. That flag is true for a workspace_admin too, and creating a SIBLING workspace
 * is an organization-level act — a delegated admin handed one workspace must not be able to grow
 * the tenant around it. The server enforces exactly this; the button only mirrors it, so that a
 * button which is visible is a button that works.
 */
function canCreateWorkspace(me) {
  if (!me) return false;
  if (me.is_platform_admin) return true;
  return me.current_org_role === 'org_owner' || me.current_org_role === 'org_admin';
}

/*
 * The "New workspace" control, rendered UNDER the selector in both views.
 *
 * ⚠️ NOT INSIDE THE DROPDOWN. It lived there first and was wrong twice over: it is an action, not
 * one of the things you are choosing between, so it read as a workspace you could switch to — and
 * it was only reachable by opening a menu, which is no use at all in the single-workspace case
 * where the menu does not exist. Under the selector it is in one predictable place whether you
 * have one workspace or twenty.
 *
 * Returns '' when the caller may not create, so both views can call it unconditionally.
 */
function createButtonHtml(me) {
  if (!canCreateWorkspace(me)) return '';
  return `
    <button class="workspace-switcher-create" type="button" data-create-workspace>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span>${t('switcher.create_title')}</span>
    </button>`;
}

/** Wire every create affordance inside `scope`. Safe to call when there are none. */
function wireCreateButtons(scope) {
  scope.querySelectorAll('[data-create-workspace]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();          // never let it also trigger a row's switch handler
      scope.classList.remove('open');
      const { openWorkspaceCreateModal } = await import('./workspace-create-modal.js');
      openWorkspaceCreateModal();
    });
  });
}

// Wire the manage-members + rename buttons within `scope`. `list` resolves a
// workspace id to its object (for the rename modal). stopPropagation so a click
// on an icon never triggers the row's switch handler.
function wireAdminIcons(scope, list) {
  scope.querySelectorAll('.workspace-switcher-pencil').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ws = list.find(w => w.id === btn.dataset.renameId);
      if (!ws) return;
      scope.classList.remove('open');
      const { openWorkspaceRenameModal } = await import('./workspace-rename-modal.js');
      openWorkspaceRenameModal(ws);
    });
  });
  scope.querySelectorAll('.workspace-switcher-members').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      scope.classList.remove('open');
      window.location.hash = `#/workspace/${btn.dataset.membersId}/members`;
    });
  });
}

// Render the workspace switcher inside #workspaceSwitcher based on the
// /api/auth/me response. Three modes:
//   - 0 accessible workspaces: muted "No workspace" placeholder
//   - 1 accessible workspace: workspace name as static text
//   - >1 accessible workspaces: dropdown button + menu with click-to-switch
/*
 * ⚠️ REMOTE ORGS APPEAR HERE ALONGSIDE LOCAL ONES, which reverses an earlier decision worth
 * recording rather than quietly overwriting.
 *
 * The old position: remote workspaces must never enter this switcher, because switching mints a JWT
 * with current_workspace_id and reloads — it assumes a LOCAL, WRITABLE workspace — so every write
 * surface would grow a disabled state, and a UI full of dead controls teaches people the product is
 * broken.
 *
 * What changed is not the risk but the destination: writes against a remote org will be relayed to
 * the server that owns it over the link that already exists. Once the controls work, keeping the
 * org out of the switcher is the arbitrary choice, and making an operator go to a different screen
 * to look at one customer instead of another is the thing that actually feels broken.
 *
 * ⚠️ SELECTING ONE DOES NOT MINT A JWT. There is no local workspace row to put in a token. The
 * selection is a client-side mode, stored here and read by the views; the token keeps pointing at
 * whatever local workspace it did. That also means signing out or expiring cannot strand somebody
 * "inside" a server they no longer have access to.
 */
export const REMOTE_ORG_KEY = 'st_remote_org';

export function selectedRemoteOrg() {
  try { return JSON.parse(localStorage.getItem(REMOTE_ORG_KEY) || 'null'); } catch (e) { return null; }
}

export function clearRemoteOrg() {
  localStorage.removeItem(REMOTE_ORG_KEY);
}

export function renderWorkspaceSwitcher(me, remoteOrgs = []) {
  const container = document.getElementById('workspaceSwitcher');
  if (!container) return;

  const local = Array.isArray(me?.accessible_workspaces) ? me.accessible_workspaces : [];
  /*
   * ⚠️ KEYED ON SERVER **AND** WORKSPACE. A remote server may hold several customers, and two
   * servers will eventually hand us the same workspace id — nothing coordinates them. Keying on the
   * workspace alone would merge two customers into one row, which is the worst available bug here.
   */
  const remote = (remoteOrgs || []).map((o) => ({
    id: `remote:${o.nodeId}:${o.workspaceId || ''}`,
    name: o.name,
    remote: true,
    nodeId: o.nodeId,
    workspaceId: o.workspaceId || null,
    stale: !!o.stale,
    writable: !!o.writable,
    device_count: o.deviceCount,
    /*
     * ⚠️ The SERVER'S NAME, not the words "another server". Every remote row was subtitled the same
     * way, which distinguishes none of them — and an MSP switching between customers is choosing
     * among rows that all looked alike. The name is declared by the peer at pairing. Where the
     * remote org has its own organisation name too, both appear: "Acme Retail · Acme HQ Server"
     * answers "which customer" and "on which box" in one line.
     */
    organization_name: [o.organizationName, o.serverName || `server ${String(o.nodeId).slice(0, 8)}`]
      .filter(Boolean).join(' · ') + (o.stale ? ' · not reachable' : ''),
  }));
  const list = [...local, ...remote];
  const picked = selectedRemoteOrg();
  const currentId = picked
    ? `remote:${picked.nodeId}:${picked.workspaceId || ''}`
    : (me?.current_workspace_id || null);

  if (list.length === 0) {
    container.classList.remove('open');
    container.innerHTML = `<span class="workspace-switcher-empty">No workspace</span>`;
    return;
  }

  if (list.length === 1) {
    // #19: a single workspace still needs its admin affordances (manage members /
    // rename + slug). Render the name as before, plus the inline manage icons
    // when the user can administer it - no dropdown for one item.
    container.classList.remove('open');
    const only = list[0];
    container.innerHTML = `
      <div class="workspace-switcher-single">
        <span class="workspace-switcher-static">${esc(only.name)}</span>
        ${adminIconsHtml(only)}
      </div>
      ${createButtonHtml(me)}`;
    wireAdminIcons(container, [only]);
    wireCreateButtons(container);
    return;
  }

  // >1: dropdown. Alpha sort by workspace name for MVP (no recently-used yet).
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  const current = sorted.find(w => w.id === currentId) || sorted[0];

  // Issue #16: show a type-to-filter search box once the list is big enough to
  // be painful to scroll (MSPs run 100+ orgs). Below the threshold a plain list
  // is fine. The full list is already loaded from /me, so filtering is client-side.
  const SHOW_SEARCH_THRESHOLD = 8;
  const showSearch = sorted.length >= SHOW_SEARCH_THRESHOLD;

  container.innerHTML = `
    <button class="workspace-switcher-button" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="ws-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(current.name)}</span>
      <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <div class="workspace-switcher-menu" role="listbox">
      ${showSearch ? `
      <div class="workspace-switcher-search">
        <input type="text" class="ws-search-input" placeholder="${t('switcher.search_placeholder')}"
               autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${t('switcher.search_placeholder')}">
      </div>` : ''}
      ${sorted.map(w => {
        const countStr = formatResourceCount(w.device_count, 'switcher.devices_count', 'switcher.no_devices');
        const orgName = w.organization_name || '';
        const subtitle = orgName && countStr ? esc(orgName) + ' · ' + esc(countStr)
                       : orgName            ? esc(orgName)
                       : countStr           ? esc(countStr)
                                            : '';
        // Searchable haystack: org name + workspace name, lowercased.
        const haystack = `${orgName} ${w.name}`.toLowerCase();
        return `
        <div class="workspace-switcher-item ${w.id === currentId ? 'current' : ''}" data-workspace-id="${esc(w.id)}" data-search="${esc(haystack)}" role="option">
          <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="${w.id === currentId ? '' : 'visibility:hidden'}">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <div class="ws-meta">
            <div class="ws-name">${esc(w.name)}${w.remote
              // ⚠️ Marked, always. An operator acting on the wrong customer's screens because two
              // rows looked identical is the failure this one character prevents.
              ? ' <span class="badge" style="font-size:9px;vertical-align:middle">remote</span>' : ''}</div>
            <div class="ws-org">${subtitle}</div>
          </div>
          ${adminIconsHtml(w)}
        </div>
      `;
      }).join('')}
      <div class="workspace-switcher-noresults" style="display:none">${t('switcher.no_matches')}</div>
    </div>
    ${createButtonHtml(me)}
  `;

  const button = container.querySelector('.workspace-switcher-button');
  const searchInput = container.querySelector('.ws-search-input'); // null below threshold

  // Shared switch action (used by click and keyboard Enter).
  async function switchTo(wsId) {
    if (wsId === currentId) { container.classList.remove('open'); return; }

    /*
     * ⚠️ A remote org is a client-side mode, not a token change. There is no local workspace row to
     * name in a JWT, and inventing one would put a workspace id in a token that resolves to nothing
     * on this server — which fails later, somewhere else, as a permissions error nobody can explain.
     */
    if (String(wsId).startsWith('remote:')) {
      const org = (remoteOrgs || []).find(
        (o) => `remote:${o.nodeId}:${o.workspaceId || ''}` === wsId);
      if (!org) return;
      localStorage.setItem(REMOTE_ORG_KEY, JSON.stringify(org));
      window.location.reload();
      return;
    }
    /*
     * ⚠️ LEAVING A REMOTE ORG IS NOT ALWAYS A WORKSPACE SWITCH, and treating it as one broke the
     * dropdown. While a remote org is selected, `currentId` is `remote:…`, so picking your own
     * workspace looked like a change — but the JWT was already pointing at it, so this asked the
     * server to switch to the workspace it was already on. That call does not return a new token,
     * and the click did nothing at all: the local workspace became unselectable for as long as a
     * remote org was active.
     *
     * Dropping the mode IS the whole action in that case. The order matters too: clear before the
     * reload, or the local workspace renders under the remote banner and an operator is looking at
     * their own data labelled as somebody else's.
     */
    const wasRemote = !!picked;
    clearRemoteOrg();
    if (wasRemote && wsId === (me?.current_workspace_id)) {
      window.location.reload();
      return;
    }

    try {
      const resp = await api.switchWorkspace(wsId);
      if (resp?.token) {
        localStorage.setItem('token', resp.token);
        window.location.reload();
      } else {
        showToast('Switch returned no token', 'error');
      }
    } catch (err) {
      showToast(err.message || 'Failed to switch workspace', 'error');
    }
  }

  // ---- type-to-filter + keyboard navigation (only when the search box renders) ----
  /*
   * ⚠️ EVERY .workspace-switcher-item MUST CARRY data-search AND data-workspace-id. applyFilter
   * reads `it.dataset.search` — an item without it makes `undefined.includes` THROW on the first
   * keystroke in the search box, killing the filter for every real workspace — and the keyboard
   * Enter path calls switchTo(dataset.workspaceId). That is why "New workspace" is a control under
   * the selector rather than a row in here: it is an action, not one of the things being chosen
   * between, and it belongs to neither list.
   */
  const allItems = Array.from(container.querySelectorAll('.workspace-switcher-item'));
  const noResults = container.querySelector('.workspace-switcher-noresults');
  let highlightIdx = -1;
  const visibleItems = () => allItems.filter(it => it.style.display !== 'none');

  function setHighlight(idx) {
    const vis = visibleItems();
    allItems.forEach(it => it.classList.remove('highlighted'));
    if (!vis.length) { highlightIdx = -1; return; }
    highlightIdx = Math.max(0, Math.min(idx, vis.length - 1));
    const el = vis[highlightIdx];
    el.classList.add('highlighted');
    el.scrollIntoView({ block: 'nearest' });
  }

  function applyFilter(q) {
    const query = (q || '').trim().toLowerCase();
    let anyVisible = false;
    for (const it of allItems) {
      const match = !query || it.dataset.search.includes(query);
      it.style.display = match ? '' : 'none';
      if (match) anyVisible = true;
    }
    if (noResults) noResults.style.display = anyVisible ? 'none' : '';
    setHighlight(0);
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => applyFilter(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(highlightIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(highlightIdx - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const el = visibleItems()[highlightIdx];
        if (el) switchTo(el.dataset.workspaceId);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        container.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        button.focus();
      }
    });
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !container.classList.contains('open');
    container.classList.toggle('open');
    button.setAttribute('aria-expanded', String(opening));
    // On open, reset the filter and focus the search box for immediate typing.
    if (opening && searchInput) {
      searchInput.value = '';
      applyFilter('');
      setTimeout(() => searchInput.focus(), 0);
    }
  });

  // Manage-members + rename icons (shared with the single-workspace view).
  wireAdminIcons(container, sorted);

  container.querySelectorAll('.workspace-switcher-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Ignore clicks that originated on an icon button (each has its own handler).
      if (e.target.closest('.workspace-switcher-pencil, .workspace-switcher-members')) return;
      switchTo(item.dataset.workspaceId);
    });
  });
  wireCreateButtons(container);

  // Click-outside closes the menu.
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      container.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
    }
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
