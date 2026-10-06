'use strict';

/*
 * "ScreenTinker hosted images" — the SECOND AI path (docs/ai-credits.md). The bring-your-own path
 * in routes/ai.js is untouched and never spends credits; this one calls providers with PLATFORM
 * keys and spends the caller's ORG credits.
 *
 * ⚠️ THE USER PICKS THE MODEL, EVERY TIME. /generate refuses a request that does not name its
 * provider, model, resolution and quality, and there is no server-side default to fall back to —
 * a hidden default is how a customer ends up on a pricier tier they never chose.
 *
 * Mounted at /api/ai/hosted (JWT only, resolveTenancy). Under /ai so the dashboard keeps it local
 * while a linked server is being viewed, exactly like the BYO routes.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const credits = require('../lib/ai-credits');
const hosted = require('../lib/ai-hosted');
const { canRead, isOrgAdmin } = require('../lib/permissions');
const { requirePlatformAdmin } = require('../middleware/auth');
const { logActivity, getClientIp } = require('../services/activity');
const stripeClient = require('../lib/stripe-client');

// Content-edit rights, as routes/ai.js has them — EXCEPT a platform operator acting as an org. On
// the BYO path that cost nothing; here every image spends the CUSTOMER'S credits on the platform's
// keys, and an operator holds no owner power over a customer's money (#13).
const canEdit = (req) => req.isPlatformAdmin || (req.actingAs && !req.isPlatformOperator)
  || ['workspace_admin', 'workspace_editor'].includes(req.workspaceRole);
const clampN = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const stripeReady = () => !!(stripeClient.get() && config.stripeWebhookSecret);

// The balance is the org's and every member may see it; the org's screen bill is billing data,
// and in an agency or corporate org the workspaces can be different customers. Org admins only.
function balanceView(orgId, req) {
  const { bill, entitled, eligible } = credits.ensureIncludedGrant(orgId);
  const bal = credits.balance(orgId);
  return {
    balance: bal.total,
    included_remaining: bal.included,
    purchased_remaining: bal.purchased,
    period: bal.period,
    included_this_month: entitled,
    ...(isOrgAdmin(req) ? {
      included_eligible: eligible,
      screen_bill: { basis: bill.basis, month: bill.billed_month, billable_screens: bill.billable_screens, cost_usd: bill.cost_cents / 100 },
    } : {}),
  };
}

// GET /status — what the designer needs: is hosted on, the priced catalog, the caller's balance.
router.get('/status', (req, res) => {
  if (!hosted.enabled()) return res.json({ enabled: false });
  if (!req.organizationId || !canRead(req)) return res.json({ enabled: false });
  res.json({
    enabled: true,
    catalog: hosted.catalog(),
    highlight: credits.HIGHLIGHT,
    packs: credits.PACKS.map((p) => ({ id: p.id, credits: p.credits, usd: p.usd_cents / 100 })),
    checkout_available: stripeReady(),
    can_buy: isOrgAdmin(req),
    can_generate: canEdit(req),
    ...balanceView(req.organizationId, req),
    // Platform admins see the re-verify reminder here, so it is not only in a log nobody reads.
    ...(req.isPlatformAdmin ? { rate_card: credits.rateCardAge() } : {}),
  });
});

// GET /usage — org settings panel: balance + this month's usage by model.
router.get('/usage', (req, res) => {
  if (!hosted.enabled()) return res.json({ enabled: false });
  if (!req.organizationId || !canRead(req)) return res.status(403).json({ error: 'Workspace access required' });
  // Usage spans every workspace in the org: org admins only, like the bill.
  res.json({ enabled: true, ...balanceView(req.organizationId, req), ...(isOrgAdmin(req) ? { usage: credits.usageThisMonth(req.organizationId) } : {}) });
});

// POST /generate — one image, paid in credits, landing in the content library.
router.post('/generate', async (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Editor access required' });
  if (!hosted.enabled()) return res.status(404).json({ error: 'Hosted AI is not enabled on this server.' });
  if (!req.organizationId) return res.status(403).json({ error: 'No organization context' });
  const b = req.body || {};
  const prompt = String(b.prompt || '').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  const key = String(b.idempotency_key || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) return res.status(400).json({ error: 'idempotency_key required (8-100 chars of [A-Za-z0-9_-])' });
  const selection = {
    provider: String(b.provider || ''), model: String(b.model || ''),
    resolution: String(b.resolution || ''), quality: String(b.quality || ''),
  };
  if (!hosted.providerEnabled(selection.provider)) {
    return res.status(400).json({ error: 'That provider is not enabled.', code: 'unknown_model' });
  }

  let r;
  try {
    r = credits.reserve({
      orgId: req.organizationId, workspaceId: req.workspaceId, userId: req.user.id,
      idempotencyKey: key, selection,
    });
  } catch (e) {
    if (e instanceof credits.CreditError && e.code === 'insufficient_credits') {
      // 402 + a code the UI turns into a "buy credits" prompt. Cheaper models stay usable.
      return res.status(402).json({ error: e.message, code: e.code, needed: e.needed, ...balanceView(req.organizationId, req), can_buy: isOrgAdmin(req) });
    }
    if (e instanceof credits.CreditError) return res.status(400).json({ error: e.message, code: e.code });
    // Express 4 does not catch a throw from an async handler — answer here. Nothing was charged:
    // the reserve is one transaction and it rolled back.
    console.error('[ai-hosted] reserve failed:', e && e.message);
    return res.status(500).json({ error: 'Could not reserve credits' });
  }

  const resv = r.reservation;
  if (r.replay) {
    // The same click arriving twice charges once: replay what happened the first time.
    if (resv.status === 'committed') {
      const c = db.prepare('SELECT id, filename, width, height FROM content WHERE id = ?').get(resv.content_id) || {};
      return res.json({ content_id: resv.content_id, filename: c.filename, width: c.width, height: c.height, credits_spent: resv.credits, replayed: true, ...balanceView(req.organizationId, req) });
    }
    if (resv.status === 'pending') return res.status(409).json({ error: 'This generation is already in progress.', code: 'in_progress' });
    return res.status(resv.error_status || 400).json({ error: resv.error, code: 'failed', credits_refunded: resv.credits, replayed: true });
  }

  const row = r.row;
  const { generateAndIngest } = require('./ai');
  let content;
  try {
    ({ content } = await generateAndIngest({
      produce: () => hosted.generate({
        row, prompt,
        width: clampN(b.width, 256, 4096, 1920), height: clampN(b.height, 256, 4096, 1080),
      }),
      name: `ai-hosted-${prompt.slice(0, 40).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'image'}.png`,
      userId: req.user.id,
      workspaceId: req.workspaceId,
    }));
  } catch (e) {
    // Fail closed: nothing ingested, the reserve is refunded in full.
    // ⚠️ A provider's own error text stays in the server log. It describes the PLATFORM's account
    // (quota, billing limits, team ids), and every tenant would read it; they get a plain sentence,
    // which is also all the reservation keeps for a replayed retry. Our own errors (an ingest
    // refusal, a storage limit) are written for the customer and pass through.
    const detail = String(e && e.message || e).slice(0, 300);
    const why = e instanceof hosted.ProviderError ? e.publicMessage : detail.slice(0, 200);
    credits.release(resv.id, 'Image generation failed: ' + why, 400);
    console.warn(`[ai-hosted] generation failed (${row.provider}/${row.model}), refunded ${resv.credits} credits: ${detail}`);
    return res.status(400).json({ error: 'Image generation failed: ' + why, code: 'failed', credits_refunded: resv.credits });
  }

  if (!credits.commit(resv.id, content.id)) {
    // Only reachable if the reservation was swept mid-flight, which staleWindowSec() rules out.
    // Said loudly rather than ignored: it means an image went out uncharged.
    console.error(`[ai-hosted] reservation ${resv.id} was no longer pending at commit — image ${content.id} delivered without a charge`);
  }
  // Billing ledger holds no prompt; the activity log gets who/what/how much, not the words.
  logActivity(req.user.id, 'ai_hosted_image',
    `${row.provider}/${row.model} · ${row.resolution} · ${row.quality} · ${resv.credits} credits`,
    null, getClientIp(req), req.workspaceId);
  res.json({
    content_id: content.id, filename: content.filename, width: content.width, height: content.height,
    credits_spent: resv.credits, ...balanceView(req.organizationId, req),
  });
});

// POST /checkout — buy a credit pack. Org owner/admin. Fulfilled ONLY by the verified webhook.
router.post('/checkout', async (req, res) => {
  if (!hosted.enabled()) return res.status(404).json({ error: 'Hosted AI is not enabled on this server.' });
  if (!req.organizationId || !isOrgAdmin(req)) return res.status(403).json({ error: 'Organization admin required' });
  const pack = credits.packById(String(req.body && req.body.pack_id || ''));
  if (!pack) return res.status(400).json({ error: 'Unknown pack' });
  const stripe = stripeClient.get();
  if (!stripe || !config.stripeWebhookSecret) {
    return res.status(503).json({ error: 'Online purchase is not available on this server — contact your administrator.', code: 'checkout_unavailable' });
  }
  const raw = req.headers.origin || process.env.APP_URL || `${req.protocol}://${req.get('host') || ''}`;
  const base = `${String(raw).replace(/\/+$/, '')}/app`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      ...(req.user.stripe_customer_id ? { customer: req.user.stripe_customer_id } : { customer_email: req.user.email }),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd', unit_amount: pack.usd_cents,
          product_data: { name: `ScreenTinker AI credits — ${pack.credits.toLocaleString('en-US')}` },
        },
      }],
      success_url: `${base}#/settings?credits=success`,
      cancel_url: `${base}#/settings?credits=cancelled`,
      metadata: { kind: 'ai_credits', org_id: req.organizationId, pack_id: pack.id, user_id: req.user.id },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[ai-hosted] checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/* ---------- platform admin ---------- */

router.get('/admin/providers', requirePlatformAdmin, (req, res) => {
  res.json(hosted.providerStatus());
});

// Owner-only grant/adjust, e.g. a goodwill credit or a manual invoice.
router.post('/admin/grant', requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  const orgId = String(b.org_id || '');
  const delta = Number(b.credits);
  try {
    const bal = credits.adminAdjust({ orgId, delta, userId: req.user.id, ref: b.note });
    logActivity(req.user.id, 'ai_credits_admin_adjust', `org ${orgId}: ${delta > 0 ? '+' : ''}${delta} credits`, null, getClientIp(req), null);
    res.json({ ok: true, balance: bal.total, included_remaining: bal.included, purchased_remaining: bal.purchased });
  } catch (e) {
    if (e instanceof credits.CreditError) return res.status(e.code === 'no_org' ? 404 : 400).json({ error: e.message, code: e.code });
    throw e;
  }
});

module.exports = router;
