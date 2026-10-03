'use strict';

/*
 * The plugin hard invariants, one named test each. See docs/plugins.md.
 *
 * Several are SOURCE-LEVEL assertions: for an invariant whose value is absence, absence is the
 * thing to test. Behavioural tests cover load, collision, isolation, and render degradation.
 *
 * These tests do not use better-sqlite3. load.js already accepts an injected `db` and `stateMap`,
 * so a tiny stub is enough — and it means this file still runs on a host that has not compiled
 * the native addon.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PLUGIN_DIR = path.join(__dirname, '..', 'lib', 'plugins');
const FIXTURES = path.join(__dirname, 'fixtures', 'plugins');
const registry = require('../lib/plugins/registry');
const { loadPlugins } = require('../lib/plugins/load');
const { escapeHtml, safeCss, safeUrl, safeNumber } = require('../lib/widget-sanitize');
const hooks = require('../lib/plugins/hooks');
const { satisfies } = require('../lib/plugins/semver');

function pluginSources() {
  return fs.readdirSync(PLUGIN_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8') }));
}

function stubDb() {
  return {
    prepare() {
      return {
        all: () => [],
        get: () => null,
        run: () => ({ changes: 0 }),
      };
    },
  };
}

function cfgFor(bundled, extra = {}) {
  return {
    pluginsEnabled: true,
    bundledPluginsDir: bundled,
    dataPluginsDir: path.join(os.tmpdir(), 'st-plugins-empty-' + process.pid),
    ...extra,
  };
}

function enabledMap(...ids) {
  const m = new Map();
  for (const id of ids) m.set(id, { id, enabled: 1, error: null });
  return m;
}

function clearRequire(dir) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir)) delete require.cache[key];
  }
}

beforeEach(() => { registry.reset(); hooks.reset(); });
afterEach(() => {
  registry.reset();
  clearRequire(FIXTURES);
});

test('test_plugins_off_by_default (P1)', () => {
  const result = loadPlugins({
    config: { pluginsEnabled: false, bundledPluginsDir: FIXTURES, dataPluginsDir: FIXTURES },
    db: stubDb(),
  });
  assert.equal(result.enabled, false);
  assert.equal(registry.listPlugins().length, 0);
  assert.equal(registry.listWidgetTypes().length, 0);
});

test('test_plugins_off_by_default is a source-level early return (P1)', () => {
  const src = fs.readFileSync(path.join(PLUGIN_DIR, 'load.js'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(stripped, /if\s*\(\s*!cfg\.pluginsEnabled\s*\)/,
    'boot/load must return before scanning when the flag is off');
  assert.match(stripped, /return \{ enabled: false/,
    'the early return must not discover plugins');
});

test('test_path_traversal_refused (P2)', () => {
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: enabledMap('escape-main') });
  const p = registry.getPlugin('escape-main');
  assert.ok(p, 'discovered');
  assert.ok(p.error, 'main that walks out of the plugin dir is an error, not a load');
  assert.equal(p.loaded, false);
  assert.equal(registry.hasWidget('ok-widget'), false,
    'must not have required the escaped main (ok-widget/index.js)');
});

test('test_content_dir_is_not_a_plugin_root (P2)', () => {
  const src = pluginSources().map((s) => s.src).join('\n');
  assert.doesNotMatch(src, /contentDir/,
    'the loader must not scan uploads/content for plugins');
  const pathsSrc = fs.readFileSync(path.join(PLUGIN_DIR, 'paths.js'), 'utf8');
  assert.match(pathsSrc, /bundledPluginsDir/, 'bundled root');
  assert.match(pathsSrc, /dataPluginsDir/, 'data-dir root');
});

test('test_broken_activate_does_not_prevent_load (P3)', () => {
  const result = loadPlugins({
    config: cfgFor(FIXTURES),
    db: stubDb(),
    stateMap: enabledMap('broken', 'ok-widget'),
  });
  assert.equal(result.enabled, true);
  const broken = registry.getPlugin('broken');
  const ok = registry.getPlugin('ok-widget');
  assert.ok(broken && broken.error, 'broken plugin recorded an error');
  assert.match(broken.error, /deliberately broken/);
  assert.equal(broken.loaded, false);
  assert.equal(ok.loaded, true, 'the good plugin still loaded');
  assert.equal(registry.hasWidget('ok-widget'), true);
});

test('test_unknown_type_is_degraded_not_thrown (P3)', async () => {
  const widgets = new Map([
    ['w-missing', { id: 'w-missing', widget_type: 'no-such-plugin-type', config: '{}', workspace_id: 'ws1' }],
  ]);
  const fake = {
    prepare(sql) {
      return {
        get(...args) {
          if (/FROM widgets WHERE id/.test(sql)) return widgets.get(args[0]) || null;
          if (/widget_sandbox_isolation/.test(sql)) return { disabled: 0 };
          return null;
        },
        all: () => [...widgets.values()],
        run: () => ({ changes: 0 }),
      };
    },
  };
  const dbModulePath = require.resolve('../db/database');
  const prev = require.cache[dbModulePath];
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db: fake } };
  delete require.cache[require.resolve('../routes/widgets')];
  const express = require('express');
  const widgetsRouter = require('../routes/widgets');
  const app = express();
  app.use('/api/widgets', widgetsRouter);
  const server = app.listen(0);
  await new Promise((r) => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/widgets/w-missing/render`);
  const html = await res.text();
  assert.equal(res.status, 200, 'render path must not 500');
  assert.match(html, /Unknown widget/);
  await new Promise((r) => server.close(r));
  if (prev) require.cache[dbModulePath] = prev;
  else delete require.cache[dbModulePath];
  delete require.cache[require.resolve('../routes/widgets')];
});

test('test_no_phone_home (P4)', () => {
  for (const { file, src } of pluginSources()) {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(stripped, /screentinker\.com/,
      `${file} must not name screentinker.com (P4)`);
    if (file === 'egress.js') {
      assert.match(stripped, /guardedRequest/,
        'egress.js must route plugin fetches through the SSRF-guarded helper');
      continue;
    }
    if (file === 'load.js') {
      assert.match(stripped, /makePluginFetch/,
        'plugin api.fetch must be the guarded egress helper, not global fetch');
      assert.doesNotMatch(stripped, /[^.]\bfetch\s*\(/,
        'load.js must not call a bare global fetch()');
      assert.doesNotMatch(stripped, /https?:\/\/[^\s'"]*registry/,
        'load.js must not fetch a plugin registry');
      continue;
    }
    assert.doesNotMatch(stripped, /\bfetch\s*\(/,
      `${file} must not fetch (P4 — no registry, no licence check)`);
  }
});

test('test_collision_with_clock_is_refused (P5)', () => {
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: enabledMap('clock-clash') });
  const p = registry.getPlugin('clock-clash');
  assert.ok(p.error, 'reserved widget type is refused');
  assert.match(p.error, /reserved/);
  assert.equal(registry.hasWidget('clock'), false, 'must not replace the built-in clock');
});

test('a plugin using an undeclared capability is refused and rolled back (P6)', () => {
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: enabledMap('undeclared-cap') });
  const p = registry.getPlugin('undeclared-cap');
  assert.ok(p.error, 'calling an undeclared capability must error the plugin');
  assert.match(p.error, /capability/, 'error names the missing capability');
  assert.equal(p.loaded, false, 'must not load');
  // The widget it managed to register before the throw must be rolled back, not left dangling.
  assert.equal(registry.hasWidget('undeclared-cap'), false, 'partial registration is rolled back');
  assert.equal(registry.listRouters().length, 0, 'no router mounted for a refused plugin');
});

test('test_collision_with_ical_is_refused (P5)', () => {
  registry.reset();
  assert.throws(() => {
    registry.registerDataSource('x', { type: 'ical', resolve: async () => ({}) });
  }, /reserved/);
});

test('test_admin_plugins_is_platform_admin_gated (P6)', () => {
  const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  assert.match(adminSrc, /router\.use\('\/plugins',\s*requirePlatformAdmin/,
    '/api/admin/plugins must start with requirePlatformAdmin — a workspace owner would reach it');
});

test('plugin-submissions 404s when plugins are off (P1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'plugin-submissions.js'), 'utf8');
  assert.match(src, /if\s*\(\s*!config\.pluginsEnabled\s*\)\s*return pluginsOff/,
    'workspace zip upload must 404 when the flag is unset, not 401/403 that admits the path exists');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-plugins.js'), 'utf8');
  assert.match(admin, /if\s*\(\s*!config\.pluginsEnabled\s*\)\s*return pluginsOff/,
    'admin plugin routes must 404 the same way');
});

test('admin GET rescans disk and never require()s on that path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-plugins.js'), 'utf8');
  assert.match(src, /rescan\(/, 'a newly approved or dropped folder must appear without a restart');
  const load = fs.readFileSync(path.join(PLUGIN_DIR, 'load.js'), 'utf8');
  const fn = load.match(/function rescan[\s\S]*?\nfunction boot/);
  assert.ok(fn, 'rescan must exist as its own function');
  assert.doesNotMatch(fn[0], /activatePlugin/, 'rescan must not require() plugin code');
  assert.doesNotMatch(fn[0], /\brequire\s*\(\s*mainReal/, 'rescan must not require() plugin mains');
});

test('test_plugin_routers_mount_behind_auth (P6)', () => {
  const src = fs.readFileSync(path.join(PLUGIN_DIR, 'load.js'), 'utf8');
  assert.match(src, /app\.use\(`\/api\/plugins\/\$\{pluginId\}`,\s*requireAuth,\s*resolveTenancy/,
    'plugin-contributed routers must not mount without requireAuth + resolveTenancy');
});

test('test_dockerfile_copies_bundled_plugins', () => {
  const df = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
  assert.match(df, /^COPY plugins\/ \/app\/plugins\//m,
    'bundled plugins must ship in the image or a containerised install has no countdown sample');
  const embedded = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile.embedded'), 'utf8');
  assert.match(embedded, /^COPY plugins\/ \/app\/plugins\//m,
    'the e-paper image is also a self-hosted install');
});

test('admin reviews file contents before approve, and does not auto-replace', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'admin.js'), 'utf8');
  assert.match(src, /data-plugin-inspect/, 'pending zips must be readable before approve');
  assert.match(src, /approve_confirm/, 'approve is a confirm, not a silent copy');
  assert.match(src, /body: '\{\}'/, 'first approve does not send replace:true');
  assert.match(src, /replace_confirm/, 'clobbering an installed plugin is a second confirm');
});

test('enabled plugin widget renders through GET /:id/render', async () => {
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: enabledMap('ok-widget') });
  assert.equal(registry.hasWidget('ok-widget'), true);

  const widgets = new Map([
    ['w-ok', { id: 'w-ok', widget_type: 'ok-widget', config: JSON.stringify({ headline: '<b>x</b>' }), workspace_id: 'ws1' }],
  ]);
  const fake = {
    prepare(sql) {
      return {
        get(...args) {
          if (/FROM widgets WHERE id/.test(sql)) return widgets.get(args[0]) || null;
          if (/widget_sandbox_isolation/.test(sql)) return { disabled: 0 };
          return null;
        },
        all: () => [...widgets.values()],
        run: () => ({ changes: 0 }),
      };
    },
  };
  const dbModulePath = require.resolve('../db/database');
  const prev = require.cache[dbModulePath];
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db: fake } };
  delete require.cache[require.resolve('../routes/widgets')];
  const express = require('express');
  const widgetsRouter = require('../routes/widgets');
  const app = express();
  app.use('/api/widgets', widgetsRouter);
  const server = app.listen(0);
  await new Promise((r) => server.listening ? r() : server.once('listening', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/widgets/w-ok/render`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /OK:&lt;b&gt;x&lt;\/b&gt;/, 'plugin render must escape config');
  assert.doesNotMatch(html, /OK:<b>x<\/b>/);
  await new Promise((r) => server.close(r));
  if (prev) require.cache[dbModulePath] = prev;
  else delete require.cache[dbModulePath];
  delete require.cache[require.resolve('../routes/widgets')];
});

test('data-source plugin resolve is called from the registry', async () => {
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: enabledMap('json-feed') });
  assert.equal(registry.hasDataSource('json-feed'), true);
  const ds = registry.getDataSource('json-feed');
  const data = await ds.resolve({ hello: 'sign' }, { now: new Date() });
  assert.deepEqual(data, { hello: 'sign' });
  const serviceSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'data-sources', 'service.js'), 'utf8');
  assert.match(serviceSrc, /pluginRegistry\.getDataSource/,
    'syncDataSource must consult the plugin registry, not only ical');
});

test('countdown sample is not hardcoded in the widgets view', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'widgets.js'), 'utf8');
  assert.doesNotMatch(src, /countdown/,
    'the sample type must come from GET /api/widgets/plugin-types, not a client switch');
});

test('countdown sample renders a degraded page for a missing target', () => {
  const { render } = require('../../plugins/countdown');
  const html = render({ label: 'Opens' }, { escapeHtml, safeCss, safeUrl, safeNumber, now: new Date() });
  assert.match(html, /Countdown not configured/);
  assert.doesNotMatch(html, /<script>/);
});

test('countdown sample ticks toward a target', () => {
  const { render } = require('../../plugins/countdown');
  const html = render(
    { target: '2099-01-01T00:00:00', label: 'NYE', show_seconds: true, color: '#fff', background: '#000' },
    { escapeHtml, safeCss, safeUrl, safeNumber, now: new Date('2026-01-01T00:00:00Z') }
  );
  assert.match(html, /NYE/);
  assert.match(html, /2099-01-01T00:00:00/);
  assert.match(html, /setInterval/);
});

test('disabled plugin is not required', () => {
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: new Map() });
  const p = registry.getPlugin('ok-widget');
  assert.ok(p);
  assert.equal(p.enabled, false);
  assert.equal(p.loaded, false);
  assert.equal(registry.hasWidget('ok-widget'), false);
});

test('widget sanitizers reject CSS breakout', () => {
  assert.equal(safeCss('red', 'x'), 'red');
  assert.equal(safeCss('}</style><script>', 'x'), 'x');
  // A legit gradient/colour is kept; a URL-fetching CSS function (no url( token) is rejected.
  assert.equal(safeCss('linear-gradient(45deg, #ff0000, #00ff00)', 'x'), 'linear-gradient(45deg, #ff0000, #00ff00)');
  assert.equal(safeCss('image-set("//attacker.example/beacon.png" 1x)', 'x'), 'x');
  assert.equal(safeCss('-webkit-image-set(url(x) 1x)', 'x'), 'x');
  assert.equal(safeCss('cross-fade(url(a), url(b))', 'x'), 'x');
  assert.equal(safeCss('image("//attacker.example/b.png")', 'x'), 'x');
  assert.equal(safeUrl('javascript:alert(1)'), 'about:blank');
  assert.equal(safeUrl('https://example.com'), 'https://example.com');
  assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(safeNumber('12px', 0), 0);
  assert.equal(safeNumber('12', 0), 12);
});

test('escapeHtml source still contains entities (extraction must not HTML-decode this file)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'widget-sanitize.js'), 'utf8');
  assert.match(src, /&amp;/);
  assert.match(src, /&lt;/);
  assert.match(src, /&gt;/);
  assert.match(src, /&quot;/);
});

test('unknown hook name is refused at register', () => {
  assert.throws(() => hooks.register('x', 'device.exploded', () => {}), /unknown hook/);
});

test('a throwing hook does not throw into emit (P3)', async () => {
  hooks.register('x', 'device.offline', () => { throw new Error('boom'); });
  assert.equal(hooks.emit('device.offline', { device_id: 'd1' }), 1);
  await new Promise((r) => setImmediate(r));
});

test('content.uploaded is emitted from the shared ingest path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'content-ingest.js'), 'utf8');
  assert.match(src, /content\.uploaded/,
    'ingestUploadedFile must emit content.uploaded so agency and dashboard share one fire');
});

test('device.offline is emitted from heartbeat timeout and logDeviceStatus', () => {
  const hb = fs.readFileSync(path.join(__dirname, '..', 'services', 'heartbeat.js'), 'utf8');
  const sock = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(hb, /device\.offline/);
  assert.match(sock, /'device\.' \+ status/);
});

test('activate() returning a thenable is an error and rolls back registrations', () => {
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: enabledMap('async-activate') });
  const p = registry.getPlugin('async-activate');
  assert.ok(p && p.error);
  assert.match(p.error, /synchronous/);
  assert.equal(p.loaded, false);
  assert.equal(registry.hasWidget('async-activate'), false);
});

test('screentinker >= constraint refuses an older host', () => {
  assert.equal(satisfies('>=99.0.0', '2.0.10'), false);
  assert.equal(satisfies('>=2.0.0', '2.0.10'), true);
  assert.equal(satisfies('', '2.0.10'), true);
  loadPlugins({ config: cfgFor(FIXTURES), db: stubDb(), stateMap: enabledMap('too-new') });
  const p = registry.getPlugin('too-new');
  assert.ok(p && p.error);
  assert.match(p.error, /requires ScreenTinker/);
  assert.equal(registry.hasWidget('too-new'), false);
});

test('json-api flatten produces bindable keys', () => {
  const { flatten, pickPath } = require('../../plugins/json-api');
  const flat = flatten({ weather: { temp: 18 }, tags: ['a', 'b'] }, '', {}, 0);
  assert.equal(flat.weather_temp, 18);
  assert.equal(flat.tags_count, 2);
  assert.equal(flat.tags_0, 'a');
  assert.equal(pickPath({ data: { n: 1 } }, 'data.n'), 1);
});

test('json-api data source registers from the sample plugin', () => {
  const bundled = path.join(__dirname, '..', '..', 'plugins');
  loadPlugins({
    config: { pluginsEnabled: true, bundledPluginsDir: bundled, dataPluginsDir: path.join(os.tmpdir(), 'st-empty-plugins') },
    db: stubDb(),
    stateMap: enabledMap('json-api', 'countdown'),
  });
  assert.equal(registry.hasDataSource('json-api'), true);
  assert.equal(registry.hasWidget('countdown'), true);
  const types = registry.listDataSourceTypes();
  assert.ok(types.some((t) => t.type === 'json-api' && Array.isArray(t.fields)));
});

test('json-api resolve requires ctx.fetch and returns null on 304', async () => {
  const { resolve } = require('../../plugins/json-api');
  await assert.rejects(() => resolve({ url: 'https://example.com/x.json' }, {}), /ctx\.fetch/);
  const data = await resolve({ url: 'https://example.com/x.json' }, {
    fetch: async () => ({ notModified: true, statusCode: 304 }),
  });
  assert.equal(data, null);
});

test('plugin-fields HTML goes through utils.esc (no second decoder)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'plugin-fields.js'), 'utf8');
  assert.match(src, /import \{ esc \} from '\.\.\/utils\.js'/);
  assert.doesNotMatch(src, /function escAttr/);
  assert.match(src, /\$\{esc\(/);
});

test('telemetry packets do not emit device.online (that path is a flood)', () => {
  const sock = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const idx = sock.indexOf('reported_timezone');
  assert.ok(idx > 0, 'telemetry handler writes reported_timezone');
  const window = sock.slice(idx, idx + 900);
  assert.doesNotMatch(window, /pluginHooks/);
  assert.doesNotMatch(window, /logDeviceStatus/);
});

test('widget plugin render ctx interpolates data sources and resolves images', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
  assert.match(src, /interpolate\(text\)/);
  assert.match(src, /slideRender\.interpolateDataSources/);
  assert.match(src, /resolveImage: typeof opts\.resolveImage/);
});

test('data-source plugin resolve is handed the SSRF-guarded fetch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'data-sources', 'service.js'), 'utf8');
  assert.match(src, /fetch: makePluginFetch\(/);
  assert.match(src, /resolvedData == null/);
});

test('isAcceptedWidgetType still admits slide (first-party create path)', () => {
  assert.equal(registry.isAcceptedWidgetType('slide'), true);
  assert.equal(registry.isAcceptedWidgetType('clock'), true);
  assert.equal(registry.isAcceptedWidgetType('no-such-type'), false);
});

test('widget-type creation is validated even when plugins are OFF (intentional, signed off)', () => {
  // beforeEach resets the registry, so this asserts the behaviour on an install with plugins
  // disabled (an empty registry): the built-in types are accepted and any unknown type is refused.
  // POST /api/widgets previously accepted any string; it now rejects unknown types unconditionally.
  // This is a deliberate fail-fast (the render path only ever supported the built-ins, so a stray
  // type was already unrenderable), NOT gated behind PLUGINS_ENABLED -- pinned here so the choice is
  // explicit and cannot regress silently.
  assert.equal(registry.listWidgetTypes().length, 0, 'no plugin types registered (plugins off)');
  for (const t of ['clock', 'weather', 'rss', 'text', 'webpage', 'slide']) {
    assert.equal(registry.isAcceptedWidgetType(t), true, `built-in ${t} accepted`);
  }
  assert.equal(registry.isAcceptedWidgetType('totally-made-up'), false, 'unknown type refused');
  assert.equal(registry.isAcceptedDataSourceType('ical'), true, 'built-in ical accepted');
  assert.equal(registry.isAcceptedDataSourceType('made-up-source'), false, 'unknown data source refused');
});

test('unknown hook names are a no-op at emit, not a throw', () => {
  assert.equal(hooks.emit('device.exploded', { device_id: 'x' }), 0);
});

test('secret fields redact on the way out and merge blank on the way in', () => {
  const { redactSecrets, mergeSecrets, redactConfigJson } = require('../lib/plugins/secrets');
  const fields = [{ name: 'secret', type: 'password' }, { name: 'url', type: 'url' }];
  const stored = { url: 'https://example.com', secret: 'tok_live', authorization: 'Bearer x' };
  const redacted = redactSecrets(stored, fields);
  assert.equal(redacted.secret, '');
  assert.equal(redacted.authorization, '');
  assert.equal(redacted.url, 'https://example.com');
  const merged = mergeSecrets({ url: 'https://example.com/v2', secret: '' }, stored, fields);
  assert.equal(merged.secret, 'tok_live');
  assert.equal(merged.url, 'https://example.com/v2');
  const json = redactConfigJson(JSON.stringify(stored), fields);
  const parsed = JSON.parse(json);
  assert.equal(parsed.secret, '');
  assert.equal(parsed.authorization, '');
  assert.equal(parsed.url, 'https://example.com');
});

test('data-dir wins over bundled for the same id (P2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-data-plugins-'));
  const dir = path.join(tmp, 'ok-widget');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'ok-widget',
    name: 'Override',
    version: '9.9.9',
    main: 'index.js',
    capabilities: ['widget'],
    widget: { type: 'ok-widget', fields: [] },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'),
    "module.exports = { activate(api) { api.registerWidget({ type: 'ok-widget', render() { return 'DATA'; } }); } };\n");
  try {
    loadPlugins({
      config: { pluginsEnabled: true, bundledPluginsDir: FIXTURES, dataPluginsDir: tmp },
      db: stubDb(),
      stateMap: enabledMap('ok-widget'),
    });
    const p = registry.getPlugin('ok-widget');
    assert.equal(p.origin, 'data');
    assert.equal(p.version, '9.9.9');
    assert.equal(registry.getWidget('ok-widget').render({}, {}), 'DATA');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('widget GET/PUT go through secret redact/merge', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
  assert.match(src, /redactWidgetRow/, 'dashboard GET must not return plugin widget secrets');
  assert.match(src, /mergeSecrets/, 'blank widget PUT must keep the stored secret');
});

test('plugin settings PUT does not flip enabled to 0', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-plugins.js'), 'utf8');
  assert.match(src, /plugin\.enabled \? 1 : 0/,
    'saving settings on a loaded plugin must not INSERT enabled=0');
});

test('webhook sample registers hooks and respects the off switch', async () => {
  const bundled = path.join(__dirname, '..', '..', 'plugins');
  const settings = { url: 'https://example.com/hook', on_offline: true, on_online: false, on_publish: false };
  const db = {
    prepare(sql) {
      return {
        all: () => [],
        get: () => (/SELECT settings/.test(sql) ? { settings: JSON.stringify(settings) } : null),
        run: () => ({ changes: 0 }),
      };
    },
  };
  loadPlugins({
    config: { pluginsEnabled: true, bundledPluginsDir: bundled, dataPluginsDir: path.join(os.tmpdir(), 'st-empty-wh') },
    db,
    stateMap: enabledMap('webhook'),
  });
  assert.ok(registry.getPlugin('webhook').loaded);
  const { post, enabled } = require('../../plugins/webhook');
  assert.equal(enabled({}, 'on_offline'), true);
  assert.equal(enabled({}, 'on_online'), false);
  let seen = null;
  await post({
    getSettings: () => settings,
    fetch: async (url, opts) => { seen = { url, opts }; return { statusCode: 204 }; },
    log: () => {},
  }, 'device.offline', { device_id: 'd1' });
  assert.equal(seen.url, 'https://example.com/hook');
  assert.equal(seen.opts.method, 'POST');
  assert.match(seen.opts.body.event || JSON.stringify(seen.opts.body), /device\.offline|d1/);
});

test('webhook and json-api are not hardcoded in dashboard views', () => {
  const ds = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'data-sources.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'admin.js'), 'utf8');
  assert.match(ds, /getDataSourcePluginTypes/);
  assert.match(admin, /settings_fields/);
});

test('password fields are a first-class schema type', () => {
  const { FIELD_TYPES } = require('../lib/plugins/reserved');
  assert.equal(FIELD_TYPES.has('password'), true);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'plugin-fields.js'), 'utf8');
  assert.match(src, /kind === 'password'/);
});

test('guardedRequest accepts a body and 2xx when asked', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ssrf-guard.js'), 'utf8');
  assert.match(src, /accept2xx/);
  assert.match(src, /bodyBuf/);
});

test('plugin.submitted/approved/rejected are on the hook allowlist', () => {
  for (const name of ['plugin.submitted', 'plugin.approved', 'plugin.rejected']) {
    assert.equal(hooks.ALLOWED.has(name), true, name);
  }
  const src = fs.readFileSync(path.join(PLUGIN_DIR, 'submissions.js'), 'utf8');
  assert.match(src, /plugin\.submitted/);
  assert.match(src, /plugin\.approved/);
  assert.match(src, /plugin\.rejected/);
});

test('plugin-submissions rate limit is POST-only so listing does not share the zip cap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.post\('\/api\/plugin-submissions',\s*rateLimit\(/,
    'only POST is a zip; GET is the editor listing their queue');
  assert.doesNotMatch(src, /app\.use\('\/api\/plugin-submissions',\s*rateLimit\(/,
    'app.use would count Widgets page loads against the 10/hour zip cap');
});

test('enable consults the allowlist and unpin deletes via isInside', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-plugins.js'), 'utf8');
  assert.match(src, /assertLoadable/,
    'enable must refuse an upload-sourced plugin that is not on the allowlist');
  assert.match(src, /isInside/,
    'unpin must not rmSync via a string prefix');
  assert.doesNotMatch(src, /startsWith\(rootReal/,
    'prefix check is how you delete a sibling directory');
});

test('webhook sample ships the plugin-review event switches', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'webhook', 'plugin.json'), 'utf8'));
  const names = (spec.settings.fields || []).map((f) => f.name);
  assert.ok(names.includes('on_plugin_submit'));
  assert.ok(names.includes('on_plugin_approve'));
  assert.ok(names.includes('on_plugin_reject'));
  const { enabled } = require('../../plugins/webhook');
  assert.equal(enabled({}, 'on_plugin_submit'), false, 'new events stay off until the operator ticks them');
});
