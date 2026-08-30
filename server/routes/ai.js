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
router.post('/generate-background', async (req, res) => {
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const row = db.prepare('SELECT image_base_url, image_model, image_provider, image_api_key_enc FROM ai_settings WHERE workspace_id = ?').get(req.workspaceId);
  const imgBase = row && row.image_base_url ? row.image_base_url.replace(/\/+$/, '') : '';
  if (!imgBase || !row.image_provider) {
    return res.status(400).json({ error: 'No image endpoint configured for this workspace.' });
  }
  if (!endpointAllowed(imgBase)) return res.status(400).json({ error: 'Image endpoint URL not allowed.' });

  let dataUrl;
  try {
    dataUrl = await generateImage({
      provider: row.image_provider,
      baseUrl: imgBase,
      apiKey: row.image_api_key_enc ? decrypt(row.image_api_key_enc) : '',
      model: row.image_model,
      prompt,
      /*
       * The DECK'S shape, not a fixed 16:9 — a portrait deck given a landscape background crops to
       * a centre band. Clamped, because these numbers pick an aspect ratio at the provider and a
       * hostile pair should not turn into an absurd request.
       */
      width: clampN(req.body && req.body.width, 256, 4096, 1792),
      height: clampN(req.body && req.body.height, 256, 4096, 1024),
      timeoutMs: 180000,
    });
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
  if (!dataUrl || dataUrl.indexOf('base64,') < 0) {
    console.warn('[ai] background generation: endpoint returned no image');
    return res.status(400).json({ error: 'The image endpoint returned no image.' });
  }

  /*
   * ⚠️ WRITTEN AS `<uuid>.part`, because that is what finalizeUpload expects and what makes this go
   * through the real ingest: the bytes are SNIFFED for their true type rather than trusted. A
   * generation endpoint that returned HTML, or a PNG that is really something else, must be refused
   * here exactly as an operator's upload would be — not written into the library because we asked
   * for an image and assumed we got one.
   */
  const tmpName = `${uuidv4()}.part`;
  const tmpPath = path.join(config.contentDir, tmpName);
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf('base64,') + 7), 'base64');
  try {
    fs.mkdirSync(config.contentDir, { recursive: true });
    fs.writeFileSync(tmpPath, bytes);
  } catch (e) {
    return res.status(500).json({ error: 'Could not store the generated image.' });
  }

  let content;
  try {
    content = await ingestUploadedFile({
      file: {
        path: tmpPath,
        originalname: `ai-background-${prompt.slice(0, 40).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'slide'}.png`,
        size: bytes.length,
      },
      userId: req.user.id,
      workspaceId: req.workspaceId,
    });
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (e2) { /* finalizeUpload may already have removed it */ }
    return res.status(400).json({ error: String(e && e.message || e).slice(0, 200) });
  }

  logActivity(req.user.id, 'ai_background_generated', prompt.slice(0, 120), null, getClientIp(req), req.workspaceId);
  res.json({ content_id: content.id, filename: content.filename, width: content.width, height: content.height });
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
