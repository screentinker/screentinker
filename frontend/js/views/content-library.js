import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';

function formatFileSize(bytes) {
  if (!bytes) return '--';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Content Library <span class="help-tip" data-tip="Upload videos and images here. Select multiple files for bulk upload. Use Remote URL to stream from external sources. Click a thumbnail to preview.">?</span></h1>
        <div class="subtitle">Upload and manage your media files</div>
      </div>
    </div>

    <div style="display:flex;gap:16px;margin-bottom:24px">
      <div class="upload-area" id="uploadArea" style="flex:1;margin-bottom:0">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>Drop files here or click to upload</p>
        <p class="upload-hint">Supports MP4, WebM, AVI, MKV, JPEG, PNG, GIF, WebP</p>
        <input type="file" id="fileInput" style="display:none" multiple accept="video/*,image/*">
        <div class="upload-progress" id="uploadProgress" style="display:none">
          <div class="upload-progress-bar">
            <div class="upload-progress-fill" id="uploadProgressFill" style="width:0%"></div>
          </div>
          <p style="font-size:12px;color:var(--text-secondary);margin-top:6px" id="uploadProgressText">Uploading...</p>
        </div>
      </div>
      <div style="width:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          Remote URL
        </div>
        <p style="font-size:12px;color:var(--text-muted)">Stream directly from a URL. Saves local bandwidth.</p>
        <input type="text" id="remoteUrlInput" class="input" placeholder="https://example.com/video.mp4">
        <input type="text" id="remoteNameInput" class="input" placeholder="Display name (optional)">
        <select id="remoteMimeType" class="input" style="background:var(--bg-input)">
          <option value="video/mp4">Video (MP4)</option>
          <option value="video/webm">Video (WebM)</option>
          <option value="image/jpeg">Image (JPEG)</option>
          <option value="image/png">Image (PNG)</option>
        </select>
        <button class="btn btn-primary" id="addRemoteBtn">Add Remote URL</button>
      </div>
      <div style="width:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19.13C5.12 19.56 12 19.56 12 19.56s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.43z"/>
            <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/>
          </svg>
          YouTube
        </div>
        <p style="font-size:12px;color:var(--text-muted)">Embed a YouTube video on your displays.</p>
        <input type="text" id="youtubeUrlInput" class="input" placeholder="https://youtube.com/watch?v=...">
        <input type="text" id="youtubeNameInput" class="input" placeholder="Display name (optional)">
        <button class="btn btn-primary" id="addYoutubeBtn">Add YouTube Video</button>
      </div>
    </div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
      <input type="text" id="contentSearch" class="input" placeholder="Search content..." style="width:250px">
      <select id="folderFilter" class="input" style="width:180px;background:var(--bg-input)">
        <option value="">All Folders</option>
      </select>
      <button class="btn btn-secondary btn-sm" id="newFolderBtn">+ New Folder</button>
    </div>
    <div class="content-grid" id="contentGrid">
      <div class="empty-state" style="grid-column:1/-1"><h3>Loading...</h3></div>
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
      showToast('Enter a URL', 'error');
      return;
    }
    try {
      await api.addRemoteContent(url, name, mimeType);
      showToast('Remote content added', 'success');
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
      showToast('Enter a YouTube URL', 'error');
      return;
    }
    try {
      await api.addYoutubeContent(url, name);
      showToast('YouTube video added', 'success');
      document.getElementById('youtubeUrlInput').value = '';
      document.getElementById('youtubeNameInput').value = '';
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Content search + folder filter
  function filterContent() {
    const q = document.getElementById('contentSearch').value.toLowerCase();
    const folder = document.getElementById('folderFilter').value;
    document.querySelectorAll('.content-item').forEach(item => {
      const name = item.querySelector('.content-item-name')?.textContent.toLowerCase() || '';
      const itemFolder = item.dataset.folder || '';
      const matchSearch = !q || name.includes(q);
      const matchFolder = !folder || itemFolder === folder;
      item.style.display = (matchSearch && matchFolder) ? '' : 'none';
    });
  }
  document.getElementById('contentSearch').oninput = filterContent;
  document.getElementById('folderFilter').onchange = filterContent;

  // New folder
  document.getElementById('newFolderBtn').onclick = () => {
    const name = prompt('Folder name:');
    if (name) {
      // Just add to the dropdown - folders are created when content is moved into them
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      document.getElementById('folderFilter').appendChild(opt);
      showToast(`Folder "${name}" created. Edit content to move it here.`, 'info');
    }
  };

  loadContent();
}

