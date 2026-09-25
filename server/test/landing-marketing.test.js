'use strict';

/*
 * The marketing landing page. This is the page that converts — about seven signups a day — so the
 * tests here are mostly about what must NOT change, and about the page not contradicting itself.
 *
 * ⚠️ THE FAILURE THIS GUARDS AGAINST IS A PAGE THAT DISAGREES WITH ITSELF ON PRICE. The hero ribbon,
 * the comparison table and the plan cards all quote money. Two of those are hand-written and one is
 * computed from /api/subscription/plans at runtime, so they drift silently — and a visitor who spots
 * two different per-screen prices for the same plan has learned something worse about us than any
 * stale figure would have taught them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LANDING = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'landing.html'), 'utf8'
);

// Prod's rows, 2026-09-24. The card markup is generated from these by the page's own code.
const PLANS = [
  { name: 'free',       display_name: 'Free',     max_devices: 1,  max_storage_mb: 500,    price_monthly: 0,    price_yearly: 0,    remote_url: 0, priority_support: 0, active: 1 },
  { name: 'home',       display_name: 'Home',     max_devices: 2,  max_storage_mb: 2048,   price_monthly: 9.99, price_yearly: 99,   remote_url: 0, priority_support: 0, active: 1 },
  { name: 'starter',    display_name: 'Starter',  max_devices: 5,  max_storage_mb: 5120,   price_monthly: 39,   price_yearly: 389,  remote_url: 0, priority_support: 0, active: 1 },
  { name: 'pro',        display_name: 'Pro',      max_devices: 15, max_storage_mb: 20480,  price_monthly: 99,   price_yearly: 989,  remote_url: 1, priority_support: 0, active: 1 },
  { name: 'business',   display_name: 'Business', max_devices: 50, max_storage_mb: 102400, price_monthly: 199,  price_yearly: 1989, remote_url: 1, priority_support: 1, active: 1 },
  { name: 'enterprise', display_name: 'Custom',   max_devices: -1, max_storage_mb: -1,     price_monthly: 0,    price_yearly: 0,    remote_url: 1, priority_support: 1, active: 1 },
];

/* Run the page's OWN renderer. Reading the source for strings would pass while the page rendered
 * something else, and the whole point is the numbers a visitor sees.
 *
 * Returns the two containers plus a `click` handle on the billing toggle, so a test can flip the
 * cycle the way a visitor does rather than re-implementing what the button is supposed to do. */
function render(plans) {
  const body = LANDING.match(
    /fetch\('\/api\/subscription\/plans'\)\.then\(r => r\.json\(\)\)\.then\(plans => \{([\s\S]*?)\n    \}\)/
  );
  assert.ok(body, 'could not find the pricing-grid renderer in landing.html');

  const listeners = {};
  const button = (id) => ({
    id, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(_e, fn) { listeners[id] = fn; },
    classList: { remove() {}, add() {} },
  });
  const els = {
    pricingGrid: { innerHTML: '' },
    pricingTail: { innerHTML: '' },
    cycleMonthly: button('cycleMonthly'),
    cycleAnnual: button('cycleAnnual'),
  };
  // eslint-disable-next-line no-new-func
  new Function('plans', 'document', body[1])(plans, { getElementById: (id) => els[id] || null });
  return {
    grid: els.pricingGrid.innerHTML,
    tail: els.pricingTail.innerHTML,
    pressed: () => ({
      monthly: els.cycleMonthly.getAttribute('aria-pressed'),
      annual: els.cycleAnnual.getAttribute('aria-pressed'),
    }),
    click: (which) => { listeners['cycle' + which](); return els.pricingGrid.innerHTML; },
  };
}

const cardsOf = (html) => html.split('<div class="price-card').slice(1);
const priceOf = (card) => textOf((card.match(/class="price">(.*?)<\/div>/) || [])[1] || '');
const textOf = (s) => s.replace(/<[^>]+>/g, '');

