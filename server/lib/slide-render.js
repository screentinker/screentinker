'use strict';

/*
 * Slide widgets: a template joined to a record, at render time.
 *
 * ⚠️ THE ONE THING THIS FILE EXISTS TO DO: keep the changeable text OUT of the layout.
 *
 * Every other widget in this codebase bakes its content into `config.html` and re-emits the whole
 * document on every edit. That is fine for a clock. It is fatal for a slide somebody comes back to
 * three months later to change a number, because there is no route back to the form — the HTML IS
 * the record, and it has already lost which parts were fields.
 *
 * Fifteen signage products were surveyed before this was written and not one of them makes the
 * changeable text part of the template. Scala has template variables bound to a CMS record;
 * Appspace pairs `schema.json` with `model.json`; Xibo deliberately keeps widget HTML and widget
 * data in SEPARATE files so a data change never rebuilds the layout. The single vendor that does
 * what ScreenTinker does today is the one where editing later genuinely breaks.
 *
 * So: `config.template` is a VIEW — geometry, style, motion, and a `slot` name per element.
 * `config.fields` is a RECORD — `{ slot: value }`. They meet here and nowhere else. Editing a
 * headline writes one string into `fields` and bumps the widget's rev; the template is untouched,
 * which is what makes the round trip possible at all.
 *
 * ⚠️ EVERYTHING IS BOUNDED, because all of it lands in an HTML document. Values are clamped to
 * ranges and allowlists rather than sanitised in place: an out-of-range number becomes the nearest
 * legal one, an unknown enum becomes the default, and unknown keys are dropped entirely. A slide is
 * authored by a workspace editor and rendered into a sandboxed iframe, but "it is only staff" is
 * not a security model, and a 40,000-character headline is a layout attack whoever typed it.
 */

const MAX_ELEMENTS = 40;
const MAX_FIELD_CHARS = 2000;
const MAX_FIELDS = 60;

/*
 * The entrance vocabulary, as CSS keyframe names.
 *
 * ⚠️ CSS ONLY, AND THAT IS A PLATFORM DECISION RATHER THAN A STYLISTIC ONE. BrightSign's
 * `nodejs_enabled` breaks CommonJS-first UMD modules silently — it has already cost this project
 * transitions, dayparting, mute and video-wall geometry. A JavaScript motion library is exactly
 * that shape of dependency, and its failure mode is a BLANK slide. A keyframe that a player does
 * not understand leaves the element simply present, correctly laid out, which is the only
 * acceptable way for motion to fail on a wall.
 */
const ANIMATIONS = Object.freeze({
  fade:   'st-fade',
  slideL: 'st-slide-l',
  slideR: 'st-slide-r',
  slideU: 'st-slide-u',
  slideD: 'st-slide-d',
  zoom:   'st-zoom',
  wipe:   'st-wipe',
});

const EASINGS = Object.freeze({
  'ease-out': 'ease-out',
  'ease-in': 'ease-in',
  'ease-in-out': 'ease-in-out',
  'linear': 'linear',
  'soft': 'cubic-bezier(.2,.8,.2,1)',
});

/*
 * ⚠️ FONTS ARE BUNDLED NOW, so this is no longer a request and a hope.
 *
 * It used to be: four generic stacks, each ending in a keyword, because there was no font pipeline
 * anywhere in the product and the named face was whatever the panel happened to have. Five SIL OFL
 * families now ship with the server (lib/slide-fonts.js) and are served from /fonts, so a slide
 * renders the same on Android, Tizen, BrightSign and a browser.
 *
 * The generic names still resolve — see ALIASES there. Slides authored before this exist on real
 * screens and must not silently reset.
 */
const slideFonts = require('./slide-fonts');

/*
 * ⚠️ FOUR FLAGS, AND `text` AND `glyphs` ARE NOT THE SAME QUESTION.
 *
 *   text   — reads `fields[slot]`, so the kind takes part in the template/record split.
 *   glyphs — puts characters on screen, so an @font-face must be emitted for its family.
 *   live   — the ticking behaviour LIVE_SCRIPT implements for it, or null if it is static.
 *   config — needs setup beyond geometry (a QR payload, a countdown target).
 *
 * `text` and `glyphs` used to be ONE flag, and that was correct only while every kind that showed
 * words also got them from a field. A clock shows words and reads no field; a QR reads a field and
 * shows no words. Collapsing them again drops the font for a clock — which renders it in whatever
 * face the panel happens to have, the exact "different on every screen" failure the bundled font
 * set exists to end — or emits a face for a QR that has nothing to set in it.
 *
 * `config` is what keeps these kinds out of the vocabulary offered to the AI slide generator
 * (routes/ai.js): it can invent a headline, but it cannot invent a URL to encode or a date to count
 * down to, and a kind it cannot fill would come back configured with defaults nobody asked for.
 */
