'use strict';

/*
 * The mesh surfaces in the UI: the Servers section, the centralized alerts on Activity, the uptime
 * report under Reports, and remote orgs in the workspace switcher.
 *
 * Source assertions rather than a rendered DOM, for the same reason as the invariant tests: most of
 * what is protected here is ABSENCE — that a remote row offers no action it cannot perform, that a
 * stale link is not painted red, that coverage is never rendered smaller than uptime.
 *
 * ⚠️ AND A STANDING CAVEAT ON THIS WHOLE FILE. Source-level tests cannot see whether the page
 * WORKS. This view once shipped calling `api.get()`, which did not exist, and using
 * `class="data-table"`, which no stylesheet defines — so the section threw on render and, once that
 * was fixed, rendered completely unstyled. Twelve tests here passed throughout. They check that the
 * code says the right things; frontend-api-contract.test.js checks the callees exist; only opening
 * the page checks the rest.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const front = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', ...p), 'utf8');
const VIEW = front('js', 'views', 'servers.js');
const ACTIVITY = front('js', 'views', 'activity.js');
const REPORTS = front('js', 'views', 'reports.js');
const SWITCHER = front('js', 'components', 'workspace-switcher.js');
const DASHBOARD = front('js', 'views', 'dashboard.js');
const APP = front('js', 'app.js');
const INDEX = front('index.html');

/*
 * ⚠️ Comments stripped, for assertions about what the code DOES. A guard that greps the raw file
 * matches the comment explaining why something is avoided just as happily as the thing itself —
 * so a file that says "we deliberately do not use data-table" fails a test asserting it does not
 * use data-table. That is how a correct guard gets deleted for being "wrong".
 */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '');

/* ===================== the Servers section ===================== */

test('the view is registered, routed and reachable', () => {
  assert.match(APP, /import \* as servers from '\.\/views\/servers\.js'/);
  assert.match(APP, /hash === '#\/servers'/);
  assert.match(APP, /servers\.render\(app\)/);
  assert.match(INDEX, /id="serversNavItem"/);
  assert.match(INDEX, /href="#\/servers"/);
});

test('⚠️ the nav item is ASKED for, not assumed', () => {
  /*
   * There is no client-side flag for MESH_ACCEPT_ENROLLMENT and there should not be: the server
   * mounts /api/mesh only when it is set, so whether the API answers IS the test. A hardcoded flag
   * in the bundle would drift the moment somebody changed the env var, and would show a section
   * that 404s.
   */
  assert.match(INDEX, /id="serversNavItem" style="display:none"/,
    'it must start hidden, so an ordinary install never flashes a section it does not have');
  /*
   * ⚠️ EITHER ROLE. Gating on /mesh/nodes alone hid the section on a node configured only to report
   * UPWARD — and the Connect tab, which is how such a node enrols and how its operator severs the
   * link, lives inside that section. A child could be configured to join a mesh with no way to do
   * it, which contradicts consent-from-below: the API answers GET /mesh/uplink whatever the flags
   * say, precisely so a link cannot be made and then hidden.
   */
  assert.match(APP, /api\.get\('\/mesh\/capabilities'\)[\s\S]{0,120}serversNav\.style\.display = ''/,
    'revealed when this node is part of a mesh in any way');
  assert.match(APP, /api\.get\('\/mesh\/nodes'\)[\s\S]{0,160}serversNav\.style\.display = ''/,
    'with the hub route as a fallback for an older peer');
});

test('⚠️ tables use the HOUSE style, not an invented class', () => {
  /*
   * This view shipped using `class="data-table"`, which exists in no stylesheet — so every table
   * rendered with no padding, no header rule and its columns bunched against the left edge while
   * two thirds of the row sat empty. Perfectly well-formed markup referring to a class nobody had
   * written, which is exactly what a source test cannot notice on its own.
   */
  assert.doesNotMatch(code(VIEW), /class="data-table"/, 'data-table is not a real class');
  assert.match(VIEW, /class="table-wrap"/, 'the house wrapper supplies horizontal scroll');
  assert.match(VIEW, /border-collapse:collapse/, 'and the table is styled inline like every other');
});