test('the headline price on every card is still the MONTHLY figure', () => {
  // Leading with the annual price would swap "$99" for "$989" as the first number a visitor reads.
  // That is a pricing experiment, not a copy change, and this page is not the place to run one
  // by accident.
  const prices = cardsOf(render(PLANS).grid).map(priceOf);
  // The quote card is no longer in the grid — it sits in the tail band beside the self-host panel.
  assert.deepEqual(prices, ['Free', '$9.99/mo', '$39/mo', '$99/mo', '$199/mo']);
});

test('the per-screen figure is computed, and matches the comparison table', () => {
  const cards = cardsOf(render(PLANS).grid);
  const business = cards.find((c) => /<h3>Business<\/h3>/.test(c));
  const cardFigure = textOf((business.match(/class="per-screen">(.*?)<\/div>/) || [])[1] || '')
    .match(/\$([0-9.]+)/)[1];

  // $1,989 / 50 devices / 12 months. Asserted against the hand-written table row, because those two
  // numbers living in different places is exactly how they drift.
  const row = LANDING.slice(LANDING.indexOf('Cost per screen/month at 50'));
  const tableFigure = row.match(/>\$([0-9.]+)</)[1];
  assert.equal(cardFigure, tableFigure,
    `the Business card says $${cardFigure} per screen but the table says $${tableFigure}`);
});

test('no per-screen figure where dividing would mislead', () => {
  const out = render(PLANS);
  const free = cardsOf(out.grid).find((c) => /<h3>Free<\/h3>/.test(c));
  assert.ok(!/per-screen/.test(free), 'Free must not claim a per-screen price');
  const quote = cardsOf(out.tail).find((c) => /<h3>Custom<\/h3>/.test(c));
  assert.ok(quote, 'the quote card renders in the tail band');
  assert.ok(!/per-screen/.test(quote), 'a quote-only plan has no per-screen price to claim');
});