const KINDS = Object.freeze({
  head:      { text: true,  glyphs: true,  live: null,        config: false },
  body:      { text: true,  glyphs: true,  live: null,        config: false },
  stat:      { text: true,  glyphs: true,  live: null,        config: false },
  image:     { text: false, glyphs: false, live: null,        config: false },
  rule:      { text: false, glyphs: false, live: null,        config: false },
  box:       { text: false, glyphs: false, live: null,        config: false },
  // The payload is a FIELD, so the URL behind a QR can be changed later without rebuilding the
  // layout — the same reason a headline is a field. It draws no glyphs of its own.
  qr:        { text: true,  glyphs: false, live: null,        config: true  },
  clock:     { text: false, glyphs: true,  live: 'clock',     config: true  },
  date:      { text: false, glyphs: true,  live: 'date',      config: true  },
  // The field is the message shown once the target passes ("Doors open", "We are closed").
  countdown: { text: true,  glyphs: true,  live: 'countdown', config: true  },
  /*
   * ⚠️ A PICTURE OF WORDS, AND THE WORDS ARE STILL A FIELD.
   *
   * Lettering is generated artwork — brush script, painted type, the things no bundled font can do
   * — so what lands on the slide is an image. The obvious implementation stops there, and it
   * quietly breaks the one promise this file opens by making: that the changeable text stays OUT of
   * the layout, so somebody can come back in three months and change a number.
   *
   * So the words this artwork DEPICTS stay in `fields[slot]`, exactly as a headline's do. They are
   * the record: the editor shows them, a regenerate reads them, and they are emitted as the image's
   * alt text — which means a slide whose headline is a picture is still readable to anything that
   * cannot see it. What is lost is only that editing the words needs the artwork remade, and the
   * editor can say so, rather than the words simply ceasing to exist.
   *
   * glyphs is false: it draws no text of its own, so it needs no @font-face.
   */
  lettering: { text: true,  glyphs: false, live: null,        config: true  },
});

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/*
 * ⚠️ A COLOUR IS SIX OR THREE HEX DIGITS OR IT IS THE DEFAULT.
 *
 * Not a CSS colour parser. This value is interpolated into a style attribute, and the set of
 * strings CSS accepts there is far larger than the set that is safe to concatenate — `url(...)`,
 * `expression(...)` and anything carrying a `;` or a `}` all live in it. An allowlist of hex is
 * everything a slide editor needs to emit and nothing it does not.
 */
function color(v, dflt) {
  return (typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim()))
    ? v.trim() : dflt;
}

/*
 * A URL, made safe to sit inside a CSS `url(...)`.
 *
 * ⚠️ escapeHtml IS NOT ENOUGH HERE, and a mutation run proved it. That function escapes the five
 * HTML characters; none of `; ( ) '` are among them. So a value containing `);…` closes the url(),
 * ends the declaration and appends declarations of its own — this rendered as
 * `url(https://x/a.jpg);position:fixed;width:300vw;height:300vh)` on a real call.
 *
 * That value is REACHABLE: resolveImage returns content.remote_url for remote content, and a remote
 * URL is typed by an operator. The damage is bounded — a style attribute is a declaration list, not
 * a rule block, so `}` buys nothing and the slide is a sandboxed iframe either way — but it is
 * somebody else's element being restyled by a string, which is not a thing to leave working.
 *
 * Percent-encoding is used rather than quoting because it is valid inside a URL, so a legitimate
 * address survives it unchanged while the characters that matter to CSS cannot appear at all.
 */
