'use strict';

/*
 * The receipt a customer gets when a payment succeeds.
 *
 * ⚠️ SEPARATE FROM routes/stripe.js ON PURPOSE. A webhook handler has one job it must not fail at:
 * answer Stripe quickly and with a 2xx. Composing and sending mail is neither quick nor reliable —
 * it talks to Graph or SMTP over the network — so the rule here is that nothing in this file can
 * make the webhook slow, throw, or return anything but 200. sendEmail already returns a result
 * rather than throwing; this adds the same discipline to everything around it.
 */

const { db } = require('../db/database');
const emailService = require('./email');

/** Stripe amounts are in the currency's minor unit — cents, pence, yen (which has none). */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

function formatAmount(minor, currency) {
  const cur = String(currency || 'usd').toLowerCase();
  const amount = ZERO_DECIMAL.has(cur) ? minor : minor / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(amount);
  } catch (e) {
    // An unknown or malformed currency code must not lose the customer their receipt.
    return `${amount} ${cur.toUpperCase()}`;
  }
}

/**
 * Claim the right to send exactly one receipt for this invoice.
 *
 * ⚠️ THE CLAIM IS THE INSERT, and it happens BEFORE the send. Stripe retries a webhook until it
 * gets a 2xx and can deliver the same event more than once regardless, so "check then send then
 * record" leaves a window where two deliveries both pass the check. INSERT OR IGNORE is atomic:
 * whoever creates the row owns the send, and everyone else is told no.
 *
 * The cost of that ordering is that a send which fails after the claim is not retried — the
 * customer gets no receipt rather than two. That is the right way round for money mail, and the
 * failure is logged where the alternative is silent.
 */
function claimReceipt({ invoiceId, userId, amount, currency }) {
  try {
    const info = db.prepare(
      'INSERT OR IGNORE INTO billing_receipts (invoice_id, user_id, amount, currency, sent_at) VALUES (?, ?, ?, ?, strftime(\'%s\',\'now\'))'
    ).run(invoiceId, userId || null, amount == null ? null : amount, currency || null);
    return info.changes === 1;
  } catch (e) {
    /*
     * The table is missing or the write failed. Refusing to claim means no email — deliberately.
     * The alternative is emailing without a record of having done so, which on a retry is a second
     * receipt for the same payment.
     */
    console.error('[billing] could not claim receipt for', invoiceId, '-', e.message);
    return false;
  }
}

function receiptText({ name, amountLabel, planName, periodEnd, invoiceUrl }) {
  const lines = [
    `Hi${name ? ' ' + name : ''},`,
    '',
    `Your payment of ${amountLabel} went through — thank you.`,
    '',
    planName ? `Plan: ${planName}` : null,
    periodEnd ? `Your next renewal is ${periodEnd}.` : null,
    invoiceUrl ? `Invoice: ${invoiceUrl}` : null,
    '',
    'Your screens carry on as they are — nothing needs doing.',
    '',
    'ScreenTinker',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function receiptHtml({ name, amountLabel, planName, periodEnd, invoiceUrl }) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  /*
   * ⚠️ Everything interpolated here is escaped, including values that came from Stripe. They are
   * not operator input, but they are not ours either, and a plan name is a string somebody typed
   * into a dashboard.
   */
  const row = (k, v) => (v
    ? `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`
    : '');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#222">
  <p>Hi${name ? ' ' + esc(name) : ''},</p>
  <p>Your payment of <strong>${esc(amountLabel)}</strong> went through — thank you.</p>
  <table style="border-collapse:collapse;margin:16px 0">
    ${row('Plan', planName)}
    ${row('Next renewal', periodEnd)}
  </table>
  ${invoiceUrl ? `<p><a href="${esc(invoiceUrl)}" style="color:#3b82f6">View your invoice</a></p>` : ''}
  <p style="color:#666">Your screens carry on as they are — nothing needs doing.</p>
  <p style="color:#666">ScreenTinker</p>
</div>`;
}

/**
 * Send the receipt for a paid invoice, at most once ever.
 *
 * Returns a result rather than throwing, so a webhook can await it without a try/catch and still be
 * guaranteed to reach its res.json.
 */
async function sendPaymentReceipt(invoice, deps = {}) {
  /*
   * ⚠️ RESOLVED PER CALL, not destructured at module load. A receipt is money mail whose whole
   * contract is "exactly once", and the tests that prove that have to be able to count sends
   * without one going out. Capturing `sendEmail` at import made it unstubbable — the module held
   * the original reference, so a test could replace the export and still hit the real transport.
   */
  const send = deps.sendEmail || emailService.sendEmail;
  try {
    const invoiceId = invoice && invoice.id;
    if (!invoiceId) return { sent: false, reason: 'no_invoice_id' };

    const amount = invoice.amount_paid;
    /*
     * ⚠️ A ZERO-AMOUNT INVOICE IS NOT A PAYMENT. Stripe raises them for trials, full-coupon periods
     * and proration credits, and they fire payment_succeeded like any other. "You paid $0.00, thank
     * you" is a support ticket, not a receipt.
     */
    if (!(amount > 0)) return { sent: false, reason: 'zero_amount' };

    // Who paid. The subscription is the reliable link; the customer id is the fallback for an
    // invoice raised outside a subscription.
    const subId = invoice.subscription || null;
    const custId = invoice.customer || null;
    const user = (subId && db.prepare('SELECT id, email, name, plan_id FROM users WHERE stripe_subscription_id = ?').get(subId))
      || (custId && db.prepare('SELECT id, email, name, plan_id FROM users WHERE stripe_customer_id = ?').get(custId))
      || null;

    /*
     * ⚠️ NO GUESSING AT THE RECIPIENT. Stripe puts an address on the invoice, but sending a receipt
     * for THIS instance's plan to an address we cannot tie to an account is how a receipt reaches
     * the wrong person after a customer record is merged or deleted. If we cannot identify the
     * user, the payment is still recorded by the other handlers; only the mail is skipped.
     */
    if (!user || !user.email) return { sent: false, reason: 'no_user' };

    if (!claimReceipt({ invoiceId, userId: user.id, amount, currency: invoice.currency })) {
      return { sent: false, reason: 'already_sent' };
    }

    const plan = user.plan_id
      ? db.prepare('SELECT name FROM plans WHERE id = ?').get(user.plan_id)
      : null;
    const periodEnd = invoice.lines?.data?.[0]?.period?.end || null;

    const fields = {
      name: user.name || '',
      amountLabel: formatAmount(amount, invoice.currency),
      planName: plan?.name || user.plan_id || '',
      periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : '',
      invoiceUrl: invoice.hosted_invoice_url || '',
    };

    const res = await send({
      to: user.email,
      rawSubject: true,
      subject: `Payment received — ${fields.amountLabel}`,
      text: receiptText(fields),
      html: receiptHtml(fields),
    });
    if (!res.sent) console.warn('[billing] receipt not delivered for', invoiceId, '-', res.reason);
    return { sent: !!res.sent, reason: res.reason, userId: user.id };
  } catch (e) {
    // A webhook must answer 200 whatever happens in here.
    console.error('[billing] receipt failed:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendPaymentReceipt, claimReceipt, formatAmount, receiptText, receiptHtml };
