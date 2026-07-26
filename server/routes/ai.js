'use strict';

// #41: AI content design. Bring-your-own OpenAI-COMPATIBLE endpoint (OpenAI cloud
// or self-hosted Ollama / LM Studio / llama.cpp) generates a *structured* design
// spec that the existing Designer renders with real fonts — so text is crisp and
// editable (raw image-gen garbles text). The operator bears no AI cost; each
// workspace configures its own endpoint/key (encrypted at rest, never returned).
const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const config = require('../config');
const { encrypt, decrypt } = require('../lib/secretbox');
const { generateImage } = require('../lib/image-gen');
const { logActivity, getClientIp } = require('../services/activity');

const isWorkspaceAdmin = (req) => req.isPlatformAdmin || req.actingAs || req.workspaceRole === 'workspace_admin';
const canEdit = (req) => req.isPlatformAdmin || req.actingAs || ['workspace_admin', 'workspace_editor'].includes(req.workspaceRole);

// SSRF guard. Self-hosted instances may point at localhost/LAN (the whole point);
// the hosted instance must not let a tenant admin reach the host's private network.
function endpointAllowed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (config.selfHosted) return true;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local')) return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^(fc|fd)/.test(h)) return false; // IPv6 ULA
  return true;
}

function designSystemPrompt(imagesAvailable) {
  const imgLine = imagesAvailable ? '\n{"type":"image","image_prompt":"DESCRIPTION","x":N,"y":N,"width":N,"height":N}' : '';
  const bgImg = imagesAvailable ? '"background_prompt":"DESCRIPTION or omit",' : '';
  const imgRules = imagesAvailable
    ? ' Strongly PREFER a "background_prompt" — a vivid full-bleed atmospheric scene behind everything; this makes the best-looking signs. Only add a foreground "image" element when a specific product/object must appear as a distinct picture. image_prompt / background_prompt describe a PICTURE ONLY and must contain NO words, letters, or text (the AI cannot render text) — all wording goes in text elements layered on top, and pick text colors with strong contrast against the image.'
    : '';
  return `You are a digital-signage designer. The canvas is 1920x1080 (16:9). Respond with ONLY a JSON object (no prose, no markdown fences) shaped exactly:
{"background":"#RRGGBB",${bgImg}"elements":[ELEMENT, ...]}
ELEMENT is one of:
{"type":"text","x":N,"y":N,"text":"STRING","fontSize":N,"color":"#RRGGBB","bold":true|false}
{"type":"shape","x":N,"y":N,"width":N,"height":N,"color":"#RRGGBB","opacity":N}${imgLine}
x, y, width, height are PERCENTAGES of the canvas (0-100). fontSize is a number where a big headline is about 90 and body text about 36. Use 3 to 6 elements: one bold headline, 1-2 supporting lines, and 0-2 shapes as colored accent bands behind/beside the text. Pick a tasteful, high-contrast palette that fits the request. Keep every element within 0-95 on both axes.${imgRules} Output JSON only.`;
}

const clampN = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const hex = (c, d) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : d;
const cleanText = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim().slice(0, 200);

// Keep generated text on the canvas. The Designer renders text nowrap at
// ~fontSize/10 % of the canvas width per em, so long/large text runs off the
// edge. Estimate width = chars * fontSize * 0.06 (% of canvas width) and height
// = fontSize * 0.18 (% of canvas height); shrink fontSize to fit within 4%
// margins, then nudge x/y in-bounds. Deterministic, so it doesn't depend on the
// model getting layout right.
function fitText(el) {
  // CW: width-% per (char * fontSize). 0.075 ~ bold/uppercase headlines (wider
  // than mixed-case). CH: height-% per fontSize incl. line-height.
  const M = 4, CW = 0.075, CH = 0.22;
  const len = Math.max(1, el.text.length);
  const maxByW = (100 - 2 * M) / (len * CW);
  const maxByH = (100 - 2 * M) / CH;
  el.fontSize = Math.floor(Math.max(8, Math.min(el.fontSize, maxByW, maxByH)));
  const w = len * el.fontSize * CW;
  const h = el.fontSize * CH;
  el.x = Math.round(Math.min(Math.max(el.x, M), Math.max(M, 100 - M - w)) * 10) / 10;
  el.y = Math.round(Math.min(Math.max(el.y, M), Math.max(M, 100 - M - h)) * 10) / 10;
}

