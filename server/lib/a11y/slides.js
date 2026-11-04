'use strict';

/*
 * Accessibility of one slide (a deck page, a Make-a-sign sign, a slide widget, a slide-kind
 * community template): every run of text, against what is actually behind it.
 *
 * ⚠️ THE BACKGROUND IS WORKED OUT THE WAY THE RENDERER PAINTS IT (lib/slide-render.js): the slide
 * colour, then the photo with its dim scrim, then every box drawn BEFORE the text element in
 * document order (later elements are on top, so only earlier ones can be behind it). Five points
 * across the text's box are composed separately and the worst one counts, because a headline that
 * starts on a dark panel and runs off it onto a pale one is unreadable exactly where it leaves.
 *
 * Geometry: the stage is 100 units wide (1 unit = 1cqw, the renderer's type unit) and 100·H/W tall;
 * x and w are already % of width = units, y and h are % of height. Text height is not stored (it
 * grows with the words), so it is estimated from the character count with a generous average glyph
 * width — the box is only used to find what is behind the text, and a slightly-too-tall estimate
 * errs towards sampling more background, not less.
 */

const slideRender = require('../slide-render');
const C = require('./contrast');
const { checkRun } = require('./text-check');

const TEXT_KINDS = new Set(['head', 'body', 'stat', 'countdown', 'clock', 'date']);
const LIVE_SAMPLE = { clock: '00:00', date: 'Wednesday 30 September', countdown: '00d 00h 00m' };
const AVG_GLYPH_EM = 0.52;
const LH = 1.08;

function aspectRatio(aspect) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(aspect || '16:9'));
  const w = m ? Number(m[1]) : 16;
  const h = m ? Number(m[2]) : 9;
  return w > 0 && h > 0 ? h / w : 9 / 16;
}

function estimateLines(text, sizeUnits, widthUnits) {
  const perLine = Math.max(1, Math.floor(widthUnits / (sizeUnits * AVG_GLYPH_EM)));
  return String(text).split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / perLine)), 0);
}

/** The 10th and 90th percentile luminance of the grid cells under a stage rectangle. */
function gridRange(grid, rect, stageW, stageH) {
  if (!grid || !Array.isArray(grid.lum) || !grid.w || !grid.h) return null;
  // background-size: cover, centred. Map stage fractions to image fractions.
  const ia = grid.w / grid.h;
  const sa = stageW / stageH;
  let sx = 1, sy = 1, ox = 0, oy = 0;
  if (ia > sa) { sx = sa / ia; ox = (1 - sx) / 2; } else { sy = ia / sa; oy = (1 - sy) / 2; }
  const fx0 = ox + (rect.x0 / stageW) * sx, fx1 = ox + (rect.x1 / stageW) * sx;
  const fy0 = oy + (rect.y0 / stageH) * sy, fy1 = oy + (rect.y1 / stageH) * sy;
  const cx0 = Math.max(0, Math.floor(fx0 * grid.w)), cx1 = Math.min(grid.w - 1, Math.ceil(fx1 * grid.w) - 1);
  const cy0 = Math.max(0, Math.floor(fy0 * grid.h)), cy1 = Math.min(grid.h - 1, Math.ceil(fy1 * grid.h) - 1);
  const vals = [];
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) vals.push(grid.lum[y * grid.w + x]);
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const pick = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return [pick(0.1), pick(0.9)];
}

/** sRGB black at alpha `d` over a pixel of luminance `l` → the luminance that reaches the eye. */
function dimLum(l, d) {
  if (!d) return l;
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055; // to sRGB
  const c2 = c * (1 - d);
  return c2 <= 0.04045 ? c2 / 12.92 : ((c2 + 0.055) / 1.055) ** 2.4;
}

const covers = (box, px, py) => px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1;

/**
 * @param {object} rawSlide  { template, fields } as stored
 * @param {object} view      { distanceM, widthMm }
 * @param {object} [opts]    { imageGrid(contentId) → { grid } | { unknown } }
 * @returns {Array<object>}  issues with `where` = { element, slot, kind } and `text`
 */