function cssUrl(url) {
  return String(url == null ? '' : url).replace(/[()'"\\;\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A slot name — the join key between template and record. */
const SLOT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/* ============ per-kind configuration: clock, date, countdown, qr ============ */

/*
 * ⚠️ ALLOWLISTS, NOT FORMAT STRINGS.
 *
 * The obvious design is to let an operator type a strftime-ish pattern and hand it to the player.
 * That makes the pattern operator-controlled data flowing into a formatter, which is a much larger
 * surface than this feature needs — and it is unnecessary, because the set of ways a signage screen
 * should show a time is small and known. A fixed vocabulary means the renderer interpolates a value
 * it chose itself, and the script in the page switches on it rather than interpreting it.
 */
const CLOCK_FORMATS = Object.freeze({ '24': 1, '24s': 1, '12': 1, '12s': 1 });
const DATE_FORMATS = Object.freeze({ long: 1, short: 1, numeric: 1, weekday: 1 });
const QR_EC = Object.freeze({ L: 1, M: 1, Q: 1, H: 1 });

/*
 * How a photo sits in its box.
 *
 * ⚠️ `contain` EXISTS FOR CUT-OUTS, and without it they are unusable. `cover` fills the box and
 * crops whatever does not fit, which is right for a photograph used as a panel — and wrong for an
 * object with transparency around it, because the crop slices the object itself. Measured: a
 * generated pumpkin laid into a 34x62 box lost its bottom third, and it looks like a bad
 * photograph rather than a setting anybody would think to change.
 */
const IMAGE_FITS = Object.freeze({ cover: 1, contain: 1 });

/*
 * An IANA zone name, structurally. Deliberately NOT a list of the ~600 real ones: that list moves
 * (zones are added and renamed by the tzdb), and a stale copy here would refuse a zone the panel
 * actually supports. Structure is checked so nothing strange reaches an attribute; whether the zone
 * EXISTS is answered by the platform, where Intl throws and the script falls back to local time.
 */
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
/** A BCP-47 tag, structurally, for the same reason. */
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

const pick = (table, v, dflt) =>
  (typeof v === 'string' && Object.prototype.hasOwnProperty.call(table, v)) ? v : dflt;
const matchOr = (re, v, max, dflt) =>
  (typeof v === 'string' && v.length <= max && re.test(v)) ? v : dflt;

/**
 * A countdown target, as epoch milliseconds.
 *
 * ⚠️ MILLISECONDS, AND NEVER SECONDS. Accepting both means guessing which one a bare number is, and
 * the guess is wrong for every target before 1970-01-01 in one direction and every target after
 * 1970-01-21 in the other. An ISO string is accepted because that is what a date input emits, and
 * it carries its own offset so there is nothing to infer.
 */
const MAX_INSTANT = Date.UTC(2200, 0, 1);
function instant(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN);
  if (!Number.isFinite(n) || n < 0 || n > MAX_INSTANT) return null;
  return Math.round(n);
}

/**
 * Everything a kind needs beyond geometry, or null for the kinds that need nothing.
 *
 * Total like the rest of normalize: an unrecognised format becomes the default, a malformed zone
 * becomes absent, an unparseable target becomes null. Nothing here can fail to produce a value the
 * renderer may interpolate.
 */
function kindConfig(kind, src) {
  switch (kind) {
    case 'clock':
      return {
        format: pick(CLOCK_FORMATS, src.clock_format, '24'),
        tz: matchOr(TZ_RE, src.tz, 64, ''),
        locale: matchOr(LOCALE_RE, src.locale, 32, ''),
      };
    case 'date':
      return {
        format: pick(DATE_FORMATS, src.date_format, 'long'),
        tz: matchOr(TZ_RE, src.tz, 64, ''),
        locale: matchOr(LOCALE_RE, src.locale, 32, ''),
      };
    case 'countdown':
      return { target: instant(src.target) };
    case 'image':
      // Not marked `config` in KINDS: it has a sensible default, so the AI generator can still be
      // offered image elements without having to reason about it.
      return { fit: pick(IMAGE_FITS, src.fit, 'cover') };
    case 'lettering':
      // ⚠️ Always contained, and not settable. Cropping a word is not a styling choice: it removes
      // letters, and "20% OF" on a wall is worse than no slide at all.
      return { fit: 'contain' };
    case 'qr':
      /*
       * ⚠️ THE MODULES ARE BLACK ON WHITE BY DEFAULT, AND THEY DO NOT INHERIT style.color.
       *
       * The obvious wiring is to draw the modules in the element's colour, the way every text kind
       * does. It produces a QR THAT CANNOT BE READ: style.color defaults to #FFFFFF because slides
       * are usually light text on a dark background, so a QR added with no styling is white modules
       * on the white panel below — a solid white square. It renders without error, the path data is
       * all there, and it looks like a blank box on the wall. Found by putting one on a screen; no
       * amount of reading the code showed it.
       *
       * ⚠️ AND THE LIGHT PANEL IS NOT DECORATION EITHER. A camera reads a code by thresholding
       * contrast, so dark modules straight over a photo are frequently unscannable — and the author
       * cannot tell, because it still LOOKS like a QR. The quiet zone in qrSvg is the same point.
       */
      return {
        ec: pick(QR_EC, src.qr_ec, 'M'),
        fg: color(src.qr_fg, '#000000'),
        bg: color(src.qr_bg, '#FFFFFF'),
      };
    default:
      return null;
  }
}

/**
 * Validate and clamp a stored slide config into exactly the shape the renderer expects.
 *
 * ⚠️ TOTAL, NOT PARTIAL. It never throws and never returns null: a malformed slide still renders,
 * because the alternative on a wall is a blank screen. What it does is refuse to carry anything it
 * did not recognise, so the renderer below can interpolate every value it is handed without
 * re-checking. The two halves are only safe as a pair.
 */
function normalizeSlide(raw) {
  const cfg = (raw && typeof raw === 'object') ? raw : {};
  const tplIn = (cfg.template && typeof cfg.template === 'object') ? cfg.template : {};
  const fieldsIn = (cfg.fields && typeof cfg.fields === 'object' && !Array.isArray(cfg.fields)) ? cfg.fields : {};

  const fields = {};
  let n = 0;
  for (const [k, v] of Object.entries(fieldsIn)) {
    if (n++ >= MAX_FIELDS) break;
    if (!SLOT_RE.test(k)) continue;
    // Coerced rather than skipped: a number typed into a field is a perfectly reasonable value and
    // arrives from JSON as a number. Objects and arrays are not values and are dropped.
    if (v == null) { fields[k] = ''; continue; }
    if (typeof v === 'object') continue;
    fields[k] = String(v).slice(0, MAX_FIELD_CHARS);
  }

  const elsIn = Array.isArray(tplIn.elements) ? tplIn.elements.slice(0, MAX_ELEMENTS) : [];
  const elements = elsIn.map((e, i) => {
    const src = (e && typeof e === 'object') ? e : {};
    const kind = Object.prototype.hasOwnProperty.call(KINDS, src.kind) ? src.kind : 'body';
    const box = (src.box && typeof src.box === 'object') ? src.box : {};
    const style = (src.style && typeof src.style === 'object') ? src.style : {};
    const m = (src.motion && typeof src.motion === 'object') ? src.motion : null;

    const slot = (typeof src.slot === 'string' && SLOT_RE.test(src.slot)) ? src.slot : `slot_${i}`;

    return {
      slot,
      kind,
      // ⚠️ Percentages, and allowed slightly outside 0-100 on purpose: sliding a strapline off the
      // edge is a legitimate design, and clamping it to the frame would silently move somebody's
      // layout rather than render what they built.
      x: clamp(box.x, -50, 150, 0),
      y: clamp(box.y, -50, 150, 0),
      w: clamp(box.w, 0.5, 200, 40),
      h: box.h == null ? null : clamp(box.h, 0.1, 200, 10),
      contentId: typeof src.content_id === 'string' && src.content_id.length <= 64 ? src.content_id : null,
      style: {
        color: color(style.color, '#FFFFFF'),
        /*
         * Total by construction: an unknown id resolves to the default rather than being dropped,
         * which is what lets the renderer interpolate it without re-checking.
         *
         * ⚠️ A `u:<id>` reference is KEPT AS IS. Whether that upload still exists is not a question
         * normalize can answer — it has no database — and collapsing it to the default here would
         * silently rewrite an operator's font choice on every save, including saves that happen for
         * unrelated reasons. The renderer resolves it, and falls back only at render time.
         */
        font: slideFonts.isCustom(style.font)
          ? String(style.font).slice(0, 80)
          : slideFonts.resolveFamily(style.font),
        // Container units, NEVER px. A slide is authored once and lands on panels from 720p to 4K,
        // and px is how the designer ended up with a regex that divides by 108 to rescue old
        // widgets. cqw against a sized container is the same number on every screen.
        size: clamp(style.size_cqw, 0.2, 40, 3),
        weight: Math.round(clamp(style.weight, 100, 900, 400) / 100) * 100,
        align: ['left', 'center', 'right'].includes(style.align) ? style.align : 'left',
        radius: clamp(style.radius_cqw, 0, 20, 0),
        opacity: clamp(style.opacity, 0, 1, 1),
      },
      /*
       * Per-kind setup, normalized here so the renderer never re-checks it — the same pairing the
       * header describes. Null for every kind that needs none, so its absence is not ambiguous.
       */
      cfg: kindConfig(kind, src),
      motion: (m && Object.prototype.hasOwnProperty.call(ANIMATIONS, m.animation)) ? {
        animation: m.animation,
        // Bounded well below anything sane: a 40-second delay on a 10-second slide is not a slow
        // entrance, it is an element that never appears, and the editor should have refused it.
        delay: clamp(m.delay, 0, 30, 0),
        duration: clamp(m.duration, 0.05, 10, 0.5),
        easing: Object.prototype.hasOwnProperty.call(EASINGS, m.easing) ? m.easing : 'ease-out',
      } : null,
    };
  });

  return {
    background: color(tplIn.background, '#000000'),
    /*
     * ⚠️ A PHOTO BEHIND THE WORDS, AND A SCRIM IN FRONT OF IT.
     *
     * A background image without a way to darken it is a trap on a signage product: the photo an
     * operator picks is whatever they had, its contrast varies across the frame, and white text
     * over a bright sky is unreadable from the far side of a lobby. `background_dim` overlays black
     * at that opacity BETWEEN the photo and the elements, so the text stays legible without anybody
     * having to edit the image.
     *
     * The colour stays as well, and is not redundant: it is what shows while the photo is still
     * downloading, and what shows for good if it never arrives.
     */
    backgroundContentId: typeof tplIn.background_content_id === 'string'
      && tplIn.background_content_id.length <= 64 ? tplIn.background_content_id : null,
    backgroundDim: clamp(tplIn.background_dim, 0, 1, 0),
    elements,
    fields,
  };
}

/**
 * How long after the slide appears the last element finishes arriving, in seconds.
 *
 * ⚠️ THE NUMBER THE EDITOR HAS TO SHOW. A slide's motion must finish inside the playlist item's
 * duration, and nothing in the authoring path currently knows that those two things are related.
 * An animation that outlives its dwell is not a subtle defect: the text is still moving when the
 * slide is replaced, so on the wall it reads as content that never arrives — and it looks exactly
 * like a broken player rather than a slide someone mis-timed.
 */
function settleTime(slide) {
  return (slide.elements || []).reduce(
    (max, e) => (e.motion ? Math.max(max, e.motion.delay + e.motion.duration) : max), 0);
}

/* ============ QR: drawn server-side, as an SVG, with no script at all ============ */

/*
 * ⚠️ LAZY AND CACHED. `qrcode` is already a dependency (routes/auth.js draws the MFA enrolment code
 * with it), but it is a large module and the overwhelming majority of slides have no QR on them.
 * Requiring it at module load makes every slide render pay for it.
 */
let _qrcode;
function qrLib() {
  if (_qrcode === undefined) {
    try { _qrcode = require('qrcode'); } catch (e) { _qrcode = null; }
  }
  return _qrcode;
}

/**
 * A QR code as an inline SVG, or null if the payload cannot be encoded.
 *
 * ⚠️ SERVER-SIDE AND SYNCHRONOUS, VIA `create()`. The library's `toString`/`toDataURL` are async and
 * renderSlideHtml is not — making the renderer async to draw a QR would ripple into every caller
 * (routes/widgets.js, routes/ai.js, the deck publisher) for no gain. `create()` returns the module
 * matrix synchronously and the SVG below is arithmetic on it.
 *
 * ⚠️ AND NOT VIA A THIRD-PARTY IMAGE URL. The obvious shortcut is an <img> pointed at one of the
 * public QR-rendering services. That puts a signage screen's content on someone else's uptime, and
 * leaks whatever the code encodes to them on every render — for a thing this module can compute.
 */
function qrSvg(text, ec, darkIn, lightIn) {
  const lib = qrLib();
  const payload = String(text == null ? '' : text);
  if (!lib || !payload) return null;
  /*
   * ⚠️ THE COLOURS AND THE LEVEL ARE RE-VALIDATED HERE, not trusted from the caller.
   *
   * On the render path they arrive from a normalized element and are already hex. This function is
   * ALSO reachable from the deck editor's QR preview route, where they arrive from a QUERY STRING —
   * and an unvalidated value lands inside `fill="…"`, which is an attribute breakout. Validating in
   * the caller would mean every future caller has to remember; validating here means the function
   * cannot emit anything but a colour whoever calls it and however they got there.
   */
  const dark = color(darkIn, '#000000');
  const light = color(lightIn, '#FFFFFF');
  const level = Object.prototype.hasOwnProperty.call(QR_EC, ec) ? ec : 'M';
  let qr;
  try {
    qr = lib.create(payload, { errorCorrectionLevel: level });
  } catch (e) {
    /*
     * Reachable without anybody doing anything wrong: MAX_FIELD_CHARS is 2000 and the largest QR
     * holds less than that at error-correction levels above L, so a long payload throws here. The
     * caller draws the same placeholder a missing photo gets — a slide with a hole in it is better
     * than a slide that failed to render.
     */
    return null;
  }
  const size = qr.modules.size;
  const data = qr.modules.data;

  /*
   * ⚠️ THE QUIET ZONE IS PART OF THE CODE, NOT PADDING. The spec requires four clear modules on
   * every side, and a reader that cannot find them frequently will not decode at all. Dropping it
   * makes the code look tidier in the editor and fail against real phones.
   */
  const QUIET = 4;
  const dim = size + QUIET * 2;

  // Horizontal runs rather than a rect per module: the same picture in roughly half the bytes, and
  // a slide document is fetched fresh by every player on every play.
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) { x++; continue; }
      let run = 1;
      while (x + run < size && data[y * size + x + run]) run++;
      d += `M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`;
      x += run;
    }
  }

  /*
   * Every value interpolated below is generated here or already hex-validated by `color()`:
   * `dim` and `d` are arithmetic on the matrix, `dark`/`light` are #RGB or #RRGGBB or the default.
   * There is no path for operator text to reach the markup — the payload only ever becomes module
   * coordinates.
   */
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" `
    + `preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" `
    + `style="width:100%;height:100%;display:block">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${d}" fill="${dark}"/></svg>`;
}

