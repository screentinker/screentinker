'use strict';

/*
 * The MCP server: the tool catalogue, the JSON-RPC layer, and the boundary between them and the API.
 *
 * ⚠️ THE PROPERTY THAT MATTERS: this is a CLIENT of our own public API, never a second implementation
 * of it. Every tool maps to an HTTP call carrying the caller's own token, so bearerAuth,
 * resolveTenancy, tokenScopeGate and the replica proxy all apply to an agent exactly as they apply to
 * curl. The day someone "optimises" a tool by calling the database directly, the permission model has
 * been forked and one copy will drift. That is asserted here at the source level, because it is the
 * kind of change that looks like a speedup in review.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../lib/mcp/tools');
const protocol = require('../lib/mcp/protocol');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mcp.js'), 'utf8');
const TOOLS_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp', 'tools.js'), 'utf8');

// ───────────────────────────── the catalogue ─────────────────────────────

test('every tool is well formed and describes what it is FOR', () => {
  const names = new Set();
  for (const t of tools.TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `tool name not snake_case: ${t.name}`);
    assert.ok(!names.has(t.name), `duplicate tool name: ${t.name}`);
    names.add(t.name);
    assert.ok(['read', 'write', 'full'].includes(t.scope), `${t.name} has no valid scope`);
    // The description is the entire basis on which a model picks a tool.
    assert.ok(t.description.length > 30, `${t.name} needs a real description`);
    assert.equal(t.input.type, 'object');
    assert.ok(t.call && t.call.method && t.call.path, `${t.name} has no API call`);
    for (const r of t.input.required || []) {
      assert.ok(t.input.properties[r], `${t.name} requires "${r}" but does not declare it`);
    }
  }
});

test('the catalogue stays small enough for a model to choose from', () => {
  /*
   * The spec has 133 operations. Wrapping all of them would be a worse product: an agent's ability to
   * pick the right tool degrades badly past a few dozen, so a complete catalogue is a catalogue
   * nobody can use. This is a deliberate ceiling, not an accident of how far I got.
   */
  assert.ok(tools.TOOLS.length <= 30,
    `${tools.TOOLS.length} tools — curate rather than grow this past 30`);
  assert.ok(tools.TOOLS.length >= 15, 'too few to be useful');
});

