'use strict';

/* The /download index (lib/download-index.js) and the guides it is the other half of.
 *
 * The rule under test is not "does it render". It is that a row is only ever offered when this
 * instance actually has the bytes behind it. An operator sent to a 404 by their own dashboard
 * concludes the platform is unsupported and buys a different box — so "offered" and "present" must
 * be the same condition, and a missing artifact must still say something useful instead of
 * disappearing.
 *
 * The second half is the reason this page exists at all: the guides must not send anyone to a
 * GitHub release for a player. The BrightSign archive has the server URL stamped into its bytes, so
 * a release asset points a freshly imaged player at the wrong instance — a failure that presents as
 * a pairing bug. Asserted here rather than left to review, because a plausible-looking external
 * link is exactly the edit nobody questions.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const di = require('../lib/download-index');

const GUIDE_DIR = path.join(__dirname, '..', '..', 'frontend', 'guides');
const PLATFORM_GUIDES = [
  'windows-digital-signage.html',
  'chromeos-digital-signage.html',
  'lg-webos-digital-signage.html',
  'brightsign-digital-signage.html',
];

const FULL = {
  apk: { exists: true, size: 31_000_000, version: '2.1.6' },
  ipk: { exists: true, size: 2_400_000, version: '2.1.6' },
  wgt: { exists: true, size: 1_100_000, version: '2.1.6' },
  brightsign: { exists: true, version: '2.1.6' },
};

test('every entry has the fields a row is rendered from', () => {
  for (const e of di.entries(FULL)) {
    assert.ok(e.id, 'id');
    assert.ok(e.name, `name for ${e.id}`);
    assert.ok(e.what, `what for ${e.id}`);
    assert.ok(e.guide, `guide link for ${e.id}`);
    assert.match(e.guide, /^\/(guides|certified-hardware)/, `${e.id} guide is a local path`);
  }
});

test('an artifact with no file behind it is NOT offered as a download', () => {
  // The empty state: a deployment that has none of the mounted artifacts. The three that depend on
  // a file must all be unavailable, and each must still carry an explanation.
  const bare = di.entries({});
  for (const id of ['android', 'webos', 'tizen', 'brightsign']) {
    const e = bare.find((x) => x.id === id);
    assert.equal(e.available, false, `${id} must not be offered with no file present`);
    assert.ok(e.absent, `${id} must explain what to do instead`);
  }
});

test('the platforms that need no artifact are always offered', () => {
  // These ship in the source tree or are the player URL itself, so a deployment cannot lack them —
  // and a blank downloads page on a fresh instance would be the worst possible first impression.
  const bare = di.entries({});
  for (const id of ['raspberry-pi', 'windows', 'web']) {
    assert.equal(bare.find((x) => x.id === id).available, true, `${id} should always be available`);
  }
});

test('Vega is listed but never offered as an install', () => {
  // The hardware is not certified and the package installs through Amazon's own tooling. A download
  // button here would read as a recommendation, which is the opposite of the certified-hardware
  // entry. It still gets a row, because hiding it makes the reader think the sticks are Android.
  for (const state of [{}, FULL]) {
    const vega = di.entries(state).find((x) => x.id === 'vega');
    assert.equal(vega.available, false);
    assert.equal(vega.url, null, 'Vega must have no download URL in any state');
    assert.ok(vega.absent);
  }
});

test('the BrightSign row points at this server, not at a release asset', () => {
  const bs = di.entries(FULL).find((x) => x.id === 'brightsign');
  assert.equal(bs.url, '/download/autorun.zip');
  assert.ok(!/github/i.test(JSON.stringify(bs)), 'the BrightSign row must not mention GitHub');
});

test('the rendered page prints the server address and offers only available rows', () => {
  const html = di.renderPage(FULL, 'https://signage.example.com');
  assert.match(html, /https:\/\/signage\.example\.com/, 'the page must print the instance address');
  // The address is what every one of these installs asks for next, and getting it from a page served
  // by a DIFFERENT server is how a player ends up registered against the wrong instance.
  assert.match(html, /name="robots" content="noindex"/, 'a download index has no business ranking');
  assert.match(html, /\/download\/autorun\.zip/);

  const bare = di.renderPage({}, 'https://signage.example.com');
  assert.ok(!bare.includes('href="/download/apk"'), 'no APK link when no APK is hosted');
  assert.match(bare, /Use the web player/, 'a missing artifact still offers the fallback');
});

test('renderPage escapes the host it is handed', () => {
  // `base` comes from the Host header when APP_URL is unset. It is reflected into the page, so it is
  // escaped — not because a header can realistically carry a payload past the proxy, but because
  // "reflected into HTML unescaped" is not a property to leave to luck in a public, unauthenticated
  // page.
  const html = di.renderPage(FULL, '"><script>alert(1)</script>');
  assert.ok(!html.includes('<script>alert(1)'), 'the host must not be reflected as markup');
  assert.match(html, /&lt;script&gt;/);
});

test('formatSize reads as a size, and nothing is printed for a missing one', () => {
  assert.equal(di.formatSize(0), null);
  assert.equal(di.formatSize(undefined), null);
  assert.equal(di.formatSize(500 * 1024), '500 KB');
  assert.equal(di.formatSize(31 * 1024 * 1024), '31.0 MB');
});

test('every entry links to a guide page that exists', () => {
  // The whole point of the refactor: ten platforms, ten real pages. A link to a guide that was never
  // written is a 404 in the one place a new operator is guaranteed to look.
  for (const e of di.entries(FULL)) {
    if (e.guide === '/certified-hardware') continue;
    const file = path.join(GUIDE_DIR, path.basename(e.guide));
    assert.ok(fs.existsSync(file), `${e.id} links to ${e.guide}, which does not exist`);
  }
});

test('the four new platform guides send people to this server for the player', () => {
  for (const name of PLATFORM_GUIDES) {
    const html = fs.readFileSync(path.join(GUIDE_DIR, name), 'utf8');
    // One GitHub link is fine and expected — the footer's source link. What must not appear is a
    // release download: that is the copy stamped with the wrong server URL.
    assert.ok(
      !/github\.com\/screentinker\/screentinker\/releases/.test(html),
      `${name} must not link a release asset — the artifact is served by the instance`
    );
    assert.match(html, /href="\/download\//, `${name} should point at the instance's downloads`);
  }
});

test('the new guides are indexable, canonical and in the sitemap', () => {
  const sitemap = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'sitemap.xml'), 'utf8'
  );
  for (const name of PLATFORM_GUIDES) {
    const html = fs.readFileSync(path.join(GUIDE_DIR, name), 'utf8');
    assert.match(html, /name="robots" content="index, follow"/, `${name} robots`);
    assert.match(
      html,
      new RegExp(`<link rel="canonical" href="https://screentinker\\.com/guides/${name.replace('.', '\\.')}">`),
      `${name} canonical`
    );
    assert.ok(sitemap.includes(`/guides/${name}`), `${name} is missing from sitemap.xml`);
  }
});

test('the landing page links all ten platforms and the certified-hardware page from the nav', () => {
  const landing = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'landing.html'), 'utf8'
  );
  const tiles = landing.match(/class="platform-item"/g) || [];
  assert.equal(tiles.length, 10, 'ten platform tiles');
  // Every tile is a link now — a tile that is a bare <div> is a platform with nowhere to go, which
  // is what this change removed.
  assert.equal(
    (landing.match(/<a class="platform-item"/g) || []).length, 10,
    'every platform tile must be a link'
  );
  // Named in reseller agreements, and people were hunting for it: it belongs in the nav.
  assert.match(landing, /<a href="\/certified-hardware">Certified Hardware<\/a>/);
  assert.ok(!landing.includes('9 platforms'), 'the social cards must not still say 9 platforms');
});

/*
 * The /scripts mount. This was `express.static(scripts/)`, which published the whole directory:
 * reset-admin.js, mint-billing-token.js, support-keygen.js, upgrade.sh, backup.sh. Nothing in there
 * is secret — the repository is public — but it is operational tooling handed to anonymous callers,
 * and that directory is exactly where a self-hoster's own script lands. The next person to drop a
 * restore script with a connection string in it beside them would publish it without touching a
 * route. Asserted at the source level, the way the other route tests here work.
 */
