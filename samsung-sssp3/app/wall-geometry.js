'use strict';

/*
 * Video-wall tile geometry: where does one panel's stage sit inside its own viewport?
 *
 * #236. Before per-panel rotation existed, the wall canvas was secretly drawn in FRAMEBUFFER
 * space, not in the space a person standing in front of the wall sees. That is invisible while
 * every panel is mounted the normal way up, and actively misleading the moment one isn't: a
 * customer with two portrait-mounted panels SIDE BY SIDE had to stack them VERTICALLY in the
 * editor and ship a pre-rotated copy of every video, because the editor was really asking
 * "where is this panel's 1920x1080 framebuffer?" while showing a picture that read as
 * "where is this panel on the wall?".
 *
 * The model here: the canvas is WALL space — x right, y down, as the audience sees it. A panel
 * mounted turned occupies a turned rect (a portrait-mounted 1920x1080 panel is a tall tile), and
 * `rotation` says how far the panel's own image has to be turned to come out upright on the wall.
 *
 * rotation is degrees CLOCKWISE that the content is rotated WITHIN the framebuffer — the same
 * convention as the per-device `orientation` field (lib/orientation-style.js: portrait === 90).
 * Equivalently: the panel is physically mounted rotated that far ANTI-clockwise. Picking the
 * opposite sign here would have been just as self-consistent and would have silently disagreed
 * with the device orientation setting, so it is pinned by test.
 *
 * The arithmetic lives here, once, because four players have to agree on it to the pixel — the web
 * player, Tizen, Android and BrightSign all render the same frame across panels that share a seam.
 * A half-pixel of disagreement between two of them is a visible line down the middle of the wall.
 */

const VALID_ROTATIONS = [0, 90, 180, 270];

/**
 * Coerce whatever the DB / payload carried into a rotation we can render.
 * Anything unrecognised falls back to 0: a bad value should leave the wall looking exactly as it
 * was drawn, not turn one panel of a live wall on its side.
 */
function normalizeWallRotation(value) {
  const n = Number(value);
  return VALID_ROTATIONS.includes(n) ? n : 0;
}

/**
 * Which orientation should the player apply to its container while it is a member of a wall?
 *
 * The two settings describe the SAME physical fact (this panel is mounted turned), so applying
 * both turns the content twice and lands it sideways and off-screen. When the wall carries a
 * rotation it is authoritative — the tile geometry below already accounts for the mounting — so
 * the container transform is suppressed. Rotation 0 changes nothing, which is what keeps every
 * wall that exists today behaving exactly as it does today.
 *
 * @param {string} orientation      the device's own orientation setting
 * @param {number} wallRotation     per-panel wall rotation (0/90/180/270)
 * @returns {string} the orientation the player should actually apply
 */
function orientationForWallMember(orientation, wallRotation) {
  return normalizeWallRotation(wallRotation) === 0 ? (orientation || 'landscape') : 'landscape';
}

/**
 * Tile geometry in viewport-relative units.
 *
 * The stage is the WHOLE player rect; the viewport crops it to this panel's slice. So the stage is
 * usually much larger than the screen and usually positioned partly off-view — that is the design,
 * not a bug.
 *
 * Returned as unit-tagged numbers so the same numbers can drive CSS (vw/vh) and Android
 * (displayMetrics px) without either re-deriving the maths.
 *
 * @param {{x:number,y:number,w:number,h:number}} screenRect  this panel's rect in wall space
 * @param {{x:number,y:number,w:number,h:number}} playerRect  the content rect in wall space
 * @param {number} rotation                                   0/90/180/270
 * @returns {null|{rotation:number,w:number,wAxis:'x'|'y',h:number,hAxis:'x'|'y',cx:number,cy:number}}
 *   w/h  — the stage box BEFORE rotation, as a multiple of the viewport axis named by wAxis/hAxis
 *          ('x' = viewport width, 'y' = viewport height).
 *   cx/cy— where the box's centre goes, as a fraction of viewport width / height.
 *   null when the screen rect has no area (nothing sane to map onto a zero-sized panel).
 */
