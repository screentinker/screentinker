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
  for (const kind of ['head', 'body', 'stat', 'image', 'rule', 'box']) {
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
    ['clock', 'countdown', 'date', 'qr'],
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
  for (const k of ['clock_format', 'date_format', 'tz', 'locale', 'target', 'qr_ec', 'qr_bg']) {
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
