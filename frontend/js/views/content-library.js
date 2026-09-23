import { api, assertLocalCallAllowed } from '../api.js';
import { uploadFilesResumable } from '../lib/chunked-upload.js';
import * as gettingStarted from '../components/getting-started.js';
import { showToast } from '../components/toast.js';
import { esc, hydrateAuthImages } from '../utils.js';
import { t } from '../i18n.js';
import { openHistoryModal } from '../components/history-modal.js';
import { renderApprovalBar } from '../components/approval-actions.js';
import { isPdf, renderPdfToPages, baseName } from '../components/pdf-pages.js';

/* The mime lib/html-bundle.js stamps on an uploaded HTML bundle. Kept as a constant rather than
 * spelled out at each site: it is compared in three places here, and a typo in one of them is a
 * card that renders an <img> pointed at a zip. */
const BUNDLE_MIME = 'application/vnd.screentinker.bundle+zip';

// #216: languages offered in the caption/subtitle pickers. Codes are BCP-47 primary tags —
// enough for signage; extend as needed.
const SUBTITLE_LANGS = [
  ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['pt', 'Português'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['ja', '日本語'],
  ['ko', '한국어'], ['zh', '中文'],
];

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

function metaToLines(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return Object.entries(meta).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${t('content.title')} <span class="help-tip" data-tip="${t('content.help_tip')}">?</span></h1>
        <div class="subtitle">${t('content.subtitle')}</div>
      </div>
    </div>

    <!-- The checklist follows the user here. Arriving from its "Add content" step and finding
         nothing that mentions it is how someone loses the thread. -->
    <div id="gettingStarted"></div>

    <div class="content-toolbar" style="display:flex;gap:16px;margin-bottom:24px">
      <div class="upload-area" id="uploadArea" style="flex:1;margin-bottom:0">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>${t('content.drop')}</p>
        <p class="upload-hint">${t('content.upload_hint')}</p>
        <input type="file" id="fileInput" style="display:none" multiple accept="video/*,image/*,audio/*,.zip,.wgt,.pdf,application/pdf">
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
          <option value="audio/mpeg">${t('content.mime.audio_mpeg')}</option>
          <option value="audio/wav">${t('content.mime.audio_wav')}</option>
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
      <div style="width:320px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:8px;color:var(--text-primary);font-weight:500">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
          ${t('content.hls')}
        </div>
        <p style="font-size:12px;color:var(--text-muted)">${t('content.hls_desc')}</p>
        <input type="text" id="hlsUrlInput" class="input" placeholder="${t('content.hls_url_placeholder')}">
        <input type="text" id="hlsNameInput" class="input" placeholder="${t('content.hls_name_placeholder')}">
        <button class="btn btn-primary" id="addHlsBtn">${t('content.hls_add_btn')}</button>
      </div>
    </div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <input type="text" id="contentSearch" class="input" placeholder="${t('content.search_placeholder')}" style="max-width:250px;width:100%" value="${esc(state.search)}">
      <select id="contentTypeFilter" class="input btn-sm" style="width:auto;background:var(--bg-input)">
        <option value="all" ${state.type === 'all' ? 'selected' : ''}>${t('content.filter_type_all')}</option>
        <option value="video" ${state.type === 'video' ? 'selected' : ''}>${t('content.filter_type_video')}</option>
        <option value="image" ${state.type === 'image' ? 'selected' : ''}>${t('content.filter_type_image')}</option>
        <option value="youtube" ${state.type === 'youtube' ? 'selected' : ''}>${t('content.filter_type_youtube')}</option>
        <option value="live" ${state.type === 'live' ? 'selected' : ''}>${t('content.filter_type_live')}</option>
        <option value="web" ${state.type === 'web' ? 'selected' : ''}>${t('content.filter_type_web')}</option>
        <option value="bundle" ${state.type === 'bundle' ? 'selected' : ''}>${t('content.filter_type_bundle')}</option>
      </select>
      <select id="contentSort" class="input btn-sm" style="width:auto;background:var(--bg-input)">
        <option value="date_desc" ${state.sort === 'date_desc' ? 'selected' : ''}>${t('content.sort_newest')}</option>
        <option value="date_asc" ${state.sort === 'date_asc' ? 'selected' : ''}>${t('content.sort_oldest')}</option>
        <option value="name" ${state.sort === 'name' ? 'selected' : ''}>${t('content.sort_name')}</option>
        <option value="size" ${state.sort === 'size' ? 'selected' : ''}>${t('content.sort_size')}</option>
      </select>
      <span id="contentResultCount" style="font-size:13px;color:var(--text-muted)"></span>
      <button class="btn btn-secondary btn-sm" id="newFolderBtn">${t('content.new_folder_btn')}</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);cursor:pointer;margin-left:auto">
        <input type="checkbox" id="showExpiredToggle" ${state.showExpired ? 'checked' : ''}> ${t('content.show_expired')}
      </label>
    </div>
    <div id="folderBreadcrumb" style="display:flex;gap:6px;align-items:center;margin-bottom:12px;font-size:13px;flex-wrap:wrap"></div>
    <div id="batchToolbar" style="display:none"></div>
    <div id="folderGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px"></div>
    <div class="content-grid" id="contentGrid">
      <div class="empty-state" style="grid-column:1/-1"><h3>${t('common.loading')}</h3></div>
    </div>
  `;

  // File upload handling
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');

  /*
   * The checklist, if this account still has one. Fire-and-forget: it fetches devices and
   * playlists (never content — the caller has none to give here and getContent is this page's own
   * expensive call), and hides itself when there is nothing left to do.
   */
  gettingStarted.mount(document.getElementById('gettingStarted'), {
    // Step 2 points at this page, so its button must DO something here rather than re-navigate to
    // the page it is already on. Clicking the upload area is the page's own path to the file
    // picker — and it stays inside the user's click, which is what the browser requires to open one.
    onAction: (a) => {
      if (a === 'add-content') { document.getElementById('uploadArea')?.click(); return true; }
      return false;
    },
  }).catch(() => {});

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

  // IPTV: add a live HLS stream. The screen opens the URL itself (it may be a LAN
  // address); ScreenTinker never pulls the video, so the private-URL error from the
  // server-fetched remote path never applies here.
  document.getElementById('addHlsBtn').addEventListener('click', async () => {
    const url = document.getElementById('hlsUrlInput').value.trim();
    const name = document.getElementById('hlsNameInput').value.trim();
    if (!url) {
      showToast(t('content.error_enter_hls_url'), 'error');
      return;
    }
    try {
      await api.addHlsContent(url, name);
      showToast(t('content.toast.hls_added'), 'success');
      document.getElementById('hlsUrlInput').value = '';
      document.getElementById('hlsNameInput').value = '';
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // #214: search/type/sort now query the server so results span the whole workspace,
  // not just the items already rendered on the current page. Search is debounced to
  // avoid a request per keystroke.
  let searchTimer = null;
  document.getElementById('contentSearch').oninput = (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { state.search = v.trim(); loadContent(); }, 300);
  };
  document.getElementById('contentTypeFilter').onchange = (e) => { state.type = e.target.value; loadContent(); };
  document.getElementById('contentSort').onchange = (e) => { state.sort = e.target.value; loadContent(); };

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
  search: '',            // #214: server-side text search (spans the whole workspace)
  type: 'all',           // #214: type filter — all | video | image | youtube | web
  sort: 'date_desc',     // #214: sort order — date_desc | date_asc | name | size
  selected: new Set(),   // #213: ids selected for batch operations (scoped to the current view)
  lastClickedId: null,   // #213: anchor for shift-click range selection
};

async function handleFiles(files) {
  const all = Array.from(files);
  if (all.length === 0) return;
  const progress = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');

  // A PDF is not uploaded as a PDF. It is rendered to one PNG per page in this browser and those
  // go up as ordinary images, into a folder and a playlist named after the document. The server
  // never sees the PDF and does not accept one — see components/pdf-pages.js for why.
  const pdfs = all.filter(isPdf);
  const list = all.filter((f) => !isPdf(f));

  // #212: send all selected files in a single request with aggregate progress, instead
  // of one sequential XHR per file.
  progress.style.display = 'block';
  progressFill.style.width = '0%';

  try {
    for (const pdf of pdfs) await importPdf(pdf, progressFill, progressText);
    if (list.length) {
      const label = list.length === 1 ? list[0].name : t('content.upload_progress_count', { count: list.length });
      progressText.textContent = label;
      /*
       * ⚠️ RESUMABLE, ONE FILE AT A TIME — this replaces #212's single all-or-nothing request.
       *
       * That request had to finish inside the shortest timeout between the browser and the server,
       * which on prod is Cloudflare's 125 seconds. Measured: seven consecutive failures from one
       * customer at 125.008-125.012s while his successful uploads peaked at 114.2s. Selecting
       * several files made it certain, because the bytes scaled and the 125 seconds did not — and
       * the aggregate bar sat near 1% the whole time, which is exactly how he reported it.
       *
       * The bar still aggregates across the whole selection; it is now fed by bytes rather than by
       * one XHR's progress, so it means the same thing without betting everything on one request.
       */
      await uploadFilesResumable(list, {
        folderId: state.currentFolderId,
        onProgress: (sent, total, file) => {
          const pct = total ? Math.round((sent / total) * 100) : 0;
          progressFill.style.width = pct + '%';
          progressText.textContent = list.length === 1
            ? `${label} — ${pct}%`
            : `${label} — ${pct}% (${file ? file.name : ''})`;
        },
        // Offered only when a PREVIOUS visit left bytes on the server for this exact file.
        onResumeOffer: ({ offset, total }) => window.confirm(
          t('content.upload_resume_prompt', {
            name: list.length === 1 ? list[0].name : t('content.upload_progress_count', { count: list.length }),
            done: Math.round((offset / total) * 100),
          })
        ),
      });
      showToast(
        list.length === 1
          ? t('content.toast.uploaded_named', { name: list[0].name })
          : t('content.toast.uploaded_count', { count: list.length }),
        'success'
      );
    }
  } catch (err) {
    const label = all.length === 1 ? all[0].name : t('content.upload_progress_count', { count: all.length });
    showToast(t('content.toast.upload_failed_named', { name: label, error: err.message }), 'error');
  }

  progress.style.display = 'none';
  loadContent();
}

/**
 * One PDF → a folder of page images + a playlist that plays them in order.
 *
 * Rendering is the first half of the progress bar, uploading the second. The folder is a
 * nicety and the playlist is the feature, so a folder that cannot be created (no workspace, or
 * the per-workspace folder cap) falls back to the current folder rather than failing the import,
 * and a playlist that cannot be created after the pages are up reports THAT rather than pretending
 * the upload failed — the images exist and the user should know it.
 */
async function importPdf(file, progressFill, progressText) {
  const base = baseName(file.name).slice(0, 100);
  progressText.textContent = t('content.pdf.rendering', { name: base, done: 0, total: '…' });
  const pages = await renderPdfToPages(file, (done, total) => {
    progressFill.style.width = Math.round((done / total) * 50) + '%';
    progressText.textContent = t('content.pdf.rendering', { name: base, done, total });
  });

  let folderId = state.currentFolderId;
  try {
    folderId = (await api.createFolder(base, state.currentFolderId)).id;
  } catch (_) { /* fall through: pages land in the current folder instead */ }

  const uploaded = await api.uploadContent(pages, (pct) => {
    progressFill.style.width = (50 + Math.round(pct / 2)) + '%';
    progressText.textContent = t('content.pdf.uploading', { name: base, pct });
  }, folderId);
  const items = Array.isArray(uploaded) ? uploaded : [uploaded];

  try {
    const playlist = await api.createPlaylist(base,
      t('content.pdf.playlist_description', { name: file.name, count: items.length }));
    await api.addPlaylistItemsBulk(playlist.id, items.map((c) => c.id));
    showToast(t('content.toast.pdf_imported', { name: base, count: items.length }), 'success');
  } catch (err) {
    showToast(t('content.toast.pdf_playlist_failed', { name: base, count: items.length, error: err.message }), 'error');
  }
}

async function loadContent() {
  const grid = document.getElementById('contentGrid');
  const folderGrid = document.getElementById('folderGrid');
  const breadcrumb = document.getElementById('folderBreadcrumb');
  if (!grid || !folderGrid || !breadcrumb) return;

  try {
    const [content, folders] = await Promise.all([
      api.getContent(state.currentFolderId === null ? null : state.currentFolderId, state.showExpired, {
        q: state.search, type: state.type, sort: state.sort,
      }),
      api.getFolders(),
    ]);
    state.folders = folders;

    // #214: while a search or type filter is active, results span the whole workspace,
    // so surface a count and note the folder scope no longer applies.
    const countEl = document.getElementById('contentResultCount');
    if (countEl) {
      const filtering = state.search || (state.type && state.type !== 'all');
      countEl.textContent = filtering
        ? t('content.result_count', { count: content.length })
        : '';
    }

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
      <div class="content-item" draggable="true" data-content-id="${c.id}" data-folder="${esc(c.folder || '')}" style="position:relative;${state.selected.has(c.id) ? 'outline:2px solid var(--primary,#3B82F6);outline-offset:-2px;' : ''}${exp.expired ? 'opacity:.55' : ''}">
        <label class="content-select-wrap" style="position:absolute;top:6px;left:6px;z-index:2;background:rgba(0,0,0,.55);border-radius:4px;padding:3px;display:flex;cursor:pointer">
          <input type="checkbox" class="content-select" data-content-id="${c.id}" ${state.selected.has(c.id) ? 'checked' : ''} style="width:16px;height:16px;margin:0;cursor:pointer">
        </label>
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
          : c.mime_type === BUNDLE_MIME
            ? `<div class="video-icon" style="flex-direction:column;gap:4px">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
                </svg>
                <span style="font-size:10px;color:var(--text-muted)">${t('content.type_bundle_short')}</span>
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
          ${Array.isArray(c.tags) && c.tags.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${c.tags.map((tg) => `<span data-tag="${esc(tg)}" style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg-input);color:var(--text-muted);cursor:pointer">#${esc(tg)}</span>`).join('')}</div>` : ''}
          <div class="content-item-size">
            ${c.mime_type === 'video/hls' || c.mime_type === 'video/rtsp' ? t('content.type_live') : c.mime_type === 'video/youtube' ? t('content.type_youtube') : c.mime_type === BUNDLE_MIME ? t('content.type_bundle') : c.remote_url ? t('content.type_remote') : (c.mime_type?.startsWith('video/') ? t('content.type_video') : t('content.type_image'))}
            ${c.duration_sec ? ` &middot; ${Math.floor(c.duration_sec / 60)}:${String(Math.floor(c.duration_sec % 60)).padStart(2, '0')}` : ''}
            ${c.file_size ? ' &middot; ' + formatFileSize(c.file_size) : ''}
            ${c.width && c.height ? ` &middot; ${c.width}x${c.height}` : ''}
          </div>
          ${exp.expired
            ? `<div style="font-size:11px;color:var(--danger,#e5484d);font-weight:600;margin-top:4px">${t('content.expired_badge')}${exp.dateLabel ? ` &middot; ${exp.dateLabel}` : ''}</div>`
            : (exp.dateLabel ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.expires_label', { date: exp.dateLabel })}</div>` : '')}
        </div>
        <div class="content-item-actions">
          <button class="btn btn-secondary btn-sm" data-history-content="${c.id}" title="${t('history.button')}">${t('history.button')}</button>
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

    // #213: selection checkboxes (with shift-click range). `content` is the current page's
    // ordered list, so a range fills between the anchor and the clicked item.
    grid.querySelectorAll('.content-select').forEach(cb => {
      cb.addEventListener('click', (e) => {
        const id = cb.dataset.contentId;
        if (e.shiftKey && state.lastClickedId) {
          const order = content.map(c => c.id);
          const a = order.indexOf(state.lastClickedId);
          const b = order.indexOf(id);
          if (a !== -1 && b !== -1) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            const on = cb.checked; // apply the clicked box's new state across the range
            for (let i = lo; i <= hi; i++) { if (on) state.selected.add(order[i]); else state.selected.delete(order[i]); }
          }
        } else if (cb.checked) {
          state.selected.add(id);
        } else {
          state.selected.delete(id);
        }
        state.lastClickedId = id;
        loadContent(); // re-render to reflect range + selection outlines + toolbar
      });
    });

    // Delete handler via event delegation
    grid.onclick = async (e) => {
      const histBtn = e.target.closest('[data-history-content]');
      if (histBtn) {
        const c = content.find(x => x.id === histBtn.dataset.historyContent);
        openHistoryModal('content', histBtn.dataset.historyContent, { name: c?.name || c?.filename, onChanged: () => loadContent() });
        return;
      }
      // #213: ignore clicks originating on a selection checkbox (handled above).
      if (e.target.closest('.content-select-wrap')) return;
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
      const tagEl = e.target.closest('[data-tag]');
      if (tagEl) {
        state.search = '#' + tagEl.dataset.tag;
        const box = document.getElementById('contentSearch');
        if (box) box.value = state.search;
        loadContent();
        return;
      }
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

    // #213: batch-operations toolbar reflects the current selection.
    renderBatchToolbar(content);

  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>${t('content.failed_to_load')}</h3><p>${esc(err.message)}</p></div>`;
  }

  // #313/checklist: adding content ticks a step, and this is the one path every add
  // (file, remote URL, YouTube) already goes through.
  gettingStarted.refresh().catch(() => {});
}

// #213: the batch toolbar — shown only when something is selected. `visible` is the current
// page's items, used by "select all". Actions validate/act atomically server-side; on success
// the selection is cleared and the grid reloaded.
function renderBatchToolbar(visible) {
  const bar = document.getElementById('batchToolbar');
  if (!bar) return;
  const count = state.selected.size;
  if (count === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }

  const allVisibleSelected = visible.length > 0 && visible.every(c => state.selected.has(c.id));
  bar.style.display = 'flex';
  bar.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)';
  bar.innerHTML = `
    <strong style="font-size:13px">${t('content.batch_selected', { count })}</strong>
    <button class="btn btn-secondary btn-sm" id="batchSelectAll">${allVisibleSelected ? t('content.batch_select_none') : t('content.batch_select_all')}</button>
    <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
      <select id="batchMoveFolder" class="input btn-sm" style="width:auto;background:var(--bg-input)">
        <option value="">${t('content.batch_move_placeholder')}</option>
        <option value="__root__">${t('content.folder_root_option')}</option>
        ${state.folders.map(f => `<option value="${f.id}">${esc(folderPath(f, state.folders))}</option>`).join('')}
      </select>
      <button class="btn btn-danger btn-sm" id="batchDelete">${t('content.batch_delete', { count })}</button>
    </div>
  `;

  bar.querySelector('#batchSelectAll').onclick = () => {
    if (allVisibleSelected) visible.forEach(c => state.selected.delete(c.id));
    else visible.forEach(c => state.selected.add(c.id));
    loadContent();
  };

  bar.querySelector('#batchMoveFolder').onchange = async (e) => {
    const val = e.target.value;
    if (!val) return;
    const folderId = val === '__root__' ? null : val;
    const ids = [...state.selected];
    try {
      await api.batchMoveContent(ids, folderId);
      showToast(t('content.toast.batch_moved', { count: ids.length }), 'success');
      state.selected.clear();
      state.lastClickedId = null;
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
      e.target.value = '';
    }
  };

  const delBtn = bar.querySelector('#batchDelete');
  delBtn.onclick = async () => {
    const ids = [...state.selected];
    if (delBtn.dataset.confirming !== 'true') {
      delBtn.dataset.confirming = 'true';
      delBtn.textContent = t('content.batch_delete_confirm', { count: ids.length });
      setTimeout(() => { if (delBtn.dataset.confirming === 'true') { delBtn.dataset.confirming = 'false'; delBtn.textContent = t('content.batch_delete', { count: ids.length }); } }, 3000);
      return;
    }
    try {
      delBtn.disabled = true;
      await api.batchDeleteContent(ids);
      showToast(t('content.toast.batch_deleted', { count: ids.length }), 'success');
      state.selected.clear();
      state.lastClickedId = null;
      loadContent();
    } catch (err) {
      showToast(err.message, 'error');
      delBtn.disabled = false;
      delBtn.dataset.confirming = 'false';
      delBtn.textContent = t('content.batch_delete', { count: ids.length });
    }
  };
}

function showEditModal(contentItem, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';

  const isRemote = !!contentItem.remote_url;
  const isYoutube = contentItem.mime_type === 'video/youtube';
  const isUploadedVideo = !isRemote && contentItem.mime_type?.startsWith('video/');
  // #216: language <option>s shared by the caption + subtitle pickers.
  const langOptions = (sel) => SUBTITLE_LANGS
    .map(([code, label]) => `<option value="${code}" ${sel === code ? 'selected' : ''}>${label}</option>`)
    .join('');

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
        <div class="form-group">
          <label>${t('content.label_tags')}</label>
          <input type="text" id="editTags" class="input" value="${esc((Array.isArray(contentItem.tags) ? contentItem.tags : []).join(', '))}" placeholder="${esc(t('content.tags_placeholder'))}">
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${t('content.tags_hint')}</div>
        </div>
        <div class="form-group">
          <label>${t('content.label_meta')}</label>
          <textarea id="editMeta" class="input" rows="3" placeholder="${esc(t('content.meta_placeholder'))}" style="width:100%;font-family:monospace;font-size:12px">${esc(metaToLines(contentItem.meta))}</textarea>
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
              ${['video/mp4','video/webm','image/jpeg','image/png','image/gif','image/webp'].includes(contentItem.mime_type) ? '' : `
              <!-- The item's ACTUAL type, for the cases the six choices above cannot express:
                   video/youtube, and uploads the sniffer accepts but this list omits (.mov, .svg,
                   .heic, .avif, .bmp). Without it no option matched, the browser selected the first
                   one - video/mp4 - and pressing Save with nothing else changed rewrote the item's
                   type. mime_type is the renderer selector in every player, so a YouTube item became
                   an "MP4" whose source is an embed page: a dead slide on every screen, and
                   unrecoverable here because there was no option to set it back. -->
              <option value="${esc(contentItem.mime_type || '')}" selected>${esc(contentItem.mime_type || '')}</option>`}
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
        ${isYoutube ? `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="editUnstableConnection" ${contentItem.unstable_connection ? 'checked' : ''} style="width:auto;margin:0">
            <span>${t('content.label_unstable_connection')}</span>
          </label>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.unstable_connection_hint')}</p>
        </div>
        ` : ''}
        ${isYoutube ? `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="editCaptionsEnabled" ${contentItem.captions_enabled ? 'checked' : ''} style="width:auto;margin:0">
            <span>${t('content.label_captions_enabled')}</span>
          </label>
          <div style="margin-top:8px">
            <label style="font-size:12px;color:var(--text-secondary)">${t('content.label_captions_lang')}</label>
            <select id="editCaptionsLang" class="input" style="background:var(--bg-input)">${langOptions(contentItem.captions_lang || 'en')}</select>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.captions_hint')}</p>
        </div>
        ` : ''}
        ${isUploadedVideo ? `
        <div class="form-group">
          <label>${t('content.label_subtitle_file')}</label>
          ${contentItem.subtitle_url ? `<p style="font-size:11px;color:var(--text-secondary);margin:2px 0 6px">${t('content.subtitle_current')}</p>` : ''}
          <input type="file" id="editSubtitleFile" accept=".vtt,text/vtt" style="font-size:13px;color:var(--text-secondary)">
          <div style="margin-top:8px">
            <label style="font-size:12px;color:var(--text-secondary)">${t('content.label_subtitle_lang')}</label>
            <select id="editSubtitleLang" class="input" style="background:var(--bg-input)">${langOptions(contentItem.subtitle_lang || 'en')}</select>
          </div>
          ${contentItem.subtitle_url ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px"><input type="checkbox" id="editSubtitleRemove" style="width:auto;margin:0"><span>${t('content.subtitle_remove')}</span></label>` : ''}
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('content.subtitle_hint')}</p>
        </div>
        ` : ''}
        ${!isRemote ? `
        <div class="form-group">
          <label>${t('content.label_replace_file')}</label>
          <input type="file" id="editFileReplace" accept="video/*,image/*,audio/*,.zip,.wgt" style="font-size:13px;color:var(--text-secondary)">
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
      const tagsRaw = overlay.querySelector('#editTags')?.value || '';
      const newTags = tagsRaw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      const curTags = Array.isArray(contentItem.tags) ? contentItem.tags : [];
      if (newTags.join('\0') !== curTags.join('\0')) updateData.tags = newTags;
      const metaRaw = overlay.querySelector('#editMeta')?.value || '';
      // Only send meta when it actually changed. metaToLines() renders the
      // current meta the same way the textarea is seeded, so an untouched
      // modal produces an identical string and no-op Saves don't fire a PUT
      // (which would bump a revision and re-flag approval-gated assets).
      if (metaRaw !== metaToLines(contentItem.meta)) updateData.meta = metaRaw;
      if (mimeType !== contentItem.mime_type) updateData.mime_type = mimeType;
      if (remoteUrl !== undefined && remoteUrl !== contentItem.remote_url) updateData.remote_url = remoteUrl;
      if ((contentItem.folder_id || '') !== folderId) updateData.folder_id = folderId || null;
      // #157: expiry (datetime-local local wall-clock -> epoch seconds; empty = never).
      const expiryRaw = overlay.querySelector('#editExpiresAt')?.value || '';
      const newExpiry = expiryRaw ? Math.floor(new Date(expiryRaw).getTime() / 1000) : null;
      const curExpiry = contentItem.expires_at != null ? Number(contentItem.expires_at) : null;
      if (newExpiry !== curExpiry) updateData.expires_at = newExpiry;
      // #217: YouTube-only "unstable connection" quality cap.
      const unstableEl = overlay.querySelector('#editUnstableConnection');
      if (unstableEl) {
        const newUnstable = unstableEl.checked ? 1 : 0;
        if (newUnstable !== (contentItem.unstable_connection ? 1 : 0)) updateData.unstable_connection = newUnstable;
      }
      // #216: YouTube captions (checkbox + language).
      const captionsEl = overlay.querySelector('#editCaptionsEnabled');
      if (captionsEl) {
        const newCaptions = captionsEl.checked ? 1 : 0;
        if (newCaptions !== (contentItem.captions_enabled ? 1 : 0)) updateData.captions_enabled = newCaptions;
        const capLang = overlay.querySelector('#editCaptionsLang')?.value || null;
        if (capLang !== (contentItem.captions_lang || 'en')) updateData.captions_lang = capLang;
      }
      // #216: uploaded-video subtitle language change / removal (the FILE is sent separately below).
      const subtitleFile = overlay.querySelector('#editSubtitleFile')?.files[0];
      const subLangEl = overlay.querySelector('#editSubtitleLang');
      const subRemove = overlay.querySelector('#editSubtitleRemove')?.checked;
      if (subRemove) {
        updateData.subtitle_url = null;
        updateData.subtitle_lang = null;
      } else if (subLangEl && !subtitleFile) {
        // Lang-only change (no new file) — the upload endpoint handles lang when a file IS sent.
        const subLang = subLangEl.value || null;
        if (contentItem.subtitle_url && subLang !== (contentItem.subtitle_lang || 'en')) updateData.subtitle_lang = subLang;
      }

      let pendingReview = false;
      if (Object.keys(updateData).length > 0) {
        assertLocalCallAllowed('/content', 'PUT');
        const r = await fetch('/api/content/' + contentItem.id, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Update failed');
        pendingReview = !!body.pending_review;
      }

      // Replace file if provided
      if (replaceFile) {
        const formData = new FormData();
        formData.append('file', replaceFile);
        assertLocalCallAllowed('/content', 'POST');
        await fetch('/api/content/' + contentItem.id + '/replace', {
          method: 'PUT',
          headers,
          body: formData
        });
      }

      // #216: upload a new subtitle .vtt if one was chosen (skipped when "remove" is ticked).
      if (subtitleFile && !subRemove) {
        const subForm = new FormData();
        subForm.append('subtitle', subtitleFile);
        if (subLangEl?.value) subForm.append('subtitle_lang', subLangEl.value);
        assertLocalCallAllowed('/content', 'POST');
        await fetch('/api/content/' + contentItem.id + '/subtitle', {
          method: 'POST',
          headers,
          body: subForm
        });
      }

      overlay.remove();
      showToast(pendingReview ? t('review.toast.saved_as_draft') : t('content.toast.updated'), 'success');
      if (onSave) onSave();
    } catch (err) {
      showToast(err.message || t('content.error_update_failed'), 'error');
    }
  };
}

