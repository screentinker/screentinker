// #go2rtc — workspace-level "Enable live video" toggle. Rendered on the members page for workspace
// admins, next to the approval-settings card (same host pattern). Only appears when live video is
// enabled server-wide (features.live_video); otherwise the toggle would be inert, so it is hidden
// entirely rather than shown greyed-out, the same rule device-detail follows for capabilities.
import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// host: the mount element. opts: { workspaceId, workspace } where workspace carries the current
// live_video_enabled (from accessible_workspaces).
export async function renderLiveVideoSettings(host, { workspaceId, workspace } = {}) {
  if (!host || !workspaceId) return;
  let status;
  try { status = await api.getServerStatus(); } catch (_) { return; }
  if (!status || !status.features || !status.features.live_video) return;   // not available server-wide

  let enabled = !!(workspace && workspace.live_video_enabled);

  function paint() {
    host.innerHTML = `
      <div class="settings-section" style="margin-top:24px;padding:16px 20px">
        <h3 style="margin:0 0 6px">${esc(t('live_video.title'))}</h3>
        <p style="color:var(--text-muted);font-size:13px;margin:0 0 12px">${esc(t('live_video.explain'))}</p>
        <label style="display:flex;align-items:center;gap:10px;font-weight:600;cursor:pointer">
          <input type="checkbox" id="wsLiveVideoToggle" ${enabled ? 'checked' : ''}>
          ${esc(t('live_video.toggle'))}
        </label>
        ${enabled ? `<p style="font-size:13px;margin:8px 0 0;color:var(--text-muted)">${esc(t('live_video.on_effects'))}</p>` : ''}
      </div>`;
    host.querySelector('#wsLiveVideoToggle')?.addEventListener('change', async (e) => {
      const want = !!e.target.checked;
      e.target.disabled = true;
      try {
        await api.renameWorkspace(workspaceId, { live_video_enabled: want });
        enabled = want;
        if (workspace) workspace.live_video_enabled = want ? 1 : 0;
        showToast(t(want ? 'live_video.enabled_toast' : 'live_video.disabled_toast'), 'success');
        paint();
      } catch (err) {
        e.target.checked = !want;   // revert the visual
        e.target.disabled = false;
        showToast(err.message || t('live_video.save_failed'), 'error');
      }
    });
  }
  paint();
}
