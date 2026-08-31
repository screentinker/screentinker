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
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { ingestUploadedFile } = require('../lib/content-ingest');
const { logActivity, getClientIp } = require('../services/activity');

/*
 * ⚠️ NOT 502, THOUGH THAT IS WHAT THESE FAILURES ARE. Cloudflare REPLACES a 502 body with its own
 * error page, so every upstream AI failure reached the operator as a bare "Request failed" — the
 * server was answering with `Model not found: Grok-4`, and all that survived the proxy was nothing.
 * A capitalised model name cost a support round trip that the endpoint's own words would have
 * closed in seconds.
 *
 * These are reported as 400 instead: not strictly accurate for a timeout, but almost every one of
 * them IS a configuration fault the operator can fix (wrong model, wrong key, wrong URL), and a
 * slightly-wrong status that shows the reason beats a correct one that hides it.
 */
const UPSTREAM_STATUS = 400;

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
        color: hex(e.color, '#3b82f6'), opacity: clampN(e.opacity, 0, 1, 0.85), radius: 0,
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
    return res.status(UPSTREAM_STATUS).json({ error: 'Could not reach the endpoint: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
  clearTimeout(timer);
  if (!r.ok) { const t = await r.text().catch(() => ''); return res.status(UPSTREAM_STATUS).json({ error: `Endpoint error ${r.status}: ${t.slice(0, 120)}` }); }
  let j; try { j = await r.json(); } catch { return res.status(UPSTREAM_STATUS).json({ error: 'Endpoint returned non-JSON.' }); }
  const models = Array.isArray(j && j.data) ? j.data.map(m => m && m.id).filter(Boolean) : [];
  res.json({ models: models.slice(0, 300) });
});

/*
 * The renderer's own vocabularies, imported rather than restated.
 *
 * ⚠️ A LIST TYPED OUT HERE WOULD DRIFT. Offering the model an animation the renderer does not
 * implement produces a slide that validates, ships, and then animates nothing — and the editor
 * would show the same nothing, so there is no moment at which anyone notices. Reading them from
 * the source of truth makes that impossible by construction.
 *
 * `image` is deliberately EXCLUDED from what the model may choose: an image element is meaningless
 * without a content_id pointing at a real upload in this workspace, and a model cannot know one.
 * ⚠️ Declared before the functions that read it — a TDZ on a module-level const is how a boot
 * brick happened here once.
 */
const SLIDE_RENDER = require('../lib/slide-render');
const SLIDE_ANIMATIONS = Object.keys(SLIDE_RENDER.ANIMATIONS || {}).filter((a) => a !== 'none');
/*
 * ⚠️ `config` KINDS ARE EXCLUDED ALONGSIDE `image`, and for the same reason it is.
 *
 * The generator writes a layout and the words in it. It cannot invent a URL worth encoding in a QR
 * or a date worth counting down to, and offering it a kind it cannot fill produces an element
 * configured entirely from defaults — a QR of nothing, a countdown to null — which looks like a
 * broken slide rather than an empty one. See KINDS in lib/slide-render.js.
 */
const SLIDE_KINDS = Object.keys(SLIDE_RENDER.KINDS || {})
  .filter((k) => k !== 'image' && !SLIDE_RENDER.KINDS[k].config);

/*
 * The slide schema, described to a model.
 *
 * ⚠️ DIFFERENT FROM THE DESIGNER'S, AND THE DIFFERENCE IS THE WHOLE POINT OF SLIDES. A designer
 * element carries its own text; a slide keeps LAYOUT in `template.elements` and WORDS in `fields`,
 * joined at render time. That separation is what lets somebody change a headline later without
 * rebuilding the layout — so the model is asked for both halves and told how they join, rather than
 * being allowed to bake text into the layout the way the designer's schema does.
 *
 * Sizes are cqw (percent of the container's width), never px: a slide is authored once and lands on
 * panels from 720p to 4K.
 */
function slideSystemPrompt() {
  return `You are a presentation designer. The slide is 16:9. Respond with ONLY a JSON object (no prose, no markdown fences) shaped exactly:
{"background":"#RRGGBB","elements":[ELEMENT,...],"fields":{"SLOT":"TEXT",...}}
ELEMENT is:
{"slot":"SLOT","kind":"${SLIDE_KINDS.join('|')}","box":{"x":N,"y":N,"w":N,"h":N},"style":{"color":"#RRGGBB","size_cqw":N,"weight":N,"align":"left|center|right","opacity":N,"radius_cqw":N},"motion":{"animation":"ANIM","delay":N,"duration":N}}
SLOT is a short lowercase identifier like "title" or "point_1"; every TEXT element's slot must also appear in "fields" with its wording. "rule" and "box" are decoration and take no field.
box.x/y/w/h are PERCENTAGES of the slide (0-100). size_cqw is text size as a percent of slide width: a headline is about 6, body about 3, a big stat about 12. weight is 100-900.
ANIM is one of: ${SLIDE_ANIMATIONS.join(', ')}. Use motion sparingly — at most half the elements, delays under 1.5s.
Use 2 to 6 elements: one "head", 1-4 "body" or "stat", and 0-2 "rule"/"box" as accent bands. Keep everything within 2-96 on both axes, pick a high-contrast palette, and put every word in "fields". Output JSON only.`;
}

