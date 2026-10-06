'use strict';

/*
 * Hosted AI image providers — platform keys, org credits (docs/ai-credits.md).
 *
 * ⚠️ KEYS ARE READ FROM process.env AT CALL TIME AND GO NOWHERE ELSE. Not into config, not into
 * SQLite, not into a response, a log line or the activity log. Provider error text is scrubbed of
 * the key before it is surfaced, in case an upstream ever echoes the Authorization header back.
 *
 * A provider is ENABLED only when its key is set, and OFFERED only for the rate-card rows that
 * name it. Anthropic is deliberately absent: Claude does not generate images, and image credits
 * apply only to image calls.
 */

const config = require('../config');
const credits = require('./ai-credits');
const { nearestAspect } = require('./image-gen');

const PROVIDERS = {
  xai: { label: 'xAI Grok Imagine', keyEnv: 'XAI_API_KEY', baseUrl: () => config.aiHosted.xaiBaseUrl, dialect: 'xai' },
  openai: { label: 'OpenAI Images', keyEnv: 'OPENAI_API_KEY', baseUrl: () => config.aiHosted.openaiBaseUrl, dialect: 'openai' },
  compat: { label: 'OpenAI-compatible', keyEnv: 'AI_HOSTED_COMPAT_API_KEY', baseUrl: () => config.aiHosted.compatBaseUrl, dialect: 'openai' },
};

function keyFor(id) {
  const p = PROVIDERS[id];
  return p ? (process.env[p.keyEnv] || '').trim() : '';
}

function providerEnabled(id) {
  const p = PROVIDERS[id];
  return !!(p && keyFor(id) && p.baseUrl());
}

/** Rows a user may choose right now, each with its customer price. */
function catalog() {
  return credits.rateCard()
    .filter((r) => providerEnabled(r.provider))
    .map((r) => {
      const price = credits.priceOf(r);
      return {
        provider: r.provider, provider_label: PROVIDERS[r.provider].label,
        model: r.model, resolution: r.resolution, quality: r.quality,
        credits: price.credits, charge_usd: price.charge_usd_micros / 1e6,
      };
    });
}

function enabled() { return catalog().length > 0; }

/* Platform-admin view. Says WHETHER a key is set, never what it is. */
function providerStatus() {
  const rows = credits.rateCard();
  return {
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label, key_env: p.keyEnv, key_set: !!keyFor(id), base_url: p.baseUrl() || null,
      priced_models: rows.filter((r) => r.provider === id).length,
      enabled: providerEnabled(id),
    })),
    // Copy/layout only, if ever wired — never billed as an image, never offered as an image model.
    anthropic_text_key_set: !!(process.env.ANTHROPIC_API_KEY || '').trim(),
    rate_card: credits.rateCardAge(),
  };
}

/*
 * A provider failure. `message` is the scrubbed detail for the server log; `publicMessage` is what
 * a customer is told — never the provider's own words, which describe the platform's account.
 */
class ProviderError extends Error {
  constructor(detail, status) {
    super(detail);
    this.name = 'ProviderError';
    this.status = status || null;
    this.publicMessage = status === 400 || status === 422
      ? 'the image provider refused this prompt. Try rewording it.'
      : status === 'timeout' ? 'the image provider took too long to answer.'
      : 'the image provider is unavailable right now.';
  }
}

function scrub(text, key) {
  let s = String(text || '');
  if (key) s = s.split(key).join('[redacted]');
  return s.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1[redacted]').replace(/\b(xai|sk)-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/*
 * One image from the provider, as a data: URL. Sends exactly the rate-card row's `request` — the
 * thing the user was quoted is the thing that is asked for, with no retry that might silently
 * change the tier (unlike the BYO path's size→aspect_ratio fallback, which is free to guess).
 * Throws on any failure; the caller releases the reservation.
 */
async function generate({ row, prompt, width, height, fetchImpl = fetch }) {
  const p = PROVIDERS[row.provider];
  const key = keyFor(row.provider);
  if (!p || !key) throw new ProviderError('This hosted provider is not enabled.');
  const body = { model: row.model, prompt, n: 1, ...row.request };
  if (p.dialect === 'xai') {
    body.response_format = 'b64_json';
    // 16:9-friendly by default; the deck's own shape when the editor says so.
    body.aspect_ratio = nearestAspect(width || 16, height || 9);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.aiHosted.providerTimeoutMs);
  try {
    const res = await fetchImpl(p.baseUrl() + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ProviderError(`Provider error ${res.status}: ${scrub(t, key).slice(0, 200)}`, res.status);
    }
    const j = await res.json();
    const d = j && j.data && j.data[0];
    if (d && d.b64_json) return 'data:image/png;base64,' + d.b64_json;
    if (d && d.url && /^https:\/\//.test(d.url)) {
      const img = await fetchImpl(d.url, { signal: controller.signal });
      if (!img.ok) throw new ProviderError(`Provider image download failed (${img.status})`, img.status);
      return 'data:image/png;base64,' + Buffer.from(await img.arrayBuffer()).toString('base64');
    }
    throw new ProviderError('Provider returned no image.');
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ProviderError('Provider timed out.', 'timeout');
    if (e instanceof ProviderError) { e.message = scrub(e.message, key); throw e; }
    throw new ProviderError(scrub(e && e.message, key));
  } finally {
    clearTimeout(timer);
  }
}

/* Daily nag while the rate card is past its re-verify date (see config/ai-rate-card.js). */
let _lastStaleWarn = 0;
function warnIfRateCardStale(nowMs = Date.now()) {
  if (!enabled()) return false;
  const age = credits.rateCardAge(nowMs);
  if (!age.stale || nowMs - _lastStaleWarn < 86400000) return false;
  _lastStaleWarn = nowMs;
  console.warn(`[ai-hosted] rate card last verified ${age.verified_at} (${age.age_days} days ago) — re-check provider prices and update config/ai-rate-card.js VERIFIED_AT`);
  return true;
}

module.exports = { PROVIDERS, ProviderError, catalog, enabled, providerEnabled, providerStatus, generate, scrub, warnIfRateCardStale };
