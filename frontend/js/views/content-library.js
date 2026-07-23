import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { t } from '../i18n.js';

function formatFileSize(bytes) {
  if (!bytes) return '--';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// #157: classify a content item's expiry state for the card. `expired` when the server
// deactivated it (is_active===0) or its expires_at has passed; `dateLabel` is the local
// expiry date/time (present whenever expires_at is set, past or future).
function expiryInfo(c) {
  const hasExpiry = c.expires_at != null && c.expires_at !== '';
  const ts = hasExpiry ? Number(c.expires_at) * 1000 : null;
  const past = ts != null && ts <= Date.now();
  const expired = c.is_active === 0 || past;
  const dateLabel = ts != null
    ? new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  return { expired, dateLabel };
}

// Epoch seconds -> a <input type="datetime-local"> value in the viewer's LOCAL wall-clock
// (YYYY-MM-DDTHH:MM). Empty string for no expiry.
function toLocalDatetimeInput(epochSec) {
  if (epochSec == null || epochSec === '') return '';
  const d = new Date(Number(epochSec) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('content.title')} <span class="help-tip" data-tip="${t('content.help_tip')}">?</span></h1>
        <div class="subtitle">${t('content.subtitle')}</div>
      </div>
    </div>

    <div class="content-toolbar" style="display:flex;gap:16px;margin-bottom:24px">
      <div class="upload-area" id="uploadArea" style="flex:1;margin-bottom:0">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>${t('content.drop')}</p>
        <p class="upload-hint">${t('content.upload_hint')}</p>
        <input type="file" id="fileInput" style="display:none" multiple accept="video/*,image/*">
        <div class="upload-progress" id="uploadProgress" style="display:none">
          <div class="upload-progress-bar">
            <div class="upload-progress-fill" id="uploadProgressFill" style="width:0%"></div>
          </div>
          <p style="font-size:12px;color:var(--text-secondary);margin-top:6px" id="uploadProgressText">${t('content.upload_progress')}</p>
        </div>
      </div>
      <div style="width:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          ${t('content.remote_url')}
        </div>
        <p style="font-size:12px;color:var(--text-muted)">${t('content.remote_desc')}</p>
        <input type="text" id="remoteUrlInput" class="input" placeholder="${t('content.remote_url_placeholder')}">
        <input type="text" id="remoteNameInput" class="input" placeholder="${t('content.remote_name_placeholder')}">
        <select id="remoteMimeType" class="input" style="background:var(--bg-input)">
          <option value="video/mp4">${t('content.mime.video_mp4')}</option>
          <option value="video/webm">${t('content.mime.video_webm')}</option>
          <option value="image/jpeg">${t('content.mime.image_jpeg')}</option>
          <option value="image/png">${t('content.mime.image_png')}</option>
        </select>
        <button class="btn btn-primary" id="addRemoteBtn">${t('content.remote_add_btn')}</button>
      </div>
      <div style="width:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.13C5.12 19.56 12 19.56 12 19.56s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z"/>
            <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/>
          </svg>
          ${t('content.youtube')}
        </div>
        <p style="font-size:12px;color:var(--text-muted)">${t('content.youtube_desc')}</p>
        <input type="text" id="youtubeUrlInput" class="input" placeholder="${t('content.youtube_url_placeholder')}">
        <input type="text" id="youtubeNameInput" class="input" placeholder="${t('content.youtube_name_placeholder')}">
        <button class="btn btn-primary" id="addYoutubeBtn">${t('content.youtube_add_btn')}</button>
      </div>
    </div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <input type="text" id="contentSearch" class="input" placeholder="${t('content.search_placeholder')}" style="max-width:250px;width:100%">
      <button class="btn btn-secondary btn-sm" id="newFolderBtn">${t('content.new_folder_btn')}</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer;margin-left:auto">
        <input type="checkbox" id="showExpiredToggle" ${state.showExpired ? 'checked' : ''}> ${t('content.show_expired')}
      </label>
    </div>
    <div id="folderBreadcrumb" style="display:flex;gap:6px;align-items:center;margin-bottom:12px;font-size:13px;flex-wrap:wrap"></div>
    <div id="folderGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px"></div>
    <div class="content-grid" id="contentGrid">
      <div class="empty-state" style="grid-column:1/-1"><h3>${t('common.loading')}</h3></div>
    </div>
  `;

  // File upload handling
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');

  uploadArea.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  // Remote URL handling
  document.getElementById('addRemoteBtn').addEventListener('click', async () => {
    const url = document.getElementById('remoteUrlInput').value.trim();
    const name = document.getElementById('remoteNameInput').value.trim();
    const mimeType = document.getElementById('remoteMimeType').value;
    if (!url) {
      showToast(t('content.error_enter_url'), 'error');
      return;
    }
    try {
      await api.addRemoteContent(url, name, mimeType);
      showToast(t('content.toast.remote_added'), 'success');
      document.getElementById('remoteUrlInput').value = '';
      document.getElementById('remoteNameInput').value = '';
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // YouTube URL handling
  document.getElementById('addYoutubeBtn').addEventListener('click', async () => {
    const url = document.getElementById('youtubeUrlInput').value.trim();
    const name = document.getElementById('youtubeNameInput').value.trim();
    if (!url) {
      showToast(t('content.error_enter_youtube_url'), 'error');
      return;
    }
    try {
      await api.addYoutubeContent(url, name);
      showToast(t('content.toast.youtube_added'), 'success');
      document.getElementById('youtubeUrlInput').value = '';
      document.getElementById('youtubeNameInput').value = '';
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Content search filters items currently shown in the grid.
  function filterContent() {
    const q = document.getElementById('contentSearch').value.toLowerCase();
    document.querySelectorAll('.content-item').forEach(item => {
      const name = item.querySelector('.content-item-name')?.textContent.toLowerCase() || '';
      item.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
    document.querySelectorAll('.folder-card').forEach(card => {
      const name = card.dataset.name?.toLowerCase() || '';
      card.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
  }
  document.getElementById('contentSearch').oninput = filterContent;

  // #157: "Show expired" — reloads the grid including deactivated / past-expiry items so
  // they can be inspected and restored (clear/extend expiry in the edit modal).
  document.getElementById('showExpiredToggle').onchange = (e) => {
    state.showExpired = e.target.checked;
    loadContent();
  };

  // Create folder in the current folder.
  document.getElementById('newFolderBtn').onclick = async () => {
    const name = prompt(t('content.prompt_folder_name'));
    if (!name || !name.trim()) return;
    try {
      await api.createFolder(name.trim(), state.currentFolderId);
      showToast(t('content.toast.folder_created_named', { name }), 'success');
      loadContent();
    } catch (err) { showToast(err.message, 'error'); }
  };

  loadContent();
}

// View state — current folder navigation. Lives at module scope so the back button
// and other handlers can read it without threading it through every callback.
const state = {
  currentFolderId: null, // null = root
  folders: [],           // all folders for this user (flat tree)
  showExpired: false,    // #157: include is_active=0 / past-expiry items in the library view
};

async function handleFiles(files) {
  const progress = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  for (const file of files) {
    progress.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = t('content.upload_progress_named', { name: file.name });

    try {
      await api.uploadContent(file, (pct) => {
        progressFill.style.width = pct + '%';
        progressText.textContent = t('content.upload_progress_named_pct', { name: file.name, pct });
      }, state.currentFolderId);
      showToast(t('content.toast.uploaded_named', { name: file.name }), 'success');
    } catch (err) {
      showToast(t('content.toast.upload_failed_named', { name: file.name, error: err.message }), 'error');
    }
  }

  progress.style.display = 'none';
  loadContent();
}

async function loadContent() {
  const grid = document.getElementById('contentGrid');
  const folderGrid = document.getElementById('folderGrid');
  const breadcrumb = document.getElementById('folderBreadcrumb');
  if (!grid || !folderGrid || !breadcrumb) return;

  try {
    const [content, folders] = await Promise.all([
      api.getContent(state.currentFolderId === null ? null : state.currentFolderId, state.showExpired),
      api.getFolders(),
    ]);
    state.folders = folders;

    // Breadcrumb path: walk parent_id chain from current folder up to root.
    const folderById = new Map(folders.map(f => [f.id, f]));
    const path = [];
    let cursor = state.currentFolderId ? folderById.get(state.currentFolderId) : null;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parent_id ? folderById.get(cursor.parent_id) : null;
    }
    breadcrumb.innerHTML = `
      <a href="#" data-folder-nav="" style="color:var(--text-secondary);text-decoration:none">${t('content.breadcrumb_root')}</a>
      ${path.map(f => `
        <span style="color:var(--text-muted)">/</span>
        <a href="#" data-folder-nav="${f.id}" style="color:var(--text-primary);text-decoration:none">${esc(f.name)}</a>
      `).join('')}
      ${state.currentFolderId ? `
        <button class="btn btn-secondary btn-sm" id="renameFolderBtn" style="margin-left:auto">${t('content.rename_btn')}</button>
        <button class="btn btn-danger btn-sm" id="deleteFolderBtn">${t('content.delete_folder_btn')}</button>
      ` : ''}
    `;
    breadcrumb.querySelectorAll('[data-folder-nav]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.dataset.folderNav;
        state.currentFolderId = id || null;
        loadContent();
      });
      // Make breadcrumb segments drop targets too — otherwise the only way to move
      // a file out of a folder is via the edit modal. Dropping on "All Content"
      // moves to root; dropping on a parent name moves there.
      a.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('text/content-id')) return;
        e.preventDefault();
        a.style.background = 'var(--primary)';
        a.style.color = '#fff';
        a.style.padding = '2px 8px';
        a.style.borderRadius = '4px';
      });
      a.addEventListener('dragleave', () => {
        a.style.background = '';
        a.style.color = '';
        a.style.padding = '';
        a.style.borderRadius = '';
      });
      a.addEventListener('drop', async (e) => {
        e.preventDefault();
        a.style.background = ''; a.style.color = ''; a.style.padding = ''; a.style.borderRadius = '';
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        const targetFolderId = a.dataset.folderNav || null; // empty string = root
        try {
          await api.moveContent(contentId, targetFolderId);
          showToast(targetFolderId ? t('content.toast.moved') : t('content.toast.moved_to_root'), 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });
    const renameBtn = breadcrumb.querySelector('#renameFolderBtn');
    if (renameBtn) renameBtn.onclick = async () => {
      const current = folderById.get(state.currentFolderId);
      const name = prompt(t('content.prompt_rename_folder'), current?.name || '');
      if (!name || !name.trim() || name === current?.name) return;
      try {
        await api.renameFolder(state.currentFolderId, name.trim());
        showToast(t('content.toast.folder_renamed'), 'success');
        loadContent();
      } catch (err) { showToast(err.message, 'error'); }
    };
    const deleteBtn = breadcrumb.querySelector('#deleteFolderBtn');
    if (deleteBtn) deleteBtn.onclick = async () => {
      if (!confirm(t('content.confirm_delete_folder'))) return;
      try {
        const parentId = folderById.get(state.currentFolderId)?.parent_id || null;
        await api.deleteFolder(state.currentFolderId);
        showToast(t('content.toast.folder_deleted'), 'success');
        state.currentFolderId = parentId;
        loadContent();
      } catch (err) { showToast(err.message, 'error'); }
    };

    // Render subfolders of the current folder.
    const subfolders = folders.filter(f => (f.parent_id || null) === state.currentFolderId);
    folderGrid.innerHTML = subfolders.map(f => `
      <div class="folder-card" data-folder-id="${f.id}" data-name="${esc(f.name)}"
           style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px"
           data-drop-folder="${f.id}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <div style="font-size:14px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
      </div>
    `).join('');
    folderGrid.querySelectorAll('.folder-card').forEach(card => {
      card.addEventListener('click', () => {
        state.currentFolderId = card.dataset.folderId;
        loadContent();
      });
      // Drop target for dragging content items into this folder.
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.outline = '2px solid var(--primary)'; });
      card.addEventListener('dragleave', () => { card.style.outline = ''; });
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.style.outline = '';
        const contentId = e.dataTransfer.getData('text/content-id');
        if (!contentId) return;
        try {
          await api.moveContent(contentId, card.dataset.folderId);
          showToast(t('content.toast.moved'), 'success');
          loadContent();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    if (!content.length) {
      grid.innerHTML = subfolders.length ? '' : `
        <div class="empty-state" style="grid-column:1/-1">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <h3>${state.currentFolderId ? t('content.empty_folder_title') : t('content.no_content')}</h3>
          <p>${state.currentFolderId ? t('content.empty_folder_desc') : t('content.no_content_desc')}</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = content.map(c => {
      const exp = expiryInfo(c);
      return `
      <div class="content-item" draggable="true" data-content-id="${c.id}" data-folder="${c.folder || ''}" style="${exp.expired ? 'opacity:.55' : ''}">
        <div class="content-item-preview">
          ${c.mime_type === 'video/youtube'
            ? `<div style="position:relative;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center">
                <img src="${c.thumbnail_path}" alt="${esc(c.filename)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">
                <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="red" stroke="none">
                    <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.13C5.12 19.56 12 19.56 12 19.56s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z"/>
                    <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" fill="white"/>
                  </svg>
                </div>
              </div>`
          : c.remote_url
            ? `<div class="video-icon" style="flex-direction:column;gap:4px">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <span style="font-size:10px;color:var(--text-muted)">${t('content.type_remote_short')}</span>
              </div>`
            : c.thumbnail_path
              ? `<img data-auth-src="/api/content/${c.id}/thumbnail" alt="${esc(c.filename)}" style="background:var(--bg-secondary)">`
              : c.mime_type?.startsWith('video/')
                ? `<div class="video-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </div>`
                : `<img data-auth-src="/api/content/${c.id}/file" alt="${esc(c.filename)}" style="background:var(--bg-secondary)">`
          }
        </div>
        <div class="content-item-body">
          <div class="content-item-name" title="${esc(c.filename)}">${esc(c.filename)}</div>
          <div class="content-item-size">
            ${c.mime_type === 'video/youtube' ? t('content.type_youtube') : c.remote_url ? t('content.type_remote') : (c.mime_type?.startsWith('video/') ? t('content.type_video') : t('content.type_image'))}
            ${c.duration_sec ? ` &middot; ${Math.floor(c.duration_sec / 60)}:${String(Math.floor(c.duration_sec % 60)).padStart(2, '0')}` : ''}
            ${c.file_size ? ' &middot; ' + formatFileSize(c.file_size) : ''}
            ${c.width && c.height ? ` &middot; ${c.width}x${c.height}` : ''}
          </div>
          ${exp.expired
            ? `<div style="font-size:11px;color:var(--danger,#e5484d);font-weight:600;margin-top:4px">${t('content.expired_badge')}${exp.dateLabel ? ` &middot; ${exp.dateLabel}` : ''}</div>`
            : (exp.dateLabel ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.expires_label', { date: exp.dateLabel })}</div>` : '')}
        </div>
        <div class="content-item-actions">
          <button class="btn btn-secondary btn-sm" data-edit-content="${c.id}" title="${t('content.btn_edit')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            ${t('content.btn_edit')}
          </button>
          <button class="btn btn-danger btn-sm" data-delete-content="${c.id}" title="${t('content.btn_delete')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            ${t('content.btn_delete')}
          </button>
        </div>
      </div>
    `;
    }).join('');
    hydrateAuthImages(grid);

    // Drag-to-move: each content item exposes its id; folder cards are the drop targets.
    grid.querySelectorAll('.content-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/content-id', item.dataset.contentId);
        e.dataTransfer.effectAllowed = 'move';
      });
    });

    // Delete handler via event delegation
    grid.onclick = async (e) => {
      // Preview on click (not on delete button)
      const previewTarget = e.target.closest('.content-item-preview');
      if (previewTarget) {
        const item = previewTarget.closest('.content-item');
        const id = item?.dataset.contentId;
        if (id) {
          const c = content.find(x => x.id === id);
          if (c) showPreview(c);
        }
        return;
      }

      // Edit button
      const editBtn = e.target.closest('[data-edit-content]');
      if (editBtn) {
        const id = editBtn.dataset.editContent;
        const c = content.find(x => x.id === id);
        if (c) showEditModal(c, loadContent);
        return;
      }

      const btn = e.target.closest('[data-delete-content]');
      if (!btn) return;
      e.stopPropagation();
      const id = btn.dataset.deleteContent;

      // If already confirming, do the delete
      if (btn.dataset.confirming === 'true') {
        try {
          btn.disabled = true;
          btn.textContent = t('content.btn_deleting');
          await api.deleteContent(id);
          showToast(t('content.toast.deleted'), 'success');
          loadContent();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = t('content.btn_delete');
          btn.dataset.confirming = 'false';
        }
        return;
      }

      // First click - show confirm state
      btn.dataset.confirming = 'true';
      btn.innerHTML = t('content.btn_confirm_delete');
      btn.style.background = 'var(--danger)';
      btn.style.color = 'white';
      // Reset after 3 seconds if not clicked
      setTimeout(() => {
        if (btn.dataset.confirming === 'true') {
          btn.dataset.confirming = 'false';
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> ${t('content.btn_delete')}`;
          btn.style.background = '';
          btn.style.color = '';
        }
      }, 3000);
    };

  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>${t('content.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }
}

function showEditModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';

  const isRemote = !!contentItem.remote_url;

  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;width:95vw">
      <div class="modal-header">
        <h3>${t('content.edit_modal_title')}</h3>
        <button class="btn-icon" id="closeEditModal">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>${t('content.label_filename')}</label>
          <input type="text" id="editFilename" class="input" value="${esc(contentItem.filename)}">
        </div>
        ${isRemote ? `
        <div class="form-group">
          <label>${t('content.label_remote_url_field')}</label>
          <input type="text" id="editRemoteUrl" class="input" value="${esc(contentItem.remote_url)}">
        </div>
        ` : ''}
        <div class="form-group">
          <label>${t('content.label_mime_type')}</label>
          <select id="editMimeType" class="input" style="background:var(--bg-input)">
            <option value="video/mp4" ${contentItem.mime_type === 'video/mp4' ? 'selected' : ''}>${t('content.mime.video_mp4')}</option>
            <option value="video/webm" ${contentItem.mime_type === 'video/webm' ? 'selected' : ''}>${t('content.mime.video_webm')}</option>
            <option value="image/jpeg" ${contentItem.mime_type === 'image/jpeg' ? 'selected' : ''}>${t('content.mime.image_jpeg')}</option>
            <option value="image/png" ${contentItem.mime_type === 'image/png' ? 'selected' : ''}>${t('content.mime.image_png')}</option>
            <option value="image/gif" ${contentItem.mime_type === 'image/gif' ? 'selected' : ''}>${t('content.mime.image_gif')}</option>
            <option value="image/webp" ${contentItem.mime_type === 'image/webp' ? 'selected' : ''}>${t('content.mime.image_webp')}</option>
          </select>
        </div>
        <div class="form-group">
          <label>${t('content.label_folder')}</label>
          <select id="editFolderId" class="input" style="background:var(--bg-input)">
            <option value="">${t('content.folder_root_option')}</option>
            ${state.folders.map(f => `<option value="${f.id}" ${contentItem.folder_id === f.id ? 'selected' : ''}>${esc(folderPath(f, state.folders))}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>${t('content.label_expires_at')}</label>
          <input type="datetime-local" id="editExpiresAt" class="input" style="background:var(--bg-input)" value="${toLocalDatetimeInput(contentItem.expires_at)}">
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.expires_hint')}</p>
        </div>
        ${!isRemote ? `
        <div class="form-group">
          <label>${t('content.label_replace_file')}</label>
          <input type="file" id="editFileReplace" accept="video/*,image/*" style="font-size:13px;color:var(--text-secondary)">
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.replace_file_hint')}</p>
        </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancelEditBtn">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="saveEditBtn">${t('content.save_changes')}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('#closeEditModal').onclick = () => overlay.remove();
  overlay.querySelector('#cancelEditBtn').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.querySelector('#saveEditBtn').onclick = async () => {
    const filename = overlay.querySelector('#editFilename').value.trim();
    const mimeType = overlay.querySelector('#editMimeType').value;
    const remoteUrl = overlay.querySelector('#editRemoteUrl')?.value.trim();
    const replaceFile = overlay.querySelector('#editFileReplace')?.files[0];

    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: 'Bearer ' + token };

      // Update metadata
      const folderId = overlay.querySelector('#editFolderId')?.value || '';
      const updateData = {};
      if (filename !== contentItem.filename) updateData.filename = filename;
      if (mimeType !== contentItem.mime_type) updateData.mime_type = mimeType;
      if (remoteUrl !== undefined && remoteUrl !== contentItem.remote_url) updateData.remote_url = remoteUrl;
      if ((contentItem.folder_id || '') !== folderId) updateData.folder_id = folderId || null;
      // #157: expiry (datetime-local local wall-clock -> epoch seconds; empty = never).
      const expiryRaw = overlay.querySelector('#editExpiresAt')?.value || '';
      const newExpiry = expiryRaw ? Math.floor(new Date(expiryRaw).getTime() / 1000) : null;
      const curExpiry = contentItem.expires_at != null ? Number(contentItem.expires_at) : null;
      if (newExpiry !== curExpiry) updateData.expires_at = newExpiry;

      if (Object.keys(updateData).length > 0) {
        await fetch('/api/content/' + contentItem.id, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        });
      }

      // Replace file if provided
      if (replaceFile) {
        const formData = new FormData();
        formData.append('file', replaceFile);
        await fetch('/api/content/' + contentItem.id + '/replace', {
          method: 'PUT',
          headers,
          body: formData
        });
      }

      overlay.remove();
      showToast(t('content.toast.updated'), 'success');
      if (onSave) onSave();
    } catch (err) {
      showToast(err.message || t('content.error_update_failed'), 'error');
    }
  };
}

