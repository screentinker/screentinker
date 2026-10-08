'use strict';

/*
 * Names a plugin may never register. Built-in widget types plus the two types that are created
 * by other first-party paths (slide-deck publish, the transition picker) so a dropped folder
 * cannot shadow them.
 */

const BUILTIN_WIDGET_TYPES = Object.freeze([
  'clock',
  'weather',
  'rss',
  'text',
  'webpage',
  'social',
  'directory-board',
  'directory-search',
  'diag-smoothness',
  'menu-board',
]);

const RESERVED_WIDGET_TYPES = new Set([
  ...BUILTIN_WIDGET_TYPES,
  'slide',
  'transition',
  // lib/templates: an installed template used in a workspace. Created only by /api/templates.
  'template',
  // lib/cap/feeds.js: an emergency feed's hidden alert card. Created only with its feed.
  'cap_alert',
]);

// The built-in data sources (lib/data-sources/builtin-types.js). 'api' was the "coming soon"
// placeholder in the dashboard's type list; reserved so an old draft cannot resolve to a plugin.
const RESERVED_DATA_SOURCE_TYPES = new Set(['ical', 'weather', 'rest', 'sheets', 'csv', 'rss', 'table', 'api']);

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const CAPABILITIES = new Set(['widget', 'data-source', 'routes', 'hooks']);
const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'checkbox', 'select', 'color', 'url', 'datetime', 'password']);

module.exports = {
  BUILTIN_WIDGET_TYPES,
  RESERVED_WIDGET_TYPES,
  RESERVED_DATA_SOURCE_TYPES,
  PLUGIN_ID_RE,
  CAPABILITIES,
  FIELD_TYPES,
};
