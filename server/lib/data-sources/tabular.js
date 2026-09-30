'use strict';

/*
 * Tables → the flat variables a slide binds to ({{ds:slug.key}}).
 *
 * ONE engine for every source whose data is rows and columns — Google Sheets, a CSV at a URL, a
 * REST API that returns a list, a table typed into the dashboard — so the same sheet produces the
 * same variables whichever road it came in by, and the dashboard can explain them once.
 *
 * What a table becomes:
 *   row_count, column_count, columns (the header names, comma-separated), updated (ISO time)
 *   row1_<col> … rowN_<col>        every cell, 1-based like a spreadsheet's data rows
 *   rows_text                      the first rows as ready-to-show lines ("Latte · 3.50")
 *   sum_/avg_/min_/max_<col>       for columns that are (mostly) numbers — KPI boards
 *   <key>_<col>, <key>             LOOKUP MODE: with a key column chosen, a row is addressed by
 *                                  its key instead of its position — {{ds:menu.latte_price}}.
 *
 * ⚠️ LOOKUP MODE IS THE ONE TO RECOMMEND. Positional keys (row3_price) silently point at a
 * different row the day somebody sorts the sheet or inserts a line; a key does not. The dashboard
 * says so where the option is offered.
 *
 * Everything is bounded (rows, columns, cell length, total keys) because the whole map is stored
 * per source and interpolated into documents served to every screen.
 */

const MAX_PARSE_ROWS = 5000;
const MAX_ROWS_OUT = 100;
const MAX_COLUMNS = 30;
const MAX_CELL = 500;
const MAX_KEYS = 4000;
const TEXT_ROWS = 20;

/** Column header → variable-safe key: lower-case, [a-z0-9_], never empty, never a leading digit. */
function slugKey(s, fallback) {
  let k = String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!k) k = fallback;
  if (/^[0-9]/.test(k)) k = 'c' + k;
  return k;
}

/* Which delimiter the first line uses: comma, semicolon or tab (counted outside quotes). */
function sniffDelimiter(text) {
  const line = String(text).split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, CRLF/LF, a UTF-8 BOM, embedded newlines in quotes.
 * Returns an array of rows (arrays of strings). Stops at MAX_PARSE_ROWS.
 */
function parseCsv(text, delimiter) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const d = delimiter && delimiter !== 'auto' ? delimiter : sniffDelimiter(s);
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQ = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length >= MAX_PARSE_ROWS) return { rows, delimiter: d };
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, delimiter: d };
}

/** Rows (arrays) → { columns: [{ name, key }], records: [ { key: value } ] }. */
function rowsToTable(rows, { headerRow = true } = {}) {
  const clean = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c == null ? '' : c).trim() !== ''));
  if (!clean.length) return { columns: [], records: [] };
  const width = Math.min(MAX_COLUMNS, Math.max(...clean.map((r) => r.length)));
  const header = headerRow ? clean[0] : [];
  const seen = new Map();
  const columns = [];
  for (let c = 0; c < width; c++) {
    const name = headerRow ? String(header[c] == null ? '' : header[c]).trim() || `Column ${c + 1}` : `Column ${c + 1}`;
    let key = slugKey(name, `col${c + 1}`);
    if (seen.has(key)) { const n = seen.get(key) + 1; seen.set(key, n); key = `${key}_${n}`; } else seen.set(key, 1);
    columns.push({ name: name.slice(0, 80), key });
  }
  const records = (headerRow ? clean.slice(1) : clean).map((r) => {
    const rec = {};
    columns.forEach((col, c) => { rec[col.key] = String(r[c] == null ? '' : r[c]).trim().slice(0, MAX_CELL); });
    return rec;
  });
  return { columns, records };
}

