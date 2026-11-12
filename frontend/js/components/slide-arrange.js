/*
 * The arithmetic behind the Slides editor's PowerPoint-style canvas: resize by handle, align,
 * distribute, layer order, copy/paste identity and undo history. Pure — no DOM, no state — so the
 * editor (views/slides.js) wires it to pointer and key events and test/slide-arrange.test.js pins it.
 *
 * Every rect is { x, y, w, h } in percent of the stage, the unit the deck document stores, so a
 * result can be written straight back into an element's `box`.
 */

/*
 * Resize `start` by dragging handle `dir` (n, ne, e, se, s, sw, w, nw) by (dx, dy).
 *
 * keepAspect holds w:h (images by default, Shift toggles); fromCenter grows both sides at once
 * (Alt/Option). The edge opposite the handle stays put, as it does in PowerPoint — except with
 * keepAspect on a side handle, where the other axis grows about its centre, because there is no
 * opposite edge on that axis to anchor to.
 */
export function resizeRect(start, dir, dx, dy, { keepAspect = false, fromCenter = false, minW = 1, minH = 0.5 } = {}) {
  const k = fromCenter ? 2 : 1;
  const east = dir.includes('e'); const west = dir.includes('w');
  const south = dir.includes('s'); const north = dir.includes('n');
  let w = start.w + k * (east ? dx : west ? -dx : 0);
  let h = start.h + k * (south ? dy : north ? -dy : 0);
  const horizontal = east || west; const vertical = north || south;

  if (keepAspect && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    if (horizontal && vertical) {
      // A corner: whichever axis the pointer moved further (relatively) decides the scale.
      const sw = w / start.w; const sh = h / start.h;
      // Dragged through the opposite corner: shrink to the minimum rather than turn inside out.
      const s = Math.max(1e-6, Math.abs(sw - 1) >= Math.abs(sh - 1) ? sw : sh);
      w = start.w * s; h = start.h * s;
    } else if (horizontal) { w = Math.max(1e-6, w); h = w / ratio; }
    else { h = Math.max(1e-6, h); w = h * ratio; }
    // The minimum applies to whichever side would break it first, keeping the ratio.
    const grow = Math.max(minW / w, minH / h, 1);
    w *= grow; h *= grow;
  } else {
    w = Math.max(minW, w); h = Math.max(minH, h);
  }

  let x; let y;
  if (fromCenter) { x = start.x + (start.w - w) / 2; y = start.y + (start.h - h) / 2; }
  else {
    x = west ? start.x + start.w - w : (keepAspect && !horizontal ? start.x + (start.w - w) / 2 : start.x);
    y = north ? start.y + start.h - h : (keepAspect && !vertical ? start.y + (start.h - h) / 2 : start.y);
  }
  return { x, y, w, h };
}

/** The smallest rect that holds every rect given. */
export function boundsOf(rects) {
  const x = Math.min(...rects.map((r) => r.x)); const y = Math.min(...rects.map((r) => r.y));
  const r2 = Math.max(...rects.map((r) => r.x + r.w)); const b = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: r2 - x, h: b - y };
}

/*
 * Line rects up. With two or more they align to each other (the selection's own bounds), with one
 * to `frame` (the slide) — PowerPoint's default in both cases. Returns new rects, same order.
 */
export function alignRects(rects, how, frame = { x: 0, y: 0, w: 100, h: 100 }) {
  const f = rects.length > 1 ? boundsOf(rects) : frame;
  return rects.map((r) => {
    const o = { ...r };
    if (how === 'left') o.x = f.x;
    else if (how === 'center') o.x = f.x + (f.w - r.w) / 2;
    else if (how === 'right') o.x = f.x + f.w - r.w;
    else if (how === 'top') o.y = f.y;
    else if (how === 'middle') o.y = f.y + (f.h - r.h) / 2;
    else if (how === 'bottom') o.y = f.y + f.h - r.h;
    return o;
  });
}

/*
 * Equal gaps between three or more rects along `axis` ('x' or 'y'). The outermost two stay where
 * they are; the ones between are spaced evenly in their current order. Returns new rects, same order.
 */
