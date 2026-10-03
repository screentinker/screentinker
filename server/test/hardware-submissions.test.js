'use strict';

/* Community hardware reports: the public submit-and-approve flow behind the Certified Hardware page.
 *
 * ⚠️ ONE PROPERTY MATTERS MORE THAN THE REST. Reseller agreements define Certified Hardware as the
 * models published on that page, and support obligations attach to them. So the failure this file
 * exists to prevent is a stranger's form post appearing as certified — or as anything a reader
 * could mistake for it. A form that hides the field proves nothing, because anyone can post to the
 * endpoint directly, so the tests below post the forbidden values on purpose.
 *
 * The rest is the ordinary care a public unauthenticated endpoint needs: single-use links that
 * expire, and refusing the things a spam bot sends.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const subs = require('../lib/hardware-submissions');

/** A throwaway database with just the table under test, so this never touches a real data dir. */
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwsub-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`CREATE TABLE hardware_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, name TEXT NOT NULL, manufacturer TEXT,
    model_numbers TEXT, category TEXT NOT NULL, os TEXT, player TEXT, max_resolution TEXT,
    player_version TEXT, notes TEXT, submitter_name TEXT, submitter_email TEXT, submitted_ip TEXT,
    submitted_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decision_token_hash TEXT,
    decision_token_expires INTEGER, decided_at INTEGER, decided_by TEXT)`);
  return db;
}

const VALID = { name: 'Acme Signage Box 9000', category: 'media-player' };

test('⚠️ a submission cannot become Certified Hardware, however it is posted', () => {
  const db = freshDb();
  const { token } = subs.create(db, {
    ...VALID,
    // Everything a determined poster would try. None of it is read.
    status: 'certified',
    validated_by: 'ScreenTinker',
    validated_on: '2020-01-01',
    min_version: '1.0.0',
    provisioning_url: 'https://example.com/evil',
  }, '203.0.113.1');
  const stored = db.prepare('SELECT * FROM hardware_submissions').get();
  assert.equal(stored.status, 'pending', 'it starts pending regardless of what was posted');

  subs.decide(db, token, 'approved');
  const [published] = subs.publishedDevices(db);
  assert.equal(published.status, 'community-reported', 'and publishes as a community report');
  assert.equal(published.validated_by, 'Community');
  assert.equal(published.validated_on, null);
  assert.equal(published.min_version, null, 'a stranger does not get to set a supported-version floor');
  assert.equal(published.provisioning_url, null, 'nor point our page at their URL');
});

test('a published report says on its own entry that it is not tested by ScreenTinker', () => {
  const db = freshDb();
  const { token } = subs.create(db, { ...VALID, submitter_name: 'Jo', notes: 'Works fine.' }, null);
  subs.decide(db, token, 'approved');
  const [published] = subs.publishedDevices(db);
  // The group heading says it too, but a deep link lands on the card, not the heading.
  assert.ok(published.notes.some((n) => /not tested by ScreenTinker/i.test(n)),
    'the disclaimer travels with the card, because deep links skip the heading');
  assert.ok(published.notes.includes('Works fine.'), 'and the submitter\'s own note survives');
});

test('an approval link works exactly once and does not resurrect', () => {
  const db = freshDb();
  const { token } = subs.create(db, VALID, null);
  assert.ok(subs.decide(db, token, 'approved'), 'first use works');
  assert.equal(subs.decide(db, token, 'approved'), null, 'second use is refused');
  // The dangerous replay: a forwarded email flipping a rejected entry back to published.
  const second = subs.create(db, { ...VALID, name: 'Another Box' }, null);
  subs.decide(db, second.token, 'rejected');
  assert.equal(subs.decide(db, second.token, 'approved'), null, 'a spent reject link cannot approve');
  assert.equal(subs.publishedDevices(db).length, 1, 'only the approved one is published');
});

test('an expired link is refused and changes nothing', () => {
  const db = freshDb();
  const { token } = subs.create(db, VALID, null);
  db.prepare('UPDATE hardware_submissions SET decision_token_expires = ?')
    .run(Math.floor(Date.now() / 1000) - 1);
  assert.equal(subs.decide(db, token, 'approved'), null);
  assert.equal(db.prepare('SELECT status FROM hardware_submissions').get().status, 'pending');
});

