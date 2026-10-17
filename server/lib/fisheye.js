'use strict';
/*
 * FISHEYE CAMERAS SHOWN AS A NORMAL VIEW ("digital PTZ") — the single definition.
 *
 * A 360° camera (UniFi's AI 360 and the like) sends one circular fisheye picture. A camera item can
 * carry `fisheye` settings, and a player that declares playback.fisheye then shows a flat 16:9 view
 * cut from that circle instead of the circle itself: pointed with pan / tilt, narrowed with zoom, and
 * steered live from the dashboard (the camera_view command) or, where the item allows it (`touch`),
 * by touch on the screen. Nothing moves
 * on the camera; the player re-projects every frame on the GPU.
 *
 * ⚠️ THE PICTURE IS ALWAYS UPRIGHT. The view's "up" comes from how the camera is mounted, never from
 * the image: looking down from a ceiling or high on a wall, up points away from the lens axis
 * (toward the horizon); looking up from a floor or desk, toward it; a wall camera facing out uses the
 * image's own up. `rotation` corrects a camera installed a little crooked, once. Tilt is clamped so a
 * view can never swing over the top and flip.
 *
 * The maths lives here, in android/.../player/Fisheye.kt and in native/.../logic/fisheye.py, held
 * together by shared/fisheye-vectors.json (generated from this file, checked by all three test
 * suites). The players compute the view's three directions on the CPU (basis) and hand them to a
 * small fragment shader that does what project() does per pixel.
 *
 * Coordinates. The lens looks along +z; x is image-right and y image-DOWN, so (x, y, z) is the
 * camera's own right-handed frame. A ray at angle theta from the axis lands at radius
 * theta / (lens_fov / 2) of the lens circle (the equidistant model every 360° camera approximates),
 * at angle atan2(y, x) + rotation. The circle is cx, cy (0..1 of the image width and height) and r
 * (fraction of the image HEIGHT, so a non-square picture works). Output x, y run -1..1 with y up.
 */

const MOUNTS = Object.freeze(['ceiling', 'floor', 'wall']);
const OUTPUT_ASPECT = 16 / 9;
const DEFAULTS = Object.freeze({
  mount: 'ceiling', lens_fov: 180, rotation: 0, cx: 0.5, cy: 0.5, r: 0.5, pan: 0, tilt: 55, zoom: 80, touch: false,
});
const ZOOM_MIN = 20;
const ZOOM_MAX = 120;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap180 = (a) => { let x = ((a + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };
const round = (v) => Math.round(v * 1000) / 1000;

/* The tilt range for a mount: from the axis out to the lens edge, or ± from straight ahead. */
function tiltRange(mount, lensFov) {
  const half = lensFov / 2;
  return mount === 'wall' ? [-Math.min(85, half), Math.min(85, half)] : [0, Math.min(half, 120)];
}

/**
 * Settings as stored and sent: every field present, in range. Unknown fields dropped. null when
 * `raw` is null/undefined/false (the item is not a fisheye). Throws nothing: junk becomes defaults.
 */
function normalize(raw) {
  if (raw === null || raw === undefined || raw === false) return null;
  let o = raw;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (_) { return null; } }
  if (typeof o !== 'object' || Array.isArray(o)) return null;
  const mount = MOUNTS.includes(o.mount) ? o.mount : DEFAULTS.mount;
  const lens_fov = clamp(num(o.lens_fov, DEFAULTS.lens_fov), 90, 240);
  const [tlo, thi] = tiltRange(mount, lens_fov);
  const tiltDefault = mount === 'wall' ? 0 : DEFAULTS.tilt;
  const view = viewOf(o, { mount, lens_fov }, { pan: DEFAULTS.pan, tilt: tiltDefault, zoom: DEFAULTS.zoom });
  return {
    mount,
    lens_fov: round(lens_fov),
    rotation: round(wrap180(num(o.rotation, 0))),
    cx: round(clamp(num(o.cx, DEFAULTS.cx), 0, 1)),
    cy: round(clamp(num(o.cy, DEFAULTS.cy), 0, 1)),
    r: round(clamp(num(o.r, DEFAULTS.r), 0.05, 1.5)),
    pan: view.pan,
    tilt: clamp(view.tilt, tlo, thi),
    zoom: view.zoom,
    // Whether someone at the screen may steer it by touch (drag, pinch, double-tap to reset). OFF
    // unless the operator turns it on: a sign in a lobby is not a toy for whoever walks past.
    touch: o.touch === true || o.touch === 1 || o.touch === '1' || o.touch === 'true',
  };
}

/** pan / tilt / zoom from `o`, clamped for the settings `f`, falling back to `fallback`. */
function viewOf(o, f, fallback) {
  const mount = f.mount || DEFAULTS.mount;
  const lens = f.lens_fov || DEFAULTS.lens_fov;
  const [tlo, thi] = tiltRange(mount, lens);
  let pan = num(o && o.pan, fallback.pan);
  pan = mount === 'wall' ? clamp(pan, -lens / 2, lens / 2) : wrap180(pan);
  return {
    pan: round(pan),
    tilt: round(clamp(num(o && o.tilt, fallback.tilt), tlo, thi)),
    zoom: round(clamp(num(o && o.zoom, fallback.zoom), ZOOM_MIN, ZOOM_MAX)),
  };
}

const rad = (d) => d * Math.PI / 180;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * The view's direction, right and up (unit vectors, camera frame) for normalized settings `f`.
 * `up` is d/d(tilt) of the direction (away from the axis for a ceiling mount, toward it for a floor
 * mount, image-up for a wall) and right = d × up, which keeps the view unmirrored.
 */
function basis(f) {
  const p = rad(f.pan);
  const t = rad(f.tilt);
  let d;
  let up;
  if (f.mount === 'wall') {
    d = [Math.sin(p) * Math.cos(t), -Math.sin(t), Math.cos(p) * Math.cos(t)];
    up = [-Math.sin(p) * Math.sin(t), -Math.cos(t), -Math.cos(p) * Math.sin(t)];
  } else {
    d = [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
    up = [Math.cos(t) * Math.cos(p), Math.cos(t) * Math.sin(p), -Math.sin(t)];
    if (f.mount === 'floor') up = [-up[0], -up[1], -up[2]];
  }
  up = norm(up);
  const right = norm(cross(d, up));
  return { d, right, up };
}

/**
 * Where output point (x, y) (-1..1, y up, 16:9 view) samples the source image: { u, v } in 0..1 of
 * the image (v down), or null outside the lens circle. `imageAspect` = width / height of the source.
 * This is the shader, written out.
 */
function project(f, x, y, imageAspect = 1, b = basis(f)) {
  const tx = Math.tan(rad(f.zoom) / 2);
  const ty = tx / OUTPUT_ASPECT;
  const ray = norm([0, 1, 2].map((i) => b.d[i] + x * tx * b.right[i] + y * ty * b.up[i]));
  const theta = Math.acos(clamp(ray[2], -1, 1));
  const half = rad(f.lens_fov) / 2;
  if (theta > half) return null;
  const phi = Math.atan2(ray[1], ray[0]) + rad(f.rotation);
  const rho = theta / half;
  return { u: f.cx + f.r * rho * Math.cos(phi) / imageAspect, v: f.cy + f.r * rho * Math.sin(phi) };
}

module.exports = { MOUNTS, DEFAULTS, OUTPUT_ASPECT, ZOOM_MIN, ZOOM_MAX, normalize, viewOf, tiltRange, basis, project };