export function distributeRects(rects, axis) {
  if (rects.length < 3) return rects.map((r) => ({ ...r }));
  const size = axis === 'x' ? 'w' : 'h';
  const order = rects.map((r, i) => i).sort((a, b) => rects[a][axis] - rects[b][axis]);
  const first = rects[order[0]]; const last = rects[order[order.length - 1]];
  const span = (last[axis] + last[size]) - first[axis];
  const total = order.reduce((s, i) => s + rects[i][size], 0);
  const gap = (span - total) / (order.length - 1);
  const out = rects.map((r) => ({ ...r }));
  let at = first[axis];
  for (const i of order) { out[i][axis] = at; at += rects[i][size] + gap; }
  return out;
}

/*
 * Layer order. Elements paint in array order, so the last one is on top. Returns the new order as
 * a list of OLD indices; the caller rebuilds the array from it. Selected elements keep their order
 * among themselves, and an element already as far as it can go stays put.
 */
export function reorder(count, selected, op) {
  const sel = new Set(selected);
  const idx = Array.from({ length: count }, (_, i) => i);
  if (op === 'front') return idx.filter((i) => !sel.has(i)).concat(idx.filter((i) => sel.has(i)));
  if (op === 'back') return idx.filter((i) => sel.has(i)).concat(idx.filter((i) => !sel.has(i)));
  if (op === 'forward') {
    for (let i = count - 2; i >= 0; i--) {
      if (sel.has(idx[i]) && !sel.has(idx[i + 1])) [idx[i], idx[i + 1]] = [idx[i + 1], idx[i]];
    }
  } else if (op === 'backward') {
    for (let i = 1; i < count; i++) {
      if (sel.has(idx[i]) && !sel.has(idx[i - 1])) [idx[i], idx[i - 1]] = [idx[i - 1], idx[i]];
    }
  }
  return idx;
}

/*
 * ⚠️ AN ELEMENT'S `slot` IS ITS IDENTITY: the words it shows live in `fields[slot]`. Two elements
 * sharing one would show the same text and an edit to either would change both, so a pasted or
 * duplicated element always gets a slot nobody on the slide has.
 */