test('⚠️ a read token is never SHOWN a tool that writes', () => {
  const read = tools.manifest('read');
  assert.ok(read.length > 0);
  for (const t of read) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is listed for a read token but writes`);
  }
  // A write token sees strictly more, and `full` strictly more again.
  assert.ok(tools.toolsForScope('write').length > tools.toolsForScope('read').length);
  assert.ok(tools.toolsForScope('full').length > tools.toolsForScope('write').length);
  // An unknown or absent scope gets nothing at all rather than everything.
  for (const bad of ['admin', '', null, undefined, 'FULL']) {
    assert.equal(tools.toolsForScope(bad).length, 0, `scope ${JSON.stringify(bad)} must see no tools`);
  }
});

test('destructive tools require the widest scope', () => {
  // Deleting something because a model misread a sentence is the failure people actually fear.
  for (const t of tools.TOOLS) {
    if (t.call.method === 'DELETE') {
      assert.equal(t.scope, 'full', `${t.name} deletes and must require 'full'`);
    }
  }
});

test('path parameters are URL-encoded', () => {
  // Ids arrive from a model, which means they can be anything. An unencoded one containing a slash
  // addresses a different endpoint than the catalogue says this tool calls.
  const req = tools.toRequest(tools.byName('get_display'), { display_id: 'a/b/../c' });
  assert.equal(req.path, '/api/devices/a%2Fb%2F..%2Fc');
  assert.ok(!req.path.includes('/..'));
});

test('a missing required path argument is refused before any request is made', () => {
  assert.throws(() => tools.toRequest(tools.byName('get_display'), {}), /missing required argument/);
  assert.throws(() => tools.toRequest(tools.byName('get_display'), { display_id: '' }), /missing required argument/);
});

test('argument mapping only sends what the tool declares', () => {
  // A model will pass extra keys. Forwarding them verbatim would let it set fields the tool never
  // advertised — a mass-assignment hole opened by politeness.
  const req = tools.toRequest(tools.byName('rename_display'),
    { display_id: 'd1', name: 'Lobby', role: 'admin', user_id: 'someone-else' });
  assert.deepEqual(req.body, { name: 'Lobby' });
  assert.equal(req.path, '/api/devices/d1');
});

test('tool names and paths agree with the OpenAPI spec', () => {
  // The catalogue would be fiction if it called endpoints that do not exist. Compared against the
  // spec CI already lints, so this cannot silently rot.
  const spec = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.yaml'), 'utf8');
  const specPaths = new Set((spec.match(/^  (\/[^\s:]+):/gm) || []).map((l) => l.trim().replace(/:$/, '')));
  for (const t of tools.TOOLS) {
    // Tools call /api/x; the spec is rooted at /x.
    const templated = t.call.path.replace(/^\/api/, '').replace(/\{(\w+)\}/g, (_m, k) => {
      // Spec params are named for the resource (…/{id}), tools for the argument (…/{display_id}).
      if (/^(display_id|playlist_id|group_id|content_id)$/.test(k)) return '{id}';
      if (k === 'item_id') return '{itemId}';
      return `{${k}}`;
    });
    assert.ok(specPaths.has(templated),
      `${t.name} calls ${t.call.path} (${templated}), which is not in openapi.yaml`);
  }
});

test('⚠️ every query parameter a tool sends EXISTS on that endpoint', () => {
  /*
   * THE BUG THIS WAS WRITTEN FOR. play_report sent `from`/`to`; /reports/summary takes `start`/`end`.
   * Unknown query parameters are not an error — they are ignored — so the endpoint returned its
   * DEFAULT 30-day window and the tool presented it as the answer to "what played in the first week
   * of September". A confidently wrong answer with no error anywhere, found only by running it
   * against real data and noticing the dates in the reply were not the dates asked for.
   *
   * The previous test checked that the PATH exists. A path can exist while every parameter sent to it
   * is silently discarded.
   */
  const spec = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.yaml'), 'utf8');

  // Parameter names declared per path in the spec, across all its methods.
  const paramsByPath = {};
  let current = null;
  for (const line of spec.split('\n')) {
    const p = line.match(/^  (\/[^\s:]+):/);
    if (p) { current = p[1]; paramsByPath[current] = paramsByPath[current] || new Set(); continue; }
    if (!current) continue;
    const q = line.match(/name:\s*([A-Za-z_][A-Za-z0-9_]*),\s*in:\s*query/);
    if (q) paramsByPath[current].add(q[1]);
  }

  const specPathOf = (toolPath) => toolPath.replace(/^\/api/, '').replace(/\{(\w+)\}/g, (_m, k) => {
    if (/^(display_id|playlist_id|group_id|content_id)$/.test(k)) return '{id}';
    if (k === 'item_id') return '{itemId}';
    return `{${k}}`;
  });

  for (const t of tools.TOOLS) {
    for (const q of t.call.query || []) {
      const sp = specPathOf(t.call.path);
      const known = paramsByPath[sp];
      assert.ok(known && known.has(q),
        `${t.name} sends ?${q} to ${sp}, which declares no such query parameter `
        + `(it declares: ${known ? [...known].join(', ') || 'none' : 'unknown path'}). `
        + 'An unknown parameter is IGNORED, not rejected.');
    }
  }
});

test('report tools translate the words a model uses into the endpoint\'s parameters', () => {
  // The arguments stay `from`/`to`/`days` because that is how the question is asked; the mapping is
  // what has to be right.
  const summary = tools.toRequest(tools.byName('play_report'), { from: '2026-09-01', to: '2026-09-07', display_id: 'd1' });
  assert.deepEqual(summary.query, { start: '2026-09-01', end: '2026-09-07', device_id: 'd1' });

  // `days` is converted to a window, because /reports/uptime has no `days` parameter at all.
  const week = tools.toRequest(tools.byName('uptime_report'), { days: 7 });
  assert.deepEqual(Object.keys(week.query).sort(), ['end', 'start']);
  const span = (new Date(week.query.end) - new Date(week.query.start)) / 86400000;
  assert.ok(Math.abs(span - 7) < 0.01, `expected a 7-day window, got ${span}`);
  // An explicit window wins over days.
  assert.equal(tools.toRequest(tools.byName('uptime_report'), { days: 30, from: '2026-09-01' }).query.start, '2026-09-01');
  // And a nonsense value falls back rather than producing an invalid range.
  assert.ok(tools.toRequest(tools.byName('uptime_report'), { days: 'lots' }).query.start);
});

test('⚠️ list_content names its items, and search matches something that exists', () => {
  /*
   * The shape projected c.name / c.type / c.duration. A content row has filename / mime_type /
   * duration_sec and has never had the other three, so every item came back as a bare id and
   * `search` - filtering on the same absent field - returned [] for every query. No error, no empty
   * -looking response: a well-formed empty list, which an agent reports as "your library is empty".
   *
   * Asserted against the SCHEMA, not against a handwritten row, so renaming the column in
   * database.js fails here instead of silently emptying the tool again.
   */
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'database.js'), 'utf8');
  for (const col of ['filename', 'mime_type', 'duration_sec']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(schema), `content.${col} should exist in the schema`);
  }
  const row = {
    id: 'c1', filename: 'evacuation-notice.png', mime_type: 'image/png',
    duration_sec: null, folder_id: null, filepath: '/uploads/x', byte_digest: 'deadbeef',
  };
  const [shaped] = tools.byName('list_content').shape([row], {});
  assert.equal(shaped.name, 'evacuation-notice.png');
  assert.equal(shaped.type, 'image/png');
  assert.ok(!('filepath' in shaped), 'storage paths are not a model\'s business');

  // The filter has to match on the field that actually holds the label.
  assert.equal(tools.byName('list_content').shape([row], { search: 'evacuation' }).length, 1);
  assert.equal(tools.byName('list_content').shape([row], { search: 'nope' }).length, 0);

  // A YouTube item is stored with its title (or "YouTube: <id>") in the same column.
  const [yt] = tools.byName('list_content').shape(
    [{ id: 'c2', filename: 'YouTube: dQw4w9WgXcQ', mime_type: 'video/youtube', duration_sec: 212 }], {});
  assert.equal(yt.name, 'YouTube: dQw4w9WgXcQ');
  assert.equal(yt.duration, 212);
});

test('get_display returns an answer, not a database row', () => {
  // The raw row is ~80 columns and its assignments carry filepaths and thumbnail paths. A model
  // reading that spends its context on storage detail instead of the question it was asked.
  const shaped = tools.byName('get_display').shape({
    id: 'd1', name: 'Lobby', status: 'online', screen_width: 1920, screen_height: 1080,
    app_version: '2.1.6', last_heartbeat: 1790000000, device_token: 'SECRET', settings_pin: '1234',
    assignments: [
      { id: 'a1', filename: 'promo.mp4', duration_sec: 15, filepath: '/uploads/x', thumbnail_path: '/t/x' },
      { id: 'a2', widget_id: 'w1', widget_name: 'Weather', content_duration: 10, orphan: 1 },
    ],
  });
  assert.equal(shaped.resolution, '1920x1080');
  assert.match(shaped.last_heartbeat, /^\d{4}-\d{2}-\d{2}T/, 'a timestamp a model can reason about');
  assert.equal(shaped.now_playing.length, 2);
  assert.equal(shaped.now_playing[0].name, 'promo.mp4');
  assert.equal(shaped.now_playing[1].kind, 'widget');
  assert.equal(shaped.now_playing[1].orphan, true, 'an assignment whose content is gone should be visible');
  // ⚠️ Nothing sensitive, and no storage paths, survive the shaping.
  const json = JSON.stringify(shaped);
  for (const leak of ['SECRET', 'settings_pin', '1234', 'filepath', 'thumbnail_path', '/uploads/']) {
    assert.ok(!json.includes(leak), `get_display leaked ${leak}`);
  }
  // An online screen has no offline reason to report.
  assert.equal(shaped.offline_reason, null);
});

// ───────────────────────────── the protocol ─────────────────────────────

const ctx = () => ({
  version: '2.1.6',
  instructions: 'test',
  manifest: () => tools.manifest('read'),
  callTool: async (name) => (name === 'boom'
    ? { isError: true, text: 'it failed' }
    : { isError: false, text: '{}' }),
});

test('initialize echoes a protocol version we know, and falls back to ours', async () => {
  for (const v of protocol.PROTOCOL_VERSIONS) {
    const r = await protocol.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } }, ctx());
    assert.equal(r.result.protocolVersion, v, 'a client on a version we speak keeps it');
  }
  const r = await protocol.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, ctx());
  assert.equal(r.result.protocolVersion, protocol.LATEST);
});

test('we advertise only capabilities we have', async () => {
  const r = await protocol.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx());
  assert.deepEqual(Object.keys(r.result.capabilities), ['tools']);
  // An empty capability is a client feature that renders a blank panel.
  assert.equal(r.result.capabilities.tools.listChanged, false,
    'promising change notifications we never send leaves a client subscribed forever');
  assert.ok(!('resources' in r.result.capabilities));
  assert.ok(!('prompts' in r.result.capabilities));
});

test('⚠️ a notification is never answered', async () => {
  // JSON-RPC: a message with no id gets no response. Replying leaves a client waiting for something
  // it did not ask for while a stray response arrives out of band.
  for (const m of [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    { jsonrpc: '2.0', method: 'ping' },
    { jsonrpc: '2.0', method: 'made/up' },
  ]) {
    assert.equal(await protocol.handleMessage(m, ctx()), null, `answered a notification: ${m.method}`);
  }
});

test('⚠️ a failed tool is a RESULT, not a JSON-RPC error', async () => {
  /*
   * A protocol error means "this call was malformed". A 404 from the API means "that display does not
   * exist" — information the model should see and act on. Returned as a protocol error it is hidden
   * from the model entirely and the agent simply stops.
   */
  const r = await protocol.handleMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } }, ctx());
  assert.ok(!r.error, 'a tool failure must not be a protocol error');
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'it failed');
});

test('malformed requests are refused cleanly', async () => {
  for (const bad of [null, 'nope', 42, {}, { jsonrpc: '1.0', id: 1, method: 'x' }, { jsonrpc: '2.0', id: 1 }]) {
    const r = await protocol.handleMessage(bad, ctx());
    assert.equal(r.error.code, protocol.ERR.INVALID_REQUEST, `not refused: ${JSON.stringify(bad)}`);
  }
  const noName = await protocol.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, ctx());
  assert.equal(noName.error.code, protocol.ERR.INVALID_PARAMS);
});

// ───────────────────────────── the boundary ─────────────────────────────

test('⚠️ tools reach the data ONLY through our own HTTP API', () => {
  /*
   * The whole security design. If a tool ever reads the database directly it has forked the
   * permission model — tenancy, scope and the replica proxy all live in the HTTP path.
   */
  assert.ok(!/require\('\.\.\/\.\.\/db\//.test(TOOLS_SRC), 'the catalogue must not reach the database');
  assert.ok(!/\bdb\.prepare\(/.test(TOOLS_SRC), 'the catalogue must not run SQL');
  assert.match(ROUTE_SRC, /await fetch\(url, \{/, 'tool calls go out over HTTP');
  assert.match(ROUTE_SRC, /Authorization: authorization/, "carrying the CALLER'S token, not a server one");

  // The one database read in the route is the scope lookup, which grants nothing.
  const sql = ROUTE_SRC.match(/db\.prepare\([^)]*\)/g) || [];
  assert.equal(sql.length, 1, `expected only the scope lookup, found ${sql.length} queries`);
  assert.match(sql[0], /SELECT scope, revoked_at FROM api_tokens/);
});

test('the loopback origin is never the public URL', () => {
  // A tool call must reach THIS process. Sending it to APP_URL would route through whatever proxy or
  // CDN sits in front of the hostname — and on a replica, to the wrong node entirely.
  const fn = ROUTE_SRC.slice(ROUTE_SRC.indexOf('function selfOrigin'), ROUTE_SRC.indexOf('/* Run one tool'));
  // ⚠️ Comments stripped: the function's own comment says "never APP_URL", so an absence assertion
  // against the raw source fails on the note explaining the rule. Third time this pattern has bitten
  // in this codebase — assert on code, never on prose about code.
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /127\.0\.0\.1/);
  assert.ok(!/APP_URL/.test(code), 'the loopback origin must not be built from the public URL');
});

test('a revoked token is refused', () => {
  const fn = ROUTE_SRC.slice(ROUTE_SRC.indexOf('function scopeOf'), ROUTE_SRC.indexOf('function selfOrigin'));
  assert.match(fn, /revoked_at/);
  assert.match(fn, /startsWith\(TOKEN_PREFIX\)/);
});

test('the scope check is applied to a CALL, not just to the listing', () => {
  // A client may hold a stale tool list, and a model may guess a plausible name — so a tool missing
  // from the manifest is not a tool that cannot be called.
  const fn = ROUTE_SRC.slice(ROUTE_SRC.indexOf('async function callTool'));
  assert.match(fn, /SCOPE_RANK\[tool\.scope\]/);
  assert.match(fn, /needs a token with/);
  assert.match(fn, /retrying will not help/, 'tell the agent not to loop on it');
});

test('the endpoint refuses to stream rather than holding a socket open forever', () => {
  // GET is the server-initiated stream in Streamable HTTP. We never initiate anything; an idle open
  // stream would look like a working feature.
  assert.match(ROUTE_SRC, /router\.get\('\/'/);
  assert.match(ROUTE_SRC, /status\(405\)/);
});

test('tool calls cannot hang the request forever', () => {
  assert.match(ROUTE_SRC, /AbortController/);
  assert.match(ROUTE_SRC, /CALL_TIMEOUT_MS = \d+/);
});

test('the MCP endpoint is advertised where an agent will look', () => {
  const ai = require('../lib/ai-surface');
  const cat = ai.apiCatalog('https://screentinker.com');
  assert.match(JSON.stringify(cat), /https:\/\/screentinker\.com\/mcp/);
  assert.match(ai.authMarkdown('https://screentinker.com'), /Model Context Protocol/);
});
