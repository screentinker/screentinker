'use strict';

/*
 * The receipt email for a successful Stripe payment.
 *
 * ⚠️ THE WORD THAT MATTERS IN THE REQUIREMENT IS "ONCE". Stripe retries a webhook until it gets a
 * 2xx and can deliver the same event more than once regardless — so a send sitting directly in the
 * handler mails a paying customer a fresh receipt on every delivery. Nothing in routes/stripe.js
 * dedups today; the other handlers survive it only because they are UPDATEs to a target state,
 * which a repeat harmlessly reapplies. An email is not like that.
 *
 * These tests are mostly about the ways this can send the WRONG number of emails, or the right
 * number to the wrong person.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-receipt-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { db } = require('../db/database');
const email = require('../services/email');
const { sendPaymentReceipt, formatAmount, claimReceipt } = require('../services/billingEmails');

/*
 * Capture sends instead of making them, by INJECTION rather than monkey-patching.
 * ⚠️ The first version replaced `email.sendEmail` and the tests all failed while the code was
 * correct: billingEmails had destructured it at import, so it still held the original reference.
 * A test that cannot observe the thing it is asserting about is worse than no test.
 */
let sent = [];
let sendResult = { sent: true };
function stubEmail(result = { sent: true }) { sent = []; sendResult = result; }
const deps = { sendEmail: async (msg) => { sent.push(msg); return sendResult; } };
function restoreEmail() { /* nothing to restore: nothing was patched */ }

let n = 0;
function makeUser(over = {}) {
  const id = 'u' + (++n);
  db.prepare(`INSERT INTO users (id, email, password_hash, name, role, created_at)
              VALUES (?, ?, 'x', ?, 'user', strftime('%s','now'))`)
    .run(id, over.email || `${id}@example.com`, over.name || 'Pat');
  db.prepare('UPDATE users SET stripe_subscription_id = ?, stripe_customer_id = ?, plan_id = ? WHERE id = ?')
    .run(over.sub || `sub_${id}`, over.cust || `cus_${id}`, over.plan || 'starter', id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
const invoice = (over = {}) => ({
  id: over.id || 'in_' + crypto.randomBytes(4).toString('hex'),
  amount_paid: over.amount_paid === undefined ? 2900 : over.amount_paid,
  currency: over.currency || 'usd',
  subscription: over.subscription,
  customer: over.customer,
  hosted_invoice_url: over.url,
  lines: over.periodEnd ? { data: [{ period: { end: over.periodEnd } }] } : undefined,
});

/* ============ sending exactly once ============ */

test('a successful payment sends one receipt to the paying user', async () => {
  stubEmail();
  const u = makeUser({ email: 'payer@example.com', name: 'Sam' });
  const r = await sendPaymentReceipt(invoice({ subscription: u.stripe_subscription_id, amount_paid: 2900 }), deps);
  restoreEmail();
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'payer@example.com');
  assert.match(sent[0].subject, /\$29\.00/);
  assert.match(sent[0].text, /Sam/);
});

test('⚠️ a REDELIVERED webhook does not send a second receipt', async () => {
  /*
   * The defect this whole design exists to prevent. Stripe retries until it gets a 2xx, so the same
   * invoice arrives again routinely — not as an edge case.
   */
  stubEmail();
  const u = makeUser();
  const inv = invoice({ subscription: u.stripe_subscription_id });
  const first = await sendPaymentReceipt(inv, deps);
  const second = await sendPaymentReceipt(inv, deps);
  const third = await sendPaymentReceipt({ ...inv }, deps);   // a fresh object, same invoice id
  restoreEmail();
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already_sent');
  assert.equal(third.reason, 'already_sent');
  assert.equal(sent.length, 1, 'exactly one email for one invoice');
});

test('⚠️ the claim is taken BEFORE the send, so a slow send cannot be double-claimed', async () => {
  /*
   * "check, then send, then record" leaves a window where two deliveries both pass the check. The
   * INSERT is the claim, and it is atomic. Simulated by claiming while a send is still in flight.
   */
  let release;
  const gate = new Promise((r) => { release = r; });
  sent = [];
  const slowDeps = { sendEmail: async (msg) => { sent.push(msg); await gate; return { sent: true }; } };
  const u = makeUser();
  const inv = invoice({ subscription: u.stripe_subscription_id });
  const inFlight = sendPaymentReceipt(inv, slowDeps);
  const duringFlight = await sendPaymentReceipt(inv, slowDeps);   // arrives while the first is still sending
  release();
  await inFlight;
  restoreEmail();
  assert.equal(duringFlight.reason, 'already_sent', 'the second delivery must be refused mid-send');
  assert.equal(sent.length, 1);
});

test('different invoices for the same user each get a receipt', async () => {
  // Renewals are the normal case; deduping on the user would silence every month after the first.
  stubEmail();
  const u = makeUser();
  await sendPaymentReceipt(invoice({ subscription: u.stripe_subscription_id }), deps);
  await sendPaymentReceipt(invoice({ subscription: u.stripe_subscription_id }), deps);
  restoreEmail();
  assert.equal(sent.length, 2);
});

/* ============ when NOT to send ============ */

test('⚠️ a zero-amount invoice is not a payment', async () => {
  // Stripe raises these for trials, full-coupon periods and proration credits, and they fire
  // payment_succeeded like any other. "You paid $0.00, thank you" is a support ticket.
  stubEmail();
  const u = makeUser();
  const r = await sendPaymentReceipt(invoice({ subscription: u.stripe_subscription_id, amount_paid: 0 }), deps);
  restoreEmail();
  assert.equal(r.reason, 'zero_amount');
  assert.equal(sent.length, 0);
});

test('⚠️ an invoice we cannot tie to an account sends nothing', async () => {
  /*
   * Stripe puts an address on the invoice and it is tempting to use it. Sending this instance's
   * receipt to an address we cannot tie to a user is how a receipt reaches the wrong person after a
   * customer record is merged or deleted.
   */
  stubEmail();
  const r = await sendPaymentReceipt(invoice({ subscription: 'sub_nobody', customer: 'cus_nobody' }), deps);
  restoreEmail();
  assert.equal(r.reason, 'no_user');
  assert.equal(sent.length, 0);
});

test('the customer id is the fallback link when there is no subscription', async () => {
  stubEmail();
  const u = makeUser();
  const r = await sendPaymentReceipt(invoice({ customer: u.stripe_customer_id, subscription: null }), deps);
  restoreEmail();
  assert.equal(r.sent, true);
  assert.equal(sent[0].to, u.email);
});

test('a malformed invoice never throws — a webhook must still answer 200', async () => {
  stubEmail();
  for (const bad of [undefined, null, {}, { id: null }, { id: 'in_x' }]) {
    const r = await sendPaymentReceipt(bad, deps);
    assert.equal(typeof r.sent, 'boolean', `threw or returned junk for ${JSON.stringify(bad)}`);
  }
  restoreEmail();
  assert.equal(sent.length, 0);
});

test('an email transport failure is reported, not thrown', async () => {
  stubEmail({ sent: false, reason: 'smtp_error' });
  const u = makeUser();
  const r = await sendPaymentReceipt(invoice({ subscription: u.stripe_subscription_id }), deps);
  restoreEmail();
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'smtp_error');
});