/*
 * Turn whatever the model said into something normalizeSlide will accept.
 *
 * ⚠️ NEVER TRUST RAW MODEL OUTPUT — the same rule normalizeDesign states. Everything is clamped,
 * every kind and animation is checked against the real vocabularies, slots are regenerated to a
 * safe pattern, and text is stripped of markup. A model that returns 40 elements, negative sizes or
 * a slot named "../../x" produces a small valid slide rather than an error or a render exploit.
 *
 * The output is a slide CONFIG (template + fields), which lib/slide-render.normalizeSlide then
 * re-validates on its own terms — this is a first pass, not the last line of defence.
 */
function normalizeSlideSpec(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const KINDS = SLIDE_KINDS;
  const anims = SLIDE_ANIMATIONS;
  const els = Array.isArray(src.elements) ? src.elements.slice(0, 8) : [];
  const fieldsIn = (src.fields && typeof src.fields === 'object' && !Array.isArray(src.fields)) ? src.fields : {};

  const elements = [];
  const fields = {};
  els.forEach((e, i) => {
    const o = (e && typeof e === 'object') ? e : {};
    const kind = KINDS.includes(o.kind) ? o.kind : 'body';
    // Slots are regenerated from a safe pattern rather than sanitised: the model's slot is only a
    // key, and inventing our own removes an entire class of question about what it may contain.
    const slot = `s${i + 1}_${kind}`;
    const box = (o.box && typeof o.box === 'object') ? o.box : {};
    const st = (o.style && typeof o.style === 'object') ? o.style : {};
    const mo = (o.motion && typeof o.motion === 'object') ? o.motion : null;
    const isText = kind === 'head' || kind === 'body' || kind === 'stat';

    elements.push({
      slot, kind,
      box: {
        x: clampN(box.x, 0, 96, 5),
        // ⚠️ The DEFAULT is clamped too. clampN returns `d` untouched when the input is not finite,
        // so a stacked default of 5 + i*14 reaches 103 at the eighth element and lands the whole
        // thing below the slide — a fallback that puts content off-screen is not a fallback.
        y: clampN(box.y, 0, 96, Math.min(96, 5 + i * 11)),
        w: clampN(box.w, 3, 100, isText ? 60 : 30),
        h: isText ? undefined : clampN(box.h, 1, 100, 6),
      },
      style: {
        color: hex(st.color, '#FFFFFF'),
        size_cqw: clampN(st.size_cqw, 0.5, 30, kind === 'head' ? 6 : kind === 'stat' ? 12 : 3),
        weight: Math.round(clampN(st.weight, 100, 900, kind === 'head' ? 700 : 400) / 100) * 100,
        align: ['left', 'center', 'right'].includes(st.align) ? st.align : 'left',
        opacity: clampN(st.opacity, 0, 1, 1),
        radius_cqw: clampN(st.radius_cqw, 0, 20, 0),
      },
      motion: (mo && anims.includes(mo.animation)) ? {
        animation: mo.animation,
        delay: clampN(mo.delay, 0, 5, 0),
        duration: clampN(mo.duration, 0.05, 5, 0.5),
        easing: 'ease-out',
      } : null,
    });

    if (isText) {
      /*
       * ⚠️ hasOwnProperty, NOT map[key]. Both `fieldsIn` and `o.slot` are model-controlled, so a
       * slot of "constructor" or "toString" reads a prototype member and renders
       * `function Object() { [native code] }` on a wall in place of the operator's words. The same
       * hazard lib/slide-render.js and lib/html-bundle.js already guard against by hand.
       */
      const has = Object.prototype.hasOwnProperty.call(fieldsIn, o.slot);
      const text = has ? fieldsIn[o.slot] : (Object.prototype.hasOwnProperty.call(o, 'text') ? o.text : '');
      fields[slot] = cleanText(text);
    }
  });

  return {
    template: { background: hex(src.background, '#0B1220'), elements },
    fields,
  };
}

/*
 * Ask the workspace's configured model for a JSON object, and hand back something already parsed.
 *
 * ⚠️ EXTRACTED SO THE SECOND CALLER IS NOT A SECOND COPY. Everything up to "the model replied" is
 * identical for any generate-* route — settings lookup, the endpoint allowlist, the long timeout
 * local models need, the non-JSON and non-OK paths, and digging the content out of a
 * chat-completions envelope. What differs is the system prompt and how the reply is sanitised, and
 * those are the only things a caller supplies.
 *
 * Errors come back as {error, status} rather than thrown, because every one of them is a specific
 * message an operator can act on ("AI is not configured", "timed out", "returned non-JSON") and
 * flattening them into a 500 is how a misconfigured endpoint becomes an unexplainable failure.
 */