test('"Most Popular" is on a named plan, not a positional index', () => {
  // It was `i === 2`, correct when there were four plans. Two were added, index 2 became Starter, and
  // the badge moved off Pro with nothing to notice it.
  assert.match(LANDING, /const FEATURED_PLAN = '[a-z]+';/);
  assert.ok(!/price-card \$\{i === \d/.test(LANDING), 'the featured card must not be chosen by index');

  const cards = cardsOf(render(PLANS).grid);
  const featured = cards.filter((c) => c.startsWith(' featured'));
  assert.equal(featured.length, 1, 'exactly one card carries the badge');
  // And it is on the plan that was chosen, not wherever the list happens to put it. Pinned because
  // the last time this moved, it moved by itself.
  assert.match(featured[0], /<h3>Pro<\/h3>/, 'the badge belongs on Pro');
});

test('the hero ribbon and the comparison table quote the same 15-screen prices', () => {
  // Same numbers, two places on one page. They are competitors' published prices, so a visitor can
  // check them — and will, if they disagree.
  const ribbon = LANDING.slice(LANDING.indexOf('class="price-math"'), LANDING.indexOf('Compare the math'));
  const row = LANDING.slice(LANDING.indexOf('Price (15 screens/yr)'));
  const rowCells = row.slice(0, row.indexOf('</tr>'));
  for (const amount of ['989', '1,440', '2,160', '1,620', '2,430', '3,600', '5,400']) {
    assert.ok(ribbon.includes(amount), `the hero ribbon is missing ${amount}`);
    assert.ok(rowCells.includes(amount), `the 15-screen table row is missing ${amount}`);
  }
});

test('the comparison table no longer quotes monthly-times-twelve as our price', () => {
  // $1,188 is $99 x 12. The annual plan is $989 and the API already returned it, so the page was
  // understating its own advantage by $199.
  //
  // ⚠️ COMMENTS STRIPPED FIRST. The page carries an HTML comment explaining why that figure went,
  // and it names the figure — so an absence assertion against the raw source fails on the very note
  // documenting the fix. Strip comments, then assert on what a visitor can actually read.
  const visible = LANDING
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.ok(!visible.includes('$1,188'), 'the table must quote the annual price, not monthly x 12');
  // And the annual figure IS what it quotes.
  const row = visible.slice(visible.indexOf('Price (15 screens/yr)'));
  assert.match(row.slice(0, row.indexOf('</tr>')), /\$989/);
});

test('every table row has a cell for all four vendors', () => {
  // The column order changed when OptiSigns and ScreenCloud were swapped to match the price rows.
  // A row one cell short silently shifts every value after it into the wrong vendor's column, which
  // is a false claim about a named company.
  const table = LANDING.slice(LANDING.indexOf('<table class="compare-table">'), LANDING.indexOf('</table>'));
  const headers = (table.match(/<th[^>]*>(.*?)<\/th>/g) || []).map(textOf);
  assert.deepEqual(headers, ['', 'ScreenTinker', 'Yodeck', 'OptiSigns', 'ScreenCloud']);
  const bodyRows = table.slice(table.indexOf('<tbody>')).match(/<tr>[\s\S]*?<\/tr>/g) || [];
  assert.ok(bodyRows.length >= 15, `expected the full table, found ${bodyRows.length} rows`);
  for (const r of bodyRows) {
    assert.equal((r.match(/<td/g) || []).length, 5, `row has the wrong cell count: ${textOf(r).slice(0, 60)}`);
  }
});

test('the things that convert are all still on the page', () => {
  // Every one of these was working before the refresh. A copy change must not quietly drop one.
  for (const [what, re] of [
    ['the free-trial badge',        /14-day Pro trial, no credit card/],
    ['the primary hero CTA',        /class="btn btn-primary"[^>]*>Start Free Trial</],
    ['the GitHub CTA',              /View on GitHub/],
    ['the compare CTA',             /See How We Compare/],
    ['the certified-hardware line', /See certified hardware/],
    ['the live deployed counter',   /id="deployed-count"/],
    ['the enterprise contact form', /openContactModal\(\)/],
    ['the dynamic pricing grid',    /id="pricingGrid"/],
  ]) {
    assert.match(LANDING, re, `${what} is missing from the landing page`);
  }
});

test('the hero keeps its keyword phrases', () => {
  // The H1 changed. These are the phrases the page ranks on; losing them to a punchier headline
  // would trade traffic for tone.
  const h1 = LANDING.match(/<h1>([\s\S]*?)<\/h1>/)[1];
  assert.match(h1, /Digital Signage/i);
  assert.match(h1, /Open-Source/i);
  assert.match(LANDING, /<strong>digital signage CMS<\/strong>/);
});

/* ─────────────── the pieces the mockup showed that the first pass left out ─────────────── */

test('the billing toggle switches the headline and leaves monthly selected by default', () => {
  const out = render(PLANS);
  // ⚠️ Default is monthly: that is the number this page has always led with, and swapping the first
  // figure a visitor reads from "$99" to "$989" is a pricing experiment, not a layout change.
  assert.deepEqual(out.pressed(), { monthly: 'true', annual: 'false' });

  const annual = cardsOf(out.click('Annual'));
  const pro = annual.find((c) => /<h3>Pro<\/h3>/.test(c));
  assert.equal(priceOf(pro), '$989/year', 'the annual view leads with the yearly price');
  assert.match(pro, /\$99\/month billed monthly/, 'and names the monthly alternative');
  assert.deepEqual(out.pressed(), { monthly: 'false', annual: 'true' });

  // And back, because a toggle that only goes one way is a trap.
  const monthly = cardsOf(out.click('Monthly'));
  assert.equal(priceOf(monthly.find((c) => /<h3>Pro<\/h3>/.test(c))), '$99/mo');
  assert.deepEqual(out.pressed(), { monthly: 'true', annual: 'false' });
});

test('the per-screen figure does not move when the cycle does', () => {
  // It is derived from the ANNUAL price in both views: the plan costs that over a year either way, and
  // a number that jumped on a toggle click would read as one of the two being wrong.
  const out = render(PLANS);
  const ps = (html) => textOf((cardsOf(html).find((c) => /<h3>Pro<\/h3>/.test(c))
    .match(/class="per-screen">(.*?)<\/div>/) || [])[1] || '');
  const before = ps(out.grid);
  assert.match(before, /\$5\.49 per screen/);
  assert.equal(ps(out.click('Annual')), before);
});

test('prices in the cards carry thousands separators', () => {
  // "$1989/year" beside a table that says "$1,989" is the page disagreeing with itself in a way a
  // reader notices before they notice anything else.
  // Compare the RENDERED TEXT: the unit sits in a <span>, so "$1,989/year" never appears as a literal
  // in the markup. Measuring the markup instead is how a passing test can describe a page nobody sees.
  const annual = render(PLANS).click('Annual');
  const prices = cardsOf(annual).map(priceOf);
  assert.ok(prices.includes('$1,989/year'), `expected a separated price, got ${prices.join(', ')}`);
  assert.ok(!prices.some((p) => /\$\d{4,}/.test(p)), 'no unseparated four-digit price');
});

test('the tail band holds the quote card and the self-host answer, with both routes out', () => {
  const tail = render(PLANS).tail;
  assert.match(tail, /<h3>Custom<\/h3>/, 'the quote card title comes from the plans row');
  assert.match(tail, /openContactModal\(\)/, 'the enterprise contact route');
  assert.match(tail, /run it yourself and pay nothing/);
  assert.match(tail, /href="\/guides\/self-hosted-digital-signage\.html"/);
  assert.match(tail, /href="\/download\/"/, 'the downloads page, which is where self-hosting starts');
});

test('every platform tile carries a sub-caption, and BrightSign says Series 5 / 6', () => {
  const grid = LANDING.slice(LANDING.indexOf('<div class="platform-grid">'));
  const tiles = grid.slice(0, grid.indexOf('</div>\n    <!--')).match(/<a class="platform-item"[\s\S]*?<\/a>/g) || [];
  assert.equal(tiles.length, 10);
  for (const t of tiles) {
    assert.match(t, /<div class="sub">[^<]+<\/div>/, `a tile has no sub-caption: ${textOf(t).trim()}`);
  }
  // Corrected from "Series 4 / 5" during review — 5 and 6 are the generations this runs on.
  assert.ok(tiles.some((t) => /BrightSign/.test(t) && /Series 5 \/ 6/.test(t)));
  assert.ok(!LANDING.includes('Series 4 / 5'));
});

test('the platforms and comparison sections each end in a call to action', () => {
  assert.match(LANDING, /Browse certified hardware, with prices/);
  assert.match(LANDING, />Start your free trial</);
  assert.match(LANDING, /href="\/compare\/yodeck-alternative\.html"[^>]*>Yodeck alternative/);
  assert.match(LANDING, /href="\/compare\/optisigns-alternative\.html"[^>]*>OptiSigns alternative/);
});

test('the live deployed count sits in the trust strip and degrades to three columns', () => {
  /*
   * ⚠️ Only the deployment that collects install statistics answers /api/public/stats. Everywhere
   * else it 404s, and on a new instance the count is 0 — so the cell starts hidden and the strip is
   * three columns until a number arrives. A marketing page must not show an empty frame or a zero.
   */
  const strip = LANDING.slice(LANDING.indexOf('<div class="trust-strip'), LANDING.indexOf('class="price-math"'));
  assert.match(strip, /class="trust-strip cols-3" id="trustStrip"/);
  assert.match(strip, /<div id="deployed-stat" hidden>/);
  assert.match(strip, /id="deployed-count"/);
  assert.match(LANDING, /\.trust-strip\.cols-3 \{ grid-template-columns:repeat\(3/);
  // And the existing stats fetch is what widens it — the cell and the switch must move together.
  const fetchBlock = LANDING.slice(LANDING.indexOf("fetch('/api/public/stats')"));
  assert.match(fetchBlock.slice(0, 900), /classList\.remove\('cols-3'\)/);
  // The old standalone paragraph is gone, so the count is not rendered twice.
  assert.ok(!LANDING.includes('screens deployed with ScreenTinker'));
});