/* ============ the money ============ */

test('⚠️ amounts are minor units, and not every currency has cents', async () => {
  /*
   * Stripe sends 2900 for $29.00. Printing it raw is a receipt for twenty-nine hundred dollars.
   * And yen has no minor unit at all: 2900 JPY is 2900 yen, not 29.
   */
  assert.equal(formatAmount(2900, 'usd'), '$29.00');
  assert.equal(formatAmount(2900, 'gbp'), '£29.00');
  assert.equal(formatAmount(2900, 'jpy'), '¥2,900');
  assert.equal(formatAmount(99, 'usd'), '$0.99');
});

test('an unknown currency still produces a readable amount', () => {
  // A receipt that throws on an odd currency code is worse than one that reads plainly.
  assert.doesNotThrow(() => formatAmount(1234, 'zzz'));
  assert.match(formatAmount(1234, 'zzz'), /12\.34|ZZZ/);
});

test('⚠️ values from Stripe are escaped into the HTML', async () => {
  // A plan name is a string somebody typed into a dashboard. Not operator input, but not ours.
  stubEmail();
  const u = makeUser({ name: '<img src=x onerror=alert(1)>' });
  await sendPaymentReceipt(invoice({ subscription: u.stripe_subscription_id, url: 'https://x/"><script>' }), deps);
  restoreEmail();
  assert.ok(!sent[0].html.includes('<img src=x'), 'markup breakout through the name');
  assert.ok(!sent[0].html.includes('"><script>'), 'markup breakout through the invoice url');
  assert.ok(sent[0].html.includes('&lt;img'), 'the value survives as escaped text');
});

test('claimReceipt is the gate, and it refuses rather than guessing', () => {
  const id = 'in_claim_' + crypto.randomBytes(3).toString('hex');
  assert.equal(claimReceipt({ invoiceId: id, userId: 'u', amount: 1, currency: 'usd' }), true);
  assert.equal(claimReceipt({ invoiceId: id, userId: 'u', amount: 1, currency: 'usd' }), false);
});

/* ============ the webhook must acknowledge before it sends ============ */

test('⚠️ the receipt is sent AFTER the 200, not before it', () => {
  /*
   * services/email.js has no timeout on either transport, so awaiting the send inside the handler
   * means a hung Graph or SMTP connection holds the webhook open until Stripe gives up — and enough
   * of those pile up as open requests. Stripe's own guidance is to acknowledge quickly and do the
   * work afterwards.
   *
   * Deferring is only safe because the send is idempotent: the retry Stripe issues after a timeout
   * is refused by the invoice claim rather than by timing.
   */
  const src = require('fs').readFileSync(require.resolve('../routes/stripe.js'), 'utf8');
  const ack = src.indexOf('res.json({ received: true })');
  const dispatch = src.indexOf('sendPaymentReceipt(pendingReceipt)');
  assert.ok(ack > 0 && dispatch > 0, 'both the acknowledgement and the dispatch must be present');
  assert.ok(dispatch > ack, 'the send must come after the response');
  assert.ok(!/await sendPaymentReceipt/.test(src), 'the request must not await the send');
});

test('the handler subscribes to invoice.payment_succeeded, not checkout only', () => {
  /*
   * checkout.session.completed fires once, for the first payment through the hosted page. Every
   * renewal, and every payment made from the billing portal or after a card is fixed, is an
   * invoice — so a receipt hung off checkout would arrive for month one and never again.
   */
  const src = require('fs').readFileSync(require.resolve('../routes/stripe.js'), 'utf8');
  assert.match(src, /case 'invoice\.payment_succeeded':/);
});

test('the dedup table is a migration, so an existing install gets it on upgrade', () => {
  const DB = require('fs').readFileSync(require.resolve('../db/database.js'), 'utf8');
  assert.match(DB, /CREATE TABLE IF NOT EXISTS billing_receipts/);
  assert.match(DB, /invoice_id\s+TEXT PRIMARY KEY/, 'the invoice id must be the key that enforces once');
});
