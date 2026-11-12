#!/usr/bin/env node
'use strict';

/*
 * Who pays: the person (today) or the organization. Run ON THE SERVER, WITH IT STOPPED (it changes
 * triggers and a setting the running process caches).
 *
 *   node scripts/org-billing-switch.js status
 *   node scripts/org-billing-switch.js to-organizations
 *   node scripts/org-billing-switch.js to-people [--force]
 *
 * status            which side is the source of truth, and whether the two sides agree.
 * to-organizations  organizations become the paying accounts. Refused if any organization
 *                   disagrees with its owner. Every organization keeps the state it holds now; one
 *                   that was riding on a sibling's subscription keeps its plan with no Stripe ids.
 * to-people         back. Lists the organizations whose own state would be overwritten by their
 *                   owner's and stops, unless --force.
 *
 * Before to-organizations on production: run scripts/org-billing-report.js on a copy and read it.
 * The database is the one the server uses (DATA_DIR / DB_PATH, as for the server).
 */

const path = require('node:path');
process.chdir(path.join(__dirname, '..', 'server'));
const { db } = require(path.join(process.cwd(), 'db', 'database'));
const orgBilling = require(path.join(process.cwd(), 'lib', 'org-billing'));

const cmd = process.argv[2];
const force = process.argv.includes('--force');

if (cmd === 'status') {
  const d = orgBilling.drift(db);
  const follows = db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE billing_follows_org IS NOT NULL').get().n;
  console.log(`source of truth: ${orgBilling.source(db) === 'org' ? 'ORGANIZATIONS' : 'people'}`);
  if (orgBilling.source(db) !== 'org') {
    console.log(`organizations that disagree with their owner: ${new Set(d.map((x) => x.organization_id)).size}`);
    console.log(`organizations riding on a sibling's subscription: ${follows}`);
    console.log(`people paying who own no organization (block the switch): ${orgBilling.strandedPayers(db).length}`);
  }
} else if (cmd === 'to-organizations') {
  const r = orgBilling.switchToOrganizations(db);
  if (!r.ok) {
    if (r.drift.length) { console.error('refused: organizations disagree with their owners'); console.error(JSON.stringify(r.drift.slice(0, 20), null, 2)); }
    if (r.stranded && r.stranded.length) {
      console.error(`refused: ${r.stranded.length} person(s) pay for a subscription but own no organization; move or cancel each first:`);
      for (const x of r.stranded) console.error(`  ${x.user_id} ${x.email || ''} ${x.stripe_subscription_id}`);
    }
    process.exit(1);
  }
  console.log(r.already ? 'already organizations' : 'organizations are now the paying accounts');
} else if (cmd === 'to-people') {
  const r = orgBilling.switchToPeople(db, { force });
  if (!r.ok) { console.error(`refused: ${r.would_overwrite.length} organization(s) hold state their owner does not; rerun with --force to overwrite them:`); for (const id of r.would_overwrite) console.error('  ' + id); process.exit(1); }
  console.log(r.already ? 'already people' : `people are the paying accounts again${r.overwritten && r.overwritten.length ? ` (${r.overwritten.length} organization(s) overwritten)` : ''}`);
} else {
  console.error('usage: node scripts/org-billing-switch.js status | to-organizations | to-people [--force]');
  process.exit(2);
}
