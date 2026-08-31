'use strict';

/*
 * The four kinds ported out of the designer: qr, clock, date, countdown.
 *
 * ⚠️ WHY THIS PORT NEEDED ITS OWN SECURITY ARGUMENT. frontend/js/views/designer.js implements the
 * same four features by BUILDING A SCRIPT PER ELEMENT — interpolating the element's configuration
 * into JavaScript source (`setInterval` with a date pasted in, `fetch` with a URL pasted in). Every
 * one of those interpolations is a place where operator input becomes program text, and the slide
 * renderer has spent its whole life keeping script out of its output on purpose.
 *
 * So the port is only sound if the script is a CONSTANT and the configuration travels as data. That
 * is not a property you can eyeball once and trust — it is one edit away from being false — so it
 * is asserted here directly: the emitted script is compared byte-for-byte against the constant, and
 * the constant is checked for interpolation syntax.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../lib/slide-render');

const render = (elements, fields = {}) =>
  R.renderSlideHtml({ template: { elements }, fields });

/* An image element only becomes an <img> when its content resolves; without a resolver it is the
 * missing-photo placeholder, which is a different branch entirely. */
const renderWithImages = (elements, fields = {}) =>
  R.renderSlideHtml({ template: { elements }, fields }, { resolveImage: () => '/uploads/content/x.png' });

/** Markup that would execute or restructure the document if any escape were missing. */
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

/* ============ the script is a constant, and that is the whole design ============ */

test('⚠️ the live script contains NO interpolation of any kind', () => {
  /*
   * The single property everything else rests on. A `${` in this string means some element's
   * configuration is being pasted into JavaScript, which is the designer's model and the reason
   * this file argues the port had to be done differently.
   */
  assert.ok(!R.LIVE_SCRIPT.includes('${'), 'template interpolation in the live script');
  assert.ok(!/\+\s*(el|cfg|slide|e)\./.test(R.LIVE_SCRIPT), 'concatenation of an element value into source');
});

test('⚠️ the script never writes HTML — textContent only', () => {
  // The second half of the argument: even a value that arrived carrying markup lands on screen as
  // characters. An innerHTML here would reopen the exact hole the constant script closes.
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|outerHTML/.test(R.LIVE_SCRIPT));
  assert.ok(R.LIVE_SCRIPT.includes('textContent'));
});