async function showPreview(content) {
  /*
   * ⚠️ A BUNDLE IS PREVIEWED THROUGH AN EPHEMERAL SESSION, NOT ITS PUBLIC URL. /api/content/:id/
   * bundle is gated on the content being referenced by a playlist — which a just-uploaded bundle is
   * not — so pointing an iframe at it here would 403 and show an empty box. That is the same
   * "preview shows nothing" trap the directory-board backgrounds had.
   *
   * The frame is sandboxed to allow-scripts with NO allow-same-origin, exactly as a player mounts
   * it. This is the dashboard origin, where the session JWT lives in localStorage, so that is not
   * a detail: an operator-uploaded bundle must never run with access to it.
   *
   * ⚠️ AND IT MUST BE src=, NOT srcdoc, even though the player uses srcdoc for the same bytes. A
   * srcdoc frame inherits ITS PARENT'S CSP; this page has one (`script-src 'self'`) and a flattened
   * bundle is entirely data: URIs, so every script in it would be blocked and the preview would
   * render a styled, dead page with nothing in any log. The player gets away with srcdoc only
   * because /player is CSP-exempt. Measured both ways — do not "simplify" this to srcdoc.
   */
  if (content.mime_type === BUNDLE_MIME) {
    let session;
    try {
      session = await api.post(`/content/${content.id}/bundle-preview`);
    } catch (err) {
      showToast(err.message || t('content.bundle_preview_failed'), 'error');
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div style="background:var(--bg-secondary);border-radius:var(--radius-lg);max-width:90vw;max-height:90vh;overflow:hidden;position:relative">
        <button style="position:absolute;top:8px;right:8px;z-index:1;background:rgba(0,0,0,0.7);border:none;color:white;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer" id="closePreview">&times;</button>
        <iframe sandbox="allow-scripts" src="${esc(session.url)}" style="width:80vw;height:45vw;max-height:80vh;display:block;border:none;background:#000"></iframe>
        <div style="padding:12px 16px;border-top:1px solid var(--border)">
          <div style="font-weight:500">${esc(content.filename)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${t('content.type_bundle')} — ${t('content.bundle_entry', { entry: esc(content.bundle_entry || 'index.html') })}</div>
          ${(session.skipped && session.skipped.length)
            ? `<div style="font-size:12px;color:#f59e0b;margin-top:6px">${t('content.bundle_skipped', { n: session.skipped.length })}</div>`
            : ''}
        </div>
      </div>`;
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#closePreview').onclick = () => overlay.remove();
    document.body.appendChild(overlay);
    return;
  }

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