async function handleFiles(files) {
  const progress = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  for (const file of files) {
    progress.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = `Uploading ${file.name}...`;

    try {
      await api.uploadContent(file, (pct) => {
        progressFill.style.width = pct + '%';
        progressText.textContent = `Uploading ${file.name}... ${pct}%`;
      });
      showToast(`${file.name} uploaded successfully`, 'success');
    } catch (err) {
      showToast(`Failed to upload ${file.name}: ${err.message}`, 'error');
    }
  }

  progress.style.display = 'none';
  loadContent();
}

async function loadContent() {
  const grid = document.getElementById('contentGrid');
  if (!grid) return;

  try {
    const content = await api.getContent();
    if (!content.length) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          <h3>No content yet</h3>
          <p>Upload videos and images to get started.</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = content.map(c => `
      <div class="content-item" data-content-id="${c.id}" data-folder="${c.folder || ''}">
        <div class="content-item-preview">
          ${c.mime_type === 'video/youtube'
            ? `<div style="position:relative;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center">
                <img src="${c.thumbnail_path}" alt="${c.filename}" loading="lazy" style="width:100%;height:100%;object-fit:cover">
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
                <span style="font-size:10px;color:var(--text-muted)">Remote</span>
              </div>`
            : c.thumbnail_path
              ? `<img src="/api/content/${c.id}/thumbnail" alt="${c.filename}" loading="lazy">`
              : c.mime_type?.startsWith('video/')
                ? `<div class="video-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </div>`
                : `<img src="/api/content/${c.id}/file" alt="${c.filename}" loading="lazy">`
          }
        </div>
        <div class="content-item-body">
          <div class="content-item-name" title="${c.filename}">${c.filename}</div>
          <div class="content-item-size">
            ${c.mime_type === 'video/youtube' ? 'YouTube' : c.remote_url ? 'Remote URL' : (c.mime_type?.startsWith('video/') ? 'Video' : 'Image')}
            ${c.duration_sec ? ` &middot; ${Math.floor(c.duration_sec / 60)}:${String(Math.floor(c.duration_sec % 60)).padStart(2, '0')}` : ''}
            ${c.file_size ? ' &middot; ' + formatFileSize(c.file_size) : ''}
            ${c.width && c.height ? ` &middot; ${c.width}x${c.height}` : ''}
          </div>
        </div>
        <div class="content-item-actions">
          <button class="btn btn-secondary btn-sm" data-edit-content="${c.id}" title="Edit">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Edit
          </button>
          <button class="btn btn-danger btn-sm" data-delete-content="${c.id}" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            Delete
          </button>
        </div>
      </div>
    `).join('');

    // Populate folder dropdown
    const folderSelect = document.getElementById('folderFilter');
    const folders = [...new Set(content.filter(c => c.folder).map(c => c.folder))].sort();
    folders.forEach(f => {
      if (!folderSelect.querySelector(`option[value="${f}"]`)) {
        const opt = document.createElement('option');
        opt.value = f; opt.textContent = `${f} (${content.filter(c => c.folder === f).length})`;
        folderSelect.appendChild(opt);
      }
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
          btn.textContent = 'Deleting...';
          await api.deleteContent(id);
          showToast('Content deleted', 'success');
          loadContent();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Delete';
          btn.dataset.confirming = 'false';
        }
        return;
      }

      // First click - show confirm state
      btn.dataset.confirming = 'true';
      btn.innerHTML = 'Confirm Delete?';
      btn.style.background = 'var(--danger)';
      btn.style.color = 'white';
      // Reset after 3 seconds if not clicked
      setTimeout(() => {
        if (btn.dataset.confirming === 'true') {
          btn.dataset.confirming = 'false';
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete`;
          btn.style.background = '';
          btn.style.color = '';
        }
      }, 3000);
    };

  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load content</h3><p>${esc(err.message)}</p></div>`;
  }
}

function showEditModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';

  const isRemote = !!contentItem.remote_url;

  overlay.innerHTML = `
    <div class="modal" style="width:500px">
      <div class="modal-header">
        <h3>Edit Content</h3>
        <button class="btn-icon" id="closeEditModal">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Filename / Display Name</label>
          <input type="text" id="editFilename" class="input" value="${contentItem.filename}">
        </div>
        ${isRemote ? `
        <div class="form-group">
          <label>Remote URL</label>
          <input type="text" id="editRemoteUrl" class="input" value="${contentItem.remote_url}">
        </div>
        ` : ''}
        <div class="form-group">
          <label>MIME Type</label>
          <select id="editMimeType" class="input" style="background:var(--bg-input)">
            <option value="video/mp4" ${contentItem.mime_type === 'video/mp4' ? 'selected' : ''}>Video (MP4)</option>
            <option value="video/webm" ${contentItem.mime_type === 'video/webm' ? 'selected' : ''}>Video (WebM)</option>
            <option value="image/jpeg" ${contentItem.mime_type === 'image/jpeg' ? 'selected' : ''}>Image (JPEG)</option>
            <option value="image/png" ${contentItem.mime_type === 'image/png' ? 'selected' : ''}>Image (PNG)</option>
            <option value="image/gif" ${contentItem.mime_type === 'image/gif' ? 'selected' : ''}>Image (GIF)</option>
            <option value="image/webp" ${contentItem.mime_type === 'image/webp' ? 'selected' : ''}>Image (WebP)</option>
          </select>
        </div>
        ${!isRemote ? `
        <div class="form-group">
          <label>Replace File</label>
          <input type="file" id="editFileReplace" accept="video/*,image/*" style="font-size:13px;color:var(--text-secondary)">
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Leave empty to keep current file</p>
        </div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cancelEditBtn">Cancel</button>
        <button class="btn btn-primary" id="saveEditBtn">Save Changes</button>
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
      const updateData = {};
      if (filename !== contentItem.filename) updateData.filename = filename;
      if (mimeType !== contentItem.mime_type) updateData.mime_type = mimeType;
      if (remoteUrl !== undefined && remoteUrl !== contentItem.remote_url) updateData.remote_url = remoteUrl;

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
      showToast('Content updated', 'success');
      if (onSave) onSave();
    } catch (err) {
      showToast(err.message || 'Update failed', 'error');
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
          ? `<iframe src="${(() => { try { const u = new URL(src); if (!u.searchParams.has('mute')) u.searchParams.set('mute','1'); if (!u.searchParams.has('enablejsapi')) u.searchParams.set('enablejsapi','1'); if (!u.searchParams.has('origin')) u.searchParams.set('origin', window.location.origin); return u.toString(); } catch { return src; } })()}" style="width:80vw;height:45vw;max-height:80vh;display:block;border:none" allow="autoplay;encrypted-media" allowfullscreen></iframe>`
          : isVideo
            ? `<video src="${src}" controls autoplay style="max-width:80vw;max-height:80vh;display:block"></video>`
            : `<img src="${src}" style="max-width:80vw;max-height:80vh;display:block">`
        }
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--border)">
        <div style="font-weight:500">${content.filename}</div>
        <div style="font-size:12px;color:var(--text-muted)">${content.mime_type} ${content.remote_url ? '(Remote URL)' : ''}</div>
      </div>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#closePreview').onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

export function cleanup() {}
