'use strict';

/*
 * ScreenTinker for Zapier — a Zapier Platform CLI app (docs/automation.md).
 *
 * Push it as a PRIVATE integration from this folder:  npm install && npx zapier-platform-cli push
 * The server side is routes/zapier.js; every path below is under <server>/api/zapier.
 *
 * Kept free of runtime requires (zapier-platform-core is only a dependency for Zapier's build), so
 * the server's tests can load this file and check it against what the server actually offers.
 */

const pkg = require('./package.json');

const EVENTS = [
  { key: 'device_offline', noun: 'Screen', label: 'Screen Went Offline', description: 'Triggers when a screen stops reporting in.' },
  { key: 'device_online', noun: 'Screen', label: 'Screen Came Back Online', description: 'Triggers when an offline screen reports in again.' },
  { key: 'emergency_raised', noun: 'Alert', label: 'Emergency Alert Raised', description: 'Triggers when an emergency alert starts showing on screens (from a feed, a hook or Zapier).' },
  { key: 'emergency_cleared', noun: 'Alert', label: 'Emergency Alert Cleared', description: 'Triggers when an emergency alert stops showing.' },
  { key: 'content_approved', noun: 'Content', label: 'Content Approved', description: 'Triggers when a reviewer approves content or a playlist.' },
  { key: 'playlist_published', noun: 'Playlist', label: 'Playlist Published', description: 'Triggers when a playlist goes out to screens.' },
];

const base = (bundle) => `${String(bundle.authData.server_url || '').replace(/\/+$/, '')}/api/zapier`;

const addAuth = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.api_token) request.headers.Authorization = `Bearer ${bundle.authData.api_token}`;
  return request;
};

const authentication = {
  type: 'custom',
  fields: [
    { key: 'server_url', label: 'ScreenTinker address', required: true, type: 'string', helpText: 'The address you sign in at, e.g. `https://app.screentinker.com` or your own server.' },
    { key: 'api_token', label: 'API token', required: true, type: 'password', helpText: 'Settings → API tokens. **write** is enough for triggers and tables; actions that take over screens need **full**.' },
  ],
  test: { url: '{{bundle.authData.server_url}}/api/zapier/me' },
  connectionLabel: '{{bundle.inputData.workspace_name}}',
};

function hookTrigger(ev) {
  return {
    key: ev.key,
    noun: ev.noun,
    display: { label: ev.label, description: ev.description },
    operation: {
      type: 'hook',
      performSubscribe: async (z, bundle) => (await z.request({
        url: `${base(bundle)}/subscriptions`, method: 'POST', body: { event: ev.key, target_url: bundle.targetUrl },
      })).data,
      performUnsubscribe: async (z, bundle) => (await z.request({
        url: `${base(bundle)}/subscriptions/${bundle.subscribeData.id}`, method: 'DELETE',
      })).data,
      perform: (z, bundle) => [bundle.cleanedRequest],
      performList: async (z, bundle) => (await z.request({ url: `${base(bundle)}/events`, params: { event: ev.key } })).data,
      sample: { id: '0', event: ev.key, occurred_at: '2026-10-08T09:00:00.000Z', workspace_id: 'ws' },
    },
  };
}

// Hidden triggers that feed dynamic dropdowns.
function optionList(kind, noun) {
  return {
    key: `${kind}_list`,
    noun,
    display: { label: `List ${noun}s`, description: `Lists ${noun.toLowerCase()}s for a dropdown.`, hidden: true },
    operation: {
      perform: async (z, bundle) => (await z.request({ url: `${base(bundle)}/options/${kind}` })).data,
      sample: { id: 'id', name: noun },
    },
  };
}

const SCREENS = [
  { key: 'group_id', label: 'Group', dynamic: 'groups_list.id.name', required: false, helpText: 'Leave Group, Screen and Tag empty for every screen.' },
  { key: 'device_id', label: 'Screen', dynamic: 'screens_list.id.name', required: false },
  { key: 'tag', label: 'Tag', required: false, helpText: 'Screens with this tag, e.g. `lobby`.' },
];

