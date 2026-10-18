/*
 * A widget's background: a colour, or see-through (#660).
 *
 * A colour picker cannot say "no colour", so on its own it saved #000000 for every widget whose
 * default is transparent, and the widget turned black on its first save. "Transparent" is the
 * default; the picker only matters once it is unticked. Saves 'transparent' or the hex colour.
 */
import { esc } from '../utils.js';
import { t } from '../i18n.js';

const HEX = /^#[0-9a-f]{6}$/i;

// One delegated listener: the dashboard's CSP (script-src 'self') blocks inline handlers.
if (typeof document !== 'undefined') {
  document.addEventListener('change', (e) => {
    const box = e.target;
    if (!box || !box.dataset || !box.dataset.bgClear) return;
    const input = document.getElementById(box.dataset.bgClear);
    if (input) input.disabled = box.checked;
  });
}

/** True when a stored value means no colour: unset, empty, or 'transparent'. */
export function isTransparentBg(value) {
  return value == null || value === '' || String(value).trim().toLowerCase() === 'transparent';
}

export function backgroundField(id, value, label = t('widget.field.background')) {
  const clear = isTransparentBg(value);
  const colour = HEX.test(String(value || '')) ? value : '#000000';
  return `<div class="form-group"><label>${esc(label)}</label>
    <div style="display:flex;align-items:center;gap:12px">
      <input type="color" id="${id}" value="${esc(colour)}" style="width:60px;height:32px;border:none"${clear ? ' disabled' : ''}>
      <label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:normal"><input type="checkbox" id="${id}Clear" data-bg-clear="${id}"${clear ? ' checked' : ''}>${esc(t('widget.field.background_transparent'))}</label>
    </div></div>`;
}

/** What to save: 'transparent', or the picked colour. `root` defaults to the document. */
export function readBackground(id, root = document) {
  const box = root.querySelector(`#${id}Clear`);
  if (box && box.checked) return 'transparent';
  const input = root.querySelector(`#${id}`);
  return input ? input.value : 'transparent';
}
