/* PipOverlay — picture-in-picture overlay layer for the Tizen player (#109 MVP).
 *
 * Renders an image or web (iframe) overlay into a #pip element that sits ABOVE the
 * playlist #stage. The playlist renderer (PlaylistPlayer / ZoneRenderer) NEVER touches
 * #pip, so showing/clearing an overlay cannot change what's playing underneath.
 *
 * MVP semantics:
 *  - single overlay slot, last-show-wins (a new show replaces the current one);
 *  - duration timer in seconds (0 = until explicitly cleared);
 *  - device:pip-clear (matching pip_id, or none) or the timer tears it down;
 *  - teardown is wrapped so a malformed payload can never wedge the layer.
 *
 * Orientation: app.js applies the SAME orientation transform to #pip as to #stage, so a
 * corner position ("top-right") tracks the top-right of the visible CONTENT in every
 * orientation. This module only positions the box WITHIN #pip's (already-oriented) box.
 *
 * Deferred (not MVP): video/rtsp overlay types, priority/stacking, close-button focus.
 */
function PipOverlay(pipEl, opts) {
  opts = opts || {};
  this.pip = pipEl;
  this.doc = opts.document || (typeof document !== 'undefined' ? document : null);
  this.log = (typeof opts.log === 'function') ? opts.log : function () {};
  // Injectable timers keep teardown deterministic under test; default to the globals.
  this._setTimeout = opts.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
  this._clearTimeout = opts.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);
  this.timer = null;
  this.current = null; // pip_id of the overlay currently showing (null when empty)
}

// Corner/center -> inline style offsets. 4% inset keeps the box off the bezel edge.
PipOverlay.POSITIONS = {
  'top-left': { top: '4%', left: '4%' },
  'top-right': { top: '4%', right: '4%' },
  'bottom-left': { bottom: '4%', left: '4%' },
  'bottom-right': { bottom: '4%', right: '4%' },
  'center': { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
};

PipOverlay.prototype.show = function (p) {
  if (!p || !this.pip || !this.doc) return;
  try {
    this.teardown();               // single slot, last-show-wins
    var box = this._buildBox(p);
    this.pip.appendChild(box);
    this.current = p.pip_id || '(anon)';
    var dur = Number(p.duration);
    if (this._setTimeout && isFinite(dur) && dur > 0) {
      var self = this;
      this.timer = this._setTimeout(function () { self.clear(self.current); }, dur * 1000);
    }
    this.log('info', 'pip show ' + (p.type || '?') + ' ' + (p.pip_id || '') +
      ' pos=' + (p.position || 'top-right') + ' dur=' + (isFinite(dur) ? dur : 0));
  } catch (e) {
    // A malformed payload must never wedge the layer: tear down and stay usable.
    this.teardown();
    this.log('warn', 'pip show failed: ' + (e && e.message ? e.message : e));
  }
};

PipOverlay.prototype.clear = function (pipId) {
  // A clear carrying a pip_id only clears if it matches the showing overlay (so a stale
  // clear for a replaced overlay is a no-op); an omitted pip_id clears whatever shows.
  if (pipId && this.current && pipId !== this.current) return;
  var had = !!this.current;
  this.teardown();
  if (had) this.log('info', 'pip cleared' + (pipId ? ' ' + pipId : ''));
};

PipOverlay.prototype.teardown = function () {
  try { if (this.timer && this._clearTimeout) { this._clearTimeout(this.timer); } } catch (e) {}
  this.timer = null;
  this.current = null;
  try { if (this.pip) this.pip.innerHTML = ''; } catch (e) {}
};

PipOverlay.prototype._buildBox = function (p) {
  var d = this.doc;
  var box = d.createElement('div');
  var s = box.style;
  s.position = 'absolute';
  s.width = pipPx(p.width, 480);
  s.height = pipPx(p.height, 360);
  s.overflow = 'hidden';
  s.boxSizing = 'border-box';
  s.background = pipColor(p.background_color) || '#000000';
  s.zIndex = '2';
  if (p.opacity != null && isFinite(Number(p.opacity))) s.opacity = String(pipClamp(Number(p.opacity), 0, 1));
  if (p.border_radius != null && isFinite(Number(p.border_radius))) s.borderRadius = pipPx(p.border_radius, 0);

  var pos = PipOverlay.POSITIONS[p.position] || PipOverlay.POSITIONS['top-right'];
  for (var k in pos) { if (pos.hasOwnProperty(k)) s[k] = pos[k]; }

  var hasTitle = p.title != null && p.title !== '';
  if (hasTitle) {
    var bar = d.createElement('div');
    bar.textContent = String(p.title);
    var bs = bar.style;
    bs.font = '600 16px sans-serif';
    bs.padding = '6px 10px';
    bs.color = pipColor(p.title_color) || '#ffffff';
    bs.background = 'rgba(0,0,0,0.45)';
    bs.whiteSpace = 'nowrap';
    bs.overflow = 'hidden';
    bs.textOverflow = 'ellipsis';
    box.appendChild(bar);
  }

  var media;
  if (p.type === 'web') {
    media = d.createElement('iframe');
    media.setAttribute('frameborder', '0');
    media.setAttribute('scrolling', 'no');
    // Mute web audio by default: an empty allow= denies autoplay (incl. audio).
    media.setAttribute('allow', '');
    media.src = p.uri;
  } else { // 'image' (and any non-web MVP type defaults to image render)
    media = d.createElement('img');
    media.src = p.uri;
  }
  var ms = media.style;
  ms.display = 'block';
  ms.border = '0';
  ms.width = '100%';
  ms.height = hasTitle ? 'calc(100% - 32px)' : '100%';
  ms.objectFit = 'cover';
  box.appendChild(media);
  return box;
};

function pipPx(v, def) { var n = Number(v); if (!isFinite(n) || n <= 0) n = def; return n + 'px'; }
function pipClamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
function pipColor(c) { return (typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c)) ? c : null; }

if (typeof module !== 'undefined' && module.exports) module.exports = { PipOverlay: PipOverlay };