function showPreview(content) {
  const isYoutube = content.mime_type === 'video/youtube';
  const isVideo = !isYoutube && content.mime_type?.startsWith('video/');
  const src = content.remote_url || `/uploads/content/${content.filepath}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border-radius:var(--radius-lg);max-width:90vw;max-height:90vh;overflow:hidden;position:relative">
      <button style="position:absolute;top:8px;right:8px;z-index:1;background:rgba(0,0,0,0.7);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer" id="closePreview">&times;</button>
      <div style="max-width:80vw;max-height:80vh">
        ${isYoutube
          ? `<iframe referrerpolicy="strict-origin-when-cross-origin" src="${(() => { /* #YT153 ROOT CAUSE: the dashboard sends Referrer-Policy: no-referrer (helmet default), so a raw YouTube iframe reaches youtube.com with NO Referer -> YouTube can't identify the embedding site -> "Video player configuration error" (153). referrerpolicy on THIS iframe overrides the page policy to send just our origin, which YouTube uses to validate the embed. (The device player dodges no-referrer differently: YT.Player's iframe_api origin postMessage handshake, which doesn't rely on Referer.) The enablejsapi/origin URL params are inert in a raw iframe (no API loaded), so they're dropped. */ try { const u = new URL(src); u.searchParams.set('mute', '1'); u.searchParams.delete('enablejsapi'); u.searchParams.delete('origin'); return u.toString(); } catch { return src; } })()}" style="width:80vw;height:45vw;max-height:80vh;display:block;border:none" allow="autoplay;encrypted-media" allowfullscreen></iframe>`
          : isVideo
            ? `<video src="${esc(src)}" controls autoplay style="max-width:80vw;max-height:80vh;display:block"></video>`
            : `<img src="${esc(src)}" style="max-width:80vw;max-height:80vh;display:block">`
        }
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border)">
        <div style="font-weight:500">${esc(content.filename)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(content.mime_type)} ${content.remote_url ? `(${t('content.type_remote')})` : ''}</div>
      </div>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#closePreview').onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// Build a "Parent / Child / Leaf" path for a folder so the move-to dropdown is unambiguous
// when two folders share a name in different branches.
function folderPath(folder, all) {
  const byId = new Map(all.map(f => [f.id, f]));
  const parts = [folder.name];
  let cursor = folder;
  while (cursor.parent_id && byId.has(cursor.parent_id)) {
    cursor = byId.get(cursor.parent_id);
    parts.unshift(cursor.name);
  }
  return parts.join(' / ');
}

export function cleanup() {}