test('⚠️ a stale link is AMBER, never red', () => {
  /*
   * Red says "this screen is broken" and sends an engineer to a working site. Amber says "we cannot
   * currently see it", which is the true statement and points at the network instead.
   */
  const stale = VIEW.match(/stale:\s*\{[^}]*\}/);
  assert.ok(stale, 'a stale status style must exist');
  assert.ok(!/#ef4444/.test(stale[0]), 'stale must not use the offline red');
  assert.match(stale[0], /#f59e0b/, 'it should be amber');
  assert.match(stale[0], /Last known/, 'and read as last-known rather than as a live state');
});

test('⚠️ every row shows its age, not just the stale ones', () => {
  // A green dot from ninety minutes ago is a lie by omission, and the reader cannot tell.
  assert.match(VIEW, /function statusCell[\s\S]{0,900}asOfAgeSec/,
    'the age belongs in the shared status cell, so no row can be rendered without it');
});

test('⚠️ the origin server is its own column, not folded into the name', () => {
  // "Lobby (Acme)" breaks sort and search for every row at once, and is hard to undo once customers
  // have learned to read it that way.
  assert.match(VIEW, /'Screen', 'Server', 'Status'/, 'the server gets its own column header');
  assert.match(VIEW, /\$\{idBadge\(d\.originNodeId\)\}/, 'and its own cell');
  assert.doesNotMatch(VIEW, /\$\{d\.name\}\s*\(\$\{d\.originNodeId/, 'never concatenated');
});

test('⚠️ node ids are shortened for display but stay recoverable', () => {
  /*
   * A UUID in every row pushes the columns an operator actually reads off the screen, for something
   * nobody distinguishes by eye. It still has to be recoverable when somebody genuinely needs it.
   */
  assert.match(VIEW, /const shortId = \(id\) => \(id \? String\(id\)\.slice\(0, 8\)/);
  assert.match(VIEW, /title="\$\{esc\(id\)\}"/, 'the full id must survive on hover');
});

test('⚠️ THE DEEP LINK IS GONE, deliberately', () => {
  /*
   * It was what made a read-only hub useful while remote objects were a dead end here. Now that a
   * remote org can be selected locally, sending an operator to another server under a different
   * login is strictly worse — and it would be the path people took, because it sat on the row.
   */
  assert.doesNotMatch(VIEW, /Open on its server/);
  assert.doesNotMatch(VIEW, /deepLink/);
});

test('a device with no shared name says so rather than rendering blank', () => {
  // A health-only grant sends no name. An empty cell reads as a bug; "not shared" reads as a choice.
  assert.match(VIEW, /not shared/);
});

test('the search caveat from the server is rendered, not swallowed', () => {
  // Without it an empty result reads as a broken search, and the "fix" someone reaches for is
  // widening the grant — the outcome the grant vocabulary exists to avoid.
  assert.match(VIEW, /searchNote/);
});

test('paging is server-side, with a bounded page', () => {
  assert.match(VIEW, /limit=\$\{state\.limit\}&offset=\$\{state\.offset\}/,
    'the page must be requested from the server, not sliced in the browser');
  assert.doesNotMatch(VIEW, /devices\.slice\(/, 'no client-side pagination over a full fleet');
});

test('a new search returns to the first page', () => {
  // Otherwise a search from page 7 shows "no results" for a term that matches three screens.
  assert.match(VIEW, /state\.search = e\.target\.value;[\s\S]{0,120}state\.offset = 0/);
});

test('⚠️ MINTING AND REPORTING UPWARD ARE SEPARATE, and gated separately', () => {
  /*
   * They are opposite directions behind different flags, used by different people at different
   * times. Bundled into one "Connect" tab, a hub — which can only ever do the first — grew a tab
   * whose second half read "this server is not configured for that", which is a dead end an
   * operator opens once and then distrusts the whole section for.
   *
   * Minting is a HEADER ACTION, like adding a display: on a hub it is the ordinary next thing to do
   * on this page. The tab is the report-upward side only.
   *
   * ⚠️ The existing-uplink case is NOT optional. A link that exists must stay visible and severable
   * from below, or turning MESH_ALLOW_UPLINK off afterwards would be a way to hide an MSP
   * relationship from the client subject to it.
   */
  assert.match(VIEW, /const showConnect = connect\.canEnroll \|\| \(connect\.uplinks \|\| \[\]\)\.length > 0/,
    'the tab follows the uplink flag, never the mint flag');
  assert.match(VIEW, /api\.get\('\/mesh\/capabilities'\)/,
    'the flags are asked for, never duplicated into the bundle');
  assert.match(VIEW, /\$\{connect\.canMint \?[\s\S]{0,160}connectServerBtn/,
    'minting is a header button, gated on its own flag');
  assert.match(VIEW, /\$\{caps\.canEnroll \?/, 'and the uplink half on its own');
  assert.doesNotMatch(code(VIEW), /caps\.canMint/,
    'the tab body must no longer contain the mint half at all');
});

test('⚠️ mesh writes address LOCAL administration only (I2)', () => {
  /*
   * I2 is "there is no downward channel to write over" — this server cannot change what plays on
   * somebody else's screens. Minting a code and connecting this server to a parent are writes to
   * THIS node's own configuration by its own instance owner, so the guard is about the TARGET
   * rather than the verb.
   */
  /*
   * ⚠️ /mesh/clients joins the list, and it belongs here for the same reason the other two do: it
   * writes THIS hub's own records — which customers exist, which of this hub's staff may act on
   * them, and which customer a linked server is filed under. Nothing under it reaches another node.
   *
   * The check below still forbids writes to /mesh/nodes, and it caught the first spelling of the
   * filing route (PUT /mesh/nodes/:id/client). That was a real catch rather than a false positive:
   * a URL reading "write to a node" is one somebody later extends into writing to a node, so the
   * route was re-addressed under the resource it actually modifies.
   */
  /*
   * ⚠️ /mesh/identity is the most local write on this page: what this box calls ITSELF. It changes
   * one column on this node's own mesh_node row and reaches nothing else. A peer learns the new
   * name only because this node volunteers it on its next self-report — which the peer is free to
   * ignore, and which no hub can request.
   *
   * Worth stating the direction, since a name IS displayed on other people's dashboards: it travels
   * up, never down. Nothing above can set it. A hub renaming its customers' servers is precisely
   * the thing this guard exists to keep out, and this is the opposite of it.
   */
  /*
   * ⚠️ /mesh/links: THIS hub's own edge to a server below — the parent-side disenroll. Addressed
   * as the link rather than the node for exactly the reason the filing route was re-addressed: it
   * ends this node's copy and stops this node pulling; it changes nothing on the other server,
   * which learns only that a door is shut at its next connection.
   */
  const LOCAL = ['/mesh/pair/code', '/mesh/uplink', '/mesh/clients', '/mesh/identity', '/mesh/links'];

  /*
   * ⚠️ AND ONE THAT DELIBERATELY IS NOT LOCAL. /mesh/content asks a customer's server to accept
   * files; it is the only call from this view that leaves this node, and it belongs to the same
   * family as POST /mesh/write — the hub ASKS, and the child decides against its own grant, its own
   * disk and its own free space. It is named separately from LOCAL rather than folded into it,
   * because "this write stays here" and "this write goes to a customer" are different claims and
   * collapsing them would let a future route inherit the wrong one silently.
   */
  // '/mesh/content' (no node id) is the same act aimed at several customers at once — the route
  // re-checks visibility and role PER NODE, so a batch cannot reach a client a single send could
  // not. Listed as a prefix so both forms are covered by one entry.
  const ASKS_A_CUSTOMER = ['/mesh/content'];
  const writes = [...VIEW.matchAll(/api\.(post|put|patch|delete)\(\s*[`'"]([^`'"$]*)/g)]
    .map((m) => ({ verb: m[1], path: m[2] }));
  assert.ok(writes.length > 0, 'the Connect tab does write something');
  for (const w of writes) {
    assert.ok(LOCAL.some((p) => w.path.startsWith(p)) || ASKS_A_CUSTOMER.some((p) => w.path.startsWith(p)),
      `api.${w.verb} to "${w.path}" — a write that is neither local administration nor a request ` +
      'to a customer. It must be one or the other, deliberately.');
  }
  for (const remote of ['/mesh/nodes', '/mesh/devices', '/mesh/orgs', '/mesh/topology']) {
    for (const verb of ['post', 'put', 'patch', 'delete']) {
      assert.ok(!new RegExp(`api\\.${verb}\\(\\s*[\`'"]${remote}`).test(VIEW),
        `${verb} to ${remote} — mirrored data is read-only`);
    }
  }
});

test('⚠️ version skew is measured against the COMMON version, not this server\'s', () => {
  // A hub that has not been upgraded yet would otherwise mark its entire healthy fleet as skewed,
  // which is the fastest way to teach an operator to ignore the column.
  assert.match(VIEW, /modal/);
  assert.doesNotMatch(VIEW, /ourVersion|hubVersion/);
});

test('an edge with TLS verification off is surfaced, not hidden', () => {
  // A decision somebody made once and nobody revisits unless a screen shows it.
  assert.match(VIEW, /tlsVerify === false/);
  assert.match(VIEW, /TLS unverified/);
});

/* ===================== alerts are centralized, not mesh-only ===================== */

test('⚠️ ALERTS LIVE ON ONE SCREEN, and it is not Servers', () => {
  /*
   * A mesh-only inbox is a second place to look for one question — "what is wrong right now" — and
   * with two, the one the operator does not have open is the one holding the answer.
   */
  assert.doesNotMatch(VIEW, /Open alerts across all servers/, 'the mesh-only inbox is gone');
  assert.doesNotMatch(VIEW, /'alerts', 'Alerts'/, 'and so is its tab');
  assert.match(ACTIVITY, /Open alerts/, 'Activity carries them now');
  assert.match(ACTIVITY, /\/mesh\/alerts/, 'including the remote half');
});

test('⚠️ the SELF-SUSPICION banner renders ABOVE the alerts it explains', () => {
  /*
   * When most sites go quiet at once the likely cause is this server's own connection, not forty
   * simultaneous outages — and the reader has to see that BEFORE the rows, because by row three
   * they are already phoning a client whose screens are fine.
   */
  const banner = ACTIVITY.indexOf("Check this server's connection first");
  const rows = ACTIVITY.indexOf('${local.map(');
  assert.ok(banner > -1, 'the banner must exist');
  assert.ok(rows > -1 && banner < rows, 'and be rendered before the alert rows');
  assert.match(ACTIVITY, /suspectSelf/);
});

test('local and remote incidents appear together, and remote ones say where', () => {
  // To the person on call there is no such thing as "a remote outage": there is an outage.
  assert.match(ACTIVITY, /mesh\.local/);
  assert.match(ACTIVITY, /mesh\.alerts/);
  assert.match(ACTIVITY, /last known, that server is not reachable/,
    'a stale alert must say so — acting on one is how somebody drives to a screen that is fine');
});

test('a server with no mesh shows no error about it', () => {
  // An install that has never heard of the feature must not be told the feature failed.
  assert.match(ACTIVITY, /catch \(e\) \{ mesh = null; \}/);
});

/* ===================== the uptime report lives in Reports ===================== */

test('⚠️ THE UPTIME REPORT IS A REPORT', () => {
  // Filing it under Servers means you have to already know the feature is mesh-shaped to find it.
  assert.doesNotMatch(VIEW, /uptimePct/, 'it is not in the Servers view any more');
  assert.match(REPORTS, /renderUptimeReport/);
  assert.match(REPORTS, /uptimeReportSection/);
});

test('⚠️ COVERAGE IS RENDERED BESIDE UPTIME, THE SAME SIZE', () => {
  /*
   * "99.9% uptime, 62% coverage" is honest. "99.9%" alone, computed over the 62%, tells a customer
   * their screens were fine during a week nobody was watching them. Whichever number is smaller is
   * the one cropped out of the screenshot somebody emails.
   */
  const up = REPORTS.match(/Uptime<\/div>\s*<div style="font-size:(\d+)px/);
  const cov = REPORTS.match(/Coverage<\/div>\s*<div style="font-size:(\d+)px/);
  assert.ok(up && cov, 'both figures must be rendered');
  assert.equal(up[1], cov[1], 'and at the same size — coverage is not a footnote');
  assert.match(REPORTS, /coverageNote/);
});

test('there is no "all clients" option in the report picker', () => {
  // A report with no client name, mixing customers into one percentage, is the document that gets
  // forwarded to one of those customers.
  assert.match(REPORTS, /clientId=\$\{encodeURIComponent\(uptimeState\.clientId\)\}/);
  assert.doesNotMatch(REPORTS, /All clients/);
});

test('⚠️ the CSV is FETCHED with the auth header, not linked', () => {
  /*
   * The API is Bearer-authenticated from localStorage, so an <a href> would 401 — and it would 401
   * by REDIRECTING to login, which reads to the user as "my session expired" rather than "that link
   * cannot carry a token".
   */
  assert.match(REPORTS, /Authorization: `Bearer \$\{localStorage\.getItem\('token'\)\}`/);
  assert.match(REPORTS, /URL\.createObjectURL/);
  assert.doesNotMatch(REPORTS, /<a href="\/api\/mesh\/uptime\.csv/);
});

test('a truncated incident list says so', () => {
  // A report quietly showing 50 of 300 reads as "that was all of them".
  assert.match(REPORTS, /Showing the 50 longest of/);
  assert.match(REPORTS, /CSV contains every one/);
});

test('the uptime section renders NOTHING when there is no mesh', () => {
  // An ordinary install must not gain an empty panel about a feature it does not have.
  assert.match(REPORTS, /host\.innerHTML = ''; return;/);
});

/* ===================== remote orgs ===================== */

test('⚠️ REMOTE ORGS ENTER THE SWITCHER, and selecting one does not mint a JWT', () => {
  /*
   * The reversal of an earlier decision, and the reason it is safe: there is no local workspace row
   * to name in a token. Inventing one would put a workspace id in a JWT that resolves to nothing on
   * this server, which fails later and somewhere else as a permissions error nobody can explain.
   */
  assert.match(SWITCHER, /REMOTE_ORG_KEY/);
  assert.match(SWITCHER, /String\(wsId\)\.startsWith\('remote:'\)/);
  assert.match(SWITCHER, /localStorage\.setItem\(REMOTE_ORG_KEY/);
  assert.doesNotMatch(SWITCHER, /switchWorkspace\(`remote:/, 'never through the workspace JWT path');
});

test('leaving a remote org clears the mode BEFORE anything else', () => {
  // Otherwise the local workspace renders under the remote banner and an operator is looking at
  // their own data labelled as somebody else's.
  const fn = code(SWITCHER).slice(code(SWITCHER).indexOf('async function switchTo'));
  const cleared = fn.indexOf('clearRemoteOrg()');
  const switched = fn.indexOf('api.switchWorkspace');
  assert.ok(cleared > -1 && switched > -1, 'both paths must exist');
  assert.ok(cleared < switched, 'the mode is dropped before any workspace switch is attempted');
});

test('a remote org is visibly marked as remote', () => {
  // Acting on the wrong customer's screens because two rows looked identical is the failure this
  // one badge prevents.
  assert.match(code(SWITCHER), /w\.remote[\s\S]{0,120}badge/);
});

test('⚠️ a persistent banner names the server being viewed', () => {
  // Every screen now potentially shows another company's estate; "which server am I on" must never
  // be a question the UI leaves to memory.
  assert.match(APP, /renderRemoteOrgBanner/);
  assert.match(APP, /Viewing <strong>\$\{name\}<\/strong>/);
  assert.match(APP, /Back to this server/);

  /*
   * ⚠️ This asserted the literal words "Read-only for now", which was right while nothing could be
   * changed from here and became a lie the moment write shipped. What has to survive is that the
   * banner states what this operator may ACTUALLY do — so it must answer both ways, from the
   * customer's own announcement, and must still say read-only when nothing was granted.
   */
  assert.match(APP, /org\.writable/,
    'the banner must reflect what the customer granted, not a fixed sentence');
  assert.match(APP, /[Rr]ead-only/,
    'and must still say read-only when they have granted nothing');
});

test('the remote-orgs fetch fails silently on a server with no mesh', () => {
  assert.match(APP, /catch \(e\) \{ remoteOrgs = \[\]; \}/);
});

test('⚠️ remote screens render on a SEPARATE path from local ones', () => {
  /*
   * The local renderer assumes it can act on every row — drag to a group, assign a playlist, take a
   * screenshot. Teaching it "except sometimes" is how a control that should be absent ends up
   * merely disabled, or worse, present and wrong.
   */
  assert.match(DASHBOARD, /const remoteOrg = selectedRemoteOrg\(\);[\s\S]{0,80}if \(remoteOrg\) return loadRemoteDashboard\(remoteOrg\)/);
  assert.match(DASHBOARD, /async function loadRemoteDashboard/);
});

test('⚠️ a remote org renders THE SAME CARDS as a local one', () => {
  /*
   * The first version drew a reduced table, reasoning that the local renderer assumes it can act on
   * every row. That was a fact about the renderer, not about the need: a customer's estate should
   * look like an estate, or every remote site becomes a second-class view nobody trusts. The rows
   * come from the child's own API, in the child's own shape, through renderDeviceCard() unchanged.
   */
  const fn = DASHBOARD.slice(DASHBOARD.indexOf('async function loadRemoteDashboard'),
                             DASHBOARD.indexOf('async function loadDashboard'));
  assert.ok(fn.length > 100, 'the remote renderer must exist');
  assert.match(fn, /renderDeviceCard/, 'the same card renderer as local screens');
  assert.match(fn, /class="device-grid"/, 'in the same grid');
  /*
   * ⚠️ And it is the ORDINARY call. api.js routes it to the selected server, so this view does not
   * name the mesh at all — a view that has to would be a view somebody forgets to update, and the
   * branch they forget is the one that renders local data under a remote heading.
   */
  assert.match(fn, /await api\.get\('\/devices'\)/, 'the same call a local dashboard makes');
  const API = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');
  assert.match(API, /mesh\/read\/\$\{encodeURIComponent\(org\.nodeId\)\}/,
    'with the routing done once, in the api layer');
});

test('⚠️ the ACTIONS are removed from the DOM, not disabled', () => {
  /*
   * A disabled control still says the feature exists here and is broken; an unwired one is worse,
   * because it looks live and does nothing. Deleting them means the page reads as somebody else's
   * without a single "you cannot do that" message, and no stale listener has anything to reach.
   */
  const fn = DASHBOARD.slice(DASHBOARD.indexOf('async function loadRemoteDashboard'),
                             DASHBOARD.indexOf('async function loadDashboard'));
  assert.match(fn, /removeAttribute\('draggable'\)/);
  assert.match(fn, /\.device-card-select'\)\?\.remove\(\)/);

  /*
   * ⚠️ NAVIGATION IS NOT AN ACTION, and it stays. A card you cannot open turns a customer's estate
   * into a picture of one. Clicking through is the entire point of making remote orgs first-class.
   */
  assert.doesNotMatch(fn, /removeAttribute\('onclick'\)/,
    'opening a screen must survive — looking is not changing');

  /*
   * ⚠️ And the DOM sweep is COSMETIC, not the control. The enforcement is in api.js, which refuses
   * every non-GET while a remote org is selected — so a mutating control this sweep never knew
   * about fails loudly instead of silently writing to the wrong server.
   */
  const API = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js'), 'utf8');

  /*
   * ⚠️ The property changed shape when write landed, and the assertion had to change with it. It
   * used to be "every non-GET is refused"; now a non-GET either goes to the CUSTOMER's server or is
   * refused — and it may never quietly go to ours. Both branches are asserted, and the ordering
   * with them: refusal is the fallthrough, so a route nobody considered is refused rather than
   * routed. The behavioural proof lives in mesh-remote-routing.test.js, which runs this module
   * against a stubbed fetch; this is the source-level backstop.
   */
  assert.match(API, /verb !== 'GET'/,
    'writes must still be recognised as writes at the api layer');
  assert.match(API, /org\.writable && meshWritable\(path, verb\)[\s\S]{0,200}write: true/,
    'a write may leave for the customer only when they granted it AND the path is allowlisted');
  assert.match(API, /write: true[\s\S]{0,400}refuse:/,
    'and refusal must be the fallthrough, so an unconsidered route is refused rather than routed');
});

test('⚠️ an offline server falls back to the mirror AND SAYS SO', () => {
  /*
   * A live read fails exactly when the site's link is down — which is when somebody is looking. An
   * empty page then reads as "this customer has no screens" rather than "we cannot reach them right
   * now", and the mirror is last-known by definition, so it must never be presented as current.
   */
  const fn = DASHBOARD.slice(DASHBOARD.indexOf('async function loadRemoteDashboard'),
                             DASHBOARD.indexOf('async function loadDashboard'));
  assert.match(fn, /if \(rows === null\)/, 'the fallback is on the live read failing');
  assert.match(fn, /Showing the last state this server received/);
});

/* ===================== the read-through proxy ===================== */

test('⚠️ THE PARENT MAY ASK AND CANNOT TELL — enforced by an allowlist on the CHILD', () => {
  /*
   * I2 was "there is no downward channel", enforced by the absence of a mechanism. The parent can
   * now ASK, so what must stay true is that it cannot TELL — and "we only send reads" is a
   * convention, which holds until somebody adds one convenient endpoint.
   *
   * A blocklist would have been the natural shape and is the wrong one: it fails open for every
   * route added after it was written.
   */
  const proxy = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'mesh', 'read-proxy.js'), 'utf8');
  assert.match(proxy, /const READABLE = Object\.freeze\(\[/, 'an allowlist, not a blocklist');
  /*
   * ⚠️ And it matches by SEGMENT, which is where an allowlist usually springs a leak: a naive
   * startsWith makes `/api/devices/:id` match `/api/devices/123/block` — a write, admitted by a list
   * meant to permit reads.
   */
  assert.match(proxy, /want\.length !== got\.length/, 'segment counts must agree');
  assert.match(proxy, /v === '\.\.'/, 'and traversal tokens are refused explicitly');
  assert.match(proxy, /!== 'GET'/, 'and the method is pinned');
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(!new RegExp(`'${verb}'\\s*:`).test(proxy), `${verb} must not be routable`);
  }
});

test('every readable path names the grant it needs', () => {
  // A proxy that ignored the grant would be the way around the client's own decision about what
  // travels — two paths to the same data, one of them more generous than anybody intended.
  const proxy = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'mesh', 'read-proxy.js'), 'utf8');
  const block = proxy.slice(proxy.indexOf('const READABLE'), proxy.indexOf('function matchPath'));
  const rules = [...block.matchAll(/\{\s*pattern:\s*'([^']+)'([^}]*)\}/g)];
  assert.ok(rules.length >= 4, 'there must be readable paths');
  for (const [, pat, rest] of rules) {
    // Scale-out C2: verify-device is keyed to a WRITE grant (player-events) — still a grant, and
    // still one the answering node's operator chose; authorize() reads it from the edge row.
    assert.match(rest, /grant:|writeGrant:/, `${pat} must declare a grant`);
  }
});

test('⚠️ a view NEVER re-renders itself into document.body', () => {
  /*
   * After enrolling, this view re-rendered by looking its container up with
   * `closest('#viewContainer')` — an id that exists nowhere in the app; the real one is `#app`. The
   * lookup returned null, a `|| document.body` fallback took over, and render() replaced the ENTIRE
   * page — sidebar, banners and all — with this section. It read as a half-broken reload and only a
   * hard refresh recovered it.
   *
   * ⚠️ The fallback is the part worth guarding against, not the typo. A fallback that "works" by
   * targeting something enormous converts a wrong selector into a plausible-looking screen instead
   * of an error somebody would notice immediately.
   */
  const src = code(VIEW);
  assert.doesNotMatch(src, /render\([^)]*document\.body/, 'never render into the whole page');
  assert.doesNotMatch(src, /viewContainer/, 'and not via an id this app does not have');
  assert.match(src, /state\._container = container/, 'the container handed in is remembered');
  assert.match(src, /if \(state\._container\) render\(state\._container\)/,
    'and re-renders address it explicitly');
});

/*
 * ⚠️ THE AUTO-LOGGER MUST BE MOUNTED ABOVE THE MESH ROUTERS.
 *
 * activityLogger wraps res.json for every SUBSEQUENT route, so anything mounted above it is
 * invisible to the audit log. It already carried a comment recording that it had once been mounted
 * after the workspace routes and silently never fired — and the mesh routers were then added above
 * the corrected position and inherited the identical bug. The result: nothing mesh-related was ever
 * written to activity_log. Not granting another server the right to change your screens, not
 * revoking it, not minting a pairing code, not severing a link.
 *
 * Asserted rather than commented, because a comment saying "mount this first" is exactly what
 * failed twice. This is an ordering property of one file, so it is checked as one.
 */
test('⚠️ activityLogger is mounted BEFORE the mesh routers, or the mesh is unauditable', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const logger = src.indexOf('app.use(activityLogger)');
  assert.ok(logger > 0, 'the auto-logger must still be mounted at all');

  const meshMounts = [...src.matchAll(/app\.use\('\/api\/mesh'/g)].map((m) => m.index);
  assert.ok(meshMounts.length >= 1, 'the mesh routers must still be mounted here');
  for (const at of meshMounts) {
    assert.ok(logger < at,
      'a mesh router is mounted above activityLogger, so nothing it does will ever be logged — ' +
      'move the mount below app.use(activityLogger)');
  }
});
