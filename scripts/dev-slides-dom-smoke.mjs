/*
 * Drive the real slides view in a DOM, so "it parses" is not the standard.
 *
 * The bug this whole session has been chasing — a handler that repaints the panel it lives in and
 * destroys the control under the pointer — is invisible to a syntax check and invisible to reading.
 * It only shows up when you dispatch an input event and then ask whether the element you dispatched
 * on is still in the document.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.FormData = dom.window.FormData;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.prompt = () => '';
globalThis.confirm = () => true;

const DECK = {
  id: 'd1', name: 'Smoke deck', playlist_id: null, doc: {
    slides: [{
      id: 's1', name: 'Slide 1', dwell_sec: 8, widget_id: null,
      template: { background: '#1B2029', elements: [
        { slot: 'h', kind: 'head', box: { x: 10, y: 30, w: 60 },
          style: { color: '#FFFFFF', font: 'inter', size_cqw: 7, weight: 700, align: 'left', opacity: 1, radius_cqw: 0 },
          motion: { animation: 'slideU', delay: 0.2, duration: 0.55, easing: 'ease-out' } },
        { slot: 'b', kind: 'body', box: { x: 10, y: 60, w: 50 },
          style: { color: '#A3AEC0', font: 'inter', size_cqw: 3, weight: 400, align: 'left', opacity: 1, radius_cqw: 0 },
          motion: { animation: 'fade', delay: 0.6, duration: 0.5, easing: 'ease-out' } },
      ] },
      fields: { h: 'Headline', b: 'Body' },
    }],
  }, warnings: [],
};

// Stub the API surface the view touches.
const api = {
  get: async (p) => {
    if (p === '/slide-decks') return [{ id: 'd1', name: 'Smoke deck', slide_count: 1, total_sec: 8 }];
    if (p === '/slide-decks/d1') return JSON.parse(JSON.stringify(DECK));
    if (p === '/widgets/slide-fonts') return { fonts: [
      { id: 'inter', label: 'Inter', role: 'Text', note: 'n', weights: [400, 800], file: 'inter', css: 'Inter', stack: 'sans-serif' },
      { id: 'oswald', label: 'Oswald', role: 'Condensed', note: 'n', weights: [300, 700], file: 'oswald', css: 'Oswald', stack: 'sans-serif' },
    ] };
    if (p === '/fonts') return { fonts: [] };
    if (p === '/content') return [{ id: 'c1', filename: 'sky.jpg', filepath: 'sky.jpg', mime_type: 'image/jpeg', remote_url: null }];
    return [];
  },
  put: async () => JSON.parse(JSON.stringify(DECK)),
  post: async () => JSON.parse(JSON.stringify(DECK)),
  delete: async () => ({ success: true }),
  postForm: async () => ({}),
};

// Rewrite the two imports to point at stubs, so the real view file runs unmodified otherwise.
const src = fs.readFileSync(process.env.SLIDES_SRC || '/home/owner/Downloads/remote_display/frontend/js/views/slides.js', 'utf8')
  .replace(/^import .*$/gm, '')
  // `export` is a module keyword and new Function() compiles a script, not a module.
  .replace(/^export /gm, '');
const factory = new dom.window.Function('api', 'esc', 'showToast', `${src}\nreturn { render };`);
const esc = (str) => String(str == null ? '' : str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const toasts = [];
const view = factory(api, esc, (m, k) => toasts.push(`${k}:${m}`));

const app = document.getElementById('app');
const fail = [];
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fail.push(msg); };

await view.render(app);
// open the deck
app.querySelector('[data-open]').click();
await new Promise((r) => setTimeout(r, 30));

console.log('\n=== the editor mounted ===');
ok(!!app.querySelector('#stage'), 'stage rendered');
ok(app.querySelectorAll('#strip [data-slide]').length === 1, 'filmstrip has the slide');
ok(app.querySelectorAll('#layers [data-el]').length === 2, 'layer list has both elements');

const tab = (name) => { app.querySelector(`.tabBtn[data-tab="${name}"]`).click(); };

/* ---------------------------------------------------------------- the bug, per tab */
for (const [tabName, sliderId] of [['style', 'pX'], ['style', 'pOp'], ['motion', 'mDelay'], ['motion', 'mDur'], ['slide', 'sDwell']]) {
  tab(tabName);
  const el = app.querySelector(`#${sliderId}`);
  if (!el) { ok(false, `${tabName}: #${sliderId} is missing`); continue; }
  el.value = String(Number(el.value) + Number(el.step || 1));
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const still = app.querySelector(`#${sliderId}`);
  ok(still === el, `${tabName}: #${sliderId} survives its own input event (not rebuilt mid-drag)`);
}

/* ---------------------------------------------------------------- the number boxes mirror */
tab('style');
const rx = app.querySelector('#pX'); const nx = app.querySelector('#pXn');
rx.value = '42'; rx.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
ok(nx.value === '42', 'style: dragging the slider updates the number box');
nx.value = '17'; nx.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
ok(app.querySelector('#pX').value === '17', 'style: typing a number moves the slider');

tab('motion');
const rd = app.querySelector('#mDelay'); const nd = app.querySelector('#mDelayn');
rd.value = '1.25'; rd.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
ok(nd.value === '1.25', 'motion: slider updates the number box');
ok(!!app.querySelector('#mTimeline'), 'motion: the timing view rendered');
ok(/lands at/.test(app.querySelector('#mTimeline').textContent), 'motion: the timing view names when this element lands');

/* ---------------------------------------------------------------- overrun is surfaced */
tab('slide');
const dw = app.querySelector('#sDwelln');
dw.value = '1'; dw.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
tab('motion');
ok(/never finish/.test(app.querySelector('#mTimeline').textContent),
   'motion: a dwell shorter than the motion is called out');

/* ---------------------------------------------------------------- typing in the text field */
tab('content');
const ta = app.querySelector('#pText');
ok(!!ta, 'content: the text field rendered');
if (ta) {
  ta.value = 'Kenosha'; ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  ok(app.querySelector('#pText') === ta,
     'content: the textarea survives a keystroke (the caret is not thrown away every character)');
  ok(app.querySelector('#stage').textContent.includes('Kenosha'), 'content: the stage shows what was typed');
}

/* ---------------------------------------------------------------- selecting a different element */
tab('style');
app.querySelectorAll('#layers [data-el]')[1].click();
ok(app.querySelector('#pX').value !== '17', 'selecting another element loads its own values');

console.log(`\n${fail.length ? `${fail.length} FAILURE(S)` : 'all editor checks passed'}`);
process.exit(fail.length ? 1 : 0);