test('/scripts serves an allowlist, not the directory', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Strip comments first: this file and server.js both QUOTE the removed express.static line to
  // explain why it went, and an assertion that a string is absent must not be satisfied — or
  // defeated — by prose about it.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  assert.ok(
    !/express\.static\([^)]*['"]?\.\.['"]?\s*,\s*['"]scripts['"]/.test(code),
    'the whole scripts/ directory must not be statically served'
  );
  assert.match(code, /const PUBLIC_SCRIPTS = new Set\(\[/, 'the allowlist must exist');

  const set = code.match(/const PUBLIC_SCRIPTS = new Set\(\[([\s\S]*?)\]\)/);
  const allowed = [...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  // Exactly these, and nothing else. A new entry is a deliberate edit here.
  const SETUP_SCRIPTS = ['debian-13-setup.sh', 'raspberry-pi-setup.sh', 'windows-setup.bat'];
  // ⚠️ The BrightSign payloads are NOT in the repository — a deployment bind-mounts them into
  // scripts/ (compose: ./brightsign/autorun.zip -> /app/scripts/autorun.zip) and
  // brightsign/server/bs-server-boot.js fetches <server>/scripts/server-payload.zip by URL.
  // Dropping one does not 404: the SPA fallback answers 200 with HTML, and a provisioning player
  // writes that to its storage root as its autorun. So they are asserted present on the list and
  // deliberately NOT asserted present on disk.
  const DEPLOYMENT_ARTIFACTS = ['autorun-server.zip', 'autorun.zip', 'server-payload.json', 'server-payload.zip'];
  assert.deepEqual(allowed.slice().sort(), [...SETUP_SCRIPTS, ...DEPLOYMENT_ARTIFACTS].sort());

  // A setup script, though, IS tracked — and one allowlisted but missing is a link that 404s.
  for (const name of SETUP_SCRIPTS) {
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', '..', 'scripts', name)),
      `${name} is allowlisted but not in scripts/`
    );
  }

  // And nothing sensitive can sneak back in by being added to the set. Separate from the exact
  // comparison above so that widening the list for a legitimate artifact still trips this.
  for (const name of allowed) {
    assert.ok(
      !/^(reset-admin|mint-billing-token|support-keygen|migrate-|upgrade|backup|finalize-)/.test(name),
      `${name} is operational tooling and must not be public`
    );
  }
});

/*
 * ⚠️ A binary payload must not be advertised as text. The first version of this route set
 * `text/plain; charset=utf-8` on everything, which boot-tests perfectly — the bytes arrive intact
 * and the sizes match — while telling every proxy and CDN in front of the instance that a 93 MB
 * zip is text it may transform. express.static inferred the type, so this only became a decision
 * once the mount became a route.
 */
test('/scripts serves the binary payloads with a binary content type', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const map = src.match(/const SCRIPT_TYPES = \{([^}]*)\}/);
  assert.ok(map, 'the route must map extensions to types');
  assert.match(map[1], /'\.zip':\s*'application\/zip'/, '.zip must be application/zip');
  assert.match(map[1], /'\.json':\s*'application\/json'/, '.json must be application/json');

  // Every allowlisted name whose extension is not plain text must have an entry, or it goes out as
  // text/plain by the fallback and nothing anywhere says so.
  const set = src.match(/const PUBLIC_SCRIPTS = new Set\(\[([\s\S]*?)\]\)/);
  const allowed = [...set[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const name of allowed) {
    const ext = name.slice(name.lastIndexOf('.'));
    if (['.sh', '.bat'].includes(ext)) continue;   // meant to be read in a browser
    assert.match(map[1], new RegExp(`'\\${ext}':`), `${name} (${ext}) has no explicit content type`);
  }
});

test('the download routes exist and reuse the BrightSign package helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\(\['\/download', '\/download\/'\]/, '/download index route');
  assert.match(src, /app\.get\('\/download\/autorun\.zip'/, '/download/autorun.zip route');
  // Both zip URLs must go through getPackage, so the bytes and the advertised checksum cannot
  // diverge between them — a mismatch there is how a package update becomes a download loop.
  for (const url of ['/download/autorun.zip', '/api/brightsign/package/download']) {
    const at = src.indexOf(`app.get('${url}'`);
    assert.notEqual(at, -1, `${url} route not found`);
    // The handler, not the whole file: a match anywhere else in server.js would prove nothing.
    const body = src.slice(at, at + 700);
    assert.match(body, /bsPackage\.getPackage\(bsPackage\.packageServerUrl\(req\)\)/,
      `${url} must resolve the package through the shared helper`);
  }
});

test('the BrightSign package helper answers availability without building the zip', () => {
  const bs = require('../lib/brightsign-package');
  assert.equal(typeof bs.available, 'function');
  assert.equal(typeof bs.version, 'function');
  // Called on every render of the download index, so it must not be the async build.
  assert.equal(typeof bs.available(), 'boolean');
});
