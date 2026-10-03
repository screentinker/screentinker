'use strict';

/*
 * Reading the two Stripe fields that MOVED, without caring which API version delivered the object.
 *
 * ⚠️ WHY THIS FILE EXISTS. Stripe relocated both of these in its 2025-03 API, and the old
 * expressions did not start throwing — they started evaluating to `undefined`, which the calling
 * code stored as NULL or treated as "no subscription". Two live faults on this instance came from
 * exactly that:
 *
 *   - `sub.current_period_end` → undefined, so every paid subscriber had no renewal date at all.
 *   - `invoice.subscription`   → undefined, so `invoice.payment_failed` could not find the
 *                                subscriber and did nothing whatsoever, and the receipt path was
 *                                surviving only on its customer-id fallback.
 *
 * Verified against the live account: every subscription reports `current_period_end` undefined at
 * the top level with the value on its item, and every invoice reports `subscription` undefined
 * with the value at `parent.subscription_details.subscription`.
 *
 * Both shapes are read, old first, because the webhook endpoint can be pinned to an older API
 * version than the SDK's own default — this instance has exactly that mismatch — so a payload may
 * legitimately arrive in either form. Anything unreadable returns null rather than undefined, so a
 * caller writing it to the database stores an honest "unknown" instead of a silent nothing.
 */

/** When the current period ends, as a unix timestamp, or null. */
function periodEndOf(subscription) {
  if (!subscription) return null;
  return subscription.current_period_end
      ?? subscription.items?.data?.[0]?.current_period_end
      ?? null;
}

/** The subscription id an invoice belongs to, or null for a one-off invoice. */
function subscriptionIdOf(invoice) {
  if (!invoice) return null;
  const v = invoice.subscription
         ?? invoice.parent?.subscription_details?.subscription
         ?? invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription
         ?? null;
  // Stripe expands some references into objects; take the id either way.
  return v && typeof v === 'object' ? (v.id ?? null) : v;
}

/**
 * The price an invoice line is billing, or null.
 *
 * ⚠️ The FOURTH field of this kind. `line.price` is undefined on this account today; the value is
 * at `line.pricing.price_details.price`. Verified live. Old shape first, same as the others,
 * because the webhook endpoint may be pinned to an earlier API version than the SDK.
 */
function invoicePriceIdOf(invoice) {
  const line = invoice?.lines?.data?.[0];
  if (!line) return null;
  const v = line.price?.id ?? line.price ?? line.pricing?.price_details?.price ?? null;
  return v && typeof v === 'object' ? (v.id ?? null) : v;
}

module.exports = { periodEndOf, subscriptionIdOf, invoicePriceIdOf };