async function askModelForJson({ workspaceId, system, user, timeoutMs = 180000 }) {
  const row = db.prepare('SELECT base_url, api_key_enc, model, image_base_url, image_model, image_provider, image_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(workspaceId);
  if (!row || !row.base_url || !row.model) {
    return { error: 'AI is not configured. Set an endpoint and model in AI settings first.', status: 400 };
  }
  if (!endpointAllowed(row.base_url)) return { error: 'Configured endpoint is not allowed.', status: 400 };

  const key = decrypt(row.api_key_enc) || 'none';
  const url = row.base_url.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let aiRes;
  try {
    aiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: row.model, temperature: 0.6, stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { error: 'Could not reach the AI endpoint: ' + (e.name === 'AbortError' ? 'timed out' : e.message), status: 502 };
  }
  clearTimeout(timer);
  if (!aiRes.ok) {
    const t = await aiRes.text().catch(() => '');
    return { error: `AI endpoint error ${aiRes.status}: ${t.slice(0, 150)}`, status: 502 };
  }
  let json;
  try { json = await aiRes.json(); } catch { return { error: 'AI returned non-JSON.', status: 502 }; }
  const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  try {
    // Models wrap JSON in prose or fences no matter how firmly the prompt says not to; take the
    // outermost object rather than failing on the packaging.
    const m = content.match(/\{[\s\S]*\}/);
    return { parsed: JSON.parse(m ? m[0] : content), row, key };
  } catch {
    return { error: 'AI did not return a usable answer. Try rephrasing.', status: 502 };
  }
}

/*
 * POST /api/ai/generate-slide — editor+; a whole slide from a sentence.
 *
 * Returns a slide CONFIG ({template, fields}) ready to drop onto the editor's canvas, not HTML and
 * not a widget. The caller decides whether that replaces the current slide or becomes a new one —
 * this route has no opinion about the deck, which keeps it usable for both.
 */
router.post('/generate-slide', async (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Editor access required' });
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const out = await askModelForJson({
    workspaceId: req.workspaceId,
    system: slideSystemPrompt(),
    user: prompt,
  });
  if (out.error) return res.status(out.status || 502).json({ error: out.error });

  const spec = normalizeSlideSpec(out.parsed);
  /*
   * ⚠️ COUNT WORDS, NOT ELEMENTS. A model that answers entirely in `image` elements has every one
   * of them demoted to `body` (an image needs a content_id no model can know), leaving text
   * elements with nothing to say — which passed an element-count check as a success and put a
   * blank stage in front of somebody who had just been told "Generated 2 elements".
   */
  const withWords = Object.values(spec.fields).filter((v) => String(v || '').trim()).length;
  if (!spec.template.elements.length || !withWords) {
    return res.status(UPSTREAM_STATUS).json({ error: 'AI returned an empty slide. Try a more specific prompt.' });
  }

  /*
   * ⚠️ RUN IT THROUGH THE RENDERER'S OWN NORMALIZER BEFORE ANSWERING. normalizeSlideSpec is a first
   * pass over model output; normalizeSlide is what every render and every save goes through, and it
   * is total by contract. Answering with something the editor would accept but the renderer would
   * reject is a slide that looks fine until it reaches a screen.
   */
  const settled = SLIDE_RENDER.normalizeSlide(spec);

  /*
   * ⚠️ ANSWER WITH WHAT THE RENDERER SETTLED ON — NOT WITH THE FIRST PASS.
   *
   * The two normalizers disagree on the edges: this file's hex() accepts 3-8 hex digits while the
   * renderer's color() accepts 3 or 6, so an #RRGGBBAA from a model survives here, is accepted by
   * the editor, previews correctly in a browser that understands 8-digit hex — and renders BLACK on
   * the wall. Returning spec.template made normalizeSlide a formality whose verdict was discarded,
   * which is precisely the "the editor would accept this and the renderer will render this are
   * different claims" failure this route claims to prevent.
   */
  const template = {
    background: settled.background,
    elements: settled.elements.map((e) => ({
      slot: e.slot, kind: e.kind,
      box: { x: e.x, y: e.y, w: e.w, ...(e.h == null ? {} : { h: e.h }) },
      style: {
        color: e.style.color, size_cqw: e.style.size, weight: e.style.weight,
        align: e.style.align, opacity: e.style.opacity, radius_cqw: e.style.radius,
      },
      motion: e.motion,
    })),
  };
  /* Words only survive for slots the renderer kept. */
  const fields = {};
  for (const e of template.elements) {
    if (Object.prototype.hasOwnProperty.call(spec.fields, e.slot)) fields[e.slot] = spec.fields[e.slot];
  }

  logActivity(req.user.id, 'ai_generate_slide',
    `Generated a slide from a prompt (${template.elements.length} elements)`, null, getClientIp(req), req.workspaceId);

  res.json({ template, fields, elements: template.elements.length, settle_sec: SLIDE_RENDER.settleTime(settled) });
});

// POST /api/ai/generate-design — editor+; proxies the workspace's endpoint
/*
 * A generated image, turned into REAL LIBRARY CONTENT and handed back as a content_id.
 *
 * ⚠️ WHY THIS EXISTS SEPARATELY FROM /generate-slide. That route returns a LAYOUT — text, boxes,
 * colours — and deliberately refuses image elements, because a slide references pictures by
 * content_id and a model has no way to know a real one. An invented id renders as nothing at all,
 * which is worse than refusing.
 *
 * ⚠️ AND SEPARATELY FROM /generate-design, which hands its images back as an inline data: URL for
 * the Designer's own canvas. A slide cannot use that: it ships to a screen that must hold the file
 * on disk and play it with the WAN down, so the picture has to be a library item like any other.
 * That is the whole difference between a design tool and signage.
 *
 * So this bridges the two — generate, ingest through the SAME path an operator's upload takes
 * (sniffed, thumbnailed, digested, workspace-scoped), and return the id the slide document already
 * knows how to store in background_content_id.
 */

/* ============ generating one image and putting it in the library ============ */

/**
 * Generate an image, store it through the REAL ingest, and return the content row.
 *
 * ⚠️ ONE COPY, because the tmp-file dance below is not incidental. The bytes are written as
 * `<uuid>.part` and handed to ingestUploadedFile so they are SNIFFED for their true type rather
 * than trusted: a generation endpoint that answers with HTML, or with a PNG that is really
 * something else, has to be refused here exactly as an operator's upload would be. A second
 * hand-rolled copy of this in the layered route would be the obvious place for that check to
 * quietly not exist.
 *
 * Throws with the upstream's own words. Callers translate that into a status — see UPSTREAM_STATUS
 * for why it is not 502.
 */
async function generateAndIngest({ row, prompt, width, height, name, userId, workspaceId, transform }) {
  const dataUrl = await generateImage({
    provider: row.image_provider,
    baseUrl: row.image_base_url.replace(/\/+$/, ''),
    apiKey: row.image_api_key_enc ? decrypt(row.image_api_key_enc) : '',
    model: row.image_model,
    prompt,
    width,
    height,
    timeoutMs: 180000,
  });
  if (!dataUrl || dataUrl.indexOf('base64,') < 0) throw new Error('The image endpoint returned no image.');

  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf('base64,') + 7), 'base64');
  const tmpName = `${uuidv4()}.part`;
  const tmpPath = path.join(config.contentDir, tmpName);
  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.writeFileSync(tmpPath, bytes);

  /*
   * A hook for work that has to happen on the BYTES before they become library content — the
   * layered route keys the backdrop out here. It returns whatever it wants the caller to know, and
   * may rewrite the file in place; if it refuses, nothing is ingested and the tmp file is removed.
   */
  let extra = null;
  if (typeof transform === 'function') {
    try {
      extra = await transform(tmpPath);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (e2) { /* already gone */ }
      throw e;
    }
    if (extra && extra.reject) {
      try { fs.unlinkSync(tmpPath); } catch (e2) { /* already gone */ }
      const err = new Error(extra.reject);
      err.rejected = true;
      throw err;
    }
  }

  let content;
  try {
    content = await ingestUploadedFile({
      file: { path: tmpPath, originalname: name, size: fs.statSync(tmpPath).size },
      userId,
      workspaceId,
    });
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (e2) { /* finalizeUpload may already have removed it */ }
    throw e;
  }
  return { content, extra };
}

