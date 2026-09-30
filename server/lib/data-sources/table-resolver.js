'use strict';

/*
 * A table typed into the dashboard — no network, no account, nothing to break.
 *
 * The honest answer to most "we need a data source" requests from a single site: a price list, a
 * room directory, today's specials, a leaderboard someone updates by hand. It uses the same table
 * engine as Sheets and CSV, so a board built on it keeps working unchanged when the data later
 * moves to a spreadsheet.
 *
 * config: columns: ['Item', 'Price'], rows: [['Latte', '3.50'], …], key_column
 */

const { UserFacingError } = require('./http');
const tab = require('./tabular');

const MAX_ROWS = 200;
const MAX_COLS = 20;

function validateTableConfig(c) {
  if (!c || typeof c !== 'object') return 'Config must be an object';
  if (!Array.isArray(c.columns) || !c.columns.length) return 'Add at least one column';
  if (c.columns.length > MAX_COLS) return `A table can have up to ${MAX_COLS} columns`;
  if (c.columns.some((n) => typeof n !== 'string' || n.length > 80)) return 'Column names must be text (80 characters at most)';
  if (!c.columns.some((n) => n.trim())) return 'Name at least one column';
  if (!Array.isArray(c.rows)) return 'Rows must be a list';
  if (c.rows.length > MAX_ROWS) return `A table can have up to ${MAX_ROWS} rows — use a Google Sheet for more`;
  for (const r of c.rows) {
    if (!Array.isArray(r) || r.length > MAX_COLS) return 'Each row must be a list of cells';
    if (r.some((v) => v != null && typeof v !== 'string' && typeof v !== 'number')) return 'Cells must be text or numbers';
    if (r.some((v) => String(v == null ? '' : v).length > tab.MAX_CELL)) return `A cell can hold up to ${tab.MAX_CELL} characters`;
  }
  if (c.key_column && String(c.key_column).length > 80) return 'The key column name is too long';
  return null;
}

function resolveTable(config, ctx = {}) {
  const c = config || {};
  const err = validateTableConfig(c);
  if (err) throw new UserFacingError(err, 'config');
  const table = tab.rowsToTable([c.columns, ...c.rows.map((r) => r.map((v) => (v == null ? '' : String(v))))], { headerRow: true });
  const data = tab.flattenTable(table, { keyColumn: c.key_column, now: ctx.now });
  return { data, table: { columns: table.columns, sample: table.records.slice(0, 5) } };
}

module.exports = { validateTableConfig, resolveTable, MAX_ROWS, MAX_COLS };
