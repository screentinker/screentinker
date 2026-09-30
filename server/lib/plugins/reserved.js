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
]);

const RESERVED_WIDGET_TYPES = new Set([
  ...BUILTIN_WIDGET_TYPES,
  'slide',
  'transition',
  // lib/templates: an installed template used in a workspace. Created only by /api/templates.
  'template',
]);

const RESERVED_DATA_SOURCE_TYPES = new Set(['ical', 'weather']);

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