/* ============ the live elements: clock, date, countdown ============ */

/*
 * ⚠️ ONE CONSTANT SCRIPT, AND EVERY PARAMETER ARRIVES THROUGH THE DOM.
 *
 * This is the whole security design of the feature, and it is worth stating plainly because the
 * obvious implementation is the dangerous one. `frontend/js/views/designer.js` builds a script per
 * element by interpolating the element's configuration into JavaScript source — `setInterval` with
 * a date pasted in, `fetch` with a URL pasted in. That makes operator input part of a program, and
 * the only thing standing between a slide and arbitrary script in the frame is whether every one of
 * those interpolations was escaped for a JS string context. Some of them are not.
 *
 * Here the script below is a CONSTANT: byte-for-byte identical in every document this module emits,
 * containing no interpolation of any kind. Configuration reaches it as `data-` attributes, which
 * pass through escapeHtml on the way in, and it reads them with getAttribute — a string API that
 * cannot execute anything. It writes with `textContent` and never `innerHTML`, so even a value that
 * somehow arrived carrying markup lands on the screen as the characters the operator typed rather
 * than as elements. There is no path from a slide's configuration to executed code.
 *
 * ⚠️ A LIVE ELEMENT WITH NO WORKING SCRIPT RENDERS EMPTY, DELIBERATELY. The tempting fallback is to
 * bake the time at render into the element so something shows if the script never runs. But a slide
 * document is fetched once and can sit on a panel for the length of a playlist loop, so that
 * fallback is a clock displaying a time that is quietly, plausibly wrong — which on a wall is worse
 * than an empty box, because nobody can tell by looking.
 */
