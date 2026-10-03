'use strict';

/*
 * HOSTED AI IMAGE RATE CARD — what ScreenTinker pays a provider per image, by the exact
 * model + resolution + quality the user picks. lib/ai-credits.js turns each row into a customer
 * price (2× provider cost, rounded UP to the cent, 1 credit = $0.01).
 *
 * ⚠️ ADDING A MODEL IS ADDING A ROW. The debit path never names a model: it looks the user's
 * selection up here and refuses anything it cannot find. A combination that is not a row is
 * not offered and not charged — there is no "closest match" fallback, because guessing a price
 * is how a customer gets billed for something they did not choose.
 *
 * Costs are integer MICRO-dollars (1 USD = 1,000,000) so no float ever reaches the ledger.
 *
 * `request` is what is sent to the provider on top of {model, prompt, n:1}. It lives on the row
 * so a provider vocabulary change (a renamed resolution value, say) is a config edit too.
 *
 * ---------------------------------------------------------------------------------------------
 * xAI: https://docs.x.ai/developers/pricing — page last updated 2026-09-29.
 *   grok-imagine-image          $0.02 / image at 1K and 2K. Image input $0.002.
 *   grok-imagine-image-2.0      1K low $0.04, 1.5K low $0.05, 2K low $0.06,
 *                               1K medium $0.06, 1.5K medium $0.07, 2K medium $0.08. Image input $0.01.
 *   grok-imagine-image-quality  1K $0.05, 1.5K $0.06, 2K $0.07. Image input $0.01.
 * Image INPUT pricing is recorded for completeness; v1 is text-to-image only and never sends one.
 * The `resolution`/`quality` request values are xAI's lowercase forms ('1k', '2k' is already
 * what lib/image-gen.js sends successfully); '1.5k' and `quality` are UNVERIFIED against a live
 * call — if xAI rejects them the generation fails closed and no credits move.
 *
 * OpenAI: prices images per TOKEN, not per image (https://developers.openai.com/api/docs/pricing),
 * so there is no published per-image figure to put here. The provider is wired; it offers no
 * models until an operator adds a row with a cost they have verified — via AI_HOSTED_RATE_CARD
 * (JSON array, same shape) without a code change. Example row, NOT active:
 *   { provider: 'openai', model: 'gpt-image-1', resolution: '1536x1024', quality: 'low',
 *     provider_cost_usd_micros: <verified>, request: { size: '1536x1024', quality: 'low' } }
 * ---------------------------------------------------------------------------------------------
 */

const XAI_IMAGE_INPUT = { 'grok-imagine-image': 2000, 'grok-imagine-image-2.0': 10000, 'grok-imagine-image-quality': 10000 };

const xai = (model, resolution, quality, usd, request) => ({
  provider: 'xai', model, resolution, quality,
  provider_cost_usd_micros: Math.round(usd * 1e6),
  image_input_usd_micros: XAI_IMAGE_INPUT[model],
  request,
});

const RATE_CARD = [
  xai('grok-imagine-image', '1K', 'standard', 0.02, { resolution: '1k' }),
  xai('grok-imagine-image', '2K', 'standard', 0.02, { resolution: '2k' }),

  xai('grok-imagine-image-2.0', '1K', 'low', 0.04, { resolution: '1k', quality: 'low' }),
  xai('grok-imagine-image-2.0', '1.5K', 'low', 0.05, { resolution: '1.5k', quality: 'low' }),
  xai('grok-imagine-image-2.0', '2K', 'low', 0.06, { resolution: '2k', quality: 'low' }),
  xai('grok-imagine-image-2.0', '1K', 'medium', 0.06, { resolution: '1k', quality: 'medium' }),
  xai('grok-imagine-image-2.0', '1.5K', 'medium', 0.07, { resolution: '1.5k', quality: 'medium' }),
  xai('grok-imagine-image-2.0', '2K', 'medium', 0.08, { resolution: '2k', quality: 'medium' }),

  xai('grok-imagine-image-quality', '1K', 'standard', 0.05, { resolution: '1k' }),
  xai('grok-imagine-image-quality', '1.5K', 'standard', 0.06, { resolution: '1.5k' }),
  xai('grok-imagine-image-quality', '2K', 'standard', 0.07, { resolution: '2k' }),
];

/*
 * The highlighted cheap option. A PRESELECTION the user sees and can change on every
 * generation — never a server-side default: the generate route refuses a request that does not
 * name its model, resolution and quality.
 */
const HIGHLIGHT = { provider: 'xai', model: 'grok-imagine-image', resolution: '1K', quality: 'standard' };

/*
 * ⚠️ PRICES DO NOT ADJUST THEMSELVES, ON PURPOSE. A provider can change its prices at any time,
 * but the customer was shown a credit cost before they clicked, so nothing here ever re-prices
 * from a live source. Instead this records when a person last checked the rows above against the
 * provider pages; the platform-admin provider status reports the age and flags it stale after
 * STALE_AFTER_DAYS, so drift is surfaced to an operator rather than silently absorbed or silently
 * passed on. Update the date when you re-verify (and update any rows that moved).
 */
const VERIFIED_AT = '2026-09-29';
const STALE_AFTER_DAYS = 30;

/* Credit packs: face value $0.01/credit. The 2× markup is already in the image price. */
const PACKS = [
  { id: 'pack_10', credits: 1000, usd_cents: 1000 },
  { id: 'pack_25', credits: 2500, usd_cents: 2500 },
  { id: 'pack_50', credits: 5000, usd_cents: 5000 },
];

module.exports = { RATE_CARD, HIGHLIGHT, PACKS, VERIFIED_AT, STALE_AFTER_DAYS };