export function freshSlot(taken, prefix = 'f') {
  for (;;) {
    const s = `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
    if (!taken.has(s)) return s;
  }
}

/*
 * Load-time repair for a slide whose elements share a slot (or an `id`) — a deck made before
 * duplicates were given their own, or assembled elsewhere. ADDITIVE: the later twin gets a new slot
 * and a COPY of the words, so the slide looks exactly as it did and nothing is lost. Returns how
 * many elements were renamed.
 */
export function repairSlots(slide) {
  const els = (slide && slide.template && Array.isArray(slide.template.elements)) ? slide.template.elements : [];
  if (!slide.fields || typeof slide.fields !== 'object') slide.fields = {};
  const taken = new Set(); const ids = new Set();
  let fixed = 0;
  for (const e of els) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.slot !== 'string' || !e.slot || taken.has(e.slot)) {
      const next = freshSlot(new Set([...taken, ...els.map((x) => x && x.slot)]));
      if (typeof e.slot === 'string' && Object.prototype.hasOwnProperty.call(slide.fields, e.slot)) {
        slide.fields[next] = slide.fields[e.slot];
      }
      e.slot = next; fixed++;
    }
    taken.add(e.slot);
    if (e.id != null) {
      if (ids.has(e.id)) { e.id = freshSlot(ids, 'el'); fixed++; }
      ids.add(e.id);
    }
  }
  return fixed;
}

/*
 * Copies of elements for the clipboard, with the words they show. Deep copies: the clipboard must
 * not change when the originals are edited after copying.
 */
export function copyElements(slide, indices) {
  const els = slide.template.elements;
  return indices.filter((i) => els[i]).map((i) => ({
    el: JSON.parse(JSON.stringify(els[i])),
    text: Object.prototype.hasOwnProperty.call(slide.fields || {}, els[i].slot) ? slide.fields[els[i].slot] : undefined,
  }));
}

/*
 * Put clipboard copies on `slide`, on top, offset by `offset` percent, each with a NEW slot (and a
 * new id where the element had one). Returns the new elements' indices.
 */
export function pasteElements(slide, clip, offset = 2, max = Infinity) {
  const els = slide.template.elements;
  if (!slide.fields || typeof slide.fields !== 'object') slide.fields = {};
  const taken = new Set(els.map((e) => e.slot));
  const ids = new Set(els.map((e) => e.id).filter((v) => v != null));
  const out = [];
  for (const c of clip) {
    if (els.length >= max) break;
    const e = JSON.parse(JSON.stringify(c.el));
    e.slot = freshSlot(taken); taken.add(e.slot);
    if (e.id != null) { e.id = freshSlot(ids, 'el'); ids.add(e.id); }
    if (e.box) { e.box.x = (Number(e.box.x) || 0) + offset; e.box.y = (Number(e.box.y) || 0) + offset; }
    if (c.text !== undefined) slide.fields[e.slot] = c.text;
    els.push(e);
    out.push(els.length - 1);
  }
  return out;
}

/*
 * A copy of slides[index], inserted right after it. Returns the copy's index, or -1 if there is no
 * such slide.
 *
 * ⚠️ THE COPY IS A NEW, UNPUBLISHED SLIDE. Publish recognises a slide it already made a widget for
 * by `widget_id`, so a copy that kept it would overwrite the original's widget on the next publish
 * and the two could never be edited apart. The slide `id` is new for the same reason (it is also
 * what undo uses to put widget ids back, and what translation keys strings by). Element ids are
 * renewed too; slots are kept, because they only need to be unique within one slide and the copy's
 * `fields` are keyed by them. Everything else (layout, words, style, motion, background, dwell,
 * audio) is a deep copy, so editing one slide never changes the other.
 */
export function duplicateSlide(slides, index, name) {
  const src = slides && slides[index];
  if (!src) return -1;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = freshSlot(new Set(slides.map((s) => s && s.id)), 's');
  copy.widget_id = null;
  if (typeof name === 'string' && name) copy.name = name;
  const els = (copy.template && Array.isArray(copy.template.elements)) ? copy.template.elements : [];
  const ids = new Set(els.map((e) => e && e.id).filter((v) => v != null));
  for (const e of els) if (e && e.id != null) { e.id = freshSlot(ids, 'el'); ids.add(e.id); }
  slides.splice(index + 1, 0, copy);
  return index + 1;
}

/*
 * Undo history of document snapshots (strings, so a snapshot can never be mutated after it is
 * taken). `base` is the state the editor is in now; every record() pushes the previous one.
 *
 * Changes with the same `coalesce` key inside `windowMs` become one step — a slider dragged across
 * fifty values is one undo, not fifty. Structural changes pass no key and are always their own step.
 */
export function createHistory(limit = 100, windowMs = 600) {
  let undoStack = []; let redoStack = []; let base = null;
  let lastKey = null; let lastAt = 0;
  return {
    reset(snap) { undoStack = []; redoStack = []; base = snap; lastKey = null; },
    /** Adopt `snap` as the current state without making it a step (a save returned it). */
    rebase(snap) { base = snap; lastKey = null; },
    record(snap, { coalesce = null, now = Date.now() } = {}) {
      if (base === null) { base = snap; return false; }
      if (snap === base) return false;
      if (coalesce && coalesce === lastKey && now - lastAt < windowMs) {
        base = snap; lastAt = now; redoStack = [];
        return false;
      }
      undoStack.push(base);
      if (undoStack.length > limit) undoStack.shift();
      redoStack = [];
      base = snap; lastKey = coalesce; lastAt = now;
      return true;
    },
    undo(current) {
      if (current != null && current !== base) this.record(current);
      if (!undoStack.length) return null;
      redoStack.push(base);
      base = undoStack.pop(); lastKey = null;
      return base;
    },
    redo(current) {
      if (current != null && current !== base) return null;   // edited since the undo: nothing to redo
      if (!redoStack.length) return null;
      undoStack.push(base);
      base = redoStack.pop(); lastKey = null;
      return base;
    },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
  };
}