function wallStageGeometry(screenRect, playerRect, rotation) {
  const s = screenRect, p = playerRect;
  if (!s || !p || !s.w || !s.h) return null;
  const rot = normalizeWallRotation(rotation);

  // The player rect's centre, as a fraction of this panel's rect. Working from the CENTRE (not the
  // top-left) is what makes all four rotations one formula: rotation moves a corner but leaves a
  // centre where it is.
  const nx = (p.x + p.w / 2 - s.x) / s.w;
  const ny = (p.y + p.h / 2 - s.y) / s.h;
  const fw = p.w / s.w;   // stage extent along wall X, in units of the panel's wall width
  const fh = p.h / s.h;   // stage extent along wall Y, in units of the panel's wall height

  // A quarter turn swaps which viewport axis each wall axis is measured against: on a panel mounted
  // sideways, the wall's horizontal is the framebuffer's vertical. Getting this wrong is the classic
  // "the wall is right but every tile is squashed" symptom.
  const quarter = rot === 90 || rot === 270;
  const wAxis = quarter ? 'y' : 'x';
  const hAxis = quarter ? 'x' : 'y';

  // Where wall-space (nx, ny) lands in framebuffer-normalised (across, down) coordinates.
  // Derivation: rotating content by `rot` clockwise inside the framebuffer sends the wall's
  // top-left corner to the framebuffer corner listed, and the wall axes to the framebuffer axes
  // listed. Each case is pinned by a test.
  let cx, cy;
  if (rot === 90) {
    // wall +X -> framebuffer down, wall +Y -> framebuffer left; wall origin at framebuffer top-right
    cx = 1 - ny; cy = nx;
  } else if (rot === 180) {
    cx = 1 - nx; cy = 1 - ny;
  } else if (rot === 270) {
    // wall +X -> framebuffer up, wall +Y -> framebuffer right; wall origin at framebuffer bottom-left
    cx = ny; cy = 1 - nx;
  } else {
    cx = nx; cy = ny;
  }

  return { rotation: rot, w: fw, wAxis, h: fh, hAxis, cx, cy };
}

/**
 * The same geometry as CSS values, ready to assign onto element.style.
 * Empty string means "clear it" — a half-reset leaves a stage stuck at the previous wall's size.
 *
 * @returns {{left:string,top:string,width:string,height:string,transform:string,transformOrigin:string}}
 *          or null when the screen rect has no area.
 */
function wallStageStyle(screenRect, playerRect, rotation) {
  const s = screenRect, p = playerRect;
  if (!s || !p || !s.w || !s.h) return null;

  // Unrotated walls take the ORIGINAL top-left expression verbatim, not the centre-based one below.
  // The two are algebraically equal but not bit-for-bit equal in floating point, and every wall in
  // the field today is rotation 0. An operator upgrading must not find a hairline seam appear down
  // a wall that was aligned yesterday, so this path is deliberately left untouched.
  if (normalizeWallRotation(rotation) === 0) {
    return {
      left: (((p.x - s.x) / s.w) * 100) + 'vw',
      top: (((p.y - s.y) / s.h) * 100) + 'vh',
      width: ((p.w / s.w) * 100) + 'vw',
      height: ((p.h / s.h) * 100) + 'vh',
      transform: '',
      transformOrigin: '',
    };
  }

  const g = wallStageGeometry(s, p, rotation);
  const unit = (axis) => (axis === 'x' ? 'vw' : 'vh');
  return {
    left: (g.cx * 100) + 'vw',
    top: (g.cy * 100) + 'vh',
    width: (g.w * 100) + unit(g.wAxis),
    height: (g.h * 100) + unit(g.hAxis),
    // translate BEFORE rotate: transform functions apply right-to-left, so the box turns about its
    // own centre and THEN that centre is moved into place. Reversed, the offset is rotated too and
    // the tile lands on the wrong side of the panel (the same trap as orientation-style.js).
    transform: 'translate(-50%, -50%) rotate(' + g.rotation + 'deg)',
    transformOrigin: 'center center',
  };
}

/**
 * The wall footprint of a panel whose framebuffer is renderW x renderH, once mounted at `rotation`.
 * The editor sizes new tiles with this so a portrait-mounted 1920x1080 panel is drawn as the tall
 * rect it physically is — which is the whole point of #236.
 */
function rotatedFootprint(renderW, renderH, rotation) {
  const rot = normalizeWallRotation(rotation);
  return (rot === 90 || rot === 270) ? { w: renderH, h: renderW } : { w: renderW, h: renderH };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VALID_ROTATIONS,
    normalizeWallRotation,
    orientationForWallMember,
    wallStageGeometry,
    wallStageStyle,
    rotatedFootprint,
  };
}
if (typeof window !== 'undefined') {
  window.WallGeometry = {
    VALID_ROTATIONS,
    normalizeWallRotation,
    orientationForWallMember,
    wallStageGeometry,
    wallStageStyle,
    rotatedFootprint,
  };
}