// Never trust raw model output: cap count, clamp ranges, fix px-vs-% (models
// often emit pixels), strip any HTML from text, validate colors, fit to canvas.
function normalizeDesign(raw) {
  const out = { background: hex(raw && raw.background, '#111827'), elements: [] };
  const bgPrompt = cleanText(raw && raw.background_prompt);
  if (bgPrompt) out.background_prompt = bgPrompt;
  const els = Array.isArray(raw && raw.elements) ? raw.elements.slice(0, 20) : [];
  for (const e of els) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'image') {
      const prompt = cleanText(e.image_prompt || e.prompt);
      if (!prompt) continue;
      const w = clampN(e.width, 5, 100, 30), h = clampN(e.height, 5, 100, 40);
      out.elements.push({
        type: 'image', image_prompt: prompt,
        x: Math.min(clampN(e.x, 0, 100, 60), 100 - w),
        y: Math.min(clampN(e.y, 0, 100, 30), 100 - h),
        width: w, height: h,
      });
    } else if (e.type === 'text') {
      const text = cleanText(e.text);
      if (!text) continue;
      const el = {
        type: 'text', x: clampN(e.x, 0, 95, 5), y: clampN(e.y, 0, 95, 5), text,
        fontSize: clampN(e.fontSize, 12, 200, 48), fontFamily: 'Arial',
        color: hex(e.color, '#FFFFFF'), bold: !!e.bold, shadow: !!e.shadow,
      };
      fitText(el);
      out.elements.push(el);
    } else if (e.type === 'shape') {
      let w = Number(e.width), h = Number(e.height);
      if (w > 100) w = w / 19.2;  // px of 1920 -> %
      if (h > 100) h = h / 10.8;  // px of 1080 -> %
      w = clampN(w, 1, 100, 30);
      h = clampN(h, 1, 100, 20);
      out.elements.push({
        type: 'shape', shape: 'rect',
        // keep the shape on-canvas: x+width <= 100, y+height <= 100
        x: Math.min(clampN(e.x, 0, 100, 0), 100 - w),
        y: Math.min(clampN(e.y, 0, 100, 0), 100 - h),
        width: w, height: h,
        color: hex(e.color, '#e65c00'), opacity: clampN(e.opacity, 0, 1, 0.85), radius: 0,
      });
    }
  }

  // De-overlap text lines (models stack them at the same y) and stack layers so
  // text is always on top: shapes (back) -> images (mid) -> text (front).
  const shapes = out.elements.filter((e) => e.type === 'shape');
  const images = out.elements.filter((e) => e.type === 'image').slice(0, 2);
  const texts = out.elements.filter((e) => e.type === 'text');
  deoverlapTexts(texts);
  out.elements = [...shapes, ...images, ...texts];
  return out;
}

// Push text lines apart so they don't sit on top of each other. Only nudges a
// line down when it also overlaps horizontally (leaves side-by-side text alone),
// then shifts the whole stack up if it ran past the bottom margin. CW/CH match
// fitText's width/height estimates.
function deoverlapTexts(texts) {
  const M = 4, GAP = 2.5, CW = 0.075, CH = 0.26;
  const widthOf = (el) => Math.max(1, el.text.length) * el.fontSize * CW;
  const heightOf = (el) => el.fontSize * CH;
  const ordered = texts.map((el, i) => ({ el, i })).sort((a, b) => a.el.y - b.el.y || a.i - b.i);
  const placed = [];
  for (const cur of ordered) {
    const cw = widthOf(cur.el);
    let minY = M;
    for (const p of placed) {
      const hOverlap = cur.el.x < p.el.x + widthOf(p.el) && p.el.x < cur.el.x + cw;
      if (hOverlap) minY = Math.max(minY, p.el.y + heightOf(p.el) + GAP);
    }
    if (cur.el.y < minY) cur.el.y = Math.round(minY * 10) / 10;
    placed.push(cur);
  }
  let maxBottom = 0;
  for (const p of placed) maxBottom = Math.max(maxBottom, p.el.y + heightOf(p.el));
  const overflow = maxBottom - (100 - M);
  if (overflow > 0 && placed.length) {
    const shift = Math.min(overflow, Math.min(...placed.map((p) => p.el.y)) - M);
    if (shift > 0) for (const p of placed) p.el.y = Math.round((p.el.y - shift) * 10) / 10;
  }
}

