# AI credits — ScreenTinker-hosted images

The slide editor can generate images in two ways. **You pick the path and the model every
time.**

| Path | Who pays the provider | Uses credits? |
|---|---|---|
| **My endpoint** (bring your own: OpenAI key, Ollama, sd.cpp — see [local-ai-setup.md](local-ai-setup.md)) | You, directly | **Never** |
| **ScreenTinker credits** (platform keys run by the operator) | ScreenTinker | Yes |

BYO is unchanged. It never touches platform keys and never spends credits.

## Pricing: you pay 2× the model you chose

- **1 credit = $0.01.**
- An image costs **2× the provider's price** for the exact model, resolution and quality you
  selected, **rounded up to the nearest cent**.
- The picker shows every row's cost before you generate, and you confirm it before anything is spent.
- A combination that is not on the rate card is refused. It is never priced by guesswork.

Rate card (xAI, from <https://docs.x.ai/developers/pricing>, page last updated 2026-09-29):

| Model | Tier | Provider cost | Credits | You pay |
|---|---|---|---|---|
| `grok-imagine-image` | 1K / 2K | $0.02 | 4 | $0.04 |
| `grok-imagine-image-2.0` | 1K low | $0.04 | 8 | $0.08 |
| `grok-imagine-image-2.0` | 1.5K low | $0.05 | 10 | $0.10 |
| `grok-imagine-image-2.0` | 2K low | $0.06 | 12 | $0.12 |
| `grok-imagine-image-2.0` | 1K medium | $0.06 | 12 | $0.12 |
| `grok-imagine-image-2.0` | 1.5K medium | $0.07 | 14 | $0.14 |
| `grok-imagine-image-2.0` | 2K medium | $0.08 | 16 | $0.16 |
| `grok-imagine-image-quality` | 1K | $0.05 | 10 | $0.10 |
| `grok-imagine-image-quality` | 1.5K | $0.06 | 12 | $0.12 |
| `grok-imagine-image-quality` | 2K | $0.07 | 14 | $0.14 |

`grok-imagine-image` at 1K is preselected the first time, as the cheap option. After that the
picker remembers your last choice for that workspace, in your browser only.

**OpenAI** charges for images per token, so it publishes no per-image price. Its hook is wired,
but it offers no models until an operator adds a row with a cost they have verified.

**Anthropic** is text-only, so Claude is never offered as an image model. `ANTHROPIC_API_KEY`
is reserved for an optional copy/layout step, and credits are charged only for image calls.

## Included credits: 10% of your screen bill

Each month your organization gets credits worth **10% of that month's screen bill**. The bill
comes from the normal Active Screen-Day formula ([billing.md](billing.md)), which this feature
only reads. The amount is converted at $0.01 per credit and rounded down.

> Example: a $150 screen bill → $15 included → **1,500 credits**. That is 375 images on
> `grok-imagine-image`, or 187 on Imagine 2.0 1K low.

- The cap is 10% of the bill. It is not a 10% markup, and the 2× markup on whatever model you
  pick still applies.
- The grant follows the month-to-date bill. It tops up as the estimate rises and is never taken
  back when it falls. On the 1st, before any day of the month has finished, it uses last month's
  final bill.
- 0 billable screens means 0 included credits. You can still buy credits.
- Included credits are spent first, **expire at month end** and do not roll over.

## Buying credits

Organization owners and admins can buy packs in **Settings → AI credits** or from the
"not enough credits" prompt:

| Pack | Credits | Price |
|---|---|---|
| $10 | 1,000 | $10.00 |
| $25 | 2,500 | $25.00 |
| $50 | 5,000 | $50.00 |

Packs are at face value. The 2× markup is already in the image price. **Purchased credits never
expire.** Payment goes through Stripe Checkout, and credits are granted only by the signed
`checkout.session.completed` webhook once Stripe reports the session `paid`. A webhook that
Stripe delivers twice still grants the pack once. On a server without Stripe, the panel says
"contact your administrator", and a platform admin can grant credits with
`POST /api/ai/hosted/admin/grant {org_id, credits, note}`.

When your balance is below the price of the model you picked, that generation is refused and you
get a "buy credits" prompt. Cheaper models you can still afford keep working.

## Guarantees

- **No charge for a failure.** Credits are reserved before the provider is called, then committed
  on success or refunded in full on any error. If the server crashes mid-attempt, the reservation
  is refunded by a sweep after 15 minutes.
- **No double charge.** Each click carries an idempotency key. A retry replays the first result.
- **Never negative.** The balance check and the reservation happen in one transaction.
- **Append-only ledger** (`ai_credit_ledger`). No row is ever edited, and the balance is the sum of
  the rows. The ledger stores no prompts. The activity log records who generated what, with
  model, tier and credits, but not the prompt.
- Output is an ordinary content-library image, so decks and playlists use it like any upload.

## Operator setup

Keys live **only** in the server environment. They are never stored in SQLite, never returned to
the browser, and never written to logs or the activity log. A provider appears only when its key
is set:

```bash
XAI_API_KEY=...                 # xAI Grok Imagine — base https://api.x.ai/v1
OPENAI_API_KEY=...              # OpenAI Images — offers models only once priced rows exist
AI_HOSTED_COMPAT_BASE_URL=...   # optional OpenAI-compatible image provider
AI_HOSTED_COMPAT_API_KEY=...
AI_HOSTED_RATE_CARD='[...]'     # extra rate-card rows (JSON), same shape as config/ai-rate-card.js
```

On an install with none of these set, hosted AI is hidden entirely.

**Adding a model means adding a row** to `server/config/ai-rate-card.js`, or to
`AI_HOSTED_RATE_CARD`. The debit path has no per-model code.

### Re-check the rate card monthly

Prices are **never** updated from a live source. The customer was quoted a price before clicking,
so the card changes only when a person changes it. `VERIFIED_AT` in `config/ai-rate-card.js`
records the last check. After 30 days:
- the server logs a daily warning,
- platform admins see a "re-check provider prices" notice in Settings → AI credits and the slide
  editor,
- `GET /api/ai/hosted/admin/providers` reports `rate_card.stale: true`.

To clear it, compare the rows against the provider pricing pages, update any that moved, and bump
`VERIFIED_AT`.

### Endpoints

| Route | Who |
|---|---|
| `GET /api/ai/hosted/status` | workspace members (catalog, prices, balance) |
| `GET /api/ai/hosted/usage` | workspace members (balance + this month by model) |
| `POST /api/ai/hosted/generate` | content editors (`provider, model, resolution, quality, prompt, idempotency_key`) |
| `POST /api/ai/hosted/checkout` | org owner/admin (`pack_id`) |
| `GET /api/ai/hosted/admin/providers` | platform admin (which keys are set — never their values) |
| `POST /api/ai/hosted/admin/grant` | platform admin |
