'use strict';

/*
 * Outbound webhook. Settings are instance-global and re-read on every fire, so
 * changing the URL in Admin does not need a restart. The POST goes through
 * api.fetch (SSRF-guarded, 2xx accepted). Failures are logged, never thrown
 * into the heartbeat or publish path.
 */

const DEFAULTS = {
  on_offline: true,
  on_online: false,
  on_publish: true,
  on_upload: false,
  on_plugin_submit: false,
  on_plugin_approve: false,
  on_plugin_reject: false,
};

function enabled(settings, key) {
  if (settings && settings[key] != null) return !!settings[key];
  return !!DEFAULTS[key];
}

function post(api, event, payload) {
  const s = (api.getSettings && api.getSettings()) || {};
  const url = typeof s.url === 'string' ? s.url.trim() : '';
  if (!url) return Promise.resolve();
  const headers = { 'content-type': 'application/json' };
  if (s.secret) headers.authorization = 'Bearer ' + String(s.secret);
  const body = { event, at: new Date().toISOString(), ...payload };
  return Promise.resolve(api.fetch(url, {
    method: 'POST',
    headers,
    body,
    timeoutMs: 8000,
    maxBytes: 4096,
  })).catch((e) => {
    if (api.log) api.log(event, e && e.message ? e.message : e);
  });
}

function activate(api) {
  api.on('device.offline', (p) => {
    const s = api.getSettings() || {};
    if (!enabled(s, 'on_offline')) return;
    post(api, 'device.offline', p);
  });
  api.on('device.online', (p) => {
    const s = api.getSettings() || {};
    if (!enabled(s, 'on_online')) return;
    post(api, 'device.online', p);
  });
  api.on('playlist.published', (p) => {
    const s = api.getSettings() || {};
    if (!enabled(s, 'on_publish')) return;
    post(api, 'playlist.published', p);
  });
  api.on('content.uploaded', (p) => {
    const s = api.getSettings() || {};
    if (!enabled(s, 'on_upload')) return;
    post(api, 'content.uploaded', p);
  });
  api.on('plugin.submitted', (p) => {
    const s = api.getSettings() || {};
    if (!enabled(s, 'on_plugin_submit')) return;
    post(api, 'plugin.submitted', p);
  });
  api.on('plugin.approved', (p) => {
    const s = api.getSettings() || {};
    if (!enabled(s, 'on_plugin_approve')) return;
    post(api, 'plugin.approved', p);
  });
  api.on('plugin.rejected', (p) => {
    const s = api.getSettings() || {};
    if (!enabled(s, 'on_plugin_reject')) return;
    post(api, 'plugin.rejected', p);
  });
}

module.exports = { activate, post, enabled };