/** Records (objects) → a table, columns in first-seen order, one level of nesting flattened. */
function recordsToTable(list) {
  const flat = (list || []).slice(0, MAX_PARSE_ROWS).map((item) => {
    if (item === null || typeof item !== 'object') return { value: item };
    const out = {};
    for (const [k, v] of Object.entries(item)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) if (v2 === null || typeof v2 !== 'object') out[`${k}_${k2}`] = v2;
      } else if (Array.isArray(v)) {
        out[k] = v.filter((x) => x === null || typeof x !== 'object').join(', ');
      } else out[k] = v;
    }
    return out;
  });
  const order = [];
  const seenKey = new Set();
  for (const r of flat.slice(0, 50)) for (const k of Object.keys(r)) if (!seenKey.has(k)) { seenKey.add(k); order.push(k); }
  const rows = [order, ...flat.map((r) => order.map((k) => (r[k] == null ? '' : String(r[k]))))];
  return rowsToTable(rows, { headerRow: true });
}

/*
 * A cell as a number, or null. Currency symbols, spaces, thousands separators and a trailing %
 * are tolerated; `decimalComma` (semicolon-delimited files, the European convention) reads
 * "3,50" as 3.5.
 */
function toNumber(v, decimalComma) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return null;
  s = s.replace(/[\s$€£¥₹%]/g, '');
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  if (!/^-?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round(n) { return Math.round(n * 100) / 100; }

/**
 * The flat variable map for a table.
 * opts: keyColumn (a column key or header name), maxRows, decimalComma, now
 */
function flattenTable(table, opts = {}) {
  const out = {};
  let keys = 0;
  const put = (k, v) => {
    if (keys >= MAX_KEYS || Object.prototype.hasOwnProperty.call(out, k)) return;
    out[k] = v; keys++;
  };
  const { columns, records } = table;
  const maxRows = Math.max(1, Math.min(MAX_ROWS_OUT, parseInt(opts.maxRows, 10) || MAX_ROWS_OUT));
  put('row_count', records.length);
  put('column_count', columns.length);
  put('columns', columns.map((c) => c.name).join(', '));
  put('updated', (opts.now || new Date()).toISOString());

  records.slice(0, maxRows).forEach((rec, i) => {
    for (const col of columns) put(`row${i + 1}_${col.key}`, rec[col.key]);
  });
  put('rows_text', records.slice(0, TEXT_ROWS)
    .map((rec) => columns.map((c) => rec[c.key]).filter((v) => v !== '').join(' · ')).join('\n'));

  // Numeric columns (≥80% of non-empty cells are numbers): the aggregates a KPI screen wants.
  for (const col of columns) {
    const vals = records.map((r) => r[col.key]).filter((v) => v !== '');
    if (!vals.length) continue;
    const nums = vals.map((v) => toNumber(v, opts.decimalComma)).filter((n) => n !== null);
    if (nums.length / vals.length < 0.8) continue;
    const sum = nums.reduce((a, b) => a + b, 0);
    put(`sum_${col.key}`, round(sum));
    put(`avg_${col.key}`, round(sum / nums.length));
    put(`min_${col.key}`, Math.min(...nums));
    put(`max_${col.key}`, Math.max(...nums));
  }

  // Lookup mode.
  if (opts.keyColumn) {
    const want = slugKey(opts.keyColumn, '');
    const keyCol = columns.find((c) => c.key === want || c.name.toLowerCase() === String(opts.keyColumn).toLowerCase());
    if (keyCol) {
      const others = columns.filter((c) => c !== keyCol);
      for (const rec of records) {
        const k = slugKey(rec[keyCol.key], '');
        if (!k) continue;
        if (others.length === 1) put(k, rec[others[0].key]);
        for (const col of others) put(`${k}_${col.key}`, rec[col.key]);
      }
    }
  }
  return out;
}

/** Everything a preview needs: the variables, plus the first rows as a table for the dashboard. */
function describeTable(table, flat) {
  return {
    variables: flat,
    columns: table.columns,
    sample: table.records.slice(0, 5),
  };
}

module.exports = {
  MAX_ROWS_OUT, MAX_COLUMNS, MAX_CELL, MAX_KEYS,
  slugKey, sniffDelimiter, parseCsv, rowsToTable, recordsToTable, toNumber, flattenTable, describeTable,
};
