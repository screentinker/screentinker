import { esc } from '../utils.js';

/*
 * Schema-driven form HTML for plugin widgets and data sources.
 * Escaping goes through utils.esc — do not add a second helper here.
 * A previous copy HTML-decoded its entities and became a no-op.
 */

export function pluginFieldsHtml(fields, config, idPrefix) {
  const cfg = config || {};
  const prefix = idPrefix || 'plugin_';
  return (fields || []).map((f) => {
    const name = f.name;
    const id = prefix + name;
    const label = esc(f.label || name);
    const raw = cfg[name] != null ? cfg[name] : (f.default != null ? f.default : '');
    const kind = f.type || 'text';
    const req = f.required ? ' required' : '';
    if (kind === 'checkbox') {
      const on = raw === true || raw === 'true' || raw === 1 || raw === '1';
      const checked = on ? ' checked' : '';
      return `<div class="form-group"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="${esc(id)}" data-plugin-field="${esc(name)}" data-plugin-kind="checkbox"${checked}${req}> ${label}</label></div>`;
    }
    if (kind === 'textarea') {
      return `<div class="form-group"><label>${label}</label><textarea id="${esc(id)}" data-plugin-field="${esc(name)}" data-plugin-kind="textarea" class="input" rows="4"${req}>${esc(String(raw))}</textarea></div>`;
    }
    if (kind === 'select') {
      const opts = (f.options || []).map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? o.label : o;
        return `<option value="${esc(v)}" ${String(raw) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
      }).join('');
      return `<div class="form-group"><label>${label}</label><select id="${esc(id)}" data-plugin-field="${esc(name)}" data-plugin-kind="select" class="input" style="background:var(--bg-input)"${req}>${opts}</select></div>`;
    }
    if (kind === 'color') {
      return `<div class="form-group"><label>${label}</label><input type="color" id="${esc(id)}" data-plugin-field="${esc(name)}" data-plugin-kind="color" value="${esc(raw || '#ffffff')}" style="width:60px;height:32px;border:none"${req}></div>`;
    }
    if (kind === 'password') {
      const ph = f.placeholder ? esc(f.placeholder) : 'unchanged if blank';
      return `<div class="form-group"><label>${label}</label><input type="password" id="${esc(id)}" data-plugin-field="${esc(name)}" data-plugin-kind="password" class="input" value="" placeholder="${ph}" autocomplete="off"${req}></div>`;
    }
    const inputType = kind === 'number' ? 'number' : (kind === 'datetime' ? 'datetime-local' : (kind === 'url' ? 'url' : 'text'));
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    return `<div class="form-group"><label>${label}</label><input type="${inputType}" id="${esc(id)}" data-plugin-field="${esc(name)}" data-plugin-kind="${esc(kind)}" class="input" value="${esc(raw)}"${ph}${req}></div>`;
  }).join('');
}

export function readPluginFields(fields, idPrefix) {
  const prefix = idPrefix || 'plugin_';
  const config = {};
  for (const f of fields || []) {
    const el = document.getElementById(prefix + f.name);
    if (!el) continue;
    const kind = f.type || 'text';
    if (kind === 'checkbox') config[f.name] = !!el.checked;
    else if (kind === 'password') {
      if (!el.value) continue;
      config[f.name] = el.value;
    }
    else if (kind === 'number') {
      const n = Number(el.value);
      config[f.name] = Number.isFinite(n) ? n : el.value;
    } else config[f.name] = el.value;
  }
  return config;
}
