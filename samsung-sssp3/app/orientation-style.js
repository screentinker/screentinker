'use strict';

/*
 * The CSS needed to rotate a full-screen player container, and (below) the CSS needed to show that
 * rotated output back to a human in the dashboard.
 *
 * This looks trivial and is not, because rotating a box does NOT move it. The web player set
 * `width:100vh; height:100vw` and `rotate(90deg)` on a container pinned `inset: 0`, which leaves
 * the box in the top-left corner and spins it about ITS OWN centre — not the viewport's. On a
 * 1920x1080 panel that put the content 420px off-screen to the left and 420px off the bottom:
 * portrait content, correctly rotated, in the wrong place and cropped on two edges.
 *
 * The box has to be centred on the viewport BEFORE it is turned. Tizen already does this
 * (`top:50%; left:50%; translate(-50%,-50%) rotate()`), and Android does the equivalent with
 * translationX/Y offsets of (w-h)/2 — so the web player was the odd one out.
 *
 * Returned as plain style values so the same rule can be asserted in a test without a browser,
 * and shared rather than re-derived per player. Every property the rotated state sets is also
 * cleared by the landscape state: a half-reset leaves a container stuck at 100vh wide.
 */

const ROTATION_DEG = {
  'landscape': 0,
  'portrait': 90,
  'landscape-flipped': 180,
  'portrait-flipped': 270,
};

/**
 * @param {string} orientation  landscape | portrait | landscape-flipped | portrait-flipped
 * @returns {{transform:string,width:string,height:string,top:string,left:string,transformOrigin:string}}
 *          Values to assign directly onto element.style. Empty string means "clear it".
 */
function orientationStyle(orientation) {
  const deg = ROTATION_DEG[orientation];

  // Unknown orientation falls back to landscape rather than throwing: a bad value from the server
  // should leave a readable screen, not a blank or sideways one.
  if (!deg) {
    return { transform: '', width: '', height: '', top: '', left: '', transformOrigin: '' };
  }

  // 180 needs no dimension swap — the box already matches the viewport, it just turns over. Giving
  // it the portrait treatment would swap width and height for no reason and letterbox it.
  const swap = deg === 90 || deg === 270;
  if (!swap) {
    return {
      transform: 'rotate(180deg)',
      width: '', height: '', top: '', left: '',
      transformOrigin: 'center center',
    };
  }

  return {
    // translate BEFORE rotate: transforms apply right-to-left, so the box is turned about its own
    // centre and then that centre is moved onto the viewport's. Reversing them rotates the offset
    // as well and puts the content back off-screen.
    transform: 'translate(-50%, -50%) rotate(' + deg + 'deg)',
    width: '100vh',
    height: '100vw',
    top: '50%',
    left: '50%',
    transformOrigin: 'center center',
  };
}

/** Does this orientation put the panel's long edge vertical? 90 and 270 swap the axes; 0/180 don't. */
function swapsAxes(orientation) {
  const deg = ROTATION_DEG[orientation];
  return deg === 90 || deg === 270;
}

/**
 * The CSS needed to show a rotated display's OUTPUT — its framebuffer — inside a fixed dashboard
 * box, as a person standing in front of the panel sees it.
 *
 * #238: the dashboard preview of a 90/270 device was sideways while the panel was right, and the
 * reason is that the dashboard only did half the job. A portrait panel is a landscape framebuffer
 * that the player rotates content INSIDE (+90), hung on the wall turned the other way (-90); the
 * two cancel and the viewer sees upright portrait. The dashboard iframed the player into a box it
 * had already made portrait-shaped, so the player rotated content a second time inside a box that
 * was pretending to be the finished picture — one rotation applied, the mount's never modelled.
 * Designers checking their work on a portrait screen saw sideways content and could not tell a
 * real fault from a preview artefact, so every portrait anomaly became a support question.
 *
 * So the frame stands in for the physical mount and rotates by the INVERSE of the player's angle.
 * Rotating it the SAME way instead is the tempting mistake and the worst kind of wrong: 90+90
 * lands upside-down, which reads as "nearly right" and gets shipped.
 *
 * The dimension swap matters as much as the angle. Composing into a box the shape of the real
 * FRAMEBUFFER (stage axes swapped) and turning that is not a no-op round trip — it is what makes
 * the player lay the content out in the same portrait box the panel uses. Feed the player a
 * portrait-shaped viewport instead and every zone, aspect and object-fit decision is computed for
 * the wrong canvas.
 *
 * @param {string} orientation  landscape | portrait | landscape-flipped | portrait-flipped
 * @param {{width:number,height:number}} box  the on-screen stage, in px, AS THE VIEWER SEES IT
 * @returns {{transform:string,width:string,height:string,top:string,left:string,transformOrigin:string}}
 *          Values to assign directly onto element.style. Empty string means "clear it" — the
 *          landscape state must clear every property the rotated state sets, or a device switched
 *          back to landscape keeps a stale swapped size and looks broken until a reload.
 */
function previewFrameStyle(orientation, box) {
  const deg = ROTATION_DEG[orientation];
  const w = box && box.width, h = box && box.height;

  // Unknown/landscape, or a stage that has not been laid out yet (a hidden tab measures 0x0):
  // clear back to the base CSS rather than pinning a 0px frame nobody can see.
  if (!deg || !(w > 0) || !(h > 0)) {
    return { transform: '', width: '', height: '', top: '', left: '', transformOrigin: '' };
  }

  const swap = swapsAxes(orientation);
  return {
    transform: 'translate(-50%, -50%) rotate(' + ((360 - deg) % 360) + 'deg)',
    width: (swap ? h : w) + 'px',
    height: (swap ? w : h) + 'px',
    top: '50%',
    left: '50%',
    transformOrigin: 'center center',
  };
}

/** Stage aspect for a device, as the viewer sees it: '9 / 16' for a portrait-hung 16:9 panel. */
function previewAspectRatio(orientation, panelW, panelH) {
  const w = panelW || 16, h = panelH || 9;
  return swapsAxes(orientation) ? (h + ' / ' + w) : (w + ' / ' + h);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { orientationStyle, previewFrameStyle, previewAspectRatio, swapsAxes, ROTATION_DEG };
}
if (typeof window !== 'undefined') {
  window.OrientationStyle = { orientationStyle, previewFrameStyle, previewAspectRatio, swapsAxes, ROTATION_DEG };
}