test('⚠️ the script contains no evaluator', () => {
  assert.ok(!/\beval\b|new Function|setTimeout\(\s*['"]/.test(R.LIVE_SCRIPT));
});

test('the emitted script is byte-identical to the constant', () => {
  const html = render([{ kind: 'clock' }]);
  const emitted = html.slice(html.indexOf('<script>'), html.indexOf('</script>') + 9);
  assert.equal(emitted, R.LIVE_SCRIPT, 'the document must carry the constant unmodified');
});

test('⚠️ the script selector matches the class the renderer emits', () => {
  /*
   * These two live 200 lines apart and nothing but this test connects them. Rename one and every
   * clock on every screen silently stops ticking — with no error anywhere, because a selector that
   * matches nothing is not an error.
   */
  const sel = R.LIVE_SCRIPT.match(/querySelectorAll\('([^']+)'\)/);
  assert.ok(sel, 'the script must select its elements');
  const html = render([{ kind: 'clock' }]);
  assert.ok(html.includes(`class="e t ${sel[1].replace('.', '')}"`), `nothing carries ${sel[1]}`);
});

test('the script rides only on documents that need it', () => {
  // Every player fetches this document fresh on every play; shipping a ticker to a slide of static
  // text is dead weight on hardware that has little to spare.
  assert.equal((render([{ kind: 'head', slot: 'a' }]).match(/<script/g) || []).length, 0);
  assert.equal((render([{ kind: 'image' }, { kind: 'box' }]).match(/<script/g) || []).length, 0);
});

test('many live elements still emit exactly one script', () => {
  const html = render([{ kind: 'clock' }, { kind: 'date' }, { kind: 'countdown', slot: 'a' }]);
  assert.equal((html.match(/<script/g) || []).length, 1);
});

/* ============ configuration is validated, then escaped anyway ============ */

test('⚠️ a hostile clock format / timezone / locale never reaches the document', () => {
  const html = render([{ kind: 'clock', clock_format: EVIL, tz: EVIL, locale: EVIL }]);
  assert.ok(html.includes('data-fmt="24"'), 'an unknown format must become the default');
  assert.ok(!html.includes('data-tz='), 'a malformed zone must be dropped, not emitted');
  assert.ok(!html.includes('data-loc='), 'a malformed locale must be dropped, not emitted');
  assert.ok(!html.includes('<img'), 'markup breakout');
});

test('⚠️ the countdown done-message is operator text and is escaped', () => {
  // The one value on a live element that comes straight from a field, so the one that matters most.
  const html = render([{ kind: 'countdown', slot: 'd' }], { d: EVIL });
  assert.ok(!html.includes('<img'), 'markup breakout through data-done');
  assert.ok(html.includes('&quot;&gt;&lt;img'), 'the message must survive as escaped characters');
  assert.equal((html.match(/<script/g) || []).length, 1, 'the payload must not add a script tag');
});

test('a legitimate zone and locale are carried through', () => {
  const html = render([{ kind: 'clock', clock_format: '12s', tz: 'America/Chicago', locale: 'en-GB' }]);
  assert.ok(html.includes('data-fmt="12s"'));
  assert.ok(html.includes('data-tz="America/Chicago"'));
  assert.ok(html.includes('data-loc="en-GB"'));
});

test('every clock format in the allowlist survives, and nothing else does', () => {
  for (const f of Object.keys(R.CLOCK_FORMATS)) {
    assert.ok(render([{ kind: 'clock', clock_format: f }]).includes(`data-fmt="${f}"`));
  }
  for (const f of ['', '36', 'HH:mm', null, 12, {}]) {
    assert.ok(render([{ kind: 'clock', clock_format: f }]).includes('data-fmt="24"'), `${f} slipped through`);
  }
});

test('every date format in the allowlist survives, and nothing else does', () => {
  for (const f of Object.keys(R.DATE_FORMATS)) {
    assert.ok(render([{ kind: 'date', date_format: f }]).includes(`data-fmt="${f}"`));
  }
  assert.ok(render([{ kind: 'date', date_format: 'yyyy-mm-dd' }]).includes('data-fmt="long"'));
});

/* ============ the countdown target ============ */

test('a countdown target is normalized to epoch milliseconds', () => {
  const n = R.normalizeSlide({ template: { elements: [{ kind: 'countdown', target: '2027-01-01T00:00:00Z' }] } });
  assert.equal(n.elements[0].cfg.target, Date.UTC(2027, 0, 1));
});

test('a numeric target is taken as milliseconds', () => {
  const n = R.normalizeSlide({ template: { elements: [{ kind: 'countdown', target: 1798761600000 }] } });
  assert.equal(n.elements[0].cfg.target, 1798761600000);
});

test('⚠️ an unusable target becomes null rather than a wrong date', () => {
  /*
   * NaN interpolated into data-to would render as "NaN", and the script's parseInt would then make
   * every countdown on the slide read as its done-message — a screen quietly announcing that an
   * event has already happened.
   */
  for (const v of ['soon', '', null, undefined, {}, NaN, -1, Date.UTC(9999, 0, 1)]) {
    const n = R.normalizeSlide({ template: { elements: [{ kind: 'countdown', target: v }] } });
    assert.equal(n.elements[0].cfg.target, null, `${String(v)} should not produce a target`);
  }
  assert.ok(!render([{ kind: 'countdown', slot: 'a', target: 'soon' }]).includes('data-to='));
});

/* ============ QR ============ */

test('a QR renders as an inline SVG with no script and no external request', () => {
  const html = render([{ kind: 'qr', slot: 'q' }], { q: 'https://screentinker.com' });
  assert.ok(html.includes('<svg'), 'no svg emitted');
  assert.equal((html.match(/<script/g) || []).length, 0, 'a QR must not need script');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.match(/<svg[\s\S]*?<\/svg>/)[0]),
    'the svg must not reference a third-party renderer');
});

test('⚠️ the payload becomes geometry, never markup', () => {
  const html = render([{ kind: 'qr', slot: 'q' }], { q: EVIL });
  assert.ok(!html.includes('<img'), 'markup breakout through the payload');
  assert.ok(!html.includes('onerror=alert'), 'the payload must not appear as text either');
});

test('a different payload draws a different code', () => {
  // Guards against the placeholder-for-everything failure, where a QR renders but encodes nothing.
  const a = render([{ kind: 'qr', slot: 'q' }], { q: 'https://a.example' });
  const b = render([{ kind: 'qr', slot: 'q' }], { q: 'https://b.example' });
  assert.notEqual(a.match(/<path d="([^"]*)"/)[1], b.match(/<path d="([^"]*)"/)[1]);
});

test('⚠️ the quiet zone is present', () => {
  /*
   * Four clear modules a side are part of the spec, not padding. Without them a code still LOOKS
   * correct in the editor and frequently will not decode against a real phone — a failure nobody
   * discovers until the poster is on a wall.
   */
  const svg = R.qrSvg('https://screentinker.com', 'M', '#000000', '#FFFFFF');
  const dim = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  const maxX = Math.max(...[...svg.matchAll(/M(\d+) (\d+)h(\d+)/g)].map((m) => +m[1] + +m[3]));
  const minX = Math.min(...[...svg.matchAll(/M(\d+) /g)].map((m) => +m[1]));
  assert.ok(minX >= 4, `modules start at ${minX}, inside the quiet zone`);
  assert.ok(dim - maxX >= 4, `modules reach ${maxX} of ${dim}, inside the quiet zone`);
});

test('an empty or unencodable payload falls back to the placeholder, not an exception', () => {
  assert.equal(R.qrSvg('', 'M', '#000', '#FFF'), null);
  assert.equal(R.qrSvg('x'.repeat(2000), 'H', '#000', '#FFF'), null, 'too long for level H');
  const html = render([{ kind: 'qr', slot: 'q' }], { q: '' });
  assert.ok(html.includes('class="ph"'), 'an empty QR should show the same quiet gap a photo does');
});

test('QR colours come from the validated palette only', () => {
  const html = render([{ kind: 'qr', slot: 'q', qr_bg: 'red;}</style><script>x()</script>' }],
    { q: 'https://a.example' });
  assert.ok(html.includes('fill="#FFFFFF"'), 'a non-hex background must fall back to white');
  assert.equal((html.match(/<script/g) || []).length, 0);
});

/* ============ the flag split that is easy to get wrong ============ */

test('⚠️ a clock gets an @font-face; a QR does not', () => {
  /*
   * THE BUG THIS PORT COULD EASILY HAVE SHIPPED. The face filter used to read KINDS[kind].text,
   * which was right only while "reads a field" and "shows characters" were the same set. A clock
   * shows characters and reads no field: under the old flag it rendered in whatever face the panel
   * happened to have — differently on Android, Tizen and BrightSign — which is precisely the
   * failure the bundled font set was built to end, and it is invisible on the machine that authored
   * the slide because that machine has the font installed.
   */
  assert.ok(/@font-face/.test(render([{ kind: 'clock' }])), 'a clock must carry its font');
  assert.ok(/@font-face/.test(render([{ kind: 'date' }])), 'a date must carry its font');
  assert.ok(/@font-face/.test(render([{ kind: 'countdown', slot: 'a' }])), 'a countdown must carry its font');
  assert.ok(!/@font-face/.test(render([{ kind: 'qr', slot: 'q' }], { q: 'https://a.example' })),
    'a QR draws no glyphs and must not pull a font onto the wire');
});

test('the flags agree with what each kind actually emits', () => {
  for (const [kind, k] of Object.entries(R.KINDS)) {
    const html = render([{ kind, slot: 'a' }], { a: 'https://a.example' });
    assert.equal(/@font-face/.test(html), k.glyphs, `${kind}: glyphs flag disagrees with the output`);
    assert.equal(html.includes('data-live='), !!k.live, `${kind}: live flag disagrees with the output`);
  }
});

/* ============ forward and backward compatibility ============ */

test('⚠️ an older server meeting a newer deck degrades instead of throwing', () => {
  // Decks outlive the servers that render them: a slide using a kind this build has never heard of
  // must still put something on the wall.
  const n = R.normalizeSlide({ template: { elements: [{ kind: 'hologram', slot: 'a' }] } });
  assert.equal(n.elements[0].kind, 'body');
  assert.equal(n.elements[0].cfg, null);
});

test('kinds that need no configuration carry none', () => {
  // `image` is deliberately absent: it gained a `fit` setting, which has a sensible default and so
  // does not make it a `config` kind, but does give it a cfg object.
  for (const kind of ['head', 'body', 'stat', 'rule', 'box']) {
    const n = R.normalizeSlide({ template: { elements: [{ kind }] } });
    assert.equal(n.elements[0].cfg, null, `${kind} should not have gained a cfg`);
  }
});

test('⚠️ the AI generator is not offered kinds it cannot fill', () => {
  // It can write a headline. It cannot invent a URL to encode or a date to count down to, and a
  // kind built entirely from defaults reads as a broken slide rather than an empty one.
  const src = require('fs').readFileSync(require.resolve('../routes/ai.js'), 'utf8');
  const listed = src.match(/const SLIDE_KINDS = [\s\S]*?;\n/)[0];
  assert.ok(listed.includes('.config'), 'ai.js must exclude kinds that need configuration');
  // And the flag is actually set on the four that need it, so the filter above has something to bite.
  assert.deepEqual(
    Object.keys(R.KINDS).filter((k) => R.KINDS[k].config).sort(),
    ['clock', 'countdown', 'date', 'lettering', 'qr'],
  );
});

/* ============ the save round-trip, where this feature could lose everything silently ============ */

/*
 * ⚠️ THE TRAP THIS SECTION EXISTS FOR. lib/slide-deck.js rebuilds every stored element KEY BY KEY
 * on save — deliberately, because writing normalizeSlide's output back would rename half the
 * document. Which means any field not explicitly named there is dropped, on every save, with no
 * error: a clock loses its time zone and a countdown its target the next time the deck is touched
 * for an unrelated reason, and the editor keeps showing the operator's own choice until they
 * reload. The renderer's vocabulary and the writer's list are two halves of one duty.
 */

const deckLib = require('../lib/slide-deck');
const VIEW = require('fs').readFileSync(
  require.resolve('../../frontend/js/views/slides.js'), 'utf8');

const deckWith = (elements, fields = {}) => ({
  slides: [{ id: 's1', name: 'n', dwell_sec: 10, template: { elements }, fields }],
});
const savedEl = (deck, i = 0) => deckLib.normalizeDeck(deck).slides[0].template.elements[i];

test('⚠️ a clock keeps its format, zone and language across a save', () => {
  const e = savedEl(deckWith([{ kind: 'clock', slot: 'a', clock_format: '12s', tz: 'Europe/London', locale: 'en-GB' }]));
  assert.equal(e.clock_format, '12s');
  assert.equal(e.tz, 'Europe/London');
  assert.equal(e.locale, 'en-GB');
});

test('⚠️ a date keeps its format across a save', () => {
  const e = savedEl(deckWith([{ kind: 'date', slot: 'a', date_format: 'numeric', tz: 'Asia/Tokyo' }]));
  assert.equal(e.date_format, 'numeric');
  assert.equal(e.tz, 'Asia/Tokyo');
});

test('⚠️ a countdown keeps its target across a save', () => {
  const t = Date.UTC(2027, 5, 1, 9, 30);
  assert.equal(savedEl(deckWith([{ kind: 'countdown', slot: 'a', target: t }])).target, t);
});

test('⚠️ a QR keeps its level and background across a save', () => {
  const e = savedEl(deckWith([{ kind: 'qr', slot: 'a', qr_ec: 'H', qr_bg: '#EEEEEE' }], { a: 'https://a.example' }));
  assert.equal(e.qr_ec, 'H');
  assert.equal(e.qr_bg, '#EEEEEE');
});

test('a second save changes nothing — the document is a fixed point', () => {
  // Decks are re-saved constantly for unrelated reasons. A round-trip that drifts loses a little
  // more each time, which is the shape of failure nobody notices until it has happened everywhere.
  const deck = deckWith([
    { kind: 'clock', slot: 'a', clock_format: '12', tz: 'Europe/London' },
    { kind: 'countdown', slot: 'b', target: Date.UTC(2027, 0, 1) },
    { kind: 'qr', slot: 'c', qr_ec: 'Q' },
  ], { b: 'Open', c: 'https://a.example' });
  const once = deckLib.normalizeDeck(deck);
  assert.deepEqual(deckLib.normalizeDeck(once), once);
});

test('⚠️ hostile config does not survive a save either', () => {
  // The stored document is read back by the editor, which draws the filmstrip with innerHTML — the
  // path that was stored XSS once already. Saving is a second door onto the same decision.
  const e = savedEl(deckWith([{ kind: 'clock', slot: 'a', clock_format: EVIL, tz: EVIL, locale: EVIL }]));
  assert.equal(e.clock_format, '24');
  assert.equal(e.tz, '');
  assert.equal(e.locale, '');
});

test('a kind that needs no config gains no keys on save', () => {
  const e = savedEl(deckWith([{ kind: 'head', slot: 'a' }], { a: 'hi' }));
  for (const k of ['clock_format', 'date_format', 'tz', 'locale', 'target', 'qr_ec', 'qr_bg', 'fit']) {
    assert.ok(!(k in e), `a headline should not carry ${k}`);
  }
});

/* ============ the editor offers exactly what the server accepts ============ */

test('⚠️ the editor and the renderer agree on every allowlist', () => {
  /*
   * They are duplicated: there is no module shared between a server lib and a browser view here.
   * The failure without this test is quiet in the worst way — the editor offers a format, the
   * operator picks it, the save silently substitutes the default, and the wall shows something the
   * person who built it never chose.
   */
  const pairs = (re) => {
    const m = VIEW.match(re);
    assert.ok(m, `list not found in the editor: ${re}`);
    return [...m[1].matchAll(/\['([^']+)',/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(pairs(/const CLOCK_FORMATS = \[([\s\S]*?)\];/), Object.keys(R.CLOCK_FORMATS).sort());
  assert.deepEqual(pairs(/const DATE_FORMATS = \[([\s\S]*?)\];/), Object.keys(R.DATE_FORMATS).sort());
  assert.deepEqual(pairs(/const QR_LEVELS = \[([\s\S]*?)\];/), Object.keys(R.QR_EC).sort());
});

test('⚠️ the editor and the renderer agree on which kinds are live and which draw glyphs', () => {
  // Three flat lists in the view against three flags in KINDS. Drift here is how a clock ends up
  // without a font control, or a QR with one it cannot use.
  const names = (re) => {
    const m = VIEW.match(re);
    assert.ok(m, `list not found in the editor: ${re}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  const server = (flag) => Object.keys(R.KINDS).filter((k) => R.KINDS[k][flag]).sort();
  assert.deepEqual(names(/const LIVE_KINDS = \[([^\]]*)\];/), server('live'));
  assert.deepEqual(names(/const GLYPH_KINDS = \[([^\]]*)\];/), server('glyphs'));
  assert.deepEqual(names(/const TEXT_KINDS = \[([^\]]*)\];/), server('text'));
});

/* ============ the defect a screenshot found and no amount of reading did ============ */

test('⚠️ a QR added with no styling is BLACK ON WHITE, not white on white', () => {
  /*
   * THE BUG. The modules originally inherited style.color, the way every text kind does — and
   * style.color defaults to #FFFFFF, because slides are usually light text on a dark background.
   * So a QR dropped onto a slide rendered as white modules on the white panel behind them: a solid
   * white square. Every assertion in this file still passed. The path data was all there, the quiet
   * zone was right, the payload encoded correctly. It only showed up as an image.
   */
  const html = render([{ kind: 'qr', slot: 'q' }], { q: 'https://screentinker.com' });
  const fills = [...html.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fills, ['#FFFFFF', '#000000'], 'panel white, modules black');
  assert.notEqual(fills[0], fills[1], 'a QR whose modules match its panel is a blank square');
});

test('⚠️ the modules do not follow style.color', () => {
  // The wiring that caused it. A slide's text colour has nothing to do with whether a code scans.
  const html = render([{ kind: 'qr', slot: 'q', style: { color: '#FF0000' } }], { q: 'https://a.example' });
  assert.ok(!html.includes('fill="#FF0000"'), 'the element colour must not reach the modules');
});

test('a deliberate colour choice is still honoured', () => {
  const html = render([{ kind: 'qr', slot: 'q', qr_fg: '#003366', qr_bg: '#FFEECC' }], { q: 'https://a.example' });
  assert.ok(html.includes('fill="#FFEECC"') && html.includes('fill="#003366"'));
});

test('⚠️ a QR nobody can scan is a WARNING, not a silent render', () => {
  /*
   * The one element that can be drawn perfectly and still not work: a camera decodes by
   * thresholding light against dark, so a low-contrast pair yields something unmistakably a QR
   * that no phone reads — and the author cannot tell by looking at it.
   */
  const warn = deckLib.deckWarnings(deckLib.normalizeDeck({
    slides: [{ id: 's1', name: 'Poster', dwell_sec: 10,
      template: { elements: [{ kind: 'qr', slot: 'q', qr_fg: '#EEEEEE', qr_bg: '#FFFFFF' }] },
      fields: { q: 'https://a.example' } }],
  }));
  const hit = warn.find((w) => w.kind === 'qr-contrast');
  assert.ok(hit, 'a white-on-white QR must warn');
  assert.ok(hit.contrast < 3, `contrast reported as ${hit.contrast}`);
  assert.match(hit.message, /camera/i);
});

test('a normal QR produces no warning', () => {
  const warn = deckLib.deckWarnings(deckLib.normalizeDeck({
    slides: [{ id: 's1', name: 'Poster', dwell_sec: 10,
      template: { elements: [{ kind: 'qr', slot: 'q' }] }, fields: { q: 'https://a.example' } }],
  }));
  assert.equal(warn.filter((w) => w.kind === 'qr-contrast').length, 0);
});

test('the QR foreground survives a save like every other config field', () => {
  const e = savedEl(deckWith([{ kind: 'qr', slot: 'a', qr_fg: '#112233' }], { a: 'https://a.example' }));
  assert.equal(e.qr_fg, '#112233');
});

/* ============ how a photo sits in its box ============ */

test('⚠️ a cut-out fits inside its box instead of being cropped to fill it', () => {
  /*
   * THE DEFECT A SPIKE FOUND, and the reason this option exists. `cover` fills the box and crops
   * the overflow, which is right for a photograph used as a panel and wrong for an object with
   * transparency around it — the crop slices through the object. Measured: a generated pumpkin laid
   * into a 34x62 box lost its bottom third, and it reads as a bad photo rather than a setting
   * anybody would think to look for.
   */
  const cover = renderWithImages([{ kind: 'image', content_id: 'x' }]);
  const contain = renderWithImages([{ kind: 'image', content_id: 'x', fit: 'contain' }]);
  assert.ok(!/<img class="fit"/.test(cover), 'cover is the default and needs no class');
  assert.ok(/<img class="fit"/.test(contain), 'contain must be marked');
  assert.ok(/\.e img\.fit \{ object-fit:contain; \}/.test(contain), 'and the rule must be present');
});

test('⚠️ a slide authored before this option renders byte for byte as it did', () => {
  // A layout change nobody asked for is a worse bug than a missing option: these are on screens.
  const before = renderWithImages([{ kind: 'image', content_id: 'x' }, { kind: 'head', slot: 'a' }], { a: 'hi' });
  assert.ok(before.includes('<img src='), 'no class attribute on a default image');
  assert.ok(!before.includes('class="fit"'));
});

test('an unknown fit falls back to cover rather than reaching the markup', () => {
  const html = renderWithImages([{ kind: 'image', content_id: 'x', fit: '" onerror=alert(1)' }]);
  assert.ok(!html.includes('onerror'), 'markup breakout through fit');
  assert.ok(!html.includes('class="fit"'));
});

test('every fit in the allowlist survives, and nothing else does', () => {
  assert.deepEqual(Object.keys(R.IMAGE_FITS).sort(), ['contain', 'cover']);
  for (const f of ['fill', 'none', '', null, 7]) {
    const n = R.normalizeSlide({ template: { elements: [{ kind: 'image', fit: f }] } });
    assert.equal(n.elements[0].cfg.fit, 'cover', `${String(f)} slipped through`);
  }
});

test('fit survives a save like every other per-element setting', () => {
  // The same silent-loss trap: unnamed keys are dropped by sanitizeStored on every save.
  assert.equal(savedEl(deckWith([{ kind: 'image', slot: 'a', fit: 'contain' }])).fit, 'contain');
  assert.equal(savedEl(deckWith([{ kind: 'image', slot: 'a' }])).fit, 'cover');
});

/* ============ layered placement: keeping objects out of the words ============ */

/*
 * ⚠️ TESTED HERE BECAUSE THE FAILURE WAS SEEN ON A REAL RUN, not imagined. The plan prompt asks the
 * model to keep objects clear of the headline; a run that produced a good background, leaf and cup
 * also dropped a pair of mittens directly under "20% OFF". Asking is right — a cooperating model
 * composes better than a corrected one — but it cannot be the only defence.
 */
const AI_SRC = require('fs').readFileSync(require.resolve('../routes/ai.js'), 'utf8');

test('⚠️ object placement is ENFORCED, not merely requested in the prompt', () => {
  assert.match(AI_SRC, /function placeClear/, 'there must be a server-side placement rule');
  assert.match(AI_SRC, /box: placeClear\(/, 'and every object must go through it');
});

test('the text band is reserved and objects are pushed clear of it', () => {
  // Exercised through the module's own constants so the test cannot drift from the rule.
  const zone = AI_SRC.match(/const TEXT_ZONE = Object\.freeze\(\{ x: (\d+), y: (\d+), w: (\d+), h: (\d+) \}\)/);
  assert.ok(zone, 'TEXT_ZONE must be declared');
  const [, zx, zy, zw, zh] = zone.map(Number);
  assert.ok(zw > 40 && zh > 40, 'the reserved band must actually cover where the words sit');
  assert.ok(zx < 10 && zy < 30, 'and start where the headline starts');
});

test('⚠️ the headline box is sized for the wrap that will happen', () => {
  /*
   * A headline as short as "20% OFF" wrapped to two lines at 12cqw in a 52%-wide box and the second
   * line landed on the subhead. Nothing server-side can measure text, so the geometry has to assume
   * the wrap rather than the intent — and the subhead has to clear a two-line headline.
   */
  const head = AI_SRC.match(/slot: 'headline'[\s\S]*?box: \{ x: \d+, y: (\d+), w: (\d+) \}[\s\S]*?size_cqw: ([\d.]+)/);
  const sub = AI_SRC.match(/slot: 'subhead'[\s\S]*?box: \{ x: \d+, y: (\d+), w: (\d+) \}/);
  assert.ok(head && sub, 'both text elements must be findable');
  const headY = Number(head[1]); const headSize = Number(head[3]); const subY = Number(sub[1]);
  assert.ok(headSize <= 10, `headline at ${headSize}cqw is large enough to wrap unexpectedly`);
  assert.ok(subY - headY >= 2.5 * headSize,
    `subhead at ${subY} does not clear a two-line headline starting at ${headY} at ${headSize}cqw`);
});

test('the plan asks for text short enough for the size it is set at', () => {
  assert.match(AI_SRC, /at most 14 characters/, 'the headline length must be constrained upstream too');
});

/* ============ lettering: a picture of words that is still a record ============ */

test('⚠️ the words a lettering element depicts stay in fields', () => {
  /*
   * THE PROMISE THIS FEATURE COULD EASILY HAVE BROKEN. slide-render.js opens by arguing that the
   * changeable text must stay OUT of the layout, so somebody can come back in three months and
   * change a number. Generated lettering is an image, and the obvious implementation stops there —
   * at which point the words have ceased to exist as data, and the slide has become the thing this
   * whole module was written to prevent.
   */
  const n = R.normalizeSlide({
    template: { elements: [{ kind: 'lettering', slot: 'w', content_id: 'c' }] },
    fields: { w: 'AUTUMN SALE' },
  });
  assert.equal(n.fields.w, 'AUTUMN SALE', 'the words must survive normalization');
  assert.ok(R.KINDS.lettering.text, 'lettering must read its field');
});

test('⚠️ the artwork carries the words as alt text', () => {
  // A headline that is a picture is invisible to a screen reader, to a search, and to anyone
  // reading the document as text — and the words are the one thing we reliably know about it.
  const html = R.renderSlideHtml({
    template: { elements: [{ kind: 'lettering', slot: 'w', content_id: 'c' }] },
    fields: { w: 'AUTUMN SALE' },
  }, { resolveImage: () => '/uploads/content/a.png' });
  assert.match(html, /<img class="fit" src="[^"]+" alt="AUTUMN SALE">/);
});

test('⚠️ words that look like markup are escaped into the alt attribute', () => {
  const html = R.renderSlideHtml({
    template: { elements: [{ kind: 'lettering', slot: 'w', content_id: 'c' }] },
    fields: { w: EVIL },
  }, { resolveImage: () => '/uploads/content/a.png' });
  assert.ok(!html.includes('<img src=x'), 'markup breakout through alt');
  assert.ok(html.includes('&quot;'), 'the words must survive as escaped characters');
});

test('⚠️ lettering can never be cropped, and the setting is not offered', () => {
  /*
   * Cropping a word is not a styling choice — it removes letters, and "20% OF" two feet tall on a
   * wall is worse than no slide. So `contain` is fixed here rather than defaulted.
   */
  for (const attempt of ['cover', 'fill', '', null]) {
    const n = R.normalizeSlide({ template: { elements: [{ kind: 'lettering', slot: 'w', fit: attempt }] } });
    assert.equal(n.elements[0].cfg.fit, 'contain', `fit=${String(attempt)} must not take effect`);
  }
  const html = R.renderSlideHtml({
    template: { elements: [{ kind: 'lettering', slot: 'w', content_id: 'c', fit: 'cover' }] },
    fields: { w: 'HI' },
  }, { resolveImage: () => '/u/a.png' });
  assert.match(html, /<img class="fit"/, 'the artwork must always be contained');
});

test('lettering draws no glyphs of its own, so it pulls no font onto the wire', () => {
  const html = R.renderSlideHtml({
    template: { elements: [{ kind: 'lettering', slot: 'w', content_id: 'c' }] },
    fields: { w: 'HI' },
  }, { resolveImage: () => '/u/a.png' });
  assert.ok(!/@font-face/.test(html), 'the words are painted into the image, not set in a face');
});

test('lettering with no artwork yet shows the placeholder rather than breaking', () => {
  // The element is placeable before it has been generated, and a missing upload must not throw.
  const html = R.renderSlideHtml({
    template: { elements: [{ kind: 'lettering', slot: 'w' }] }, fields: { w: 'HI' },
  });
  assert.ok(html.includes('class="ph"'));
});

test('lettering survives a save, words and all', () => {
  const deck = deckWith([{ kind: 'lettering', slot: 'w', content_id: 'c' }], { w: 'AUTUMN SALE' });
  const saved = deckLib.normalizeDeck(deck).slides[0];
  assert.equal(saved.template.elements[0].kind, 'lettering');
  assert.equal(saved.template.elements[0].fit, 'contain');
  assert.equal(saved.fields.w, 'AUTUMN SALE');
});

test('⚠️ the operator is told to check the spelling, every time', () => {
  /*
   * Nothing server-side can verify that the picture spells the headline, and a misspelled word set
   * two feet tall is the worst thing this feature can produce. The operator is the check, so the
   * route has to tell them there is something to check.
   */
  assert.match(AI_SRC, /check it reads/i, 'the route must warn about generated spelling');
});

test('⚠️ lettering falls back to real type rather than leaving no headline', () => {
  // A slide whose whole purpose is to say one thing must not come back saying nothing because an
  // image endpoint had a bad minute.
  assert.match(AI_SRC, /letteringDone/, 'there must be a fallback path');
  assert.match(AI_SRC, /if \(headline && !letteringDone\)/, 'and it must emit a real head element');
});

test('the AI slide generator is not offered lettering either', () => {
  // Like qr and countdown: it cannot produce a content_id, so a lettering element from it would be
  // a permanent empty placeholder.
  assert.ok(R.KINDS.lettering.config, 'lettering must be a config kind');
});

test('⚠️ the subhead is sized for its length, because the model ignores the cap it is given', () => {
  /*
   * The plan prompt asks for at most 40 characters; a real run answered with 48 — "Autumn Sale -
   * Warm up your home with rustic charm" — which at a fixed 4.5cqw wrapped to three lines and ran
   * out of the bottom of the text band and over the objects. Asking is still worth doing, but the
   * geometry cannot depend on the answer.
   */
  assert.match(AI_SRC, /function subheadSize/, 'the subhead size must be derived, not fixed');
  assert.match(AI_SRC, /size_cqw: subheadSize\(subhead\)/, 'and actually used');
  const fn = AI_SRC.match(/function subheadSize\(text\) \{[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  const subheadSize = new Function(`${fn}; return subheadSize;`)();
  assert.ok(subheadSize('Autumn Sale') > subheadSize('Autumn Sale - Warm up your home with rustic charm'),
    'a longer subhead must be set smaller');
  assert.equal(subheadSize('x'.repeat(48)), 3.6);
  assert.ok(subheadSize('x'.repeat(200)) >= 3, 'and never collapse to nothing');
});

/* ============ video backgrounds ============ */

const renderBg = (template, fields = {}, urls = {}) =>
  R.renderSlideHtml({ template, fields }, { resolveImage: (id) => urls[id] || null });

test('a video background renders as a muted, looping, autoplaying layer', () => {
  const html = renderBg({ background_video_content_id: 'v', elements: [] }, {},
    { v: '/uploads/content/clip.mp4' });
  const tag = html.match(/<video[^>]*>/)[0];
  for (const attr of ['autoplay', 'muted', 'loop', 'playsinline']) {
    assert.ok(tag.includes(attr), `a background video must be ${attr}`);
  }
  assert.ok(tag.includes('src="/uploads/content/clip.mp4"'));
});

test('⚠️ muted is not a default — there is no way to turn it off', () => {
  /*
   * Three reasons, any one sufficient: autoplay without a gesture is only permitted for muted
   * media, so an unmuted background would never start; the player already decides which ZONE owns
   * the audio and a widget cannot see out of its iframe to respect that; and scenery that talks
   * over the next zone is a support call.
   */
  const html = renderBg({ background_video_content_id: 'v', elements: [] }, {}, { v: '/c.mp4' });
  assert.match(html, /<video[^>]*\bmuted\b/);
  const src = require('fs').readFileSync(require.resolve('../lib/slide-render.js'), 'utf8');
  assert.ok(!/background_video_muted|video_audio|bg_audio/.test(src), 'muting must not be configurable');
});

test('⚠️ hwz="off" is emitted, or the video plays OVER the slide on a BrightSign', () => {
  /*
   * With hardware z-order the video decodes onto a plane the DOM sits BEHIND, so a background
   * would cover the headline and the cut-outs — the exact inverse of a background. The codebase
   * already documents this for transitions and PiP, and suppressMedia() pauses video rather than
   * covering it precisely because covering it does not work.
   */
  const html = renderBg({ background_video_content_id: 'v', elements: [] }, {}, { v: '/c.mp4' });
  assert.match(html, /<video[^>]*hwz="off"/);
});

test('⚠️ the still becomes the poster rather than being replaced', () => {
  /*
   * A slide document is fetched fresh on every play and a video is megabytes. For the seconds
   * before the first frame decodes — and for good on a panel that cannot decode it — what shows is
   * the still. Dropping it would turn every one of those cases into a black rectangle behind white
   * text.
   */
  const html = renderBg({ background_content_id: 'i', background_video_content_id: 'v', elements: [] },
    {}, { i: '/still.jpg', v: '/clip.mp4' });
  assert.match(html, /<video[^>]*poster="\/still\.jpg"/);
  assert.equal((html.match(/<div class="bg"/g) || []).length, 0,
    'the still rides as the poster, not as a second layer to paint');
});

test('a video with no still is fine, and emits no empty poster', () => {
  const html = renderBg({ background_video_content_id: 'v', elements: [] }, {}, { v: '/clip.mp4' });
  assert.ok(!html.includes('poster='), 'an absent still must not become poster=""');
});

test('the scrim still applies over a video', () => {
  // Text over moving footage is harder to read than over a still, not easier.
  const html = renderBg({ background_video_content_id: 'v', background_dim: 0.4, elements: [] },
    {}, { v: '/clip.mp4' });
  assert.match(html, /<div class="scrim" style="background:rgba\(0,0,0,0\.4\)">/);
  // Compared inside the BODY: `.scrim` also appears in the stylesheet above, so searching the whole
  // document finds the CSS rule and says the scrim comes first no matter what the layers do.
  const body = html.slice(html.indexOf('<body'));
  assert.ok(body.indexOf('<video') < body.indexOf('<div class="scrim"'),
    'the scrim must sit above the video');
});

test('a slide with neither still nor video gets no scrim, whatever the dim says', () => {
  const html = renderBg({ background_dim: 0.5, elements: [] });
  const body = html.slice(html.indexOf('<body'));
  assert.ok(!body.includes('class="scrim"'), 'a scrim over a flat colour is just a darker flat colour');
});

test('⚠️ a hostile video url cannot break out of the attribute', () => {
  const html = renderBg({ background_video_content_id: 'v', elements: [] }, {},
    { v: '" onerror=alert(1) x="' });
  /*
   * The escaped characters DO still read as "onerror=alert(1)" inside the attribute value — that is
   * the payload surviving as data, which is correct. What must not happen is the quote closing the
   * attribute, so the test is on the structure of the tag, not on the presence of the string.
   */
  const tag = html.match(/<video[^>]*>/)[0];
  assert.ok(tag.includes('&quot;'), 'the quote must be entity-encoded');
  assert.equal((tag.match(/"/g) || []).length % 2, 0, 'attribute quoting must stay balanced');
  assert.ok(!/\ssrc="[^"]*"\s+onerror/.test(tag), 'nothing may escape the src attribute');
});

test('the video background survives a save', () => {
  // The same silent-loss trap: sanitizeStored rebuilds the template key by key.
  const saved = deckLib.normalizeDeck({
    slides: [{ id: 's1', name: 'n', dwell_sec: 10,
      template: { background_video_content_id: 'vid-1', elements: [] }, fields: {} }],
  }).slides[0];
  assert.equal(saved.template.background_video_content_id, 'vid-1');
});

test('an over-long content id is refused rather than interpolated', () => {
  const n = R.normalizeSlide({ template: { background_video_content_id: 'x'.repeat(200) } });
  assert.equal(n.backgroundVideoContentId, null);
});

test('⚠️ the editor offers only video in the video picker', () => {
  /*
   * The renderer cannot tell a clip from a photo — it resolves an id to a URL and emits it — so a
   * JPEG chosen here becomes a <video> that never decodes. It would not even look broken: the
   * poster shows, so the operator gets a still and no explanation for why it does not move.
   */
  assert.match(VIEW, /function videoContent\(\)/, 'the picker must filter by type');
  assert.match(VIEW, /id="sBgVid"[\s\S]{0,200}videoContent\(\)/, 'and the select must use it');
});