const action = (key, noun, label, description, inputFields, path, sample) => ({
  key, noun,
  display: { label, description },
  operation: {
    inputFields,
    perform: async (z, bundle) => (await z.request({ url: `${base(bundle)}/actions/${path}`, method: 'POST', body: bundle.inputData })).data,
    sample,
  },
});

const creates = [
  action('raise_emergency', 'Alert', 'Raise or Clear Emergency Alert', 'Shows an emergency alert on screens, or clears one.', [
    { key: 'op', label: 'Action', choices: { raise: 'Raise', clear: 'Clear' }, default: 'raise', required: true },
    { key: 'alert_id', label: 'Alert ID', required: false, helpText: 'The same ID twice is one alert. To clear, send the same ID; empty clears every alert raised from Zapier.' },
    { key: 'headline', label: 'Headline', required: false },
    { key: 'message', label: 'Message', required: false, type: 'text' },
    { key: 'instruction', label: 'What to do', required: false },
    { key: 'severity', label: 'Severity', choices: { Extreme: 'Extreme', Severe: 'Severe', Moderate: 'Moderate', Minor: 'Minor' }, default: 'Extreme', required: false },
    { key: 'expires_min', label: 'End after (minutes)', type: 'integer', required: false, default: '60' },
    ...SCREENS,
  ], 'emergency', { ok: true, result: 'raised 1 on 12 screen(s)' }),
  action('switch_playlist', 'Playlist', 'Switch Screens to a Playlist', 'Shows a playlist on screens for a number of minutes, then they go back.', [
    { key: 'op', label: 'Action', choices: { start: 'Switch', stop: 'Switch back' }, default: 'start', required: true },
    { key: 'playlist_id', label: 'Playlist', dynamic: 'playlists_list.id.name', required: false },
    { key: 'minutes', label: 'Minutes', type: 'integer', default: '30', required: false },
    ...SCREENS,
  ], 'playlist', { ok: true, result: 'switched 4 screen(s) for 30 minute(s)' }),
  action('fire_trigger', 'Trigger', 'Fire a Trigger', 'Fires (or clears) a trigger on the screens it is assigned to. Works over the internet on Raspberry Pi and Windows screens.', [
    { key: 'trigger_id', label: 'Trigger', dynamic: 'triggers_list.id.name', required: true },
    { key: 'op', label: 'Action', choices: { fire: 'Fire', clear: 'Clear' }, default: 'fire', required: true },
  ], 'trigger', { ok: true, result: 'fired "Doorbell" on 2 screen(s)' }),
  action('update_table', 'Row', 'Update a Table', 'Writes rows into a Table data source, so slides and menu boards update.', [
    { key: 'data_source_id', label: 'Table', dynamic: 'tables_list.id.name', required: true },
    { key: 'mode', label: 'How', choices: { replace: 'Replace all rows', upsert: 'Update or add by key', append: 'Add rows' }, default: 'upsert', required: true },
    { key: 'key_column', label: 'Key column', required: false },
    { key: 'rows', label: 'Rows (JSON)', type: 'text', required: true, helpText: 'A JSON list, e.g. `[{"Item":"Latte","Price":"3.50"}]`.' },
  ], 'data', { ok: true, result: 'upserted 1 row(s); the table has 8' }),
];

const triggers = [
  ...EVENTS.map(hookTrigger),
  optionList('groups', 'Group'), optionList('screens', 'Screen'), optionList('playlists', 'Playlist'),
  optionList('triggers', 'Trigger'), optionList('tables', 'Table'),
];

module.exports = {
  version: pkg.version,
  platformVersion: pkg.dependencies['zapier-platform-core'],
  authentication,
  beforeRequest: [addAuth],
  triggers: Object.fromEntries(triggers.map((t) => [t.key, t])),
  creates: Object.fromEntries(creates.map((c) => [c.key, c])),
  EVENTS: EVENTS.map((e) => e.key),
};