function checkSlide(rawSlide, view, opts = {}) {
  const s = slideRender.normalizeSlide(rawSlide);
  const W = 100;
  const H = 100 * aspectRatio(s.aspect);
  const imageGrid = typeof opts.imageGrid === 'function' ? opts.imageGrid : () => ({ unknown: 'image' });

  const boxes = s.elements.map((e) => {
    const x0 = e.x, x1 = e.x + e.w;
    const y0 = (e.y / 100) * H;
    const y1 = e.h == null ? y0 : y0 + (e.h / 100) * H;
    return { x0, x1, y0, y1 };
  });

  // The slide's own backdrop, once: a video in front of everything, else the photo, else the colour.
  let photo = null;
  if (s.backgroundVideoContentId) photo = { unknown: 'video' };
  else if (s.backgroundContentId) {
    const g = imageGrid(s.backgroundContentId) || { unknown: 'image' };
    photo = g.grid ? { grid: g.grid } : { unknown: g.unknown || 'image' };
  }
  const baseRgb = C.parseHex(s.background) || [0, 0, 0];

  const issues = [];
  s.elements.forEach((e, i) => {
    if (e.kind === 'lettering') {
      if (e.contentId) issues.push({ code: 'text_in_image', severity: 'note', values: { kind: 'lettering' }, where: { element: i, slot: e.slot, kind: e.kind }, text: excerpt(s.fields[e.slot]) });
      return;
    }
    if (!TEXT_KINDS.has(e.kind)) return;
    const text = LIVE_SAMPLE[e.kind] && !s.fields[e.slot] ? LIVE_SAMPLE[e.kind] : String(s.fields[e.slot] || '');
    if (!text.trim() || e.style.opacity <= 0.02) return;

    const size = e.style.size;
    const lines = estimateLines(text, size, e.w);
    const y0 = (e.y / 100) * H;
    const tall = e.h != null ? Math.min((e.h / 100) * H, lines * size * LH) : lines * size * LH;
    const rect = { x0: Math.max(0, e.x), x1: Math.min(W, e.x + e.w), y0: Math.max(0, y0), y1: Math.min(H, y0 + Math.max(size * LH, tall)) };
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return; // entirely off the stage

    /*
     * The background under five points of the INK, not of the box: a short centred line in a wide
     * box covers only its middle, and the box's corners may lie on a different panel entirely. The
     * width of the longest line is estimated and placed by the element's alignment; points sit on
     * the middle of the first and the last line.
     */
    const longest = Math.max(...text.split('\n').map((p) => p.length));
    const inkW = Math.min(rect.x1 - rect.x0, longest * size * AVG_GLYPH_EM);
    const ix0 = e.style.align === 'center' ? (rect.x0 + rect.x1 - inkW) / 2 : e.style.align === 'right' ? rect.x1 - inkW : rect.x0;
    const firstY = Math.min(rect.y1, rect.y0 + size * LH * 0.5);
    const lastY = Math.max(firstY, Math.min(rect.y1, rect.y0 + tall - size * LH * 0.5));
    const pts = [[0.5, firstY], [0.1, firstY], [0.9, firstY], [0.1, lastY], [0.9, lastY]]
      .map(([fx, py]) => [ix0 + inkW * fx, py]);
    const bgs = new Map();
    for (const [px, py] of pts) {
      let bg;
      if (photo && photo.grid) {
        const r = gridRange(photo.grid, rect, W, H);
        bg = r ? { range: [dimLum(r[0], s.backgroundDim), dimLum(r[1], s.backgroundDim)], dim: s.backgroundDim } : { rgb: baseRgb };
      } else if (photo) {
        // A dark enough scrim over an unreadable photo is still a known colour.
        bg = s.backgroundDim >= 0.95 ? { rgb: [0, 0, 0] } : { unknown: photo.unknown };
      } else bg = { rgb: baseRgb };
      for (let j = 0; j < i; j++) {
        const o = s.elements[j];
        if (!covers(boxes[j], px, py)) continue;
        if (o.kind === 'box' || o.kind === 'rule') {
          const col = C.parseHex(o.style.color) || [255, 255, 255];
          const a = o.style.opacity;
          if (a >= 0.999) bg = { rgb: col };
          else if (bg.rgb) bg = { rgb: C.blend(col, bg.rgb, a) };
          else if (bg.range) { const lc = C.luminance(col); bg = { range: bg.range.map((l) => a * lc + (1 - a) * l), dim: bg.dim }; }
          else if (a >= 0.95) bg = { rgb: col };
        } else if (o.kind === 'image' || o.kind === 'lettering') {
          bg = { unknown: 'image' };
        } else if (o.kind === 'video') {
          bg = { unknown: 'video' };   // moving pictures: no colour to measure, like a background video
        } else if (o.kind === 'qr') {
          bg = { rgb: C.parseHex(o.cfg && o.cfg.bg) || [255, 255, 255] };
        }
      }
      const key = bg.rgb ? 'c' + C.toHex(bg.rgb) : bg.range ? 'r' + bg.range.map((v) => v.toFixed(3)).join(',') : 'u' + bg.unknown;
      bgs.set(key, bg);
    }

    const fontMm = (size / 100) * view.widthMm;
    let worst = null;   // the contrast-ish issue that reads worst across the sampled backgrounds
    let sizeIssue = null;
    for (const bg of bgs.values()) {
      const found = checkRun({ text, color: e.style.color, opacity: e.style.opacity, weight: e.style.weight, fontMm, bg }, view);
      for (const f of found) {
        if (f.code === 'text_small') { sizeIssue = f; continue; }
        if (!worst || rank(f) > rank(worst)) worst = f;
      }
    }
    const where = { element: i, slot: e.slot, kind: e.kind };
    if (worst) issues.push({ ...worst, where, text: excerpt(text) });
    if (sizeIssue) issues.push({ ...sizeIssue, where, text: excerpt(text), values: { ...sizeIssue.values, size_cqw: size, min_size_cqw: Math.ceil((sizeIssue.values.min_font_mm / view.widthMm) * 1000) / 10 } });
  });
  return issues;
}

/** Which of two findings for the same text is the one to report: errors first, then the lowest ratio. */
function rank(f) {
  const sev = { error: 3, warning: 2, note: 1 }[f.severity] || 0;
  const ratio = f.values && Number.isFinite(f.values.ratio) ? f.values.ratio : 21;
  return sev * 100 + (21 - ratio);
}

function excerpt(t) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

/** Every content id a slide's checks would want a luminance grid for (the background photo only). */
function imageIdsOf(rawSlide) {
  const t = rawSlide && rawSlide.template;
  return t && typeof t.background_content_id === 'string' && !t.background_video_content_id ? [t.background_content_id] : [];
}

module.exports = { checkSlide, imageIdsOf, excerpt, gridRange, dimLum, aspectRatio };
