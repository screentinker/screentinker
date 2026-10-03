'use strict';

const { PLUGIN_ID_RE, CAPABILITIES, FIELD_TYPES } = require('./reserved');

function validateFields(fields) {
  if (fields === undefined) return null;
  if (!Array.isArray(fields)) return 'fields must be an array';
  for (const f of fields) {
    if (!f || typeof f !== 'object') return 'fields entries must be objects';
    if (typeof f.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(f.name)) {
      return `invalid field name "${f && f.name}"`;
    }
    if (f.type && !FIELD_TYPES.has(f.type)) return `unknown field type "${f.type}"`;
  }
  return null;
}

function validateManifest(raw, dirName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'plugin.json must be an object' };
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!PLUGIN_ID_RE.test(id)) {
    return { error: `plugin id must match ${PLUGIN_ID_RE}` };
  }
  if (dirName && dirName !== id) {
    return { error: `plugin id "${id}" must match its directory name "${dirName}"` };
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0.0.0';
  const description = typeof raw.description === 'string' ? raw.description : '';
  const main = typeof raw.main === 'string' && raw.main.trim() ? raw.main.trim() : 'index.js';
  if (main.includes('..') || pathIsAbsolute(main)) {
    return { error: 'plugin.json main must be a relative path inside the plugin directory' };
  }
  let capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  capabilities = capabilities.filter((c) => typeof c === 'string');
  for (const c of capabilities) {
    if (!CAPABILITIES.has(c)) return { error: `unknown capability "${c}"` };
  }
  let widget = null;
  if (raw.widget && typeof raw.widget === 'object') {
    const type = typeof raw.widget.type === 'string' ? raw.widget.type.trim() : '';
    if (!PLUGIN_ID_RE.test(type) && !/^[a-z][a-z0-9-]{1,63}$/.test(type)) {
      return { error: 'widget.type is invalid' };
    }
    const fieldErr = validateFields(raw.widget.fields);
    if (fieldErr) return { error: fieldErr };
    widget = {
      type,
      label: typeof raw.widget.label === 'string' ? raw.widget.label : type,
      icon: typeof raw.widget.icon === 'string' ? raw.widget.icon.slice(0, 8) : '🔌',
      fields: Array.isArray(raw.widget.fields) ? raw.widget.fields : [],
    };
    if (!capabilities.includes('widget')) capabilities.push('widget');
  }
  let dataSource = null;
  if (raw.dataSource && typeof raw.dataSource === 'object') {
    const type = typeof raw.dataSource.type === 'string' ? raw.dataSource.type.trim() : '';
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(type)) {
      return { error: 'dataSource.type is invalid' };
    }
    const fieldErr = validateFields(raw.dataSource.fields);
    if (fieldErr) return { error: fieldErr };
    dataSource = {
      type,
      label: typeof raw.dataSource.label === 'string' ? raw.dataSource.label : type,
      icon: typeof raw.dataSource.icon === 'string' ? raw.dataSource.icon.slice(0, 8) : '🔗',
      fields: Array.isArray(raw.dataSource.fields) ? raw.dataSource.fields : [],
    };
    if (!capabilities.includes('data-source')) capabilities.push('data-source');
  }
  let settings = null;
  if (raw.settings && typeof raw.settings === 'object') {
    const fieldErr = validateFields(raw.settings.fields);
    if (fieldErr) return { error: 'settings.' + fieldErr };
    settings = { fields: Array.isArray(raw.settings.fields) ? raw.settings.fields : [] };
  }
  // Optional egress allowlist: network.allow is a list of hostnames / "*." wildcards this plugin's
  // fetches may reach (see lib/plugins/egress.js). Absent = unrestricted (still SSRF-guarded).
  let network = null;
  if (raw.network && typeof raw.network === 'object') {
    if (raw.network.allow != null) {
      if (!Array.isArray(raw.network.allow) || !raw.network.allow.every((h) => typeof h === 'string' && h.length && h.length <= 253)) {
        return { error: 'network.allow must be an array of hostname strings' };
      }
      network = { allow: raw.network.allow };
    }
  }
  return {
    manifest: {
      id,
      name,
      version,
      description,
      main,
      capabilities,
      widget,
      dataSource,
      settings,
      network,
      screentinker: typeof raw.screentinker === 'string' ? raw.screentinker : null,
    },
  };
}

function pathIsAbsolute(p) {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

module.exports = { validateManifest };