// GET /api/ai/settings — workspace members (never returns the key)
router.get('/settings', (req, res) => {
  const row = db.prepare('SELECT base_url, model, image_base_url, image_model, image_provider, api_key_enc, image_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  res.json({
    base_url: row ? row.base_url || '' : '',
    model: row ? row.model || '' : '',
    image_base_url: row ? row.image_base_url || '' : '',
    image_model: row ? row.image_model || '' : '',
    image_provider: row ? row.image_provider || '' : '',
    has_key: !!(row && row.api_key_enc),
    has_image_key: !!(row && row.image_api_key_enc),
    configured: !!(row && row.base_url && row.model),
    image_configured: !!(row && row.image_base_url && row.image_provider),
  });
});

// PUT /api/ai/settings — workspace admin
router.put('/settings', (req, res) => {
  if (!isWorkspaceAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const base_url = String(req.body && req.body.base_url || '').trim().replace(/\/+$/, '');
  const model = String(req.body && req.body.model || '').trim();
  const image_base_url = String(req.body && req.body.image_base_url || '').trim().replace(/\/+$/, '');
  const image_model = String(req.body && req.body.image_model || '').trim();
  const image_provider = ['comfyui', 'openai', 'sdcpp'].includes(req.body && req.body.image_provider) ? req.body.image_provider : null;
  if (base_url && !endpointAllowed(base_url)) return res.status(400).json({ error: 'Endpoint URL not allowed (private/internal addresses are blocked on this instance).' });
  if (image_base_url && !endpointAllowed(image_base_url)) return res.status(400).json({ error: 'Image endpoint URL not allowed.' });

  const existing = db.prepare('SELECT api_key_enc, image_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  let api_key_enc = existing ? existing.api_key_enc : null;
  if (typeof (req.body && req.body.api_key) === 'string' && req.body.api_key.length) api_key_enc = encrypt(req.body.api_key);
  if (req.body && req.body.clear_key) api_key_enc = null;

  let image_api_key_enc = existing ? existing.image_api_key_enc : null;
  if (typeof (req.body && req.body.image_api_key) === 'string' && req.body.image_api_key.length) image_api_key_enc = encrypt(req.body.image_api_key);
  if (req.body && req.body.clear_image_key) image_api_key_enc = null;

  db.prepare(`
    INSERT INTO ai_settings (workspace_id, base_url, api_key_enc, model, image_base_url, image_model, image_provider, image_api_key_enc, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(workspace_id) DO UPDATE SET base_url=excluded.base_url, api_key_enc=excluded.api_key_enc,
      model=excluded.model, image_base_url=excluded.image_base_url, image_model=excluded.image_model,
      image_provider=excluded.image_provider, image_api_key_enc=excluded.image_api_key_enc, updated_at=excluded.updated_at
  `).run(req.workspaceId, base_url || null, api_key_enc, model || null, image_base_url || null, image_model || null, image_provider, image_api_key_enc);
  logActivity(req.user.id, 'ai_settings_update', `endpoint: ${base_url || '(none)'} model: ${model || '(none)'}`, null, getClientIp(req), req.workspaceId);
  res.json({ ok: true });
});

// POST /api/ai/models — list the models the configured/entered endpoint offers,
// for the settings dropdown. Admin only. Uses the posted key, or the saved one.
router.post('/models', async (req, res) => {
  if (!isWorkspaceAdmin(req)) return res.status(403).json({ error: 'Workspace admin required' });
  const base_url = String(req.body && req.body.base_url || '').trim().replace(/\/+$/, '');
  if (!base_url) return res.status(400).json({ error: 'Endpoint base URL required' });
  if (!endpointAllowed(base_url)) return res.status(400).json({ error: 'Endpoint URL not allowed (private/internal addresses are blocked on this instance).' });
  let key = (req.body && typeof req.body.api_key === 'string' && req.body.api_key.length) ? req.body.api_key : null;
  if (!key) { const row = db.prepare('SELECT api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId); key = (row && decrypt(row.api_key_enc)) || 'none'; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let r;
  try {
    r = await fetch(base_url + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: 'Could not reach the endpoint: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
  clearTimeout(timer);
  if (!r.ok) { const t = await r.text().catch(() => ''); return res.status(502).json({ error: `Endpoint error ${r.status}: ${t.slice(0, 120)}` }); }
  let j; try { j = await r.json(); } catch { return res.status(502).json({ error: 'Endpoint returned non-JSON.' }); }
  const models = Array.isArray(j && j.data) ? j.data.map(m => m && m.id).filter(Boolean) : [];
  res.json({ models: models.slice(0, 300) });
});

// POST /api/ai/generate-design — editor+; proxies the workspace's endpoint
router.post('/generate-design', async (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Editor access required' });
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const row = db.prepare('SELECT base_url, api_key_enc, model, image_base_url, image_model, image_provider, image_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  if (!row || !row.base_url || !row.model) return res.status(400).json({ error: 'AI is not configured. Set an endpoint and model in AI settings first.' });
  if (!endpointAllowed(row.base_url)) return res.status(400).json({ error: 'Configured endpoint is not allowed.' });

  const imgBase = row.image_base_url ? row.image_base_url.replace(/\/+$/, '') : '';
  const imagesAvailable = !!(imgBase && row.image_provider && endpointAllowed(imgBase));

  const key = decrypt(row.api_key_enc) || 'none';
  const url = row.base_url.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000); // local models can be slow
  let aiRes;
  try {
    aiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: row.model, temperature: 0.6, stream: false,
        messages: [{ role: 'system', content: designSystemPrompt(imagesAvailable) }, { role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: 'Could not reach the AI endpoint: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
  clearTimeout(timer);
  if (!aiRes.ok) {
    const t = await aiRes.text().catch(() => '');
    return res.status(502).json({ error: `AI endpoint error ${aiRes.status}: ${t.slice(0, 150)}` });
  }
  let json;
  try { json = await aiRes.json(); } catch { return res.status(502).json({ error: 'AI returned non-JSON.' }); }
  const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  let parsed;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : content);
  } catch { return res.status(502).json({ error: 'AI did not return a usable design. Try rephrasing.' }); }
  const design = normalizeDesign(parsed);
  if (!design.elements.length && !design.background_prompt) return res.status(502).json({ error: 'AI returned an empty design. Try a more specific prompt.' });

  // Phase 2: generate the AI background + foreground images (best-effort: a failed
  // image never fails the whole design — the text/shapes still come back).
  const imageEls = design.elements.filter((e) => e.type === 'image');
  if (imagesAvailable && (design.background_prompt || imageEls.length)) {
    // Separate image key if set, else fall back to the text key (all-OpenAI setups).
    const imgKey = decrypt(row.image_api_key_enc) || key;
    const common = { provider: row.image_provider, baseUrl: imgBase, apiKey: imgKey, model: row.image_model, timeoutMs: 180000 };
    const jobs = [];
    if (design.background_prompt) {
      jobs.push(generateImage({ ...common, prompt: design.background_prompt, width: 1024, height: 576 })
        .then((src) => { design.backgroundImage = src; })
        .catch((e) => { design.image_warning = 'Background image failed: ' + e.message; }));
    }
    for (const el of imageEls) {
      jobs.push(generateImage({ ...common, prompt: el.image_prompt, width: 768, height: 768 })
        .then((src) => { el.src = src; })
        .catch(() => { el._failed = true; }));
    }
    await Promise.all(jobs);
  }
  // drop image elements that never got a src (no endpoint, or generation failed)
  design.elements = design.elements.filter((e) => e.type !== 'image' || e.src);
  design.elements.forEach((e) => { delete e.image_prompt; delete e._failed; });
  delete design.background_prompt;

  logActivity(req.user.id, 'ai_generate_design', `prompt: ${prompt.slice(0, 80)}${imagesAvailable ? ' (+images)' : ''}`, null, getClientIp(req), req.workspaceId);
  res.json(design);
});

module.exports = router;
// Exposed for unit tests (security-critical: untrusted-LLM-output normalization
// and the SSRF guard).
module.exports.normalizeDesign = normalizeDesign;
module.exports.endpointAllowed = endpointAllowed;