const LIVE_SCRIPT = `<script>
(function () {
  var els = document.querySelectorAll('.live');
  if (!els.length) return;
  function at(el, n, d) { var v = el.getAttribute(n); return v === null || v === '' ? d : v; }
  function opts(el, kind) {
    var o;
    if (kind === 'clock') {
      var f = at(el, 'data-fmt', '24');
      o = { hour: '2-digit', minute: '2-digit', hour12: f.charAt(0) === '1' };
      if (f.indexOf('s') >= 0) o.second = '2-digit';
    } else {
      var g = at(el, 'data-fmt', 'long');
      o = g === 'weekday' ? { weekday: 'long', month: 'long', day: 'numeric' }
        : g === 'numeric' ? { year: 'numeric', month: '2-digit', day: '2-digit' }
        : g === 'short' ? { year: 'numeric', month: 'short', day: 'numeric' }
        : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    }
    return o;
  }
  function span(el, now) {
    var t = parseInt(at(el, 'data-to', ''), 10);
    if (!isFinite(t)) return '';
    var ms = t - now;
    if (ms <= 0) return at(el, 'data-done', '');
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60), ss = s % 60;
    return d > 0 ? d + 'd ' + h + 'h ' + m + 'm'
      : h > 0 ? h + 'h ' + m + 'm ' + ss + 's'
      : m + 'm ' + ss + 's';
  }
  function text(el, kind, now) {
    if (kind === 'countdown') return span(el, now);
    var loc = at(el, 'data-loc', '') || undefined;
    var tz = at(el, 'data-tz', '');
    var o = opts(el, kind);
    var when = new Date(now);
    if (tz) {
      o.timeZone = tz;
      try { return new Intl.DateTimeFormat(loc, o).format(when); } catch (e) { delete o.timeZone; }
    }
    try { return new Intl.DateTimeFormat(loc, o).format(when); } catch (e) {}
    try { return kind === 'clock' ? when.toLocaleTimeString() : when.toLocaleDateString(); } catch (e) {}
    return '';
  }
  function tick() {
    var now = Date.now();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var v = text(el, el.getAttribute('data-live'), now);
      if (el.textContent !== v) el.textContent = v;
    }
  }
  tick();
  setInterval(tick, 1000);
})();
</script>`;