router.post('/generate-background', async (req, res) => {
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const row = db.prepare('SELECT image_base_url, image_model, image_provider, image_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  const imgBase = row && row.image_base_url ? row.image_base_url.replace(/\/+$/, '') : '';
  if (!imgBase || !row.image_provider) {
    return res.status(400).json({ error: 'No image endpoint configured for this workspace.' });
  }
  if (!endpointAllowed(imgBase)) return res.status(400).json({ error: 'Image endpoint URL not allowed.' });

  let content;
  try {
    ({ content } = await generateAndIngest({
      row,
      prompt,
      /*
       * The DECK'S shape, not a fixed 16:9 — a portrait deck given a landscape background crops to
       * a centre band. Clamped, because these numbers pick an aspect ratio at the provider and a
       * hostile pair should not turn into an absurd request.
       */
      width: clampN(req.body && req.body.width, 256, 4096, 1792),
      height: clampN(req.body && req.body.height, 256, 4096, 1024),
      name: `ai-background-${prompt.slice(0, 40).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'slide'}.png`,
      userId: req.user.id,
      workspaceId: req.workspaceId,
    }));
  } catch (e) {
    /*
     * ⚠️ 502 IS NOT USABLE HERE — CLOUDFLARE REPLACES THE BODY. A 502 from the origin is rendered
     * as Cloudflare's own error page, so the operator sees "request failed" while the server is
     * answering in 0.1s with the exact reason (measured: xAI's "Argument not supported: size"
     * reached the origin and never reached the browser). The upstream failed, but 502 is the one
     * status that guarantees nobody finds out why, so this reports 400 with the reason intact.
     */
    const why = String(e && e.message || e).slice(0, 200);
    console.warn('[ai] background generation failed:', why);
    return res.status(400).json({ error: 'Image generation failed: ' + why });
  }

  logActivity(req.user.id, 'ai_background_generated', prompt.slice(0, 120), null, getClientIp(req), req.workspaceId);
  res.json({ content_id: content.id, filename: content.filename, width: content.width, height: content.height });
});


/* ============ layered slides: a background plus cut-out objects that animate ============ */

/*
 * ⚠️ THE BACKDROP INSTRUCTION IS WRITTEN BY THE SERVER, NOT BY THE MODEL.
 *
 * The whole feature rests on each object arriving on a flat, uniform backdrop, because that is what
 * lib/image-key.js removes. Left to describe an object freely a model writes "a pumpkin on a wooden
 * table in soft autumn light" — which is a better picture and completely unusable, since keying it
 * takes the table, the light and half the pumpkin. So the model supplies the SUBJECT and this
 * supplies the staging, every time, in words measured against real output.
 */
const CHROMA = Object.freeze({
  green:   { rgb: '#0BC314', words: 'a perfectly flat uniform chroma-key green (#0BC314)' },
  magenta: { rgb: '#FF00FF', words: 'a perfectly flat uniform chroma-key magenta (#FF00FF)' },
  blue:    { rgb: '#0047FF', words: 'a perfectly flat uniform chroma-key blue (#0047FF)' },
});

/*
 * ⚠️ THE WORDS ARE QUOTED, ALONE ON THEIR OWN LINE, AND REPEATED.
 *
 * Image models misspell. That is the whole risk of this feature — a headline is the largest thing
 * on the slide and a wrong one is worse than a plain font would ever have been. Nothing here can
 * guarantee the spelling, so the prompt does the only things that measurably help: it states the
 * string once, exactly, in quotes, and says that nothing else may appear. Everything about HOW it
 * looks is kept in a separate clause so the two cannot blur together and turn a style word into
 * something the model tries to write.
 */
function letteringPrompt(words, style, backdrop) {
  const c = CHROMA[backdrop] || CHROMA.green;
  return `The words "${words}" written as display lettering, and NOTHING else. `
    + `Spell it exactly: "${words}". No other words, no extra letters, no signature, no watermark. `
    + `Style: ${style}. `
    + `The lettering fills the frame, isolated on ${c.words} background. `
    + 'No shadow on the background, no gradient, no vignette, no border, no frame.';
}

function objectPrompt(subject, backdrop) {
  const c = CHROMA[backdrop] || CHROMA.green;
  return `${subject}. A single subject, centred, complete and not cropped, photographed straight on, `
    + `isolated on ${c.words} background. No shadow on the background, no gradient, no vignette, `
    + `no text, no border. Product cutout style.`;
}

/*
 * ⚠️ A CAP, AND IT IS ABOUT MONEY. Each object is a separate call to an image endpoint the operator
 * pays for, on top of the background — so this route costs (objects + 1) generations per press,
 * and a request for "twelve leaves" would quietly spend twelve times what the operator expected.
 * Four is enough for the compositions this is for and keeps the worst case legible.
 */
const MAX_OBJECTS = 4;

/*
 * ⚠️ REFUSAL THRESHOLDS, because a bad cut-out still looks like a cut-out.
 *
 * spread  — how far the backdrop's border pixels wander from its median. A flat backdrop measures
 *           low single digits; real output that drifted into a gradient measured far above this,
 *           and keying a gradient leaves a torn edge or a ghost of the backdrop still attached.
 * opaque  — a value near 1 means the key removed nothing, i.e. the generator ignored the backdrop
 *           instruction entirely and the "cut-out" is a rectangular photo with its scene intact.
 *           Laid onto a slide that reads as a broken image rather than a missing one.
 */
/*
 * ⚠️ WHERE THE WORDS GO, AND IT IS ENFORCED RATHER THAN REQUESTED.
 *
 * The plan prompt asks the model to keep objects clear of the headline. Measured against real
 * output it does not: a run that produced a perfectly good background, leaf and cup also dropped a
 * pair of mittens directly under "20% OFF". Asking is the right thing to do — a model that
 * cooperates gives a better composition than one that is corrected — but it cannot be the only
 * thing, because the failure lands on somebody's wall and reads as a broken slide.
 */
const TEXT_ZONE = Object.freeze({ x: 4, y: 20, w: 62, h: 56 });

/**
 * How large the subhead can be set, given how much of it there is.
 *
 * ⚠️ BECAUSE THE MODEL IGNORES THE LENGTH IT IS ASKED FOR. The plan prompt says at most 40
 * characters; a real run answered with 48 ("Autumn Sale - Warm up your home with rustic charm"),
 * which at a fixed 4.5cqw wrapped to three lines and ran out of the bottom of the text band and
 * over the objects. Asking is still worth doing, but the geometry cannot depend on the answer.
 *
 * Scaling the type to the copy is what a person would do, needs no measurement, and degrades
 * gracefully: a long subhead gets smaller rather than getting clipped or colliding.
 */
function subheadSize(text) {
  const n = text.length;
  if (n <= 32) return 4.5;
  if (n <= 56) return 3.6;
  return 3;
}

/** Push an object clear of the text band, if it would sit inside it. */
function placeClear(box) {
  const overlaps = box.x < TEXT_ZONE.x + TEXT_ZONE.w && box.x + box.w > TEXT_ZONE.x
    && box.y < TEXT_ZONE.y + TEXT_ZONE.h && box.y + box.h > TEXT_ZONE.y;
  if (!overlaps) return box;
  /*
   * Moved sideways rather than shrunk or dropped: the model chose a vertical position that suits
   * the composition, and an object scaled down to fit a gap looks like a mistake in a way that the
   * same object further right does not. Clamped so a wide object still lands on the slide.
   */
  const x = Math.min(100 - box.w, TEXT_ZONE.x + TEXT_ZONE.w + 2);
  return { ...box, x: Math.max(0, x) };
}

const MAX_BACKDROP_SPREAD = 70;
const MAX_OPAQUE = 0.985;

function layeredSystemPrompt(maxObjects) {
  return 'You plan a digital-signage slide as SEPARATE LAYERS so each part can animate on its own.\n'
    + 'Answer with ONE JSON object and nothing else:\n'
    + '{"background_prompt":"...","headline":"...","subhead":"...",'
    + '"lettering":{"style":"...","backdrop":"green|magenta|blue"},'
    + '"objects":[{"subject":"...","backdrop":"green|magenta|blue","x":N,"y":N,"w":N,"h":N,'
    + '"animation":"fade|slideL|slideR|slideU|slideD|zoom|wipe","delay":N}]}\n'
    + '\n'
    + `Rules. At most ${maxObjects} objects. x, y, w and h are PERCENTAGES of the slide, 0-100; `
    + 'objects must not cover the middle-left area where the headline sits. '
    + 'delay is seconds, 0-2, and each object should differ so they arrive in sequence. '
    + 'headline is at most 14 characters and subhead at most 40, because both are set large '
    + 'over a photograph and a long one wraps into the other. '
    + '\n'
    + 'subject names ONE physical thing with no setting and no background — "a ripe orange pumpkin '
    + 'with a curled stem", never "a pumpkin on a table". The background is described separately '
    + 'and must contain NO text and none of the objects.\n'
    + '\n'
    + 'lettering.style describes HOW the headline should be painted - "thick red brush script with '
    + 'rough dry-brush edges", "condensed gold serif with a subtle shadow" - and never says what it '
    + 'says; the words come from headline. Choose a style that suits the scene.\n'
    + '\n'
    + 'backdrop is the screen colour the object will be photographed against and then removed from, '
    + 'so it MUST NOT be a colour that appears in the object itself: choose magenta for green or '
    + 'blue subjects, green for red, orange, pink or purple subjects, blue for yellow subjects.';
}

/**
 * POST /api/ai/generate-layered — editor+; a slide whose parts are separate, animatable images.
 *
 * This is the thing the designer could never do and no other signage product does: the operator
 * describes a scene, and gets back a background plus individually cut-out objects, each its own
 * element with its own entrance — rather than one flat picture with text on top.
 */
router.post('/generate-layered', async (req, res) => {
  if (!canEdit(req)) return res.status(403).json({ error: 'Editor access required' });
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const row = db.prepare('SELECT image_base_url, image_model, image_provider, image_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  if (!row || !row.image_base_url || !row.image_provider) {
    return res.status(400).json({ error: 'No image endpoint configured for this workspace.' });
  }
  if (!endpointAllowed(row.image_base_url)) return res.status(400).json({ error: 'Image endpoint URL not allowed.' });

  const want = clampN(req.body && req.body.objects, 1, MAX_OBJECTS, 3);
  const W = clampN(req.body && req.body.width, 256, 4096, 1792);
  const H = clampN(req.body && req.body.height, 256, 4096, 1024);

  const plan = await askModelForJson({
    workspaceId: req.workspaceId,
    system: layeredSystemPrompt(want),
    user: prompt,
  });
  if (plan.error) return res.status(plan.status === 400 ? 400 : UPSTREAM_STATUS).json({ error: plan.error });

  const p = plan.parsed && typeof plan.parsed === 'object' ? plan.parsed : {};
  const objects = (Array.isArray(p.objects) ? p.objects : []).slice(0, want)
    .filter((o) => o && typeof o.subject === 'string' && o.subject.trim());
  const bgPrompt = String(p.background_prompt || prompt).slice(0, 500);

  const ops = require('../lib/image-ops');
  const elements = [];
  const fields = {};
  const notes = [];

  /*
   * ⚠️ THE BACKGROUND FIRST, AND A FAILURE HERE IS FATAL WHILE AN OBJECT FAILURE IS NOT.
   * Losing one object costs a layer; losing the background costs the slide, and continuing would
   * hand back cut-outs floating on a flat colour that nobody asked for.
   */
  let backgroundId = null;
  try {
    const { content } = await generateAndIngest({
      row, prompt: `${bgPrompt}. No text, no words, no lettering anywhere in the image.`,
      width: W, height: H,
      name: `ai-layer-bg-${prompt.slice(0, 32).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'slide'}.png`,
      userId: req.user.id, workspaceId: req.workspaceId,
    });
    backgroundId = content.id;
  } catch (e) {
    const why = String(e && e.message || e).slice(0, 200);
    console.warn('[ai] layered background failed:', why);
    return res.status(400).json({ error: 'Background generation failed: ' + why });
  }

  /*
   * ⚠️ SEQUENTIAL, NOT Promise.all. Each of these holds a full RGBA bitmap while it is keyed, and
   * the image worker runs one job at a time by design (see lib/image-ops) — firing four at once
   * would queue behind each other anyway while holding four decoded images in heap, on the small
   * hosts this product is expected to run on.
   */
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const backdrop = Object.prototype.hasOwnProperty.call(CHROMA, o.backdrop) ? o.backdrop : 'green';
    const subject = String(o.subject).slice(0, 300);
    let cut = null;
    let content = null;
    try {
      ({ content, extra: cut } = await generateAndIngest({
        row,
        prompt: objectPrompt(subject, backdrop),
        width: 1024, height: 1024,
        name: `ai-layer-${subject.slice(0, 32).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'object'}.png`,
        userId: req.user.id, workspaceId: req.workspaceId,
        transform: async (tmpPath) => {
          const r = await ops.cutout(tmpPath, tmpPath, {});
          if (!r.written) return { reject: r.reason };
          if (r.spread > MAX_BACKDROP_SPREAD) {
            return { reject: `the generated backdrop was not flat (spread ${r.spread.toFixed(0)})` };
          }
          if (r.opaque > MAX_OPAQUE) {
            return { reject: 'the generated image had no backdrop to remove' };
          }
          return r;
        },
      }));
    } catch (e) {
      // One layer lost is a slide with fewer layers, which is still a slide. Reported, never silent.
      notes.push(`"${subject.slice(0, 60)}" was skipped: ${String(e && e.message || e).slice(0, 120)}`);
      continue;
    }

    elements.push({
      slot: `obj_${i}`,
      kind: 'image',
      content_id: content.id,
      box: placeClear({
        x: clampN(o.x, -20, 110, 60), y: clampN(o.y, -20, 110, 40),
        w: clampN(o.w, 5, 100, 30), h: clampN(o.h, 5, 100, 40),
      }),
      // ⚠️ contain, always. A cut-out cropped to fill its box is sliced through the object itself.
      fit: 'contain',
      motion: {
        animation: Object.prototype.hasOwnProperty.call(SLIDE_RENDER.ANIMATIONS, o.animation) ? o.animation : 'slideU',
        delay: clampN(o.delay, 0, 2, 0.4 + i * 0.25),
        duration: 0.7,
        easing: 'soft',
      },
      style: { opacity: 1 },
    });
  }

  // Text last, so it paints over the objects rather than under them.
  const headline = String(p.headline || '').slice(0, SLIDE_RENDER.MAX_FIELD_CHARS);
  const subhead = String(p.subhead || '').slice(0, SLIDE_RENDER.MAX_FIELD_CHARS);

  /*
   * ⚠️ THE HEADLINE AS PAINTED ARTWORK, WITH THE WORDS STILL KEPT AS A FIELD.
   *
   * This is the part a bundled font cannot do — brush script, dry-brush edges, the lettering that
   * makes a seasonal poster look designed rather than typeset. It goes through the same generate,
   * key and refuse path as an object, because it IS one: a picture on a flat backdrop.
   *
   * ⚠️ AND IT FALLS BACK TO REAL TYPE RATHER THAN FAILING. If the lettering cannot be generated, or
   * comes back on a backdrop that will not key, the slide gets an ordinary `head` element with the
   * same words — set in a bundled font, correctly spelled, on every panel. A missing headline is
   * not an acceptable outcome for a slide whose whole purpose is to say one thing.
   */
  let letteringDone = false;
  const wantLettering = headline && req.body && req.body.lettering !== false;
  if (wantLettering) {
    const lp = (p.lettering && typeof p.lettering === 'object') ? p.lettering : {};
    const style = String(lp.style || 'bold condensed poster lettering with clean edges').slice(0, 200);
    const backdrop = Object.prototype.hasOwnProperty.call(CHROMA, lp.backdrop) ? lp.backdrop : 'green';
    try {
      const { content } = await generateAndIngest({
        row,
        prompt: letteringPrompt(headline, style, backdrop),
        // Wide and short: lettering is a banner, and a square frame wastes most of the pixels on
        // backdrop that is about to be thrown away.
        width: 1024, height: 512,
        name: `ai-lettering-${headline.slice(0, 32).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'headline'}.png`,
        userId: req.user.id, workspaceId: req.workspaceId,
        transform: async (tmpPath) => {
          const r = await ops.cutout(tmpPath, tmpPath, {});
          if (!r.written) return { reject: r.reason };
          if (r.spread > MAX_BACKDROP_SPREAD) {
            return { reject: `the generated backdrop was not flat (spread ${r.spread.toFixed(0)})` };
          }
          if (r.opaque > MAX_OPAQUE) return { reject: 'the generated image had no backdrop to remove' };
          return r;
        },
      });
      elements.push({
        slot: 'headline', kind: 'lettering', content_id: content.id,
        box: { x: 5, y: 22, w: 58, h: 22 },
        motion: { animation: 'slideD', delay: 0.15, duration: 0.7, easing: 'soft' },
        style: { opacity: 1 },
      });
      fields.headline = headline;
      letteringDone = true;
      /*
       * ⚠️ SAID OUT LOUD, EVERY TIME. Nothing here can verify that the picture spells the headline
       * correctly, and a misspelled word set two feet tall is the worst thing this feature can
       * produce. The operator is the check, so they have to be told there is something to check.
       */
      notes.push(`The headline is generated lettering — check it reads "${headline}" before publishing.`);
    } catch (e) {
      notes.push(`Lettering fell back to type: ${String(e && e.message || e).slice(0, 120)}`);
    }
  }

  if (headline && !letteringDone) {
    elements.push({
      /*
       * ⚠️ WIDER AND SMALLER THAN IT LOOKS LIKE IT NEEDS TO BE. At 12cqw in a 52%-wide box, a
       * headline as short as "20% OFF" wraps to two lines and the second line lands on top of the
       * subhead below — measured, on a real run. Nothing server-side can measure text, so the box
       * has to be sized for the wrap that will happen rather than the one line that was intended.
       */
      slot: 'headline', kind: 'head', box: { x: 5, y: 24, w: 60 },
      style: { color: '#FFFFFF', size_cqw: 10, weight: 900, align: 'left' },
      motion: { animation: 'slideD', delay: 0.15, duration: 0.6, easing: 'soft' },
    });
    fields.headline = headline;
  }
  if (subhead) {
    elements.push({
      // Far enough below a two-line headline to clear it. See the headline's box.
      slot: 'subhead', kind: 'body', box: { x: 5, y: 58, w: 56 },
      style: { color: '#FFFFFF', size_cqw: subheadSize(subhead), weight: 600, align: 'left' },
      motion: { animation: 'wipe', delay: 0.5, duration: 0.7, easing: 'soft' },
    });
    fields.subhead = subhead;
  }

  const spec = {
    template: {
      background: '#101318',
      background_content_id: backgroundId,
      // A scrim by default: these backgrounds are photographic and the headline sits on top of one.
      background_dim: 0.28,
      elements,
    },
    fields,
  };

  /*
   * ⚠️ THROUGH THE RENDERER'S OWN NORMALIZER BEFORE ANSWERING, exactly as generate-slide does.
   * Anything this route builds that the renderer would reject is a slide that looks right in the
   * editor and is wrong on a screen.
   */
  const settled = SLIDE_RENDER.normalizeSlide(spec);

  logActivity(req.user.id, 'ai_layered_generated',
    `${prompt.slice(0, 90)} (${elements.filter((e) => e.kind === 'image').length} layers)`,
    null, getClientIp(req), req.workspaceId);

  res.json({
    template: {
      background: settled.background,
      background_content_id: settled.backgroundContentId,
      background_dim: settled.backgroundDim,
      elements: settled.elements.map((e, i) => ({
        slot: e.slot, kind: e.kind,
        box: { x: e.x, y: e.y, w: e.w, ...(e.h == null ? {} : { h: e.h }) },
        content_id: e.contentId,
        style: {
          color: e.style.color, font: e.style.font, size_cqw: e.style.size,
          weight: e.style.weight, align: e.style.align,
          radius_cqw: e.style.radius, opacity: e.style.opacity,
        },
        motion: e.motion,
        ...(e.cfg && e.cfg.fit ? { fit: e.cfg.fit } : {}),
      })),
    },
    fields: settled.fields,
    // What was asked for versus what arrived, so the editor can say so rather than quietly showing
    // fewer layers than the operator paid for.
    generated: elements.filter((e) => e.kind === 'image').length,
    requested: objects.length,
    notes,
  });
});

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
    return res.status(UPSTREAM_STATUS).json({ error: 'Could not reach the AI endpoint: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
  }
  clearTimeout(timer);
  if (!aiRes.ok) {
    const t = await aiRes.text().catch(() => '');
    return res.status(UPSTREAM_STATUS).json({ error: `AI endpoint error ${aiRes.status}: ${t.slice(0, 150)}` });
  }
  let json;
  try { json = await aiRes.json(); } catch { return res.status(UPSTREAM_STATUS).json({ error: 'AI returned non-JSON.' }); }
  const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  let parsed;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : content);
  } catch { return res.status(UPSTREAM_STATUS).json({ error: 'AI did not return a usable design. Try rephrasing.' }); }
  const design = normalizeDesign(parsed);
  if (!design.elements.length && !design.background_prompt) return res.status(UPSTREAM_STATUS).json({ error: 'AI returned an empty design. Try a more specific prompt.' });

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