test('a wrong or absent token never matches anything', () => {
  const db = freshDb();
  subs.create(db, VALID, null);
  for (const bad of [null, undefined, '', 'x', 'f'.repeat(64), 12345, {}]) {
    assert.equal(subs.decide(db, bad, 'approved'), null, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.equal(db.prepare('SELECT status FROM hardware_submissions').get().status, 'pending');
});

test('the spam controls a public form needs', () => {
  const db = freshDb();
  // Honeypot: hidden from people, filled in by bots.
  assert.throws(() => subs.create(db, { ...VALID, website: 'http://spam.example' }, null),
    /rejected/i, 'honeypot');
  // The page ranks, so link spam in free text is the obvious attack.
  for (const notes of ['visit https://spam.example', 'see www.spam.example', 'buy at spam.top now']) {
    assert.throws(() => subs.create(db, { ...VALID, notes }, null), /links/i, `link in notes: ${notes}`);
  }
  assert.throws(() => subs.create(db, { name: '', category: 'media-player' }, null), /name is required/i);
  assert.throws(() => subs.create(db, { ...VALID, category: 'supercomputer' }, null), /category/i);
  assert.throws(() => subs.create(db, { ...VALID, submitter_email: 'not-an-email' }, null), /email/i);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM hardware_submissions').get().c, 0,
    'nothing rejected was stored');
});

test('oversized fields are cut rather than stored whole', () => {
  const db = freshDb();
  subs.create(db, { ...VALID, name: 'A'.repeat(500), notes: 'B'.repeat(5000) }, null);
  const row = db.prepare('SELECT * FROM hardware_submissions').get();
  assert.equal(row.name.length, subs.LIMITS.name);
  assert.equal(row.notes.length, subs.LIMITS.notes);
});

test('anchors stay unique, because deep links go into reseller quotes', () => {
  const db = freshDb();
  for (let i = 0; i < 3; i += 1) {
    const { token } = subs.create(db, VALID, null);
    subs.decide(db, token, 'approved');
  }
  const ids = subs.publishedDevices(db).map((d) => d.id);
  assert.equal(new Set(ids).size, 3, `three same-named reports produced ${ids.join(', ')}`);
  for (const id of ids) assert.match(id, /^community-[a-z0-9-]+$/);
});

test('only approved reports reach the page', () => {
  const db = freshDb();
  const pending = subs.create(db, { ...VALID, name: 'Pending Box' }, null);
  const rejected = subs.create(db, { ...VALID, name: 'Rejected Box' }, null);
  const approved = subs.create(db, { ...VALID, name: 'Approved Box' }, null);
  subs.decide(db, rejected.token, 'rejected');
  subs.decide(db, approved.token, 'approved');
  assert.ok(pending.token, 'the pending one was never decided');
  const names = subs.publishedDevices(db).map((d) => d.name);
  assert.deepEqual(names, ['Approved Box']);
});

test('the page renderer accepts a community device without special-casing', () => {
  // The community half and the committed half go through ONE renderer, so a submitted entry cannot
  // end up looking different from an entry that carries contract weight.
  const { render, loadData } = require('../lib/certified-hardware');
  const db = freshDb();
  const { token } = subs.create(db, { ...VALID, submitter_name: 'Jo' }, null);
  subs.decide(db, token, 'approved');
  const data = loadData();
  const html = render({ ...data, devices: [...data.devices, ...subs.publishedDevices(db)] });
  assert.ok(html.includes('id="community-acme-signage-box-9000"'), 'it renders as a card with an anchor');
  assert.ok(html.includes('Acme Signage Box 9000'));
  // And it lands under the heading that states the absence of any support commitment.
  const community = html.indexOf('Community reported');
  const notSupported = html.indexOf('>Not supported');
  const card = html.indexOf('id="community-acme-signage-box-9000"');
  assert.ok(community < card && card < notSupported, 'it is inside the community section');
});

test('the submit form posts where the server listens, and offers no status field', () => {
  const form = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'certified-hardware-submit.html'), 'utf8');
  assert.match(form, /action="\/api\/hardware-submissions"/);
  assert.match(form, /method="post"/i);
  assert.doesNotMatch(form, /name="status"/, 'the form must not even suggest a status is choosable');
  assert.doesNotMatch(form, /name="validated_by"/);
  assert.match(form, /name="website"/, 'the honeypot field is present');
  // Whitespace-tolerant: the sentence wraps in the source, and pinning the wrap would make this
  // fail on a reflow rather than on the wording actually changing.
  assert.match(form, /no\s+support\s+commitment/i, 'the form says what a report is and is not');
  // The page must work with scripting off; a form post does, a fetch() handler does not.
  const body = form.slice(form.indexOf('<body'));
  assert.equal((body.match(/<script\b/g) || []).length, 0, 'no JavaScript on the submit page');
});