/**
 * Join the template to the record and emit a standalone document.
 *
 * `resolveImage(contentId)` returns a URL or null; injected rather than imported so this module
 * stays a pure function of its inputs and can be tested without a database.
 */
function renderSlideHtml(rawConfig, opts = {}) {
  const slide = normalizeSlide(rawConfig);
  const resolveImage = typeof opts.resolveImage === 'function' ? opts.resolveImage : () => null;
  /*
   * ⚠️ INJECTED, LIKE resolveImage, AND FOR THE SAME REASON. An uploaded font is a row scoped to a
   * workspace, and the lookup that enforces that belongs with the route that knows the workspace —
   * not in a pure renderer. Absent (tests, previews) every `u:` reference simply falls back.
   */
  const resolveCustomFont = typeof opts.resolveFont === 'function' ? opts.resolveFont : () => null;

  // Resolved once: the same font may be referenced by several elements, and a lookup per element
  // would hit the database once per line of text on the slide.
  const customs = new Map();
  for (const e of slide.elements) {
    const id = e.style && e.style.font;
    if (!slideFonts.isCustom(id) || customs.has(id)) continue;
    customs.set(id, resolveCustomFont(slideFonts.customId(id)) || null);
  }

  /*
   * ⚠️ A `u:` reference whose upload is gone falls back to the DEFAULT family, not to nothing.
   * The alternative — emitting the missing family name anyway — gives the browser a face it cannot
   * load and no fallback, so the text renders in whatever the platform picks, differently on every
   * panel. That is the exact failure the bundled set was built to end.
   */
  const fontFamilyFor = (id) => {
    if (!slideFonts.isCustom(id)) return slideFonts.fontStack(id);
    const f = customs.get(id);
    if (!f) return slideFonts.fontStack(slideFonts.DEFAULT_FAMILY);
    const generic = f.format === 'otf' || f.format === 'ttf' ? 'sans-serif' : 'sans-serif';
    return `'${f.css_family}', ${generic}`;
  };

  const body = slide.elements.map((e) => {
    const s = e.style;
    const css = [
      `left:${e.x}%`, `top:${e.y}%`, `width:${e.w}%`,
      e.h == null ? '' : `height:${e.h}%`,
      s.opacity === 1 ? '' : `opacity:${s.opacity}`,
      s.radius ? `border-radius:${s.radius}cqw` : '',
    ];

    if (e.motion) {
      const m = e.motion;
      css.push(
        `animation-name:${ANIMATIONS[m.animation]}`,
        `animation-duration:${m.duration}s`,
        `animation-delay:${m.delay}s`,
        `animation-timing-function:${EASINGS[m.easing]}`,
        // ⚠️ `both`, so the element holds its FROM state through the delay. Without it every
        // element is painted in place on frame one and then jumps to its entrance when its delay
        // elapses — the slide flashes its finished layout before animating into it.
        'animation-fill-mode:both',
      );
    }

    if (e.kind === 'rule' || e.kind === 'box') {
      css.push(`background:${s.color}`);
      return `<div class="e" style="${css.filter(Boolean).join(';')}"></div>`;
    }

    if (e.kind === 'image') {
      const url = resolveImage(e.contentId);
      css.push('overflow:hidden');
      // Only the non-default is emitted, so every slide authored before this renders byte for byte
      // as it did — a layout change nobody asked for is a worse bug than a missing option.
      const fitCls = e.cfg.fit === 'contain' ? ' class="fit"' : '';
      const inner = url
        ? `<img${fitCls} src="${escapeHtml(url)}" alt="">`
        // A slide whose photo is missing says so, quietly, rather than leaving a hole an operator
        // has to guess at. It is deliberately unobtrusive: on a wall this is better than a red box.
        : `<div class="ph"></div>`;
      return `<div class="e" style="${css.filter(Boolean).join(';')}">${inner}</div>`;
    }

    if (e.kind === 'lettering') {
      const url = resolveImage(e.contentId);
      css.push('overflow:hidden');
      /*
       * ⚠️ THE ALT TEXT IS THE ACTUAL WORDS, from the field. A headline that is a picture is
       * invisible to a screen reader, to a search, and to anybody reading this document as text —
       * and the one thing we reliably know about the picture is what it was asked to say.
       */
      const words = escapeHtml(slide.fields[e.slot] || '');
      const inner = url
        ? `<img class="fit" src="${escapeHtml(url)}" alt="${words}">`
        : `<div class="ph"></div>`;
      return `<div class="e" style="${css.filter(Boolean).join(';')}">${inner}</div>`;
    }

    if (e.kind === 'qr') {
      // cfg.fg, NOT s.color — see kindConfig for the white-on-white failure that caused.
      const svg = qrSvg(slide.fields[e.slot] || '', e.cfg.ec, e.cfg.fg, e.cfg.bg);
      css.push('overflow:hidden');
      // The same quiet placeholder a missing photo gets, for the same reason: an empty payload or
      // one too long to encode should leave a gap somebody notices, not break the slide.
      return `<div class="e" style="${css.filter(Boolean).join(';')}">${svg || '<div class="ph"></div>'}</div>`;
    }

    css.push(
      `color:${s.color}`,
      `font-family:${fontFamilyFor(s.font)}`,
      `font-size:${s.size}cqw`,
      `font-weight:${s.weight}`,
      `text-align:${s.align}`,
    );
    const live = KINDS[e.kind].live;
    if (live) {
      /*
       * ⚠️ EVERY ONE OF THESE VALUES IS ESCAPED ON THE WAY INTO THE ATTRIBUTE, even though
       * normalizeSlide already restricted each to an allowlist, a structural regex or a number.
       * That is the pairing the header describes and it is not redundancy for its own sake: the day
       * somebody adds a format or widens a regex, this line is what decides whether that becomes a
       * markup bug. `data-done` in particular carries operator text straight from a field.
       */
      const attrs = [`data-live="${escapeHtml(live)}"`];
      if (live === 'countdown') {
        if (e.cfg.target != null) attrs.push(`data-to="${e.cfg.target}"`);
        attrs.push(`data-done="${escapeHtml(slide.fields[e.slot] || '')}"`);
      } else {
        attrs.push(`data-fmt="${escapeHtml(e.cfg.format)}"`);
        if (e.cfg.tz) attrs.push(`data-tz="${escapeHtml(e.cfg.tz)}"`);
        if (e.cfg.locale) attrs.push(`data-loc="${escapeHtml(e.cfg.locale)}"`);
      }
      return `<div class="e t live" ${attrs.join(' ')} style="${css.filter(Boolean).join(';')}"></div>`;
    }

    return `<div class="e t" style="${css.filter(Boolean).join(';')}">${escapeHtml(slide.fields[e.slot] || '')}</div>`;
  }).join('\n    ');

  /*
   * ⚠️ @font-face FOR EXACTLY THE FAMILIES THIS SLIDE USES, emitted into the document itself.
   *
   * It cannot be a stylesheet link: the player mounts this in an iframe sandboxed to allow-scripts
   * with NO allow-same-origin, so the frame is an opaque origin and every subresource fetch from it
   * is cross-origin. A font fetch in that position is CORS-restricted in a way an image is not —
   * which is why the /fonts mount sets Access-Control-Allow-Origin, and why fonts do NOT ride
   * /uploads/content (hardenUploadResponse forces octet-stream + attachment on anything outside the
   * inline-safe set, and a font served that way is refused under nosniff).
   */
  const customFaces = [...customs.values()].filter(Boolean)
    .map((f) => slideFonts.customFace(f)).join('\n  ');

  const faces = require('./slide-fonts').fontFaceCss(
    /*
     * ⚠️ FILTERED ON KIND, NOT ON size. The obvious filter is `e.style.size` — and it is wrong,
     * because normalizeSlide CLAMPS size to a default of 3 for every element including rules and
     * panels. So every slide, even one that is nothing but a coloured bar, asked for a font it
     * could not possibly show. A test caught it; reading the code did not.
     */
    /*
     * ⚠️ Bundled families only — a `u:` id is not one, and handing it to fontFaceCss would quietly
     * emit the DEFAULT family's face under a custom name.
     *
     * ⚠️ PLUS the default, when a `u:` reference could not be resolved. fontFamilyFor falls back to
     * the default family for a missing upload — and without declaring its face, that fallback is
     * INERT: the browser is asked for 'Inter', has no rule for it, and lands on the platform's own
     * sans. Which is the exact "different on every panel" failure the bundled set exists to end.
     * Caught by looking at the emitted HTML, not by reading this function.
     */
    slide.elements
      .filter((e) => KINDS[e.kind] && KINDS[e.kind].glyphs)
      .map((e) => (slideFonts.isCustom(e.style.font)
        ? (customs.get(e.style.font) ? null : slideFonts.DEFAULT_FAMILY)
        : e.style.font))
      .filter(Boolean));

  /*
   * ⚠️ THE PHOTO IS A LAYER UNDER THE ELEMENTS, NOT A body background.
   *
   * `background-image` on body cannot carry a scrim without a second element anyway, and the
   * elements are absolutely positioned inside .stage — putting the photo on body would leave it
   * outside the container that `container-type:size` establishes, so it would not track the stage
   * on a zoned layout.
   */
  const bgUrl = slide.backgroundContentId ? resolveImage(slide.backgroundContentId) : null;
  const bgLayers = (bgUrl ? `<div class="bg" style="background-image:url(${escapeHtml(cssUrl(bgUrl))})"></div>` : '')
    + (bgUrl && slide.backgroundDim > 0
      ? `<div class="scrim" style="background:rgba(0,0,0,${slide.backgroundDim})"></div>` : '');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  ${faces}${customFaces ? `\n  ${customFaces}` : ''}
  html,body { margin:0; height:100%; overflow:hidden; background:${slide.background}; }
  /* ⚠️ container-type:size is what makes every cqw above mean anything. Without it the units
     resolve against the viewport and a slide inside a ZONE renders at full-screen sizes. */
  .stage { position:relative; width:100%; height:100%; container-type:size; }
  .e { position:absolute; }
  /* Both fill the stage and sit beneath every element, in source order: photo, then scrim. */
  .bg { position:absolute; inset:0; background-size:cover; background-position:center; }
  .scrim { position:absolute; inset:0; }
  .t { line-height:1.08; white-space:pre-wrap; word-break:break-word; }
  .e img { width:100%; height:100%; object-fit:cover; display:block; }
  /* A cut-out must fit inside its box, not be cropped to fill it. See IMAGE_FITS. */
  .e img.fit { object-fit:contain; }
  .ph { width:100%; height:100%; background:rgba(255,255,255,.06);
        border:1px dashed rgba(255,255,255,.18); box-sizing:border-box; }
  @keyframes st-fade    { from { opacity:0 } to { opacity:1 } }
  @keyframes st-slide-l { from { opacity:0; transform:translateX(-14%) } to { opacity:1; transform:none } }
  @keyframes st-slide-r { from { opacity:0; transform:translateX(14%) }  to { opacity:1; transform:none } }
  @keyframes st-slide-u { from { opacity:0; transform:translateY(26%) }  to { opacity:1; transform:none } }
  @keyframes st-slide-d { from { opacity:0; transform:translateY(-26%) } to { opacity:1; transform:none } }
  @keyframes st-zoom    { from { opacity:0; transform:scale(.86) }       to { opacity:1; transform:none } }
  @keyframes st-wipe    { from { clip-path:inset(0 100% 0 0) }           to { clip-path:inset(0 0 0 0) } }
</style></head>
<body><div class="stage">
    ${bgLayers}
    ${body}
</div>${slide.elements.some((e) => KINDS[e.kind].live) ? LIVE_SCRIPT : ''}</body></html>`;
}

module.exports = {
  ANIMATIONS, EASINGS, KINDS,
  CLOCK_FORMATS, DATE_FORMATS, QR_EC, IMAGE_FITS,
  MAX_ELEMENTS, MAX_FIELD_CHARS, MAX_FIELDS,
  normalizeSlide, settleTime, renderSlideHtml,
  // Exported for tests: the QR matrix and the constant script are the two pieces whose properties
  // have to be asserted directly rather than inferred from a rendered document.
  qrSvg, LIVE_SCRIPT,
};
