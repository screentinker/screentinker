import { api } from '../api.js';
import { t } from '../i18n.js';
import { showToast } from './toast.js';
/* ⚠️ esc CAME WITH THE CODE AND THE IMPORT DID NOT. Extracting this dialog out of designer.js left
 * five esc() calls behind their import, so opening it threw ReferenceError while building the
 * markup — before appendChild — which broke the Designer's OWN settings button as well as the new
 * one in Slides. Exactly the defect of 2026-08-11, in a file the guard could not see. */
import { esc } from '../utils.js';

/*
 * The AI endpoint/model settings dialog, shared by the Designer and the Slides editor.
 *
 * ⚠️ EXTRACTED RATHER THAN COPIED. There is ONE ai_settings row per workspace, so two dialogs
 * writing it would be two ways to configure one thing — and the second copy is the one that stops
 * getting the fix when the first is corrected. The Slides editor needed this the moment it grew a
 * Generate button; the honest move was to move it, not to clone it.
 *
 * Text still lives under the `designer.ai.*` keys. Renaming them would touch eight locale files to
 * change nothing a user sees, and the keys are an internal address, not a label.
 */

export async function openAiSettingsModal() {
  let cur = {};
  try { cur = await api.aiGetSettings(); } catch { /* show empty form */ }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px;width:95vw">
      <div class="modal-header">
        <h3>${t('designer.ai.settings_title')}</h3>
        <button class="btn-icon" data-ai-close aria-label="${t('common.close')}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${t('designer.ai.settings_desc')}</p>
        <div class="form-group"><label>${t('designer.ai.base_url')}</label>
          <input id="aiBaseUrl" class="input" value="${esc(cur.base_url || '')}" placeholder="https://api.openai.com/v1  ·  http://localhost:11434/v1" style="width:100%"></div>
        <div class="form-group"><label>${t('designer.ai.model')}</label>
          <div style="display:flex;gap:6px">
            <input id="aiModel" class="input" list="aiModelList" value="${esc(cur.model || '')}" placeholder="gpt-4o-mini  ·  llama3.1:8b" style="flex:1" autocomplete="off">
            <button class="btn btn-secondary btn-sm" id="aiLoadModels" type="button" style="white-space:nowrap">${t('designer.ai.load_models')}</button>
          </div>
          <datalist id="aiModelList"></datalist>
          <div id="aiModelMsg" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div></div>
        <div class="form-group"><label>${t('designer.ai.api_key')}</label>
          <input id="aiKey" class="input" type="password" autocomplete="off" placeholder="${cur.has_key ? t('designer.ai.key_set') : t('designer.ai.key_placeholder')}" style="width:100%">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('designer.ai.key_hint')}</div></div>

        <hr style="border:none;border-top:1px solid var(--border);margin:14px 0 10px">
        <h4 style="font-size:13px;margin-bottom:4px">${t('designer.ai.images_title')}</h4>
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${t('designer.ai.images_desc')}</p>
        <div class="form-group"><label>${t('designer.ai.image_provider')}</label>
          <select id="aiImageProvider" class="input" style="width:100%">
            <option value="" ${!cur.image_provider ? 'selected' : ''}>${t('designer.ai.image_off')}</option>
            <option value="sdcpp" ${cur.image_provider === 'sdcpp' ? 'selected' : ''}>Stable Diffusion — local (sd.cpp)</option>
            <option value="openai" ${cur.image_provider === 'openai' ? 'selected' : ''}>OpenAI / OpenAI-compatible</option>
            <option value="comfyui" ${cur.image_provider === 'comfyui' ? 'selected' : ''}>ComfyUI</option>
          </select></div>
        <div class="form-group"><label>${t('designer.ai.image_base_url')}</label>
          <input id="aiImageBaseUrl" class="input" value="${esc(cur.image_base_url || '')}" placeholder="http://localhost:8080/v1  ·  http://localhost:8188" style="width:100%"></div>
        <div class="form-group"><label>${t('designer.ai.image_model')}</label>
          <input id="aiImageModel" class="input" value="${esc(cur.image_model || '')}" placeholder="${t('designer.ai.image_model_ph')}" style="width:100%"></div>
        <div class="form-group"><label>${t('designer.ai.image_api_key')}</label>
          <input id="aiImageKey" class="input" type="password" autocomplete="off" placeholder="${cur.has_image_key ? t('designer.ai.key_set') : t('designer.ai.image_key_ph')}" style="width:100%">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('designer.ai.image_key_hint')}</div></div>
        <div id="aiSettingsErr" style="display:none;color:var(--danger);font-size:13px;margin-top:8px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-ai-close>${t('common.cancel')}</button>
        <button class="btn btn-primary" id="aiSaveSettings">${t('common.save')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-ai-close]').forEach(b => b.onclick = close);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  // Load the model list from the entered endpoint into the dropdown.
  overlay.querySelector('#aiLoadModels').onclick = async () => {
    const msg = overlay.querySelector('#aiModelMsg');
    const base_url = overlay.querySelector('#aiBaseUrl').value.trim();
    if (!base_url) { msg.style.color = 'var(--danger)'; msg.textContent = t('designer.ai.need_base_url'); return; }
    const btn = overlay.querySelector('#aiLoadModels');
    btn.disabled = true;
    msg.style.color = 'var(--text-muted)'; msg.textContent = t('designer.ai.loading_models');
    try {
      const r = await api.aiListModels(base_url, overlay.querySelector('#aiKey').value || undefined);
      const models = r.models || [];
      overlay.querySelector('#aiModelList').innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
      const modelInput = overlay.querySelector('#aiModel');
      if (models.length && !modelInput.value) modelInput.value = models[0];
      msg.textContent = t('designer.ai.models_loaded', { n: models.length });
    } catch (e2) {
      msg.style.color = 'var(--danger)'; msg.textContent = (e2 && e2.message) || t('designer.ai.models_failed');
    } finally {
      btn.disabled = false;
    }
  };

  overlay.querySelector('#aiSaveSettings').onclick = async () => {
    const errEl = overlay.querySelector('#aiSettingsErr');
    errEl.style.display = 'none';
    const data = {
      base_url: overlay.querySelector('#aiBaseUrl').value.trim(),
      model: overlay.querySelector('#aiModel').value.trim(),
      image_provider: overlay.querySelector('#aiImageProvider').value,
      image_base_url: overlay.querySelector('#aiImageBaseUrl').value.trim(),
      image_model: overlay.querySelector('#aiImageModel').value.trim(),
    };
    const key = overlay.querySelector('#aiKey').value;
    if (key) data.api_key = key;
    const imgKey = overlay.querySelector('#aiImageKey').value;
    if (imgKey) data.image_api_key = imgKey;
    try {
      await api.aiSaveSettings(data);
      showToast(t('designer.ai.saved'), 'success');
      close();
    } catch (e2) {
      errEl.textContent = (e2 && e2.message) || t('designer.ai.save_failed');
      errEl.style.display = 'block';
    }
  };
}
