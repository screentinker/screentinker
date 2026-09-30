'use strict';

/*
 * The built-in data-source types that live next to ical and weather: one table of what each type
 * validates, how it resolves, which config fields are secrets and how often it may refresh.
 * service.js, routes/data-sources.js and plugins/secrets.js all read this — adding a type is one
 * entry here plus its form in the dashboard.
 *
 * resolve(config, ctx) → { data, table?, raw? }
 *   data   the flat variable map that is cached and bound into slides ({{ds:slug.key}})
 *   table  { columns, sample } — the preview the dashboard shows after a test, never cached
 *   raw    a trimmed copy of the selected JSON (REST only), for the same preview
 *
 * ical and weather keep their own dispatch in service.js; they predate this table and return
 * their data map directly.
 */

const { resolveRest, validateRestConfig, SECRET_FIELDS: REST_SECRETS } = require('./rest-resolver');
const { resolveSheets, validateSheetsConfig } = require('./sheets-resolver');
const { resolveCsv, validateCsvConfig } = require('./csv-resolver');
const { resolveRss, validateRssConfig } = require('./rss-resolver');
const { resolveTable, validateTableConfig } = require('./table-resolver');

const intervalOf = (floor) => (c) => Math.max(floor, parseInt(c && c.interval_min, 10) || 15);

const TYPES = {
  rest: {
    validate: validateRestConfig,
    resolve: resolveRest,
    fields: REST_SECRETS.map((name) => ({ name, type: 'password' })),
    interval: intervalOf(1),
    network: true,
  },
  sheets: {
    validate: validateSheetsConfig,
    resolve: resolveSheets,
    fields: [],
    // Google throttles the unauthenticated CSV endpoints; a minute is plenty for a menu board.
    interval: intervalOf(2),
    network: true,
  },
  csv: { validate: validateCsvConfig, resolve: resolveCsv, fields: [], interval: intervalOf(1), network: true },
  rss: { validate: validateRssConfig, resolve: resolveRss, fields: [], interval: intervalOf(5), network: true },
  // Nothing to fetch: it only "syncs" when edited, so the interval just keeps the poller away.
  table: { validate: validateTableConfig, resolve: resolveTable, fields: [], interval: () => 24 * 60, network: false },
};

function getBuiltinType(type) {
  return Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
}

module.exports = { BUILTIN_TYPE_NAMES: Object.freeze(Object.keys(TYPES)), getBuiltinType };
