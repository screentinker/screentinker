import { api } from '../api.js';
import { showToast } from '../components/toast.js';

// Escape user-controlled strings for safe HTML interpolation
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function formatDate(ts) {
  if (!ts) return '--';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getTypeIcon(item) {
  if (item.widget_id) return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>';
  if (item.mime_type && item.mime_type.startsWith('video/')) return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
}

let currentPlaylistId = null;

export function render(container) {
  const hash = window.location.hash;
  const match = hash.match(/#\/playlists\/(.+)/);
  if (match) {
    currentPlaylistId = match[1];
    renderDetail(container, match[1]);
  } else {
    currentPlaylistId = null;
    renderList(container);
  }
}

export function cleanup() {
  currentPlaylistId = null;
}

// ==================== LIST VIEW ====================

async function renderList(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Playlists</h1>
        <div class="subtitle">Create and manage content playlists</div>
      </div>
      <button class="btn btn-primary" id="createPlaylistBtn">+ New Playlist</button>
    </div>
    <div id="playlistGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      <div style="color:var(--text-muted);padding:40px;text-align:center">Loading...</div>
    </div>
  `;

  document.getElementById('createPlaylistBtn').addEventListener('click', showCreateModal);
  loadPlaylists();
}

async function loadPlaylists() {
  const grid = document.getElementById('playlistGrid');
  if (!grid) return;

  try {
    const playlists = await api.getPlaylists();
    if (!playlists.length) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 16px;display:block;opacity:0.4">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          <h3 style="margin-bottom:8px;color:var(--text-primary)">No playlists yet</h3>
          <p>Create your first playlist to organize content for your displays.</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = playlists.map(p => `
      <a href="#/playlists/${esc(p.id)}" class="playlist-card" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;text-decoration:none;color:inherit;display:block;transition:border-color 0.15s;cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px">
          <div style="font-size:16px;font-weight:600;color:var(--text-primary)" data-name="${esc(p.id)}">${esc(p.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;margin-left:12px">${p.item_count} item${p.item_count !== 1 ? 's' : ''}</div>
        </div>
        ${p.description ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.4">${esc(p.description)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-muted)">Created ${formatDate(p.created_at)}</div>
      </a>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-muted);padding:40px;text-align:center">Failed to load playlists: ${esc(err.message)}</div>`;
  }
}

function showCreateModal() {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:400px;max-width:90vw">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">New Playlist</h3>
      <input type="text" id="newPlaylistName" class="input" placeholder="Playlist name" style="width:100%;margin-bottom:12px" autofocus>
      <textarea id="newPlaylistDesc" class="input" placeholder="Description (optional)" style="width:100%;height:60px;resize:vertical;margin-bottom:16px"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary" id="cancelCreateBtn">Cancel</button>
        <button class="btn btn-primary" id="confirmCreateBtn">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const nameInput = document.getElementById('newPlaylistName');
  nameInput.focus();

  document.getElementById('cancelCreateBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  async function doCreate() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const desc = document.getElementById('newPlaylistDesc').value.trim();
    try {
      const pl = await api.createPlaylist(name, desc);
      modal.remove();
      showToast('Playlist created');
      window.location.hash = `#/playlists/${pl.id}`;
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  document.getElementById('confirmCreateBtn').addEventListener('click', doCreate);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
}

// ==================== DETAIL VIEW ====================

async function renderDetail(container, playlistId) {
  container.innerHTML = `
    <div style="color:var(--text-muted);padding:40px;text-align:center">Loading...</div>
  `;

  try {
    const playlist = await api.getPlaylist(playlistId);
    renderDetailContent(container, playlist);
  } catch (err) {
    container.innerHTML = `
      <div style="padding:40px;text-align:center;color:var(--text-muted)">
        <p>Failed to load playlist: ${esc(err.message)}</p>
        <a href="#/playlists" class="btn btn-secondary" style="margin-top:16px">Back to Playlists</a>
      </div>
    `;
  }
}

function renderDetailContent(container, playlist) {
  container.innerHTML = `
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="#/playlists" style="color:var(--text-muted);text-decoration:none;font-size:20px" title="Back">&larr;</a>
        <div>
          <h1 id="playlistTitle" style="cursor:pointer" title="Click to rename">${esc(playlist.name)}</h1>
          <div class="subtitle" id="playlistDesc" style="cursor:pointer" title="Click to edit description">${playlist.description ? esc(playlist.description) : '<span style="opacity:0.5">Add a description...</span>'}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="addItemBtn">+ Add Content</button>
        <button class="btn btn-secondary" id="deletePlaylistBtn" style="color:var(--danger)">Delete Playlist</button>
      </div>
    </div>

    <div id="playlistItems" style="display:flex;flex-direction:column;gap:8px">
    </div>
  `;

  renderItems(playlist.items || []);

  // Inline rename
  document.getElementById('playlistTitle').addEventListener('click', () => inlineEdit(playlist, 'name'));
  document.getElementById('playlistDesc').addEventListener('click', () => inlineEdit(playlist, 'description'));

  // Add content
  document.getElementById('addItemBtn').addEventListener('click', () => showAddItemModal(playlist.id));

  // Delete playlist
  document.getElementById('deletePlaylistBtn').addEventListener('click', async () => {
    if (!confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
    try {
      await api.deletePlaylist(playlist.id);
      showToast('Playlist deleted');
      window.location.hash = '#/playlists';
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function renderItems(items) {
  const itemsEl = document.getElementById('playlistItems');
  if (!itemsEl) return;

  if (!items.length) {
    itemsEl.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted);border:2px dashed var(--border);border-radius:var(--radius-lg)">
        <p style="margin-bottom:8px">This playlist is empty</p>
        <p style="font-size:13px">Click "Add Content" to add items.</p>
      </div>
    `;
    return;
  }

  itemsEl.innerHTML = items.map((item, i) => `
    <div class="playlist-item" data-item-id="${item.id}" draggable="true" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;display:flex;align-items:center;gap:12px;cursor:grab;transition:border-color 0.15s">
      <div style="color:var(--text-muted);font-size:12px;min-width:24px;text-align:center;user-select:none">${i + 1}</div>
      <div style="width:48px;height:36px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
        ${item.thumbnail_path
          ? `<img src="/uploads/thumbnails/${esc(item.thumbnail_path.split('/').pop())}" style="width:100%;height:100%;object-fit:cover">`
          : `<div style="color:var(--text-muted);opacity:0.5">${getTypeIcon(item)}</div>`
        }
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.filename || item.widget_name || 'Unknown')}</div>
        <div style="font-size:12px;color:var(--text-muted)">${item.widget_id ? 'Widget' : (item.mime_type || 'Unknown type')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <label style="font-size:12px;color:var(--text-muted)">Duration</label>
        <input type="number" class="input item-duration" data-item-id="${item.id}" value="${item.duration_sec}" min="1" style="width:60px;padding:4px 8px;font-size:13px;text-align:center">
        <span style="font-size:12px;color:var(--text-muted)">sec</span>
      </div>
      <button class="btn-icon item-remove" data-item-id="${item.id}" title="Remove" style="color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px;border-radius:4px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');

  // Duration change handlers
  itemsEl.querySelectorAll('.item-duration').forEach(input => {
    input.addEventListener('change', async (e) => {
      const itemId = e.target.dataset.itemId;
      const val = parseInt(e.target.value, 10);
      if (!val || val < 1) { e.target.value = 10; return; }
      try {
        await api.updatePlaylistItem(currentPlaylistId, itemId, { duration_sec: val });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Remove handlers
  itemsEl.querySelectorAll('.item-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const itemId = e.currentTarget.dataset.itemId;
      try {
        await api.deletePlaylistItem(currentPlaylistId, itemId);
        const playlist = await api.getPlaylist(currentPlaylistId);
        renderItems(playlist.items || []);
        showToast('Item removed');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Drag-to-reorder
  setupDragReorder(itemsEl);
}

function setupDragReorder(container) {
  let dragEl = null;

  container.addEventListener('dragstart', (e) => {
    dragEl = e.target.closest('.playlist-item');
    if (!dragEl) return;
    dragEl.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', () => {
    if (dragEl) dragEl.style.opacity = '';
    dragEl = null;
    container.querySelectorAll('.playlist-item').forEach(el => el.style.borderTop = '');
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.playlist-item');
    container.querySelectorAll('.playlist-item').forEach(el => el.style.borderTop = '');
    if (target && target !== dragEl) {
      target.style.borderTop = '2px solid var(--primary)';
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.playlist-item');
    if (!target || !dragEl || target === dragEl) return;

    // Reorder DOM
    container.insertBefore(dragEl, target);

    // Collect new order
    const order = Array.from(container.querySelectorAll('.playlist-item'))
      .map(el => parseInt(el.dataset.itemId, 10));

    try {
      const items = await api.reorderPlaylistItems(currentPlaylistId, order);
      renderItems(items);
    } catch (err) {
      showToast(err.message, 'error');
      // Reload to fix state
      const playlist = await api.getPlaylist(currentPlaylistId);
      renderItems(playlist.items || []);
    }
  });
}

// ==================== INLINE EDIT ====================

function inlineEdit(playlist, field) {
  const el = field === 'name' ? document.getElementById('playlistTitle') : document.getElementById('playlistDesc');
  if (!el) return;

  const current = playlist[field] || '';
  const isName = field === 'name';

  if (isName) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.value = current;
    input.style.cssText = 'font-size:24px;font-weight:700;padding:2px 8px;width:100%';
    el.replaceWith(input);
    input.focus();
    input.select();

    async function save() {
      const val = input.value.trim();
      if (!val) { input.value = current; return; }
      try {
        const updated = await api.updatePlaylist(playlist.id, { [field]: val });
        playlist[field] = updated[field];
      } catch (err) {
        showToast(err.message, 'error');
      }
      const newEl = document.createElement('h1');
      newEl.id = 'playlistTitle';
      newEl.style.cursor = 'pointer';
      newEl.title = 'Click to rename';
      newEl.textContent = playlist.name;
      input.replaceWith(newEl);
      newEl.addEventListener('click', () => inlineEdit(playlist, 'name'));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } });
  } else {
    const input = document.createElement('textarea');
    input.className = 'input';
    input.value = current;
    input.style.cssText = 'font-size:13px;padding:4px 8px;width:100%;height:40px;resize:vertical';
    el.replaceWith(input);
    input.focus();

    async function save() {
      const val = input.value.trim();
      try {
        const updated = await api.updatePlaylist(playlist.id, { description: val });
        playlist.description = updated.description;
      } catch (err) {
        showToast(err.message, 'error');
      }
      const newEl = document.createElement('div');
      newEl.className = 'subtitle';
      newEl.id = 'playlistDesc';
      newEl.style.cursor = 'pointer';
      newEl.title = 'Click to edit description';
      if (playlist.description) {
        newEl.textContent = playlist.description;
      } else {
        newEl.innerHTML = '<span style="opacity:0.5">Add a description...</span>';
      }
      input.replaceWith(newEl);
      newEl.addEventListener('click', () => inlineEdit(playlist, 'description'));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = current; input.blur(); } });
  }
}

// ==================== ADD ITEM MODAL ====================

async function showAddItemModal(playlistId) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:560px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">Add Content to Playlist</h3>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn btn-primary btn-sm tab-btn active" data-tab="content">Content</button>
        <button class="btn btn-secondary btn-sm tab-btn" data-tab="widgets">Widgets</button>
      </div>
      <input type="text" id="addItemSearch" class="input" placeholder="Search..." style="width:100%;margin-bottom:12px">
      <div id="addItemList" style="flex:1;overflow-y:auto;min-height:200px;max-height:400px"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-secondary" id="closeAddModal">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let activeTab = 'content';
  let allContent = [];
  let allWidgets = [];

  // Load data
  try {
    [allContent, allWidgets] = await Promise.all([
      api.getContent(),
      api.getWidgets ? api.getWidgets() : Promise.resolve([])
    ]);
  } catch (err) {
    document.getElementById('addItemList').innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">Failed to load: ${esc(err.message)}</div>`;
  }

  function renderTab() {
    const list = document.getElementById('addItemList');
    const search = (document.getElementById('addItemSearch')?.value || '').toLowerCase();
    const items = activeTab === 'content' ? allContent : allWidgets;
    const filtered = items.filter(item => {
      const name = (item.filename || item.name || '').toLowerCase();
      return name.includes(search);
    });

    if (!filtered.length) {
      list.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">No ${activeTab} found</div>`;
      return;
    }

    list.innerHTML = filtered.map(item => {
      const isWidget = activeTab === 'widgets';
      const name = item.filename || item.name || 'Unknown';
      const sub = isWidget ? (item.widget_type || 'Widget') : (item.mime_type || '');
      const thumb = item.thumbnail_path ? `/uploads/thumbnails/${esc(item.thumbnail_path.split('/').pop())}` : null;
      return `
        <div class="add-item-row" data-id="${esc(item.id)}" data-type="${isWidget ? 'widget' : 'content'}" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius);cursor:pointer;transition:background 0.1s">
          <div style="width:40px;height:30px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover">` : '<div style="color:var(--text-muted);opacity:0.4"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></div>'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(sub)}</div>
          </div>
          <button class="btn btn-primary btn-sm add-item-btn" data-id="${esc(item.id)}" data-type="${isWidget ? 'widget' : 'content'}">Add</button>
        </div>
      `;
    }).join('');

    // Add button handlers
    list.querySelectorAll('.add-item-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const type = btn.dataset.type;
        const data = type === 'widget' ? { widget_id: id } : { content_id: id };
        try {
          btn.disabled = true;
          btn.textContent = 'Adding...';
          await api.addPlaylistItem(playlistId, data);
          btn.textContent = 'Added';
          btn.classList.remove('btn-primary');
          btn.classList.add('btn-secondary');
          // Refresh the detail view items
          const playlist = await api.getPlaylist(playlistId);
          renderItems(playlist.items || []);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Add';
          showToast(err.message, 'error');
        }
      });
    });
  }

  // Tab switching
  modal.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      modal.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.tab === activeTab);
        b.classList.toggle('btn-secondary', b.dataset.tab !== activeTab);
        b.classList.toggle('active', b.dataset.tab === activeTab);
      });
      renderTab();
    });
  });

  // Search
  document.getElementById('addItemSearch').addEventListener('input', renderTab);

  // Close
  document.getElementById('closeAddModal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  renderTab();
}
