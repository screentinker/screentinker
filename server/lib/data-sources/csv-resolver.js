'use strict';

/*
 * CSV at a URL — the lowest common denominator of "export": Excel Online / OneDrive / SharePoint
 * download links, Airtable and Notion CSV exports, a POS or ERP report drop, a GitHub raw file.
 *
 * config: url, delimiter ('auto' | ',' | ';' | 'tab' | '|'), header_row (default true),
 *         key_column, max_rows, interval_min
 */

const { fetchText, checkHttpUrl, UserFacingError } = require('./http');
const tab = require('./tabular');

const DELIMS = { auto: 'auto', ',': ',', ';': ';', tab: '\t', '\t': '\t', '|': '|' };

function validateCsvConfig(c) {
  if (!c || typeof c !== 'object') return 'Config must be an object';
  const bad = checkHttpUrl(c.url, 'The CSV URL');
  if (bad) return bad;
  if (c.delimiter != null && c.delimiter !== '' && !(c.delimiter in DELIMS)) return 'Unknown delimiter';
  if (c.key_column && String(c.key_column).length > 80) return 'The key column name is too long';
  if (c.max_rows != null && c.max_rows !== '' && !(parseInt(c.max_rows, 10) >= 1)) return 'Rows to import must be a positive number';
  return null;
}

async function resolveCsv(config, ctx = {}) {
  const c = config || {};
  const err = validateCsvConfig(c);
  if (err) throw new UserFacingError(err, 'config');
  const { text, contentType } = await fetchText(String(c.url).trim(), {
    headers: { Accept: 'text/csv, text/plain;q=0.9, */*;q=0.5' },
    maxBytes: 2 * 1024 * 1024,
    fetcher: ctx.fetcher,
  });
  if (/text\/html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(text.slice(0, 512))) {
    throw new UserFacingError('That address returned a web page, not a CSV file. Use the direct download link (for OneDrive/SharePoint add ?download=1).', 'not-csv');
  }
  const { rows, delimiter } = tab.parseCsv(text, DELIMS[c.delimiter || 'auto'] || 'auto');
  const table = tab.rowsToTable(rows, { headerRow: c.header_row !== false });
  if (!table.columns.length) throw new UserFacingError('The file is empty.', 'empty');
  const data = tab.flattenTable(table, { keyColumn: c.key_column, maxRows: c.max_rows, decimalComma: delimiter === ';', now: ctx.now });
  return { data, table: { columns: table.columns, sample: table.records.slice(0, 5) } };
}

module.exports = { validateCsvConfig, resolveCsv };
