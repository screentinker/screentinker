/*
 * Snapping for the canvas editors (video wall screens, layout zones). Pure maths, no DOM, so the
 * wall editor (canvas pixels) and the layout editor (percent) share it and a test can run it.
 *
 * A rect is { x, y, w, h }. `targets` are the other rects it may line up with. `gap` adds "butt up
 * against it with this much space" targets on both sides — the bezel gap on a wall, so two panels
 * snap to sit exactly one bezel apart. A number, or { x, y } when the two bezels differ. `bounds` (optional) is a frame whose edges and centre lines
 * are targets too (the layout canvas: 0 / 50 / 100%).
 *
 * Returns the snapped rect plus the guide lines to draw: { x, y, w, h, guides: [{ axis, at }] }
 * where axis 'x' is a vertical line at x = at, 'y' a horizontal one at y = at.
 */

function linesOf(r) {
  return { x: [r.x, r.x + r.w / 2, r.x + r.w], y: [r.y, r.y + r.h / 2, r.y + r.h] };
}

// Every value an edge may snap to on one axis.
function targetValues(targets, gap, bounds, axis) {
  const out = [];
  const size = axis === 'x' ? 'w' : 'h';
  const g = (gap && typeof gap === 'object') ? (Number(gap[axis]) || 0) : (Number(gap) || 0);   // per-axis bezel
  for (const t of targets) {
    const a = t[axis], b = t[axis] + t[size];
    out.push(a, a + t[size] / 2, b);
    if (g > 0) out.push(b + g, a - g);
  }
  if (bounds) out.push(bounds[axis], bounds[axis] + bounds[size] / 2, bounds[axis] + bounds[size]);
  return out;
}

// Smallest correction (within threshold) that puts any of `edges` on any target.
function bestDelta(edges, values, threshold) {
  let best = null;
  for (const e of edges) {
    for (const v of values) {
      const d = v - e;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, at: v };
    }
  }
  return best;
}

// Moving: the rect keeps its size; any of its three lines per axis may snap.
export function snapMove(rect, targets, { threshold = 8, gap = 0, bounds = null } = {}) {
  const out = { ...rect, guides: [] };
  const own = linesOf(rect);
  for (const axis of ['x', 'y']) {
    const b = bestDelta(own[axis], targetValues(targets, gap, bounds, axis), threshold);
    if (b) { out[axis] = rect[axis] + b.d; out.guides.push({ axis, at: b.at }); }
  }
  return out;
}

// Resizing by handle `dir` (n/s/e/w combos): only the edges being dragged move, and never below
// the minimum size.
export function snapResize(rect, dir, targets, { threshold = 8, gap = 0, bounds = null, minW = 1, minH = 1 } = {}) {
  const out = { ...rect, guides: [] };
  const vx = targetValues(targets, gap, bounds, 'x');
  const vy = targetValues(targets, gap, bounds, 'y');
  if (dir.includes('e')) {
    const b = bestDelta([rect.x + rect.w], vx, threshold);
    if (b && rect.w + b.d >= minW) { out.w = rect.w + b.d; out.guides.push({ axis: 'x', at: b.at }); }
  } else if (dir.includes('w')) {
    const b = bestDelta([rect.x], vx, threshold);
    if (b && rect.w - b.d >= minW) { out.x = rect.x + b.d; out.w = rect.w - b.d; out.guides.push({ axis: 'x', at: b.at }); }
  }
  if (dir.includes('s')) {
    const b = bestDelta([rect.y + rect.h], vy, threshold);
    if (b && rect.h + b.d >= minH) { out.h = rect.h + b.d; out.guides.push({ axis: 'y', at: b.at }); }
  } else if (dir.includes('n')) {
    const b = bestDelta([rect.y], vy, threshold);
    if (b && rect.h - b.d >= minH) { out.y = rect.y + b.d; out.h = rect.h - b.d; out.guides.push({ axis: 'y', at: b.at }); }
  }
  return out;
}
