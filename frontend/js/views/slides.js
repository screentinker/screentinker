import { api } from '../api.js';
import { esc, canWrite } from '../utils.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { renderApprovalBar } from '../components/approval-actions.js';
import { mountHostedPicker } from '../components/ai-hosted-picker.js';
import { confirmAccessibility } from '../components/accessibility.js';
import { snapMove, snapResize } from '../components/snap.js';
import { isPrivateHost, urlHost } from '../components/private-host.js';
import {
  resizeRect, boundsOf, alignRects, distributeRects, reorder, repairSlots,
  copyElements, pasteElements, createHistory,
} from '../components/slide-arrange.js';

/*
 * The slide deck editor.
 *
 * ⚠️ THE DOCUMENT IS THE STATE, AND THE STAGE IS A VIEW OF IT. Every control writes into `deck.doc`
 * and re-renders from it. That sounds obvious and is the thing the old Content Designer got wrong:
 * it published baked HTML and kept no source, so 0 of 49 widgets in a real database can be reopened
 * for editing. Here the document is what is saved, and what plays is derived from it by publishing.
 *
 * ⚠️ SAVE AND PUBLISH ARE DIFFERENT ACTS. Saving stores the document; publishing pushes slides to
 * screens. Somebody part-way through a deck has every right to a slide that does not add up yet, and
 * nothing should reach a wall until they say so.
 */

const ANIMS = {
  none: 'None', fade: 'Fade', slideL: 'Slide in ←', slideR: 'Slide in →',
  slideU: 'Rise', slideD: 'Drop', zoom: 'Zoom', wipe: 'Wipe',
};
const EASES = { 'ease-out': 'Ease out', soft: 'Soft', linear: 'Linear', 'ease-in': 'Ease in' };
/*
 * ⚠️ FETCHED, NOT DUPLICATED. The bundled families live in server/lib/slide-fonts.js next to the
 * files themselves, and the editor asks for the list. A hardcoded copy here would drift the moment
 * a family is added or dropped, and the editor would then preview something the renderer does not
 * have — which makes the tool a liar about the one thing it exists to show.
 */
let FONT_CATALOGUE = [];
let DATA_SOURCES_LIST = [];
const KINDS = {
  head: { icon: 'H', label: 'Headline', size: 7, weight: 700 },
  body: { icon: 'T', label: 'Text', size: 3, weight: 400 },
  stat: { icon: '#', label: 'Big number', size: 14, weight: 700 },
  image: { icon: '▣', label: 'Photo', size: 0, weight: 400 },
  rule: { icon: '▬', label: 'Rule', size: 0, weight: 400 },
  box: { icon: '◻', label: 'Panel', size: 0, weight: 400 },
  clock: { icon: '◷', label: 'Clock', size: 9, weight: 700 },
  date: { icon: '▤', label: 'Date', size: 4, weight: 400 },
  countdown: { icon: '◔', label: 'Countdown', size: 9, weight: 700 },
  qr: { icon: '▦', label: 'QR code', size: 0, weight: 400 },
  lettering: { icon: '✒', label: 'Lettering', size: 0, weight: 400 },
};

/*
 * ⚠️ THE SAME TWO-FLAG SPLIT THE RENDERER MAKES, and it has to stay in step with it.
 *
 * TEXT_KINDS = reads `fields[slot]`, so the Content tab offers an input for it. A QR's payload and
 * a countdown's expiry message are fields for the same reason a headline is: changing the URL
 * behind a poster should not mean rebuilding the layout.
 *
 * GLYPH_KINDS = puts characters on screen, so it gets the font and size controls. A clock shows
 * characters and reads no field; a QR reads a field and shows none. Driving both from one list is
 * the bug the renderer's KINDS comment describes, and it looks correct in this editor either way —
 * the machine authoring the slide has the fonts installed.
 */
const TEXT_KINDS = ['head', 'body', 'stat', 'countdown', 'qr', 'lettering'];
const GLYPH_KINDS = ['head', 'body', 'stat', 'clock', 'date', 'countdown'];
const LIVE_KINDS = ['clock', 'date', 'countdown'];

/* The allowlists the server validates against; an option not in these is silently dropped there. */
const CLOCK_FORMATS = [['24', '13:45'], ['24s', '13:45:09'], ['12', '1:45 PM'], ['12s', '1:45:09 PM']];
const DATE_FORMATS = [['long', 'Monday, 5 January 2026'], ['weekday', 'Monday, 5 January'],
  ['short', '5 Jan 2026'], ['numeric', '05/01/2026']];
const QR_LEVELS = [['L', 'L — smallest'], ['M', 'M — normal'], ['Q', 'Q — tolerant'], ['H', 'H — most tolerant']];

const state = {
  decks: [], deck: null, si: 0, ei: 0, tab: 'content',
  dirty: false, saving: false, contentIndex: null,
  // The multi-selection, as element indices. `ei` is its primary member (the one the inspector
  // shows and the handles sit on); a `sel` that does not contain `ei` is stale and means [ei].
  sel: [],
  snap: true,
};

/* The renderer's cap (lib/slide-render.js MAX_ELEMENTS): a paste past it would be cut on save. */
const MAX_ELEMENTS = 40;

/*
 * Undo/redo: bounded snapshots of the whole document, taken by touch()/touchValue() — the two
 * places every edit already goes through — so no individual control has to remember to record.
 * A deck is small (40 elements a slide at most), and a string snapshot can never be mutated
 * after the fact, which is the bug a history of live objects always grows.
 */
const undoHistory = createHistory(100);
const snapshot = () => (state.deck ? JSON.stringify(state.deck.doc) : null);

const slide = () => state.deck && state.deck.doc.slides[state.si];

/* The document stores template.elements; this is just a shorthand so the code below reads. */
function elementsOf(s) { return (s.template && Array.isArray(s.template.elements)) ? s.template.elements : []; }

function resolveInterpolatedText(str) {
  if (typeof str !== 'string' || !str.includes('{{ds:')) return str;
  const formatVal = (val) => {
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') {
      try { return JSON.stringify(val).slice(0, 2000); } catch (_) { return ''; }
    }
    return String(val).slice(0, 2000);
  };
  return str.replace(/\{\{ds:([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_]+)\}\}/g, (match, slug, key) => {
    const ds = DATA_SOURCES_LIST.find((x) => x.slug === slug || x.slug === slug.toLowerCase());
    if (ds) {
      if (ds.data && ds.data[key] !== undefined && ds.data[key] !== null) return formatVal(ds.data[key]);
      if (ds.cached_data) {
        try {
          const parsed = typeof ds.cached_data === 'string' ? JSON.parse(ds.cached_data) : ds.cached_data;
          if (parsed && parsed[key] !== undefined && parsed[key] !== null) return formatVal(parsed[key]);
        } catch (_) {}
      }
    }
    return '';
  });
}

/*
 * The keys a data source can fill, from its last sync — what the Data Sources page lists. Only the
 * keys a {{ds:slug.key}} tag can name (the renderer's pattern), capped so a 500-row sheet does not
 * become a 1000-option dropdown.
 */
function dataSourceKeys(ds, cap = 150) {
  let data = ds && ds.data;
  if (!data && ds && ds.cached_data) {
    try { data = typeof ds.cached_data === 'string' ? JSON.parse(ds.cached_data) : ds.cached_data; } catch (_) { data = null; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.keys(data).filter((k) => /^[a-zA-Z0-9_]+$/.test(k)).slice(0, cap);
}

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/* The same aliases the server keeps, so a slide authored before the fonts shipped previews right. */
const FONT_ALIASES = { sans: 'inter', serif: 'bitter', mono: 'jetbrains-mono', condensed: 'oswald' };
const isUploadedFont = (id) => typeof id === 'string' && id.startsWith('u:');
const resolveFont = (id) => {
  if (FONT_CATALOGUE.some((f) => f.id === id)) return id;
  if (FONT_ALIASES[id]) return FONT_ALIASES[id];
  return FONT_CATALOGUE.length ? FONT_CATALOGUE[0].id : 'inter';
};
function fontStack(id) {
  const f = FONT_CATALOGUE.find((x) => x.id === resolveFont(id));
  // Both halves come from the server's own catalogue — no guessing a generic from the name.
  return f ? `'${f.css}', ${f.stack}` : 'system-ui, sans-serif';
}

/*
 * ⚠️ The editor loads the SAME files a screen will, from the same /fonts mount — so what you see
 * while authoring is what plays. Injected once; the dashboard's own CSP allows font-src 'self',
 * which this is.
 */
/*
 * ⚠️ A REAL STYLESHEET, because some of this cannot be done inline. A native <input type="color">
 * renders as a plain white block until its ::-webkit-color-swatch pseudo-elements are styled, and a
 * pseudo-element has no inline form. It looked like a broken text field in a 290px panel.
 */
function ensureEditorStyles() {
  if (document.getElementById('stSlideEditor')) return;
  const st = document.createElement('style');
  st.id = 'stSlideEditor';
  st.textContent = `
    .sl-group { border-top:1px solid var(--border); margin-top:4px; padding-top:9px; }
    .sl-group:first-child { border-top:0; margin-top:0; padding-top:0; }
    .sl-legend { font-size:10.5px; letter-spacing:.08em; text-transform:uppercase;
                 color:var(--text-muted); margin:0 0 7px; font-weight:600; }
    .sl-row { display:grid; grid-template-columns:56px 1fr; align-items:center; gap:8px; margin-bottom:7px; }
    .sl-row > label { font-size:12px; color:var(--text-muted); }
    .sl-slide { display:flex; align-items:center; gap:7px; min-width:0; }
    .sl-slide input[type=range] { flex:1; min-width:0; accent-color:var(--primary); }
    .sl-num { width:56px; flex:0 0 auto; padding:3px 5px; text-align:right;
              font-variant-numeric:tabular-nums; font-size:11.5px;
              background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:3px; }
    .sl-num::-webkit-outer-spin-button, .sl-num::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
    .sl-num { -moz-appearance:textfield; }
    .sl-colour { width:100%; height:26px; padding:0; border:1px solid var(--border);
                 border-radius:3px; background:none; cursor:pointer; }
    .sl-colour::-webkit-color-swatch-wrapper { padding:2px; }
    .sl-colour::-webkit-color-swatch { border:0; border-radius:2px; }
    .sl-colour::-moz-color-swatch { border:0; border-radius:2px; }
    .sl-note { font-size:11px; color:var(--text-muted); margin:2px 0 8px; line-height:1.35; }
    .sl-link { background:none; border:0; padding:0; font-size:11.5px; color:var(--primary);
               cursor:pointer; text-decoration:underline; }
    .sl-seg { display:flex; }
    .sl-seg button { flex:1; padding:4px 0; font-size:11.5px; cursor:pointer;
                     background:var(--surface); color:var(--text); border:1px solid var(--border); }
    .sl-seg button:first-child { border-radius:3px 0 0 3px; }
    .sl-seg button:last-child { border-radius:0 3px 3px 0; }
    .sl-seg button + button { border-left:0; }
    .sl-seg button[aria-pressed="true"] { background:var(--primary); border-color:var(--primary); color:#fff; }
    /* 3.0: the canvas selection — handles, guides, marquee, arrange bar and context menu. */
    #stage > [data-ei] { touch-action:none; user-select:none; -webkit-user-select:none; }
    #stage > [data-ei][data-editing] { user-select:text; -webkit-user-select:text; cursor:text; }
    .sl-overlay { position:absolute; inset:0; pointer-events:none; z-index:5; }
    .sl-handle { position:absolute; width:10px; height:10px; margin:-5px 0 0 -5px; box-sizing:border-box;
      background:#fff; border:1.5px solid var(--primary); border-radius:2px; pointer-events:auto; touch-action:none; }
    @media (pointer:coarse) { .sl-handle { width:20px; height:20px; margin:-10px 0 0 -10px; border-radius:50%; } }
    .sl-groupbox { position:absolute; border:1px dashed var(--primary); }
    .sl-guide { position:absolute; }
    .sl-marquee { position:absolute; border:1px dashed var(--primary); background:rgba(59,130,246,.12); }
    .sl-arrange { display:flex; flex-wrap:wrap; align-items:center; gap:2px; margin-bottom:8px; }
    .sl-tool { display:grid; place-items:center; width:28px; height:26px; padding:0; border:1px solid transparent;
      border-radius:5px; background:none; color:var(--text-primary, inherit); cursor:pointer; }
    .sl-tool:hover:not(:disabled) { background:var(--bg-hover, rgba(127,127,127,.12)); }
    .sl-tool:disabled { opacity:.35; cursor:default; }
    .sl-tool.on { border-color:var(--primary); color:var(--primary); }
    .sl-tool-sep { width:1px; height:18px; background:var(--border); margin:0 4px; }
    @media (pointer:coarse) { .sl-tool { width:38px; height:36px; } }
    .sl-ctx { position:fixed; z-index:2000; min-width:200px; padding:4px; font-size:13px; background:var(--bg-card);
      border:1px solid var(--border); border-radius:var(--radius, 8px); box-shadow:var(--shadow, 0 8px 24px rgba(0,0,0,.25)); }
    .sl-ctx button { display:flex; justify-content:space-between; gap:18px; width:100%; padding:6px 10px; border:0;
      border-radius:5px; background:none; color:var(--text-primary, inherit); font:inherit; text-align:left; cursor:pointer; }
    .sl-ctx button:hover:not(:disabled), .sl-ctx button:focus-visible { background:var(--bg-card-hover, rgba(127,127,127,.12)); }
    .sl-ctx button:disabled { opacity:.4; cursor:default; }
    .sl-ctx kbd { font:inherit; font-size:11px; color:var(--text-muted); }
    .sl-ctx hr { border:0; border-top:1px solid var(--border); margin:4px 2px; }`;
  document.head.appendChild(st);
}

function ensureFontFaces() {
  if (document.getElementById('stSlideFonts') || !FONT_CATALOGUE.length) return;
  const st = document.createElement('style');
  st.id = 'stSlideFonts';
  st.textContent = FONT_CATALOGUE.flatMap((f) => (f.file
    // Bundled: two script subsets, one variable file each.
    ? ['', '-ext'].map((sfx) =>
        `@font-face{font-family:'${f.css}';font-style:normal;font-weight:${f.weights[0]} ${f.weights[1]};`
        + `font-display:swap;src:url(/fonts/${f.file}${sfx}.woff2) format('woff2')}`)
    // Uploaded: one file, one weight, no unicode-range — see slide-fonts.customFace for why.
    : [`@font-face{font-family:'${f.css}';font-style:normal;font-weight:normal;`
       + `font-display:swap;src:url(/fonts/u/${encodeURIComponent(f.filepath || '')})}`])).join('');
  document.head.appendChild(st);
}

/*
 * ⚠️ THE VIDEO PICKER OFFERS ONLY VIDEO. The renderer cannot tell a clip from a photo — it resolves
 * a content id to a URL and emits it — so a JPEG chosen here becomes a <video> that will never
 * decode. It would not even look broken: the poster still shows, so the operator gets a still and
 * no explanation for why it does not move.
 */
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|m4v)$/i;
function videoContent() {
  // `mime_type`, not `type`: the API field is mime_type and the old `c.type` read was always
  // undefined, so this silently fell back to guessing from the filename.
  return (state.contentIndex || []).filter((c) => String(c.mime_type || '').startsWith('video/')
    || VIDEO_EXT.test(c.filename || ''));
}

/*
 * Audio the operator can choose for a voiceover or a bed.
 *
 * Same shape as videoContent above, and the same reason for the extension fallback: `type` is the
 * stored mime and is empty for anything uploaded before it was recorded, so a library that predates
 * it would offer nothing at all.
 */
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i;
/*
 * The index holds three kinds now, so the image picker has to say so. It used to take the whole
 * index unfiltered, which was correct only while the index happened to be images alone.
 */
function imageContent() {
  return (state.contentIndex || []).filter((c) => String(c.mime_type || '').startsWith('image/')
    || (!c.mime_type && !VIDEO_EXT.test(c.filename || '') && !AUDIO_EXT.test(c.filename || '')));
}
function audioContent() {
  return (state.contentIndex || []).filter((c) => String(c.mime_type || '').startsWith('audio/')
    || AUDIO_EXT.test(c.filename || ''));
}

function newElement(kind) {
  const k = KINDS[kind];
  return {
    slot: uid('f'), kind,
    box: {
      x: 10, y: 40, w: kind === 'qr' ? 18 : 50,
      ...(kind === 'rule' ? { h: 0.7 } : {}),
      // A QR must stay square or it does not scan; the renderer letterboxes the SVG inside the box,
      // so an equal-ish w/h is what makes the code as large as the space allows.
      ...(kind === 'qr' ? { h: 32 } : {}),
      ...(kind === 'image' || kind === 'box' ? { h: 30 } : {}),
    },
    style: { color: '#FFFFFF', font: 'sans', size_cqw: k.size || 3, weight: k.weight, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'slideU', delay: 0.2, duration: 0.55, easing: 'ease-out' },
    content_id: null,
    ...(kind === 'clock' ? { clock_format: '24', tz: '', locale: '' } : {}),
    ...(kind === 'date' ? { date_format: 'long', tz: '', locale: '' } : {}),
    // Default target a week out: a countdown to "now" reads as expired the moment it is added, and
    // the operator cannot tell whether it works.
    // locale '' = the panel's own language for the units ("3 Tg." on a German screen). A countdown
    // saved before that existed has no locale key at all and keeps its English "3d 4h 5m".
    ...(kind === 'countdown' ? { target: Date.now() + 7 * 86400000, locale: '' } : {}),
    // ⚠️ Black modules, NOT style.color — a QR that inherits the usual white text colour is a
    // white square on a white panel. See kindConfig in lib/slide-render.js.
    ...(kind === 'qr' ? { qr_ec: 'M', qr_fg: '#000000', qr_bg: '#FFFFFF' } : {}),
  };
}

function newSlide(name = 'Untitled slide') {
  const e = newElement('head');
  return {
    id: uid('s'), name, dwell_sec: 10, widget_id: null,
    template: { background: '#1B2029', elements: [e] },
    fields: { [e.slot]: 'New slide' },
  };
}

function buildRoomSignSlide(slug = null) {
  const head = {
    id: uid('el'), kind: 'head', slot: 'room_name',
    box: { x: 5, y: 8, w: 60, h: null },
    style: { color: '#FFFFFF', font: 'sans', size_cqw: 5, weight: 700, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const clock = {
    id: uid('el'), kind: 'clock', slot: 'clock', clock_format: '24', tz: '', locale: '',
    box: { x: 70, y: 8, w: 25, h: null },
    style: { color: '#94A3B8', font: 'sans', size_cqw: 4.5, weight: 600, align: 'right', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const rule = {
    id: uid('el'), kind: 'rule', slot: 'rule_top',
    box: { x: 5, y: 22, w: 90, h: 0.5 },
    style: { color: '#334155', font: 'sans', size_cqw: 0, weight: 400, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const stat = {
    id: uid('el'), kind: 'stat', slot: 'status_badge',
    box: { x: 5, y: 28, w: 90, h: null },
    style: { color: '#38BDF8', font: 'sans', size_cqw: 9, weight: 700, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const detail = {
    id: uid('el'), kind: 'body', slot: 'status_detail',
    box: { x: 5, y: 48, w: 90, h: null },
    style: { color: '#F8FAFC', font: 'sans', size_cqw: 3.5, weight: 500, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const nextMeet = {
    id: uid('el'), kind: 'body', slot: 'next_meeting',
    box: { x: 5, y: 68, w: 90, h: null },
    style: { color: '#94A3B8', font: 'sans', size_cqw: 3, weight: 400, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };

  return {
    id: uid('s'), name: 'Room Status', dwell_sec: 30, widget_id: null,
    template: {
      background: '#0F172A',
      aspect: '5:3', // 800:480 for e-paper / Sticky
      elements: [head, clock, rule, stat, detail, nextMeet],
    },
    fields: {
      room_name: t('slides.tpl_room.room_name'),
      // No calendar connected: sample words in the dashboard's language, never a tag pointing at a
      // source that does not exist (it would render as empty text on the screen).
      status_badge: slug ? `{{ds:${slug}.status}}` : t('slides.tpl_room.sample_status'),
      status_detail: slug ? `{{ds:${slug}.status_detail}}` : t('slides.tpl_room.sample_detail'),
      next_meeting: t('slides.tpl_room.next_meeting', slug
        ? { title: `{{ds:${slug}.next_title}}`, time: `{{ds:${slug}.next_time}}` }
        : { title: t('slides.tpl_room.sample_title'), time: t('slides.tpl_room.sample_time') }),
    }
  };
}

function buildWasteCalendarSlide(slug = null) {
  const head = {
    id: uid('el'), kind: 'head', slot: 'headline',
    box: { x: 6, y: 10, w: 88, h: null },
    style: { color: '#FFFFFF', font: 'sans', size_cqw: 4.5, weight: 700, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const stat = {
    id: uid('el'), kind: 'stat', slot: 'waste_type',
    box: { x: 6, y: 28, w: 88, h: null },
    style: { color: '#FACC15', font: 'sans', size_cqw: 8, weight: 700, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const date = {
    id: uid('el'), kind: 'body', slot: 'waste_date',
    box: { x: 6, y: 50, w: 88, h: null },
    style: { color: '#F8FAFC', font: 'sans', size_cqw: 4, weight: 600, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };
  const sub = {
    id: uid('el'), kind: 'body', slot: 'waste_note',
    box: { x: 6, y: 72, w: 88, h: null },
    style: { color: '#94A3B8', font: 'sans', size_cqw: 2.8, weight: 400, align: 'left', opacity: 1, radius_cqw: 0 },
    motion: { animation: 'none', delay: 0, duration: 0, easing: 'linear' },
  };

  return {
    id: uid('s'), name: 'Waste Pickup', dwell_sec: 30, widget_id: null,
    template: {
      background: '#0F172A',
      aspect: '5:3',
      elements: [head, stat, date, sub],
    },
    fields: {
      headline: t('slides.tpl_waste.headline'),
      waste_type: slug ? `{{ds:${slug}.next_title}}` : t('slides.tpl_waste.sample_type'),
      waste_date: t('slides.tpl_waste.date', { time: slug ? `{{ds:${slug}.next_time}}` : t('slides.tpl_waste.sample_time') }),
      waste_note: t('slides.tpl_waste.note'),
    }
  };
}

async function openNewDeckModal(container) {
  if (!DATA_SOURCES_LIST || !DATA_SOURCES_LIST.length) {
    try { DATA_SOURCES_LIST = await api.getDataSources(); } catch (_) { DATA_SOURCES_LIST = []; }
  }

  // Both templates read calendar keys (status, next_title, next_time), so only a calendar source
  // will do; with none, the templates fill sample text instead of tags for a made-up slug.
  const calendars = (DATA_SOURCES_LIST || []).filter((x) => x.type === 'ical' || (x.data && 'next_title' in x.data));
  const defaultRoomSlug = calendars[0]?.slug || null;
  const defaultWasteSlug = calendars.find((x) => /abfall|waste|trash|bin|garbage|recycl/i.test(x.slug))?.slug || defaultRoomSlug;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px';

  overlay.innerHTML = `
    <div class="modal" style="background:var(--bg-card,#1e293b);border-radius:12px;border:1px solid var(--border,#334155);width:100%;max-width:540px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5)">
      <div class="modal-header" style="padding:18px 24px;border-bottom:1px solid var(--border,#334155);display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0;font-size:18px;font-weight:600;color:var(--text-primary,#f8fafc)">${esc(t('slides.template_modal_title'))}</h2>
        <button id="closeNewDeckModal" style="background:none;border:none;color:var(--text-muted,#94a3b8);font-size:20px;cursor:pointer">&times;</button>
      </div>
      <div class="modal-body" style="padding:24px;display:flex;flex-direction:column;gap:16px">
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">${esc(t('slides.deck_name_label'))}</label>
          <input type="text" id="deckNameInput" class="input" style="width:100%" placeholder="${esc(t('slides.deck_name_placeholder'))}" value="New Slide Deck">
        </div>
        <p style="margin:0;font-size:13px;color:var(--text-muted)">${esc(t('signs.slides_modal_hint'))} <a href="#/signs?from=slides" data-sign-link>${esc(t('signs.new_from_template'))} &rarr;</a></p>
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">${esc(t('slides.choose_template'))}</label>
          <div style="display:flex;flex-direction:column;gap:8px">
            <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:var(--bg-input)">
              <input type="radio" name="deckTpl" value="blank" checked style="margin-top:3px">
              <div>
                <strong style="display:block;font-size:13px">${esc(t('slides.tpl_blank_title'))}</strong>
                <span style="font-size:11px;color:var(--text-muted)">${esc(t('slides.tpl_blank_desc'))}</span>
              </div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:var(--bg-input)">
              <input type="radio" name="deckTpl" value="room" style="margin-top:3px">
              <div>
                <strong style="display:block;font-size:13px">${esc(t('slides.tpl_room_title'))}</strong>
                <span style="font-size:11px;color:var(--text-muted)">${esc(t('slides.tpl_room_desc'))}</span>
              </div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:var(--bg-input)">
              <input type="radio" name="deckTpl" value="waste" style="margin-top:3px">
              <div>
                <strong style="display:block;font-size:13px">${esc(t('slides.tpl_waste_title'))}</strong>
                <span style="font-size:11px;color:var(--text-muted)">${esc(t('slides.tpl_waste_desc'))}</span>
              </div>
            </label>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="padding:16px 24px;border-top:1px solid var(--border,#334155);display:flex;justify-content:flex-end;gap:10px">
        <button type="button" id="cancelNewDeckBtn" class="btn btn-secondary">${esc(t('common.cancel'))}</button>
        <button type="button" id="submitNewDeckBtn" class="btn btn-primary">${esc(t('slides.create_deck_btn'))}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#closeNewDeckModal').onclick = close;
  overlay.querySelector('#cancelNewDeckBtn').onclick = close;
  overlay.querySelector('[data-sign-link]').addEventListener('click', close);

  overlay.querySelector('#submitNewDeckBtn').onclick = async () => {
    const name = overlay.querySelector('#deckNameInput').value.trim() || 'New Slide Deck';
    const tpl = overlay.querySelector('input[name="deckTpl"]:checked').value;

    let initialSlide;
    let initialAspect = '16:9';
    if (tpl === 'room') {
      initialSlide = buildRoomSignSlide(defaultRoomSlug);
      initialAspect = '5:3';
    } else if (tpl === 'waste') {
      initialSlide = buildWasteCalendarSlide(defaultWasteSlug);
      initialAspect = '5:3';
    } else {
      initialSlide = newSlide('Slide 1');
    }

    try {
      const d = await api.post('/slide-decks', {
        name,
        doc: { aspect: initialAspect, slides: [initialSlide] }
      });
      state.decks.unshift({ id: d.id, name: d.name, slide_count: d.doc.slides.length });
      close();
      await openDeck(container, d.id);
    } catch (e) {
      showToast(e.message || 'Could not create the deck', 'error');
    }
  };
}

/* ============================================================ render */

/*
 * render() awaits content, fonts and the deck list after painting the page. If the page is left, or
 * rendered again, meanwhile, the earlier call must not resume and draw into an #deckArea that is gone
 * ("Cannot set properties of null (setting 'innerHTML')") or over the view now showing.
 */
let renderSeq = 0;

export async function render(container) {
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq || !container.querySelector('#deckArea');
  container.innerHTML = `<div class="page-header"><div><h1>Slides</h1>
    <div class="subtitle">Build a deck of slides and publish it as a playlist.</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <!-- 3.0 Make a sign: the built-in sign templates, which come back here as an ordinary deck. -->
      <a class="btn btn-secondary" href="#/signs?from=slides">${esc(t('signs.new_from_template'))}</a>
      <!-- 3.0 Private AI: a starter set from one sentence, and translations of any deck. -->
      <a class="btn btn-secondary" href="#/ai-setup">${esc(t('ai_setup.short'))}</a>
      <a class="btn btn-secondary" href="#/translate">${esc(t('translate.title'))}</a>
      <button class="btn btn-primary" id="newDeck" ${canWrite() ? '' : 'hidden'}>${esc(t('slides.new_deck'))}</button></div></div>
    <div id="deckArea"><p style="color:var(--text-muted)">Loading…</p></div>`;

  container.querySelector('#newDeck').addEventListener('click', () => openNewDeckModal(container));

  // Loaded alongside the decks so the photo picker has something in it. Failure is not fatal:
  // a deck without its image list is still perfectly editable, and every other control works.
  if (state.contentIndex === null) await loadContent();
  if (!FONT_CATALOGUE.length) await loadFonts();
  if (stale()) return;

  try {
    state.decks = await api.get('/slide-decks');
  } catch (e) {
    if (stale()) return;
    container.querySelector('#deckArea').innerHTML =
      `<p style="color:var(--danger)">Could not load decks: ${esc(e.message || '')}</p>`;
    return;
  }
  if (stale()) return;
  if (state.deck) return renderEditor(container);
  // 3.0 accessibility: "Open the editor" from the Accessibility page lands on #/slides?deck=<id>.
  const want = new URLSearchParams((window.location.hash.split('?')[1]) || '').get('deck');
  if (want && state.decks.some((d) => d.id === want)) return openDeck(container, want);
  renderList(container);
}

function renderList(container) {
  const host = container.querySelector('#deckArea');
  if (!host) return;
  if (!state.decks.length) {
    host.innerHTML = `<div class="settings-section" style="text-align:center;padding:38px 20px">
      <p style="margin:0 0 6px;font-weight:600">No decks yet</p>
      <p style="margin:0;color:var(--text-muted);font-size:13px">A deck is a set of slides that
        publishes as a playlist — headline, photo, big number, each with its own entrance.</p></div>`;
    return;
  }
  host.innerHTML = `<div class="settings-section" style="padding:0">
    ${state.decks.map((d) => `
      <div data-deck-row="${esc(d.id)}" style="display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600" data-deck-name>${esc(d.name)}</div>
          <div style="font-size:12px;color:var(--text-muted)">
            ${d.slide_count} slide${d.slide_count === 1 ? '' : 's'} · ${(d.total_sec || 0)}s total
            ${d.playlist_id ? '· published' : '· not published yet'}</div>
        </div>
        <button class="btn btn-secondary btn-sm" data-open="${esc(d.id)}">${esc(t('common.edit'))}</button>
        <button class="btn btn-secondary btn-sm" ${canWrite() ? '' : 'hidden'} data-del="${esc(d.id)}">${esc(t('common.delete'))}</button>
      </div>`).join('')}
  </div>`;
  host.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => openDeck(container, b.dataset.open)));
  host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const d = state.decks.find((x) => x.id === b.dataset.del);
    // ⚠️ Spelled out, because the honest answer is surprising: deleting the document does NOT take
    // the published slides off the screens showing them.
    const msg = d && d.playlist_id
      ? `Delete "${d.name}"?\n\nThe playlist it published stays where it is — screens showing it keep playing.`
      : `Delete "${d && d.name}"?`;
    if (!confirm(msg)) return;                        // eslint-disable-line no-alert
    try {
      await api.delete(`/slide-decks/${b.dataset.del}`);
      state.decks = state.decks.filter((x) => x.id !== b.dataset.del);
      renderList(container);
    } catch (e) { showToast(e.message || 'Could not delete', 'error'); }
  }));
}

async function openDeck(container, id) {
  try {
    state.deck = await api.get(`/slide-decks/${id}`);
    try { DATA_SOURCES_LIST = await api.getDataSources(); } catch (_) { DATA_SOURCES_LIST = []; }
    state.si = 0; state.ei = 0; state.sel = []; state.dirty = false;
    /*
     * Two elements sharing a slot share their words, so editing one rewrote the other. Decks
     * from before pasted copies were given their own slot are repaired here, additively — the
     * twin gets a new slot and a copy of the words — and the repair is an unsaved change like any
     * other edit, kept by the next save.
     */
    const repaired = state.deck.doc.slides.reduce((n, sl) => n + repairSlots(sl), 0);
    if (repaired) state.dirty = true;
    undoHistory.reset(snapshot());
    renderEditor(container);
  } catch (e) { showToast(e.message || 'Could not open the deck', 'error'); }
}

function renderEditor(container) {
  const d = state.deck;
  const tabLabels = {
    content: t('slides.tab_content'),
    style: t('slides.tab_style'),
    motion: t('slides.tab_motion'),
    slide: t('slides.tab_slide'),
  };

  container.innerHTML = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="text" id="deckNameHeaderInput" class="input" style="font-size:22px;font-weight:700;padding:2px 8px;border:1px solid transparent;background:transparent;color:var(--text-primary);border-radius:6px;max-width:380px" value="${esc(d.name)}" title="${esc(t('slides.deck_name_label'))}">
          <span style="font-size:14px;color:var(--text-muted);cursor:pointer" onclick="const i=document.getElementById('deckNameHeaderInput');i.focus();i.select()">✏️</span>
        </div>
        <div class="subtitle" id="deckStatus"></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="backBtn">← ${esc(t('slides.all_decks'))}</button>
        <button class="btn btn-secondary" id="saveBtn" ${canWrite() ? '' : 'hidden'}>${esc(t('common.save'))}</button>
        <!--
          Preview opens the real player in preview mode against this deck's playlist, so what plays
          is the payload a screen would get — same renderer, same transitions, same audio.
        -->
        <button class="btn btn-secondary" id="previewBtn">▶ ${esc(t('common.preview'))}</button>
        <button class="btn btn-primary" id="pubBtn" ${canWrite() ? '' : 'hidden'}>${esc(t('common.publish'))}</button>
      </div>
    </div>
    <div id="warnBox"></div>
    <div id="deckApprovalBar" style="margin:0 0 10px"></div>
    <div class="settings-section" style="padding:10px 12px;margin-bottom:12px">
      <div id="strip" style="display:flex;gap:8px;overflow-x:auto"></div>
    </div>
    <!--
      ⚠️ FULL WIDTH, BETWEEN THE STRIP AND THE EDITOR — and still nowhere near the inspector.
      It used to sit under the stage, inside the middle column, where nobody found it: the eye goes
      strip -> canvas, and a control tucked beneath the canvas is below the fold on a laptop the
      moment the stage is 16:9. A feature people cannot see is a feature that does not exist.
      The original placement rule still holds and is the reason it is NOT in the panel on the right:
      the inspector edits the SELECTED ELEMENT, while this replaces the WHOLE slide, and putting a
      whole-slide action among per-element controls is how somebody loses a layout while thinking
      they were restyling one heading. Above the editor it reads as what it is — an action on the
      slide you are about to work on.
    -->
    <div class="settings-section" style="padding:10px 12px;margin-bottom:12px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="aiPrompt" class="input" style="flex:1;min-width:220px;margin:0"
               placeholder="${esc(t('slides.ai.placeholder'))}" maxlength="500">
        <button class="btn btn-secondary btn-sm" id="aiGenBtn">${esc(t('slides.ai.generate'))}</button>
        <button class="btn btn-secondary btn-sm" id="aiBgBtn" title="Generate a background image from the same prompt">Generate background</button>
        <button class="btn btn-secondary btn-sm" id="aiLayerBtn"
          title="Generate a background plus separate cut-out objects, each with its own entrance. Uses several image generations.">Generate layers</button>
        <button class="btn-icon" id="aiCfgBtn" title="${esc(t('slides.ai.settings'))}" aria-label="${esc(t('slides.ai.settings'))}" style="padding:4px 8px">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <span id="aiStatus" style="font-size:12px;color:var(--text-muted);margin-left:4px"></span>
        <span data-private-ai-badge></span>
      </div>
      <!-- Hosted AI (ScreenTinker credits). Stays hidden unless the server has a platform image
           provider configured; then "Generate background" follows whichever path is picked here. -->
      <div id="aiHostedRow" style="display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px"></div>
    </div>
    <div style="display:grid;grid-template-columns:42px minmax(0,1fr) 290px;gap:12px;align-items:start">
      <div class="settings-section" id="tools" style="padding:7px;display:flex;flex-direction:column;gap:5px"></div>
      <div class="settings-section" style="padding:12px">
        <!-- aspect-ratio here is only the pre-load default: it is re-set from the deck on every
             paint, because this markup is built before the deck has arrived -->
        <div style="display:flex;gap:9px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="playBtn">${esc(t('slides.play_entrance'))}</button>
          <!--
            The canvas shape. Editor-only: the renderer fills whatever container a screen gives it,
            so this changes what you DESIGN against, not what ships. A portrait screen laid out on a
            16:9 stage looks right here and wrong on the wall, which is the whole reason it exists.
          -->
          <!--
            The music bed. A DECK property, deliberately, not a slide one: it plays continuously
            under the whole deck, and the only way that can work is for every slide to name the
            same track. Setting it per slide would let two slides disagree and the music would
            restart in the middle.
          -->
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
            Music
            <select id="deckMusic" class="input" style="margin:0;padding:3px 6px;font-size:12px;max-width:170px">
              <option value="">— none —</option>
            </select>
          </label>
          <label id="deckMusicVolWrap" style="display:none;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
            Level
            <input type="range" id="deckMusicVol" min="0" max="1" step="0.05" style="width:80px">
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
            Shape
            <select id="aspectSel" class="input" style="margin:0;padding:3px 6px;font-size:12px">
              ${ASPECT_CHOICES.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('')}
            </select>
          </label>
          <span style="margin-left:auto;font-size:12px;color:var(--text-muted)" id="settleLabel"></span>
        </div>
        <!-- 3.0: arrange, align and undo for the canvas selection (PowerPoint's Arrange group). -->
        <div id="arrangeBar" class="sl-arrange" role="toolbar" aria-label="${esc(t('slides.edit.toolbar'))}">${arrangeBarHtml()}</div>
        <div id="stage" aria-label="${esc(t('slides.edit.canvas'))}" style="position:relative;aspect-ratio:16/9;border-radius:4px;overflow:hidden;container-type:size"></div>

      </div>
      <div class="settings-section" style="padding:0">
        <div style="display:flex;border-bottom:1px solid var(--border)" id="tabs">
          ${['content', 'style', 'motion', 'slide'].map((tab) => `
            <button class="tabBtn" data-tab="${tab}" style="flex:1;padding:8px 2px;border:0;background:none;
              cursor:pointer;font-size:12px;font-weight:600;border-bottom:2px solid transparent">
              ${esc(tabLabels[tab] || (tab[0].toUpperCase() + tab.slice(1)))}</button>`).join('')}
        </div>
        <div id="layers" style="max-height:170px;overflow-y:auto;border-bottom:1px solid var(--border)"></div>
        <div id="props" style="padding:11px 12px 14px;display:grid;gap:9px"></div>
      </div>
    </div>`;

  container.querySelector('#deckNameHeaderInput').addEventListener('input', (e) => {
    state.deck.name = e.target.value.trim() || 'Untitled Deck';
    state.dirty = true;
    container.querySelector('#deckStatus').textContent = 'Unsaved changes';
  });

  container.querySelector('#backBtn').addEventListener('click', async () => {
    if (state.dirty && !confirm('Leave without saving? Your changes will be lost.')) return; // eslint-disable-line no-alert
    state.deck = null;
    // Opened from a #/slides?deck= link: drop the parameter, or render would reopen the same deck.
    if (window.location.hash.startsWith('#/slides?')) history.replaceState(null, '', '#/slides');
    await render(container);
  });
  container.querySelector('#saveBtn').addEventListener('click', () => save(container));

  /*
   * Preview the deck as a screen would receive it.
   *
   * ⚠️ IT PREVIEWS WHAT IS PUBLISHED, NOT WHAT IS ON THIS CANVAS, and it says so rather than
   * quietly showing something else. The player renders from the deck's PLAYLIST, and a slide
   * reaches that playlist only when Publish writes its widget — so an unsaved or unpublished edit
   * genuinely is not in there. A preview that silently showed stale slides would be worse than no
   * preview: it is the button people press specifically to trust what they are about to ship.
   *
   * ⚠️ AND IT IS A NEW TAB, DELIBERATELY. Audio is the reason this button exists, and audio needs
   * a real page the operator can click in — a browser refuses unmuted autoplay without a gesture,
   * so the player offers its unmute affordance and a click there starts the sound. An iframe in
   * this editor would inherit the same restriction with nowhere obvious to click.
   */
  container.querySelector('#previewBtn').addEventListener('click', () => {
    const d = state.deck;
    if (!d || !d.playlist_id) {
      showToast('Publish the deck first — preview plays the deck\'s playlist, which Publish creates.', 'error');
      return;
    }
    if (state.dirty && !confirm('This deck has unsaved changes. Preview shows the last PUBLISHED version — continue?')) return; // eslint-disable-line no-alert
    window.open(`/player?preview=1&playlist=${encodeURIComponent(d.playlist_id)}`, '_blank', 'noopener');
  });
  container.querySelector('#pubBtn').addEventListener('click', () => publish(container));
  renderApprovalBar(container.querySelector('#deckApprovalBar'), {
    type: 'slide_deck', id: state.deck.id, name: state.deck.name,
    onChanged: async () => { try { state.deck = await api.get(`/slide-decks/${state.deck.id}`); state.dirty = false; undoHistory.reset(snapshot()); paintAll(container); } catch {} },
  });
  container.querySelector('#playBtn').addEventListener('click', play);
  editorContainer = container;
  const stageEl = container.querySelector('#stage');
  stageEl.addEventListener('pointerdown', (ev) => onStagePointerDown(ev, container));
  stageEl.addEventListener('dblclick', (ev) => onStageDblClick(ev, container));
  stageEl.addEventListener('contextmenu', (ev) => onStageContextMenu(ev, container));
  container.querySelector('#arrangeBar').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (b && !b.disabled) runAction(container, b.dataset.act);
  });
  bindEditorKeys();
  container.querySelector('#aspectSel').addEventListener('change', (e) => {
    state.deck.doc.aspect = e.target.value;
    touch(container);
    paintAll(container);
  });
  container.querySelector('#deckMusic').addEventListener('change', (e) => {
    state.deck.doc.music = e.target.value || null;
    // A bed nobody set a level for should not arrive at full volume under a voice.
    if (!e.target.value) state.deck.doc.music_volume = undefined;
    else if (state.deck.doc.music_volume == null) state.deck.doc.music_volume = 0.4;
    touch(container);
    paintAll(container);
  });
  container.querySelector('#deckMusicVol').addEventListener('input', (e) => {
    state.deck.doc.music_volume = Number(e.target.value);
    touch(container);
  });
  container.querySelector('#aiGenBtn').addEventListener('click', () => aiGenerate(container));
  container.querySelector('#aiBgBtn').addEventListener('click', () => aiGenerateBackground(container));
  container.querySelector('#aiLayerBtn').addEventListener('click', () => aiGenerateLayered(container));
  container.querySelector('#aiPrompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); aiGenerate(container); }
  });
  hostedCtl = null;
  mountHostedPicker(container.querySelector('#aiHostedRow')).then((ctl) => { hostedCtl = ctl; }).catch(() => {});
  container.querySelector('#aiCfgBtn').addEventListener('click', async () => {
    const { openAiSettingsModal } = await import('../components/ai-settings-modal.js');
    // 3.0 Private AI: the badge follows a change of provider.
    openAiSettingsModal({ onClose: () => import('../components/private-ai.js').then((m) => { m.getPrivateAiStatus(true); m.decoratePrivateBadges(container); }) });
  });
  import('../components/private-ai.js').then((m) => m.decoratePrivateBadges(container)).catch(() => {});
  container.querySelectorAll('.tabBtn').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab; paintTabs(container); renderProps(container);
  }));
  container.querySelector('#tools').innerHTML = Object.entries(KINDS).map(([k, v]) =>
    `<button class="btn btn-secondary" data-add="${k}" title="Add ${v.label}"
       style="padding:0;aspect-ratio:1;display:grid;place-items:center">${v.icon}</button>`).join('');
  container.querySelector('#tools').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-add]'); if (!b) return;
    const s = slide(); if (!s) return;
    // The same cap paste keeps: the renderer drops anything past it, so an element added here would
    // show in the editor and silently vanish from the screen.
    if (elementsOf(s).length >= MAX_ELEMENTS) { showToast(t('slides.edit.too_many', { max: MAX_ELEMENTS }), 'error'); return; }
    const e = newElement(b.dataset.add);
    s.template.elements.push(e);
    if (TEXT_KINDS.includes(e.kind)) {
      s.fields[e.slot] = e.kind === 'qr' ? 'https://screentinker.com'
        : e.kind === 'countdown' ? 'Now open'
        : KINDS[e.kind].label;
    }
    state.ei = s.template.elements.length - 1; state.sel = []; state.tab = 'content';
    // Adding an element no longer auto-plays the entrance (it dropped you into a mid-animation element
    // you were trying to place). It lands settled and grabbable; "Play entrance" previews motion.
    touch(container);
  });

  paintTabs(container);
  paintAll(container);
}

function paintTabs(container) {
  container.querySelectorAll('.tabBtn').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.style.color = on ? 'var(--text)' : 'var(--text-muted)';
    b.style.borderBottomColor = on ? 'var(--primary)' : 'transparent';
  });
}

function paintAll(container) {
  renderStage(container); renderStrip(container); renderLayers(container);
  renderProps(container); renderStatus(container);
}

/*
 * A STRUCTURAL change — an element added, deleted, reordered, a slide added. Repaints everything,
 * including the inspector, because the list of things to inspect just changed.
 */
function touch(container, coalesce = null) {
  state.dirty = true;
  undoHistory.record(snapshot(), { coalesce });
  paintAll(container);
}

/*
 * ⚠️ A VALUE change, and it must NOT rebuild the inspector.
 *
 * Every slider used to call touch(), which repaints the props panel — replacing the innerHTML of
 * the very control being dragged. The slider you were holding was destroyed on the first input
 * event, so it moved one step and stopped, and the colour picker closed the moment you picked a
 * colour. The panel looked fine and was unusable.
 *
 * This updates what the value affects — the stage, the thumbnail, the header — and leaves the DOM
 * the pointer is interacting with alone.
 */
function touchValue(container) {
  state.dirty = true;
  // One step per control: a slider dragged across fifty values undoes in one go.
  undoHistory.record(snapshot(), { coalesce: `value:${document.activeElement && document.activeElement.id}` });
  renderStage(container);
  renderStrip(container);
  renderStatus(container);
  renderLayers(container);
}

/* ============================================================ stage */

/*
 * ⚠️ THE RESULT IS A STRING THAT REACHES AN ATTRIBUTE, SO EVERY CALLER MUST ESCAPE IT.
 *
 * It interpolates stored values (colour, font, numbers) straight into CSS declarations. Assigned to
 * `.style.cssText` that is safe — the CSS parser cannot produce markup. Interpolated into an
 * innerHTML `style="…"` it is NOT: a colour containing a double quote closes the attribute and the
 * rest becomes markup, which is stored XSS in the dashboard origin. Server-side sanitising in
 * lib/slide-deck.js now means a stored colour is always hex, and the escape here is the second lock
 * on the same door — decks saved before that fix still exist.
 */
function styleFor(e) {
  const s = e.style || {};
  const out = [`left:${e.box.x}%`, `top:${e.box.y}%`, `width:${e.box.w}%`];
  if (e.box.h != null) out.push(`height:${e.box.h}%`);
  if (s.opacity != null && s.opacity !== 1) out.push(`opacity:${s.opacity}`);
  if (s.radius_cqw) out.push(`border-radius:${s.radius_cqw}cqw`);
  if (e.kind === 'rule' || e.kind === 'box') out.push(`background:${s.color}`);
  else out.push(`color:${s.color}`);
  if (GLYPH_KINDS.includes(e.kind)) {
    out.push(`font-family:${fontStack(s.font)}`, `font-size:${s.size_cqw}cqw`, `font-weight:${s.weight}`,
      `text-align:${s.align}`, 'line-height:1.08', 'white-space:pre-wrap');
  }
  return out.join(';');
}

/* ============ previewing the kinds that are not just text ============ */

/*
 * ⚠️ THE CANVAS HAS TO SHOW THE REAL CODE, so it asks the server to draw it with the SAME function
 * the renderer uses (lib/slide-render.qrSvg, via GET /api/slide-decks/qr-preview). A second QR
 * encoder in the browser would be a second thing to keep in step, and its failure mode — a preview
 * that scans and a slide that does not, or the reverse — is invisible on the machine that authored
 * the slide.
 *
 * ⚠️ AND IT ARRIVES AS AN <img>, NEVER AS innerHTML. The bytes are ours and carry no operator text,
 * but fetched markup injected into the dashboard's own origin is a habit worth not having: an
 * <img> cannot execute anything whatever the response turns out to be. The route hands back JSON
 * for the same reason — nothing serves an SVG document from this origin.
 */
const qrCache = new Map();
// Tracked QR links for the QR element's picker, loaded once per page (null = not asked yet).
let qrLinksCache = null;
const qrShortUrl = (l) => `${location.origin}${l.path}`;
const qrKey = (text, ec, fg, bg) => `${ec}|${fg}|${bg}|${text}`;

async function qrDataUrl(text, ec, fg, bg) {
  if (!text) return null;
  const key = qrKey(text, ec, fg, bg);
  if (qrCache.has(key)) return qrCache.get(key);
  const q = new URLSearchParams({ text, ec, fg, bg });
  let url = null;
  try {
    const { svg } = await api.get(`/slide-decks/qr-preview?${q}`);
    // A data: URL rather than a blob: one — nothing has to remember to revoke it, and the stage
    // repaints on every drag.
    if (svg) url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  } catch (err) { url = null; }
  // Cached either way: a payload too long to encode should not be re-asked on every repaint.
  qrCache.set(key, url);
  if (qrCache.size > 60) qrCache.delete(qrCache.keys().next().value);
  return url;
}

function paintQr(host, e, text) {
  const gap = () => {
    host.innerHTML = `<div style="width:100%;height:100%;display:grid;place-items:center;
      background:rgba(255,255,255,.07);border:1px dashed rgba(255,255,255,.22);
      color:rgba(255,255,255,.45);font-size:2.2cqw">QR</div>`;
  };
  gap();
  qrDataUrl(text, e.qr_ec || 'M', e.qr_fg || '#000000', e.qr_bg || '#FFFFFF')
    .then((url) => {
      // The stage may have been rebuilt while the request was in flight; painting into a detached
      // node is harmless but pointless, and painting a STALE code would be worse.
      if (!url || !host.isConnected) return;
      host.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
      img.src = url;
      host.appendChild(img);
    })
    .catch(() => {});
}

/*
 * ⚠️ THE FORMAT VOCABULARY IS DUPLICATED FROM lib/slide-render.js, AND A TEST HOLDS THE TWO
 * TOGETHER (test/slide-live-kinds.test.js). There is no module shared between a server lib and a
 * browser view here, so the choice was a duplicate with a guard or an editor that offers options
 * the server silently drops — which is the worse failure, because the operator sees their choice
 * accepted and the wall ignores it.
 */
// Countdown units by language (day, hour, minute, second) — the UNITS table of LIVE_SCRIPT.
const COUNTDOWN_UNITS = {
  en: ['d', 'h', 'm', 's'],
  de: ['\u00a0Tg.', '\u00a0Std.', '\u00a0Min.', '\u00a0Sek.'],
  es: ['d', 'h', 'min', 's'],
  fr: ['j', 'h', 'min', 's'],
  hi: ['\u00a0\u0926\u093f\u0928', '\u00a0\u0918\u0902\u0970', '\u00a0\u092e\u093f\u0970', '\u00a0\u0938\u0947\u0970'],
  it: ['g', 'h', 'min', 's'],
  ja: ['\u65e5', '\u6642\u9593', '\u5206', '\u79d2'],
  nl: ['d', 'u', 'm', 's'],
  pt: ['d', 'h', 'min', 's'],
  zh: ['\u5929', '\u5c0f\u65f6', '\u5206', '\u79d2']
};
function countdownUnits(locale) {
  // undefined/null: a countdown from before translated units — English, as it always was.
  if (locale === undefined || locale === null) return COUNTDOWN_UNITS.en;
  const l = String(locale || (typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase().split('-')[0];
  return Object.prototype.hasOwnProperty.call(COUNTDOWN_UNITS, l) ? COUNTDOWN_UNITS[l] : COUNTDOWN_UNITS.en;
}

function liveText(e, now) {
  if (e.kind === 'countdown') {
    const t = Number(e.target);
    if (!Number.isFinite(t)) return '';
    const ms = t - now;
    if (ms <= 0) return '';
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60); const ss = sec % 60;
    const u = countdownUnits(e.locale);
    return d > 0 ? `${d}${u[0]} ${h}${u[1]} ${m}${u[2]}` : h > 0 ? `${h}${u[1]} ${m}${u[2]} ${ss}${u[3]}` : `${m}${u[2]} ${ss}${u[3]}`;
  }
  let o;
  if (e.kind === 'clock') {
    const f = e.clock_format || '24';
    o = { hour: '2-digit', minute: '2-digit', hour12: f.charAt(0) === '1' };
    if (f.includes('s')) o.second = '2-digit';
  } else {
    const g = e.date_format || 'long';
    o = g === 'weekday' ? { weekday: 'long', month: 'long', day: 'numeric' }
      : g === 'numeric' ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : g === 'short' ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  }
  const loc = e.locale || undefined;
  if (e.kind === 'clock') fixHourCycle(loc, o);
  if (e.tz) {
    try { return new Intl.DateTimeFormat(loc, { ...o, timeZone: e.tz }).format(new Date(now)); } catch (err) { /* fall through */ }
  }
  try { return new Intl.DateTimeFormat(loc, o).format(new Date(now)); } catch (err) { return ''; }
}

/*
 * hour12: true resolves to hourCycle 'h11' (0-11, "00:38 pm") in a locale whose default clock is
 * 24-hour. Same rule as server/lib/hour-cycle.js, which the rendered slide uses; kept equal to it.
 */
function fixHourCycle(loc, o) {
  if (typeof o.hour12 !== 'boolean') return o;
  try {
    const hc = new Intl.DateTimeFormat(loc, o).resolvedOptions().hourCycle;
    if (hc === 'h11' || hc === 'h24') { const want = o.hour12 ? 'h12' : 'h23'; delete o.hour12; o.hourCycle = want; }
  } catch (err) { /* hour12 as given */ }
  return o;
}

function paintLive(host, e) {
  // A countdown whose target has passed shows its expiry message, exactly as the renderer does.
  const v = liveText(e, Date.now());
  host.textContent = (e.kind === 'countdown' && !v)
    ? ((slide() && slide().fields[e.slot]) || '')
    : v;
}

/*
 * ⚠️ ONE TIMER FOR THE WHOLE CANVAS, started once. A timer per element would be started on every
 * repaint — and the stage repaints on every drag — so they would accumulate silently until the
 * editor was spending its frame budget formatting dates.
 */
let liveTimer = null;
function ensureLiveTick() {
  if (liveTimer) return;
  liveTimer = setInterval(() => {
    const s = slide(); if (!s) return;
    const stage = document.getElementById('stage');
    if (!stage || !stage.isConnected) return;
    const els = elementsOf(s);
    stage.querySelectorAll('[data-live]').forEach((node, idx) => {
      // Index within the live subset, matched back to the element it was drawn from.
      const live = els.filter((x) => LIVE_KINDS.includes(x.kind));
      if (live[idx]) paintLive(node, live[idx]);
    });
  }, 1000);
}

function renderStage(container) {
  const s = slide(); const stage = container.querySelector('#stage');
  editingText = null;   // the node being edited is about to be replaced
  if (!s) { stage.innerHTML = ''; return; }
  // ⚠️ RENDER AT REST. The entrance animations play ONLY when the operator clicks "Play entrance"
  // (which adds `.playing`). Leaving `.playing` on across a repaint meant every slide switch, and
  // every value edit, re-fired the entrance — so on any slide but the one you opened on, elements
  // were mid-flight (opacity 0, offset) and could not be grabbed until the animation settled. Like
  // PowerPoint's editor: the canvas shows the settled slide and only previews motion on request.
  stage.classList.remove('playing');
  stage.style.aspectRatio = aspectCss();      // the shape this deck is authored for
  const sel = container.querySelector('#aspectSel');
  if (sel && sel.value !== deckAspect()) sel.value = deckAspect();

  const musicSel = container.querySelector('#deckMusic');
  if (musicSel) {
    const cur = (state.deck && state.deck.doc && state.deck.doc.music) || '';
    // Rebuilt rather than patched: the content library is fetched after this markup exists, so the
    // options are empty on the first paint and complete on the next.
    const opts = ['<option value="">— none —</option>'].concat(
      audioContent().map((c) => `<option value="${esc(c.id)}"${c.id === cur ? ' selected' : ''}>${esc(c.filename)}</option>`));
    const next = opts.join('');
    if (musicSel.innerHTML !== next) musicSel.innerHTML = next;
    musicSel.value = cur;
    const volWrap = container.querySelector('#deckMusicVolWrap');
    const vol = container.querySelector('#deckMusicVol');
    if (volWrap) volWrap.style.display = cur ? 'flex' : 'none';
    if (vol) vol.value = state.deck.doc.music_volume == null ? 0.4 : state.deck.doc.music_volume;
  }
  stage.style.background = s.template.background || '#000';
  stage.innerHTML = '';
  /*
   * ⚠️ Built the same way the renderer builds it — photo, then scrim, then elements, all inside the
   * stage. Previewing a background any other way (on the stage's own background-image, say) would
   * look right here and composite differently on a screen.
   */
  const bgUrl = contentUrl(s.template.background_content_id);
  const bgVidUrl = contentUrl(s.template.background_video_content_id);
  if (bgUrl || bgVidUrl) {
    let bg;
    if (bgVidUrl) {
      /*
       * ⚠️ Built the same way the renderer builds it, muted and looping, so what the editor shows
       * is what a panel shows. A preview that played sound here and not there — or that showed a
       * still where the wall shows motion — would make the canvas a liar about the one thing this
       * setting changes.
       */
      bg = document.createElement('video');
      bg.autoplay = true; bg.muted = true; bg.loop = true; bg.playsInline = true;
      if (bgUrl) bg.poster = bgUrl;
      bg.src = bgVidUrl;
      bg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block';
    } else {
      bg = document.createElement('div');
      bg.style.cssText = `position:absolute;inset:0;background-size:cover;background-position:center;background-image:url(${esc(bgUrl)})`;
    }
    stage.appendChild(bg);
    const d = s.template.background_dim == null ? 0 : s.template.background_dim;
    if (d > 0) {
      const scrim = document.createElement('div');
      scrim.style.cssText = `position:absolute;inset:0;background:rgba(0,0,0,${d})`;
      stage.appendChild(scrim);
    }
  }
  elementsOf(s).forEach((e, i) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;cursor:grab;${styleFor(e)}`;
    // Which element this node draws. The stage also holds the background photo and its scrim, so a
    // node's position among the stage's children is NOT its element index — see the canvas section below.
    d.dataset.ei = String(i);
    if (e.motion && e.motion.animation !== 'none') {
      d.dataset.anim = e.motion.animation;
      d.style.setProperty('--dur', `${e.motion.duration}s`);
      d.style.setProperty('--delay', `${e.motion.delay}s`);
    }
    if (e.kind === 'image') {
      const url = contentUrl(e.content_id);
      d.style.overflow = 'hidden';
      d.innerHTML = url
        ? `<img src="${esc(url)}" alt="" style="width:100%;height:100%;object-fit:${
            e.fit === 'contain' ? 'contain' : 'cover'};display:block">`
        : `<div style="width:100%;height:100%;display:grid;place-items:center;background:rgba(255,255,255,.07);
             border:1px dashed rgba(255,255,255,.22);color:rgba(255,255,255,.45);font-size:2.2cqw">photo</div>`;
    } else if (e.kind === 'lettering') {
      const url = contentUrl(e.content_id);
      d.style.overflow = 'hidden';
      if (url) {
        d.innerHTML = `<img src="${esc(url)}" alt="${esc(s.fields[e.slot] || '')}"
          style="width:100%;height:100%;object-fit:contain;display:block">`;
      } else {
        // No artwork yet: show the words, so the element is placeable before it is generated.
        d.innerHTML = `<div style="width:100%;height:100%;display:grid;place-items:center;
          border:1px dashed rgba(255,255,255,.22);color:rgba(255,255,255,.55);font-size:3cqw;
          text-align:center;padding:2%">${esc(s.fields[e.slot] || 'Lettering')}</div>`;
      }
    } else if (e.kind === 'qr') {
      d.style.overflow = 'hidden';
      paintQr(d, e, s.fields[e.slot] || '');
    } else if (LIVE_KINDS.includes(e.kind)) {
      // Painted now and again on the shared tick below, so the canvas shows the same thing the
      // wall will — a clock frozen at whatever second the panel was last repainted reads as broken.
      d.dataset.live = e.kind;
      paintLive(d, e);
    } else if (TEXT_KINDS.includes(e.kind)) {
      d.textContent = resolveInterpolatedText(s.fields[e.slot] || '');
    }
    stage.appendChild(d);
  });
  // Selection chrome goes on last, above every element; the nodes themselves stay listener-free.
  paintOutlines(container);
  paintOverlay(container);
  ensureKeyframes();
  ensureEditorStyles();
  ensureLiveTick();
  const settle = settleOf(s);
  container.querySelector('#settleLabel').textContent =
    settle > s.dwell_sec
      ? `settles at ${settle.toFixed(2)}s — after this slide is replaced at ${s.dwell_sec}s`
      : `settles at ${settle.toFixed(2)}s of ${s.dwell_sec}s`;
  container.querySelector('#settleLabel').style.color =
    settle > s.dwell_sec ? 'var(--danger)' : 'var(--text-muted)';
}

/* ============================================================ canvas: select, move, resize */

/*
 * PowerPoint-style editing on the stage: click selects and shows handles, Shift/Ctrl-click adds
 * and removes, a drag on empty canvas draws a marquee, handles resize, arrows nudge, and the
 * clipboard, layer order, align/distribute and undo all act on the selection.
 *
 * ⚠️ ONE SET OF LISTENERS ON THE STAGE, bound once per editor by renderEditor — never one per
 * element per repaint. The stage repaints on every edit, and listeners bound to its nodes are the
 * shape of the bug where an old handler moved a different element than the one selected.
 *
 * ⚠️ AN ELEMENT'S NODE IS FOUND BY ITS `data-ei`, NEVER BY ITS POSITION AMONG THE STAGE'S
 * CHILDREN. The stage also holds the background photo, its scrim and the selection overlay, so the
 * n-th child is not the n-th element — which is exactly how a drag once moved the wrong thing.
 *
 * Rotation is deliberately absent: the renderer's entrance animations are `transform` keyframes on
 * the element itself, so a rotated element would snap upright as it animated in, and the
 * independent `rotate` property is missing from the Android WebView builds still common on
 * signage panels. Doing it properly means a wrapper element in every renderer.
 */

const GRAB_PX = 3;            // pointer travel below this is a click, not a drag
const SNAP_PX = 6;            // how close an edge has to come before it snaps
const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/* Pictures keep their shape by default, as in PowerPoint; Shift frees them (and locks the rest). */
const KEEP_ASPECT_KINDS = ['image', 'lettering'];
/* Kinds whose words are typed straight onto the canvas with a double-click. */
const INLINE_TEXT_KINDS = ['head', 'body', 'stat'];

let gesture = null;           // the drag, resize or marquee in progress
let editingText = null;       // { i, node, before } while a text element is edited in place
let clip = null;              // the editor's clipboard: copies of elements with their words
let pasteCount = 0;           // each paste lands a little further down-right than the last
let editorContainer = null;   // the mounted editor, for the document-level keyboard handler

const round2 = (v) => Math.round(v * 100) / 100;
const clampPos = (v) => round2(Math.max(-20, Math.min(110, v)));

/* The selected element indices, ascending. Empty when nothing is selected. */
function selection() {
  const n = elementsOf(slide()).length;
  if (!(state.ei >= 0 && state.ei < n)) return [];
  const sel = (state.sel || []).filter((i) => i >= 0 && i < n);
  return sel.includes(state.ei) ? sel : [state.ei];
}

function select(indices, primary) {
  const uniq = [...new Set(indices)].filter((i) => i >= 0).sort((a, b) => a - b);
  state.sel = uniq;
  state.ei = uniq.length ? (uniq.includes(primary) ? primary : uniq[uniq.length - 1]) : -1;
}

function stageNode(container, i) {
  return container.querySelector(`#stage > [data-ei="${i}"]`);
}

/*
 * Every element's box as drawn, in stage percent. x, y and w are the document's own; an
 * auto-height text box has no stored height, so that one is measured from what the canvas drew.
 */
function drawnRects(container) {
  const stage = container.querySelector('#stage');
  const r = stage ? stage.getBoundingClientRect() : { width: 0, height: 0 };
  return elementsOf(slide()).map((e, i) => {
    let h = e.box.h;
    if (h == null) {
      const n = stageNode(container, i);
      h = n && r.height ? (n.getBoundingClientRect().height / r.height) * 100 : 5;
    }
    return { x: Number(e.box.x) || 0, y: Number(e.box.y) || 0, w: Number(e.box.w) || 0, h };
  });
}

/*
 * Snap in PIXELS, through the same helper the wall and layout editors use: a 6px threshold means
 * the same thing on both axes, where a percentage threshold would be twice as sticky across the
 * width of a 16:9 stage as down it. The slide's edges and centre lines are targets too.
 */
function snapRect(stageRect, rect, targets, mode, dir) {
  const sx = stageRect.width / 100; const sy = stageRect.height / 100;
  if (!sx || !sy) return { ...rect, guides: [] };
  const px = (q) => ({ x: q.x * sx, y: q.y * sy, w: q.w * sx, h: q.h * sy });
  const opts = { threshold: SNAP_PX, bounds: { x: 0, y: 0, w: stageRect.width, h: stageRect.height } };
  const out = mode === 'move'
    ? snapMove(px(rect), targets.map(px), opts)
    : snapResize(px(rect), dir, targets.map(px), { ...opts, minW: 1, minH: 1 });
  return {
    x: out.x / sx, y: out.y / sy, w: out.w / sx, h: out.h / sy,
    guides: out.guides.map((g) => ({ axis: g.axis, at: g.at / (g.axis === 'x' ? sx : sy) })),
  };
}

/* Outlines on the selected nodes: solid on the primary, dashed on the rest of a multi-selection. */
function paintOutlines(container) {
  const sel = selection();
  container.querySelectorAll('#stage > [data-ei]').forEach((n) => {
    const i = Number(n.dataset.ei);
    n.style.outline = !sel.includes(i) ? ''
      : i === state.ei ? '1.5px solid var(--primary)' : '1.5px dashed var(--primary)';
  });
}

/*
 * The layer over the elements: resize handles on a single selection, a dashed box around a
 * multi-selection, smart-guide lines while snapping, and the marquee. Pointer events pass through
 * it everywhere except the handles.
 */
function paintOverlay(container, guides = [], marquee = null) {
  const stage = container.querySelector('#stage');
  if (!stage) return;
  let ov = stage.querySelector(':scope > .sl-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'sl-overlay';
    stage.appendChild(ov);
  }
  const sel = selection();
  let html = '';
  if (sel.length && !editingText) {
    const rects = drawnRects(container);
    if (sel.length === 1) {
      const e = elementsOf(slide())[sel[0]];
      const r = rects[sel[0]];
      // An auto-height text box only has a width to change: its height is whatever its words need.
      const dirs = e.box.h == null ? ['w', 'e'] : HANDLE_DIRS;
      html += dirs.map((d) => {
        const x = d.includes('w') ? r.x : d.includes('e') ? r.x + r.w : r.x + r.w / 2;
        const y = d.includes('n') ? r.y : d.includes('s') ? r.y + r.h : r.y + r.h / 2;
        return `<div class="sl-handle" data-handle="${d}" style="left:${x}%;top:${y}%;cursor:${d}-resize"
                     aria-label="${esc(t('slides.edit.resize'))}"></div>`;
      }).join('');
    } else {
      const b = boundsOf(sel.map((i) => rects[i]));
      html += `<div class="sl-groupbox" style="left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%"></div>`;
    }
  }
  for (const g of guides) {
    html += g.axis === 'x'
      ? `<div class="sl-guide" style="left:${g.at}%;top:0;bottom:0;width:0;border-left:1px solid #ff2d87"></div>`
      : `<div class="sl-guide" style="top:${g.at}%;left:0;right:0;height:0;border-top:1px solid #ff2d87"></div>`;
  }
  if (marquee) {
    html += `<div class="sl-marquee" style="left:${marquee.x}%;top:${marquee.y}%;width:${marquee.w}%;height:${marquee.h}%"></div>`;
  }
  ov.innerHTML = html;
}

/* A selection change: the canvas chrome and the panels that follow the selection. Nodes are kept. */
function paintSelection(container) {
  paintOutlines(container);
  paintOverlay(container);
  renderLayers(container);
  renderProps(container);
  updateArrangeBar(container);
}

/* The Style tab's position and size numbers follow a drag as it happens, not only after it. */
function syncBoxInputs(container) {
  const e = elementsOf(slide())[state.ei];
  if (!e) return;
  for (const [id, key, dec] of [['pX', 'x', 0], ['pY', 'y', 0], ['pW', 'w', 0], ['pH', 'h', 1]]) {
    const v = e.box[key];
    if (v == null) continue;
    const r = container.querySelector(`#${id}`); const n = container.querySelector(`#${id}n`);
    if (r) r.value = v;
    if (n) n.value = Number(v).toFixed(dec);
  }
}

/*
 * Follow one pointer until it lifts, with the stage capturing it so a drag that leaves the canvas
 * keeps going. The listeners are removed on the way out — every time, including on cancel.
 */
function trackPointer(ev, container, onMove, onEnd) {
  const stage = container.querySelector('#stage');
  /*
   * Captured on the first MOVE, not on the press: a capture retargets the click that follows to
   * the stage, and a double-click on a text box then arrives without its element — so a plain
   * click stays uncaptured and a drag that leaves the canvas still keeps going.
   */
  let captured = false;
  const move = (m) => {
    if (m.pointerId !== ev.pointerId) return;
    if (!captured) {
      captured = true;
      try { stage.setPointerCapture(ev.pointerId); } catch { /* a synthetic pointer: still works uncaptured */ }
    }
    onMove(m);
  };
  const end = (m) => {
    if (m.pointerId !== ev.pointerId) return;
    stage.removeEventListener('pointermove', move);
    stage.removeEventListener('pointerup', end);
    stage.removeEventListener('pointercancel', end);
    try { stage.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    gesture = null;
    onEnd(m);
  };
  gesture = { pointerId: ev.pointerId };
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function onStagePointerDown(ev, container) {
  closeContextMenu();
  if (ev.button !== 0 || gesture) return;
  // Working on the canvas takes the keyboard with it: a number box left focused in the inspector
  // would otherwise swallow the arrow keys meant to nudge the element just clicked.
  const ae = document.activeElement;
  if (ae && ae !== document.body && !ae.closest('#stage') && typeof ae.blur === 'function') ae.blur();
  if (editingText) {
    // A click inside the box being edited places the caret; anywhere else finishes the edit.
    if (editingText.node.contains(ev.target)) return;
    ev.preventDefault();
    finishInlineEdit(container, true);
    return;
  }
  const handle = ev.target.closest('[data-handle]');
  if (handle) { ev.preventDefault(); startResize(ev, handle.dataset.handle, container); return; }

  const node = ev.target.closest('#stage > [data-ei]');
  if (node) {
    ev.preventDefault();
    const i = Number(node.dataset.ei);
    const sel = selection();
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      select(sel.includes(i) ? sel.filter((k) => k !== i) : sel.concat(i), i);
      paintSelection(container);
      return;
    }
    // Pressing on a member of a multi-selection drags the whole group, as in PowerPoint.
    if (!sel.includes(i)) select([i], i); else state.ei = i;
    paintSelection(container);
    startMove(ev, container);
    return;
  }

  // Empty canvas. A finger there scrolls the page on a tablet, so touch only deselects.
  if (ev.pointerType === 'touch') { select([], -1); paintSelection(container); return; }
  ev.preventDefault();
  startMarquee(ev, container, ev.shiftKey || ev.ctrlKey || ev.metaKey);
}

function startMove(ev, container) {
  const els = elementsOf(slide());
  const sel = selection();
  const r = container.querySelector('#stage').getBoundingClientRect();
  const rects = drawnRects(container);
  const starts = sel.map((i) => ({ i, e: els[i], x: Number(els[i].box.x) || 0, y: Number(els[i].box.y) || 0 }));
  const group = boundsOf(sel.map((i) => rects[i]));
  const others = rects.filter((_, k) => !sel.includes(k));
  let moved = false;
  trackPointer(ev, container, (m) => {
    if (!moved && Math.hypot(m.clientX - ev.clientX, m.clientY - ev.clientY) < GRAB_PX) return;
    moved = true;
    let dx = ((m.clientX - ev.clientX) / r.width) * 100;
    let dy = ((m.clientY - ev.clientY) / r.height) * 100;
    let guides = [];
    if (state.snap && !m.altKey) {
      const sn = snapRect(r, { ...group, x: group.x + dx, y: group.y + dy }, others, 'move');
      dx = sn.x - group.x; dy = sn.y - group.y; guides = sn.guides;
    }
    for (const st of starts) {
      st.e.box.x = clampPos(st.x + dx);
      st.e.box.y = clampPos(st.y + dy);
      const n = stageNode(container, st.i);
      if (n) { n.style.left = `${st.e.box.x}%`; n.style.top = `${st.e.box.y}%`; }
    }
    paintOverlay(container, guides);
    syncBoxInputs(container);
  }, () => {
    paintOverlay(container);
    if (moved) touch(container);
  });
}

function startResize(ev, dir, container) {
  const i = state.ei;
  const e = elementsOf(slide())[i];
  if (!e) return;
  const r = container.querySelector('#stage').getBoundingClientRect();
  const rects = drawnRects(container);
  const start = rects[i];
  const autoH = e.box.h == null;
  const others = rects.filter((_, k) => k !== i);
  const minH = e.kind === 'rule' ? 0.1 : 0.5;
  let changed = false;
  trackPointer(ev, container, (m) => {
    if (!changed && Math.hypot(m.clientX - ev.clientX, m.clientY - ev.clientY) < 1) return;
    changed = true;
    const dx = ((m.clientX - ev.clientX) / r.width) * 100;
    const dy = autoH ? 0 : ((m.clientY - ev.clientY) / r.height) * 100;
    const keep = !autoH && (KEEP_ASPECT_KINDS.includes(e.kind) !== m.shiftKey);
    let nb = resizeRect(start, dir, dx, dy, { keepAspect: keep, fromCenter: m.altKey, minW: 1, minH });
    let guides = [];
    // Alt is "from the centre" here, so it also means "no snapping"; a locked ratio is not snapped
    // either, because snapping one edge would break the ratio the operator asked to keep.
    if (state.snap && !m.altKey && !keep) {
      const sn = snapRect(r, nb, others, 'resize', dir);
      guides = sn.guides; nb = sn;
    }
    e.box.x = clampPos(nb.x);
    e.box.w = round2(Math.max(1, Math.min(200, nb.w)));
    if (!autoH) {
      e.box.y = clampPos(nb.y);
      e.box.h = round2(Math.max(minH, Math.min(200, nb.h)));
    }
    const n = stageNode(container, i);
    if (n) {
      n.style.left = `${e.box.x}%`; n.style.width = `${e.box.w}%`;
      if (!autoH) { n.style.top = `${e.box.y}%`; n.style.height = `${e.box.h}%`; }
    }
    paintOverlay(container, guides);
    syncBoxInputs(container);
  }, () => {
    paintOverlay(container);
    if (changed) touch(container);
  });
}

function startMarquee(ev, container, additive) {
  const r = container.querySelector('#stage').getBoundingClientRect();
  const at = (p) => ({ x: ((p.clientX - r.left) / r.width) * 100, y: ((p.clientY - r.top) / r.height) * 100 });
  const p0 = at(ev);
  const base = additive ? selection() : [];
  const rects = drawnRects(container);
  let moved = false;
  trackPointer(ev, container, (m) => {
    if (!moved && Math.hypot(m.clientX - ev.clientX, m.clientY - ev.clientY) < GRAB_PX) return;
    moved = true;
    const p1 = at(m);
    const box = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) };
    // As in PowerPoint, an element is picked up only when the marquee encloses all of it.
    const inside = rects.map((q, k) => (q.x >= box.x && q.y >= box.y && q.x + q.w <= box.x + box.w
      && q.y + q.h <= box.y + box.h ? k : -1)).filter((k) => k >= 0);
    select(base.concat(inside), state.ei);
    paintOutlines(container);
    paintOverlay(container, [], box);
  }, () => {
    if (!moved && !additive) select([], -1);
    paintSelection(container);
  });
}

/* ------------------------------------------------------------ in-place text */

function onStageDblClick(ev, container) {
  // The topmost element under the pointer, even if the click was retargeted to the stage itself.
  const hit = ev.target === ev.currentTarget ? document.elementFromPoint(ev.clientX, ev.clientY) : ev.target;
  const node = hit && hit.closest('#stage > [data-ei]');
  if (!node || editingText) return;
  const i = Number(node.dataset.ei);
  const s = slide();
  const e = elementsOf(s)[i];
  if (!e || !INLINE_TEXT_KINDS.includes(e.kind)) return;
  select([i], i);
  paintSelection(container);
  // The stored words, not the canvas's rendering of them: a `{{…}}` token has to stay editable.
  editingText = { i, node, before: s.fields[e.slot] || '' };
  node.textContent = editingText.before;
  node.contentEditable = 'plaintext-only';
  if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
  node.style.cursor = 'text';
  node.style.outline = '1.5px dashed var(--primary)';
  node.dataset.editing = '1';
  paintOverlay(container);
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  node.addEventListener('keydown', (k) => {
    k.stopPropagation();
    if (k.key === 'Escape') { k.preventDefault(); finishInlineEdit(container, false); }
    else if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); finishInlineEdit(container, true); }
  });
  node.addEventListener('blur', () => finishInlineEdit(container, true), { once: true });
}

function finishInlineEdit(container, keep) {
  const ed = editingText;
  if (!ed) return;
  editingText = null;
  const s = slide();
  const e = elementsOf(s)[ed.i];
  const v = ed.node.innerText.replace(/\n$/, '');
  if (keep && e && v !== ed.before) {
    s.fields[e.slot] = v;
    touch(container);
    return;
  }
  renderStage(container);
  paintSelection(container);
}

/* ------------------------------------------------------------ actions */

function deleteSelection(container) {
  const s = slide();
  const arr = elementsOf(s);
  const sel = selection();
  if (!sel.length) return;
  for (const i of [...sel].sort((a, b) => b - a)) {
    const [gone] = arr.splice(i, 1);
    if (gone && !arr.some((x) => x.slot === gone.slot)) delete s.fields[gone.slot];
  }
  select([], -1);
  touch(container);
}

/* Layer order. Selection follows the elements themselves, not the indices they used to have. */
function applyOrder(container, op) {
  const arr = elementsOf(slide());
  const sel = selection();
  if (!sel.length) return;
  const order = reorder(arr.length, sel, op);
  if (order.every((v, k) => v === k)) return;
  const primary = arr[state.ei];
  const chosen = sel.map((i) => arr[i]);
  arr.splice(0, arr.length, ...order.map((k) => arr[k]));
  select(chosen.map((e) => arr.indexOf(e)), arr.indexOf(primary));
  touch(container);
}

function applyAlign(container, how) {
  const els = elementsOf(slide());
  const sel = selection();
  if (!sel.length || ((how === 'dist-h' || how === 'dist-v') && sel.length < 3)) return;
  const rects = drawnRects(container);
  const mine = sel.map((i) => rects[i]);
  const out = how === 'dist-h' ? distributeRects(mine, 'x')
    : how === 'dist-v' ? distributeRects(mine, 'y')
      : alignRects(mine, how);
  sel.forEach((i, k) => { els[i].box.x = clampPos(out[k].x); els[i].box.y = clampPos(out[k].y); });
  touch(container);
}

function nudge(container, dx, dy) {
  const els = elementsOf(slide());
  const sel = selection();
  if (!sel.length) return;
  for (const i of sel) {
    els[i].box.x = clampPos((Number(els[i].box.x) || 0) + dx);
    els[i].box.y = clampPos((Number(els[i].box.y) || 0) + dy);
  }
  // Holding an arrow key down is one move, so it is one undo step.
  touch(container, 'nudge');
}

function copySelection(cut) {
  const sel = selection();
  if (!sel.length) return false;
  clip = copyElements(slide(), sel);
  // A cut pastes back where it was; a copy lands offset, so the copy is visibly a second thing.
  pasteCount = cut ? -1 : 0;
  return true;
}

function pasteItems(container, items, offset) {
  if (!items || !items.length) return;
  const s = slide();
  if (!s) return;
  const room = MAX_ELEMENTS - elementsOf(s).length;
  if (room < items.length) {
    showToast(t('slides.edit.too_many', { max: MAX_ELEMENTS }), 'error');
    if (room <= 0) return;
  }
  const idx = pasteElements(s, items, offset, MAX_ELEMENTS);
  select(idx, idx[idx.length - 1]);
  touch(container);
}

function undoRedo(container, redo) {
  const cur = snapshot();
  const snap = redo ? undoHistory.redo(cur) : undoHistory.undo(cur);
  if (snap == null) return;
  const doc = JSON.parse(snap);
  // Publishing gives slides their widget ids; undoing to before a publish must not forget them, or
  // the next publish would build a second set of widgets and orphan the first.
  const ids = new Map(state.deck.doc.slides.map((sl) => [sl.id, sl.widget_id]));
  for (const sl of doc.slides) if (ids.get(sl.id)) sl.widget_id = ids.get(sl.id);
  state.deck.doc = doc;
  undoHistory.rebase(snapshot());
  state.si = Math.max(0, Math.min(state.si, doc.slides.length - 1));
  const n = elementsOf(slide()).length;
  select(selection().filter((i) => i < n), state.ei < n ? state.ei : -1);
  state.dirty = true;
  paintAll(container);
}

function runAction(container, act) {
  switch (act) {
    case 'undo': undoRedo(container, false); break;
    case 'redo': undoRedo(container, true); break;
    case 'cut': if (copySelection(true)) deleteSelection(container); break;
    case 'copy': copySelection(false); break;
    case 'paste': pasteCount++; pasteItems(container, clip, 2 * pasteCount); break;
    case 'duplicate': {
      const sel = selection();
      if (sel.length) pasteItems(container, copyElements(slide(), sel), 2);
      break;
    }
    case 'delete': deleteSelection(container); break;
    case 'select-all': {
      const n = elementsOf(slide()).length;
      select(Array.from({ length: n }, (_, i) => i), state.ei >= 0 ? state.ei : n - 1);
      paintSelection(container);
      break;
    }
    case 'front': case 'forward': case 'backward': case 'back': applyOrder(container, act); break;
    case 'left': case 'center': case 'right': case 'top': case 'middle': case 'bottom':
    case 'dist-h': case 'dist-v':
      applyAlign(container, act); break;
    case 'snap': state.snap = !state.snap; updateArrangeBar(container); break;
    default: break;
  }
}

/* ------------------------------------------------------------ toolbar and context menu */

const ICON = (d) => `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="1.5" stroke-linecap="round" aria-hidden="true">${d}</svg>`;
const ARRANGE_ICONS = {
  undo: ICON('<path d="M5 3 2 6l3 3"/><path d="M2 6h8a4 4 0 0 1 0 8H7"/>'),
  redo: ICON('<path d="m11 3 3 3-3 3"/><path d="M14 6H6a4 4 0 0 0 0 8h3"/>'),
  front: ICON('<rect x="5" y="5" width="9" height="9" fill="currentColor" stroke="none"/><rect x="2" y="2" width="9" height="9"/>'),
  forward: ICON('<rect x="2" y="2" width="8" height="8"/><path d="M12 14V7m-2.5 2.5L12 7l2.5 2.5"/>'),
  backward: ICON('<rect x="2" y="2" width="8" height="8"/><path d="M12 7v7m-2.5-2.5L12 14l2.5-2.5"/>'),
  back: ICON('<rect x="2" y="2" width="9" height="9" fill="currentColor" stroke="none"/><rect x="5" y="5" width="9" height="9" fill="var(--bg-card,#fff)"/>'),
  left: ICON('<path d="M2 1v14"/><rect x="4" y="3" width="9" height="3"/><rect x="4" y="10" width="5" height="3"/>'),
  center: ICON('<path d="M8 1v14"/><rect x="3" y="3" width="10" height="3"/><rect x="5" y="10" width="6" height="3"/>'),
  right: ICON('<path d="M14 1v14"/><rect x="3" y="3" width="9" height="3"/><rect x="7" y="10" width="5" height="3"/>'),
  top: ICON('<path d="M1 2h14"/><rect x="3" y="4" width="3" height="9"/><rect x="10" y="4" width="3" height="5"/>'),
  middle: ICON('<path d="M1 8h14"/><rect x="3" y="3" width="3" height="10"/><rect x="10" y="5" width="3" height="6"/>'),
  bottom: ICON('<path d="M1 14h14"/><rect x="3" y="3" width="3" height="9"/><rect x="10" y="7" width="3" height="5"/>'),
  'dist-h': ICON('<path d="M1 2v12M15 2v12"/><rect x="6" y="4" width="4" height="8"/>'),
  'dist-v': ICON('<path d="M2 1h12M2 15h12"/><rect x="4" y="6" width="8" height="4"/>'),
  duplicate: ICON('<rect x="5" y="5" width="9" height="9"/><path d="M11 2H2v9"/>'),
  delete: ICON('<path d="M3 4h10M6 4V2h4v2m-6 0 1 10h6l1-10"/>'),
  snap: ICON('<path d="M3 1v14M1 13h14"/><path d="M6 10 12 4" stroke-dasharray="2 2"/>'),
};

/* Every label is a literal t() key, so the i18n guard can see each one is defined. */
function actionLabels() {
  return {
    undo: t('slides.edit.undo'), redo: t('slides.edit.redo'),
    cut: t('slides.edit.cut'), copy: t('slides.edit.copy'), paste: t('slides.edit.paste'),
    duplicate: t('slides.edit.duplicate'), delete: t('slides.edit.delete'),
    front: t('slides.edit.front'), forward: t('slides.edit.forward'),
    backward: t('slides.edit.backward'), back: t('slides.edit.back'),
    left: t('slides.edit.align_left'), center: t('slides.edit.align_center'), right: t('slides.edit.align_right'),
    top: t('slides.edit.align_top'), middle: t('slides.edit.align_middle'), bottom: t('slides.edit.align_bottom'),
    'dist-h': t('slides.edit.distribute_h'), 'dist-v': t('slides.edit.distribute_v'),
    snap: t('slides.edit.snap'),
  };
}
const SHORTCUTS = {
  undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', duplicate: 'Ctrl+D',
  delete: 'Del', front: 'Ctrl+Shift+]', forward: 'Ctrl+]', backward: 'Ctrl+[', back: 'Ctrl+Shift+[',
};

function arrangeBarHtml() {
  const L = actionLabels();
  const btn = (act) => `<button type="button" class="sl-tool" data-act="${act}"
      title="${esc(L[act] + (SHORTCUTS[act] ? ` (${SHORTCUTS[act]})` : ''))}" aria-label="${esc(L[act])}">${ARRANGE_ICONS[act]}</button>`;
  const sep = '<span class="sl-tool-sep" aria-hidden="true"></span>';
  return [['undo', 'redo'], ['front', 'forward', 'backward', 'back'],
    ['left', 'center', 'right', 'top', 'middle', 'bottom'], ['dist-h', 'dist-v'], ['duplicate', 'delete'], ['snap']]
    .map((g) => g.map(btn).join('')).join(sep);
}

/* What each action needs to be worth pressing. */
function actionEnabled(act) {
  const n = selection().length;
  if (act === 'undo') return undoHistory.canUndo;
  if (act === 'redo') return undoHistory.canRedo;
  if (act === 'paste') return !!(clip && clip.length);
  if (act === 'dist-h' || act === 'dist-v') return n >= 3;
  if (act === 'snap' || act === 'select-all') return true;
  return n > 0;
}

function updateArrangeBar(container) {
  container.querySelectorAll('#arrangeBar [data-act]').forEach((b) => {
    b.disabled = !actionEnabled(b.dataset.act);
    if (b.dataset.act === 'snap') {
      b.setAttribute('aria-pressed', state.snap ? 'true' : 'false');
      b.classList.toggle('on', state.snap);
    }
  });
}

function closeContextMenu() {
  document.querySelectorAll('.sl-ctx').forEach((n) => n.remove());
}

function onStageContextMenu(ev, container) {
  ev.preventDefault();
  if (editingText) return;
  closeContextMenu();
  const node = ev.target.closest('#stage > [data-ei]');
  if (node) {
    const i = Number(node.dataset.ei);
    if (!selection().includes(i)) select([i], i);
  } else {
    select([], -1);
  }
  paintSelection(container);
  const n = selection().length;
  const L = actionLabels();
  const groups = [['cut', 'copy', 'paste', 'duplicate', 'delete'], ['front', 'forward', 'backward', 'back']];
  if (n > 1) groups.push(['left', 'center', 'right', 'top', 'middle', 'bottom']);
  if (n > 2) groups.push(['dist-h', 'dist-v']);
  const menu = document.createElement('div');
  menu.className = 'sl-ctx';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = groups.map((g) => g.map((act) => `<button type="button" role="menuitem" data-act="${act}"
      ${actionEnabled(act) ? '' : 'disabled'}><span>${esc(L[act])}</span><kbd>${esc(SHORTCUTS[act] || '')}</kbd></button>`).join(''))
    .join('<hr>');
  document.body.appendChild(menu);
  const w = menu.offsetWidth; const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(ev.clientX, window.innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(ev.clientY, window.innerHeight - h - 4))}px`;
  menu.addEventListener('click', (c) => {
    const b = c.target.closest('[data-act]');
    if (!b || b.disabled) return;
    closeContextMenu();
    runAction(container, b.dataset.act);
  });
  const first = menu.querySelector('button:not([disabled])');
  if (first) first.focus();
}

/*
 * The keyboard, bound ONCE for the module and active only while an editor is mounted. It stands
 * aside whenever focus is in something that types — an input, the inspector, a text box being
 * edited on the canvas — so Ctrl+Z there is the field's own undo and Backspace deletes a letter,
 * not the element. Focus inside a dialog is outside the editor and is left alone too.
 */
let keysBound = false;
function bindEditorKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', (ev) => {
    const container = editorContainer;
    const stage = container && container.querySelector('#stage');
    if (!state.deck || !stage || !stage.isConnected) return;
    const target = ev.target;
    if (target && target !== document.body && !container.contains(target)) return;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    let act = null;
    if (mod && key === 'z') act = ev.shiftKey ? 'redo' : 'undo';
    else if (mod && key === 'y') act = 'redo';
    else if (mod && key === 'a') act = 'select-all';
    else if (mod && key === 'c') act = 'copy';
    else if (mod && key === 'x') act = 'cut';
    else if (mod && key === 'v') act = 'paste';
    else if (mod && key === 'd') act = 'duplicate';
    else if (mod && ev.code === 'BracketRight') act = ev.shiftKey ? 'front' : 'forward';
    else if (mod && ev.code === 'BracketLeft') act = ev.shiftKey ? 'back' : 'backward';
    else if (!mod && (key === 'Delete' || key === 'Backspace')) act = 'delete';
    if (act) {
      // With nothing to act on, the browser keeps the key (copying page text, say). Otherwise its
      // own meaning — Ctrl+D bookmarks, Ctrl+A selects the page — must not fire as well.
      if (!actionEnabled(act)) return;
      ev.preventDefault();
      runAction(container, act);
      return;
    }
    if (key === 'Escape') {
      closeContextMenu();
      if (selection().length) { select([], -1); paintSelection(container); }
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!mod && arrows[key] && selection().length) {
      ev.preventDefault();
      const step = ev.shiftKey ? 10 : 1;
      nudge(container, arrows[key][0] * step, arrows[key][1] * step);
    }
  });
  // A context menu closes on any press outside it, and when the page scrolls under it.
  document.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest || !ev.target.closest('.sl-ctx')) closeContextMenu();
  }, true);
  window.addEventListener('scroll', closeContextMenu, true);
}

/*
 * ⚠️ The same keyframes the SERVER emits (lib/slide-render.js). Kept in one <style> injected once
 * rather than per render: the editor previewing something different from what ships would make the
 * whole tool a liar, so if these ever diverge the preview is the thing that is wrong.
 */
function ensureKeyframes() {
  if (document.getElementById('stKeyframes')) return;
  const st = document.createElement('style');
  st.id = 'stKeyframes';
  st.textContent = `
    #stage.playing > div[data-anim] { animation-name:var(--kf); animation-duration:var(--dur);
      animation-delay:var(--delay); animation-fill-mode:both; animation-timing-function:ease-out; }
    #stage.playing > div[data-anim="fade"]   { --kf:st-fade }
    #stage.playing > div[data-anim="slideL"] { --kf:st-slide-l }
    #stage.playing > div[data-anim="slideR"] { --kf:st-slide-r }
    #stage.playing > div[data-anim="slideU"] { --kf:st-slide-u }
    #stage.playing > div[data-anim="slideD"] { --kf:st-slide-d }
    #stage.playing > div[data-anim="zoom"]   { --kf:st-zoom }
    #stage.playing > div[data-anim="wipe"]   { --kf:st-wipe }
    @keyframes st-fade    { from{opacity:0} to{opacity:1} }
    @keyframes st-slide-l { from{opacity:0;transform:translateX(-14%)} to{opacity:1;transform:none} }
    @keyframes st-slide-r { from{opacity:0;transform:translateX(14%)}  to{opacity:1;transform:none} }
    @keyframes st-slide-u { from{opacity:0;transform:translateY(26%)}  to{opacity:1;transform:none} }
    @keyframes st-slide-d { from{opacity:0;transform:translateY(-26%)} to{opacity:1;transform:none} }
    @keyframes st-zoom    { from{opacity:0;transform:scale(.86)}       to{opacity:1;transform:none} }
    @keyframes st-wipe    { from{clip-path:inset(0 100% 0 0)}          to{clip-path:inset(0 0 0 0)} }`;
  document.head.appendChild(st);
}

function play() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.classList.remove('playing');
  void stage.offsetWidth;                     // reflow, so the animation restarts
  stage.classList.add('playing');
}

function settleOf(s) {
  return elementsOf(s).reduce((m, e) =>
    (e.motion && e.motion.animation !== 'none' ? Math.max(m, e.motion.delay + e.motion.duration) : m), 0);
}

/* ============================================================ filmstrip */

function renderStrip(container) {
  const d = state.deck;
  container.querySelector('#strip').innerHTML = d.doc.slides.map((s, i) => `
    <button data-slide="${i}" style="flex:0 0 auto;width:124px;padding:0;cursor:pointer;text-align:left;
      border:1px solid ${i === state.si ? 'var(--primary)' : 'var(--border)'};border-radius:4px;overflow:hidden;background:var(--surface)">
      <div style="position:relative;aspect-ratio:${esc(aspectCss())};container-type:size;background:${esc(s.template.background || '#000')}">
        ${contentUrl(s.template.background_content_id) ? `<div style="position:absolute;inset:0;background-size:cover;background-position:center;background-image:url(${esc(contentUrl(s.template.background_content_id))})"></div>` : ''}
        ${(s.template.background_dim || 0) > 0 && (contentUrl(s.template.background_content_id) || s.template.background_video_content_id) ? `<div style="position:absolute;inset:0;background:rgba(0,0,0,${s.template.background_dim})"></div>` : ''}
        ${elementsOf(s).map((e) => `<div style="position:absolute;overflow:hidden;${esc(styleFor(e))}">${
          // A thumbnail shows what the slide shows: a clock reads as a clock, and a QR is a shape
          // rather than the raw URL behind it, which at 124px is unreadable noise either way.
          LIVE_KINDS.includes(e.kind) ? esc(liveText(e, Date.now()) || resolveInterpolatedText(s.fields[e.slot] || ''))
            : e.kind === 'qr' ? ''
            : TEXT_KINDS.includes(e.kind) ? esc(resolveInterpolatedText(s.fields[e.slot] || '')) : ''}</div>`).join('')}
      </div>
      <div style="display:flex;gap:6px;padding:4px 6px;border-top:1px solid var(--border)">
        <span style="flex:1;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span>
        <span style="font-size:10px;color:var(--text-muted)">${s.dwell_sec}s</span>
      </div>
    </button>`).join('')
    + `<button id="addSlide" style="flex:0 0 auto;width:124px;border:1px dashed var(--border);
        border-radius:4px;background:none;color:var(--text-muted);cursor:pointer;font-size:12px">+ Add slide</button>`;

  container.querySelectorAll('[data-slide]').forEach((b) => {
    b.addEventListener('click', () => {
      // Switching to a slide lands it SETTLED (no auto entrance) so elements are grabbable at once.
      state.si = +b.dataset.slide; state.ei = 0; state.sel = []; paintAll(container);
    });
    b.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      const idx = +b.dataset.slide;
      const targetSlide = state.deck.doc.slides[idx];
      if (!targetSlide) return;
      const newName = prompt(t('slides.prompt_rename_slide'), targetSlide.name);
      if (newName !== null && newName.trim()) {
        targetSlide.name = newName.trim();
        touch(container);
        paintAll(container);
      }
    });
  });
  container.querySelector('#addSlide').addEventListener('click', () => {
    state.deck.doc.slides.splice(state.si + 1, 0, newSlide(`Slide ${state.deck.doc.slides.length + 1}`));
    // A newly added slide lands settled too, not mid-entrance.
    state.si++; state.ei = 0; state.sel = []; touch(container);
  });
}

/* ============================================================ inspector */

function renderLayers(container) {
  const s = slide(); if (!s) return;
  const sel = selection();
  container.querySelector('#layers').innerHTML = elementsOf(s).map((e, i) => `
    <button data-el="${i}" style="display:flex;align-items:center;gap:7px;padding:6px 12px;width:100%;
      text-align:left;border:0;cursor:pointer;border-bottom:1px solid var(--border);
      background:${sel.includes(i) ? 'var(--bg-hover, rgba(127,127,127,.12))' : 'none'}">
      <span style="width:14px;text-align:center;color:var(--text-muted);font-size:12px">${KINDS[e.kind].icon}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px">
        ${esc(TEXT_KINDS.includes(e.kind) ? (s.fields[e.slot] || KINDS[e.kind].label) : KINDS[e.kind].label)}</span>
      <span style="font-size:10px;color:var(--text-muted);font-variant-numeric:tabular-nums">${
        !e.motion || e.motion.animation === 'none' ? '—' : `${e.motion.delay.toFixed(2)}+${e.motion.duration.toFixed(2)}`}</span>
    </button>`).join('');
  // The same element the canvas would pick: one selection, whichever of the two you click in.
  container.querySelectorAll('[data-el]').forEach((b) => b.addEventListener('click', (ev) => {
    const i = +b.dataset.el;
    const cur = selection();
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) select(cur.includes(i) ? cur.filter((k) => k !== i) : cur.concat(i), i);
    else select([i], i);
    paintSelection(container);
  }));
}

/*
 * The Content tab's two rows. The Style, Slide and Motion tabs build their own with the .sl-*
 * classes because they need slider/number pairs and grouping; this stays for the two plain fields
 * that do not.
 *
 * ⚠️ The `rng()` helper that used to live here is gone. It produced a slider with a static text
 * readout and every caller wired it to touch(), which repaints the panel and destroys the control
 * mid-drag — the bug that made Style and Motion unusable. Leaving it around would be leaving the
 * shape of that bug lying next to the code that replaced it.
 */
/*
 * Epoch milliseconds -> the value a <input type="datetime-local"> wants, in the AUTHOR's zone.
 *
 * ⚠️ NOT toISOString().slice(0,16). That is UTC, so an author in Chicago opening their own
 * countdown would see it five or six hours off and "correct" it — moving the target every time the
 * element was inspected. The offset has to be subtracted first.
 */
function localInput(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n - new Date(n).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

const row = (label, inner) =>
  `<div class="sl-row"><label>${label}</label>${inner}</div>`;

function renderProps(container) {
  const host = container.querySelector('#props');
  const s = slide(); if (!s) { host.innerHTML = ''; return; }

  if (state.tab === 'slide') {
    if (!s.template.audio || typeof s.template.audio !== 'object') s.template.audio = {};
    const voId = s.template.audio.vo || '';
    const voVol = s.template.audio.vo_volume == null ? 1 : s.template.audio.vo_volume;
    const bgId = s.template.background_content_id || '';
    const bgVid = s.template.background_video_content_id || '';
    const dim = s.template.background_dim == null ? 0 : s.template.background_dim;
    host.innerHTML =
      `<div class="sl-group"><p class="sl-legend">${esc(t('slides.tab_slide'))}</p>
         <div class="sl-row"><label for="sName">${esc(t('slides.slide.name'))}</label>
           <input class="input" id="sName" value="${esc(s.name)}"></div>
         <div class="sl-row"><label for="sDwell">${esc(t('slides.slide.dwell'))}</label>
           <div class="sl-slide"><input type="range" id="sDwell" min="1" max="60" step="1" value="${s.dwell_sec}">
             <input type="number" class="sl-num" id="sDwelln" min="1" max="60" step="1" value="${s.dwell_sec}"></div></div>
       </div>`
      + `<div class="sl-group"><p class="sl-legend">${esc(t('slides.slide.voiceover'))}</p>
           <div class="sl-row"><label for="sVo">${esc(t('slides.slide.track'))}</label>
             <select class="input" id="sVo"><option value="">${esc(t('slides.none_option'))}</option>${
               audioContent().map((c) => `<option value="${esc(c.id)}" ${
                 c.id === voId ? 'selected' : ''}>${esc(c.filename)}</option>`).join('')}</select></div>
           ${voId ? `<div class="sl-row"><label for="sVoVol">${esc(t('slides.slide.volume'))}</label>
             <div class="sl-slide"><input type="range" id="sVoVol" min="0" max="1" step="0.05" value="${voVol}">
               <input type="number" class="sl-num" id="sVoVoln" min="0" max="1" step="0.05" value="${voVol.toFixed(2)}"></div></div>
             <p class="sl-note">${esc(t('slides.slide.vo_note'))}</p>` : ''}
         </div>`
      + `<div class="sl-group"><p class="sl-legend">${esc(t('slides.slide.background'))}</p>
           <div class="sl-row"><label for="sBg">${esc(t('slides.slide.colour'))}</label>
             <input type="color" class="sl-colour" id="sBg" value="${esc(s.template.background || '#000000')}"></div>
           <div class="sl-row"><label for="sBgImg">${esc(t('slides.slide.photo'))}</label>
             <select class="input" id="sBgImg"><option value="">${esc(t('slides.none_option'))}</option>${
               imageContent().map((c) => `<option value="${esc(c.id)}" ${
                 c.id === bgId ? 'selected' : ''}>${esc(c.filename)}</option>`).join('')}</select></div>
           <div class="sl-row"><label for="sBgVid">${esc(t('slides.slide.video'))}</label>
             <select class="input" id="sBgVid"><option value="">${esc(t('slides.none_option'))}</option>${
               videoContent().map((c) => `<option value="${esc(c.id)}" ${
                 c.id === bgVid ? 'selected' : ''}>${esc(c.filename)}</option>`).join('')}</select></div>
           ${bgVid ? `<p class="sl-note">${esc(t('slides.slide.poster_note'))}</p>` : ''}
           ${(bgId || bgVid) ? `<div class="sl-row"><label for="sDim">${esc(t('slides.slide.dim'))}</label>
             <div class="sl-slide"><input type="range" id="sDim" min="0" max="0.9" step="0.05" value="${dim}">
               <input type="number" class="sl-num" id="sDimn" min="0" max="0.9" step="0.05" value="${dim.toFixed(2)}"></div></div>
             <p class="sl-note">${esc(t('slides.slide.dim_note'))}</p>` : ''}
           <p class="sl-note">${esc(t('slides.slide.colour_note'))}</p>
         </div>`
      + `<div class="sl-group"><button class="btn btn-secondary btn-sm" id="delSlide">${esc(t('slides.slide.delete'))}</button></div>`;

    host.querySelector('#sName').oninput = (e) => { s.name = e.target.value; touchValue(container); };
    host.querySelector('#sBg').oninput = (e) => { s.template.background = e.target.value; touchValue(container); };
    // Changing the photo shows or hides the Dim row, so this one genuinely rebuilds the panel.
    // Rebuilds the panel, because choosing a track reveals the volume row.
    host.querySelector('#sVo').onchange = (e) => {
      s.template.audio.vo = e.target.value || null;
      if (!e.target.value) delete s.template.audio.vo_volume;
      else if (s.template.audio.vo_volume == null) s.template.audio.vo_volume = 1;
      state.dirty = true; paintAll(container);
    };
    host.querySelector('#sBgImg').onchange = (e) => {
      s.template.background_content_id = e.target.value || null;
      if (!e.target.value && !s.template.background_video_content_id) delete s.template.background_dim;
      else if (s.template.background_dim == null) s.template.background_dim = 0.35;
      state.dirty = true; paintAll(container);
    };
    host.querySelector('#sBgVid').onchange = (e) => {
      s.template.background_video_content_id = e.target.value || null;
      if (!e.target.value && !s.template.background_content_id) delete s.template.background_dim;
      else if (s.template.background_dim == null) s.template.background_dim = 0.35;
      state.dirty = true; paintAll(container);
    };
    const bindSlidePair = (id, set, dec) => {
      const r = host.querySelector(`#${id}`); const n = host.querySelector(`#${id}n`);
      if (!r || !n) return;
      const apply = (v, from) => {
        const num = Number(v); if (!Number.isFinite(num)) return;
        set(num);
        if (from !== 'range') r.value = num;
        if (from !== 'num') n.value = num.toFixed(dec);
        touchValue(container);
      };
      r.oninput = (ev) => apply(ev.target.value, 'range');
      n.onchange = (ev) => apply(ev.target.value, 'num');
    };
    bindSlidePair('sVoVol', (v) => { s.template.audio.vo_volume = v; }, 2);
    bindSlidePair('sDwell', (v) => { s.dwell_sec = Math.round(v); }, 0);
    bindSlidePair('sDim', (v) => { s.template.background_dim = v; }, 2);
    host.querySelector('#delSlide').onclick = () => {
      if (state.deck.doc.slides.length === 1) { showToast(t('slides.slide.last_one'), 'error'); return; }
      state.deck.doc.slides.splice(state.si, 1);
      state.si = Math.max(0, state.si - 1); state.ei = 0; state.sel = []; touch(container);
    };
    return;
  }

  const e = elementsOf(s)[state.ei];
  if (!e) {
    host.innerHTML = `<p style="font-size:12px;color:var(--text-muted)">${esc(elementsOf(s).length
      ? t('slides.edit.nothing_selected') : t('slides.edit.add_hint'))}</p>`;
    return;
  }
  const isText = TEXT_KINDS.includes(e.kind);

  if (state.tab === 'content') {
    host.innerHTML =
      (e.kind === 'qr'
        ? row(esc(t('slides.qr.tracked_link')), `<select class="input" id="pQrLink"><option value="">${esc(t('slides.qr.not_tracked'))}</option>${(qrLinksCache || []).map((l) =>
              `<option value="${esc(l.id)}" ${s.fields[e.slot] === qrShortUrl(l) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`)
          + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">${esc(t('slides.qr.tracked_help'))}</p>`
          + row(esc(t('slides.qr.encodes')), `<textarea class="input" id="pText" rows="2" style="resize:vertical">${esc(s.fields[e.slot] || '')}</textarea>`)
          + `<p id="pQrPrivate" style="font-size:11.5px;color:#ca8a04;grid-column:1/-1;margin:0" hidden></p>`
          + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">${esc(t('slides.qr.encodes_help'))}</p>`
          + row(esc(t('slides.qr.error_correction')), `<select class="input" id="pQrEc">${QR_LEVELS.map(([v, lbl]) =>
              `<option value="${v}" ${(e.qr_ec || 'M') === v ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}</select>`)
          + row(esc(t('slides.qr.modules')), `<input type="color" class="input" id="pQrFg" value="${esc(e.qr_fg || '#000000')}">`)
          + row(esc(t('slides.qr.code_background')), `<input type="color" class="input" id="pQrBg" value="${esc(e.qr_bg || '#FFFFFF')}">`)
          + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">${esc(t('slides.qr.contrast_help'))}</p>`
        : e.kind === 'clock'
        ? row('Format', `<select class="input" id="pFmt">${CLOCK_FORMATS.map(([v, lbl]) =>
              `<option value="${v}" ${(e.clock_format || '24') === v ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}</select>`)
          + row('Time zone', `<input class="input" id="pTz" placeholder="the panel's own" value="${esc(e.tz || '')}">`)
          + row('Language', `<input class="input" id="pLoc" placeholder="the panel's own" value="${esc(e.locale || '')}">`)
          + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">
               Leave both blank to follow the screen. A zone is an IANA name — Europe/London,
               America/Chicago — which is how you run a lobby clock for another office.</p>`
        : e.kind === 'date'
        ? row('Format', `<select class="input" id="pFmt">${DATE_FORMATS.map(([v, lbl]) =>
              `<option value="${v}" ${(e.date_format || 'long') === v ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}</select>`)
          + row('Time zone', `<input class="input" id="pTz" placeholder="the panel's own" value="${esc(e.tz || '')}">`)
          + row('Language', `<input class="input" id="pLoc" placeholder="the panel's own" value="${esc(e.locale || '')}">`)
        : e.kind === 'countdown'
        ? row('Counts down to', `<input type="datetime-local" class="input" id="pTarget" value="${esc(localInput(e.target))}">`)
          + row('Language', `<input class="input" id="pLoc" placeholder="${e.locale == null ? 'English (3d 4h 5m)' : "the panel's own"}" value="${esc(e.locale || '')}">`)
          + row('Then shows', `<textarea class="input" id="pText" rows="2" style="resize:vertical">${esc(s.fields[e.slot] || '')}</textarea>`)
          + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">
               The message replaces the counter once the moment passes, so the slide keeps working
               without anybody editing it that morning.</p>`
        : e.kind === 'lettering'
        ? row('Words', `<textarea class="input" id="pText" rows="2" style="resize:vertical">${esc(s.fields[e.slot] || '')}</textarea>`)
          + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">
               These words are the record — they stay editable, are read out to screen readers, and
               are what a regenerate is asked for. <strong>The picture will not change until you
               generate it again.</strong> Check the artwork actually spells them.</p>`
        : isText
        /*
         * ⚠️ ONE grid cell. .sl-row is a two-column grid (label | control), so a picker placed as a
         * second child dropped into the 56px label column of the next row ("⚡ Ins▾").
         *
         * And the keys are the ones each source ACTUALLY has, read from its last sync — the same
         * list the Data Sources page shows. A fixed calendar list offered status / next_title for
         * a Sheet or a Weather source, which have no such keys, and the tag then showed nothing.
         */
        ? row(esc(t('slides.text')), `<div style="min-width:0">
            <textarea class="input" id="pText" rows="3" style="resize:vertical;width:100%">${esc(s.fields[e.slot] || '')}</textarea>
            ${DATA_SOURCES_LIST && DATA_SOURCES_LIST.length > 0 ? `
              <select class="input" id="pDsVarPicker" style="font-size:11px;padding:3px 6px;margin:6px 0 0;width:100%">
                <option value="">${esc(t('slides.insert_var'))}</option>
                ${DATA_SOURCES_LIST.map((ds) => {
                  const keys = dataSourceKeys(ds);
                  return `<optgroup label="${esc(ds.name)} (${esc(ds.slug)})">${keys.length
                    ? keys.map((k) => `<option value="${esc(`{{ds:${ds.slug}.${k}}}`)}">${esc(k)}</option>`).join('')
                    : `<option value="" disabled>${esc(t('slides.ds_no_data'))}</option>`}</optgroup>`;
                }).join('')}
              </select>
            ` : ''}</div>`)
        : e.kind === 'image'
          ? row('Photo', `<select class="input" id="pImg"><option value="">— none —</option>${
              imageContent().map((c) => `<option value="${esc(c.id)}" ${
                c.id === e.content_id ? 'selected' : ''}>${esc(c.filename)}</option>`).join('')}</select>`)
            + row('Fit', `<select class="input" id="pFit">
                 <option value="cover" ${(e.fit || 'cover') === 'cover' ? 'selected' : ''}>Fill the box (crop)</option>
                 <option value="contain" ${e.fit === 'contain' ? 'selected' : ''}>Fit inside (whole image)</option>
               </select>`)
            + `<p style="font-size:11.5px;color:var(--text-muted);grid-column:1/-1;margin:0">
                 Pick from the content library — the slide stores a reference, not a copy.
                 Use <strong>Fit inside</strong> for a cut-out with transparency — filling the box
                 crops it, which slices through the object itself.</p>`
          : `<p style="font-size:12px;color:var(--text-muted)">Decorative — no text.</p>`)
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
           <button class="btn btn-secondary btn-sm" id="pFwd">↑ Forward</button>
           <button class="btn btn-secondary btn-sm" id="pDel">Delete</button></div>`;
    if (host.querySelector('#pText')) {
      host.querySelector('#pText').oninput = (ev) => {
        /*
         * ⚠️ One string, into fields. The template is not touched — that is the whole design.
         *
         * ⚠️ AND touchValue, NOT touch. This fired on every keystroke and called the full repaint,
         * which rewrites the panel's innerHTML — so the textarea was destroyed and recreated after
         * each character and the caret went with it. Typing a headline was impossible past the
         * first letter. Same defect as the Style and Motion sliders, in the one control where it is
         * most obvious and was somehow the last to be found; a source guard caught it, not use.
         */
        s.fields[e.slot] = ev.target.value; touchValue(container);
      };
    }
    const dsPicker = host.querySelector('#pDsVarPicker');
    if (dsPicker) {
      dsPicker.onchange = (ev) => {
        const val = ev.target.value;
        if (!val) return;
        const textEl = host.querySelector('#pText');
        if (textEl) {
          const start = textEl.selectionStart ?? textEl.value.length;   // 0 is a caret, not "none"
          const end = textEl.selectionEnd ?? textEl.value.length;
          const old = textEl.value;
          textEl.value = old.substring(0, start) + val + old.substring(end);
          s.fields[e.slot] = textEl.value;
          touchValue(container);
          ev.target.value = '';
        }
      };
    }
    /*
     * ⚠️ touchValue, NOT touch, for every one of these — the same rule the Text box above states.
     * touch() rewrites the panel's innerHTML, which destroys the control being used; on a <select>
     * that closes the dropdown mid-choice, and on the zone box it eats the caret after one letter.
     */
    const bindCfg = (id, apply) => {
      const el = host.querySelector(id);
      if (el) el.onchange = (ev) => { apply(ev.target.value); touchValue(container); };
      return el;
    };
    bindCfg('#pQrEc', (v) => { e.qr_ec = v; });
    // A tracked link fills the encoded text with its short address (views/qr-codes.js).
    /*
     * A code that holds a private address (the dashboard was open at localhost, a LAN IP or a .local
     * name when the link was picked, or one was typed) scans to nothing on a visitor's phone. Same
     * rule as the QR codes page (components/private-host.js).
     */
    const qrWarn = host.querySelector('#pQrPrivate');
    const paintQrWarn = () => {
      if (!qrWarn) return;
      const h = urlHost(s.fields[e.slot]);
      qrWarn.hidden = !(h && isPrivateHost(h));
      qrWarn.textContent = qrWarn.hidden ? '' : t('slides.qr.private_address', { host: h });
    };
    paintQrWarn();
    if (qrWarn) host.querySelector('#pText').addEventListener('input', paintQrWarn);
    const qrLinkSel = host.querySelector('#pQrLink');
    if (qrLinkSel) qrLinkSel.onchange = () => {
      const links = qrLinksCache || [];
      const l = links.find((x) => x.id === qrLinkSel.value);
      if (l) {
        s.fields[e.slot] = qrShortUrl(l);
      } else {
        /*
         * "Not tracked": the code goes back to the link's own destination, so it still opens the
         * same page but no longer counts scans. Matched on the path, so a short address picked at
         * another dashboard address (LAN vs public) is recognised too. Text that is not a short
         * address is left alone — there is nothing to untrack.
         */
        let path = '';
        try { path = new URL(String(s.fields[e.slot] || '')).pathname; } catch (_) { path = ''; }
        const was = path && links.find((x) => x.path === path);
        if (!was) return;
        s.fields[e.slot] = was.target_url || '';
      }
      const textEl = host.querySelector('#pText');
      if (textEl) textEl.value = s.fields[e.slot];
      paintQrWarn();
      touchValue(container);
    };
    if (e.kind === 'qr' && qrLinksCache === null) {
      qrLinksCache = [];
      api.get('/qr-links').then((rows) => { qrLinksCache = Array.isArray(rows) ? rows : []; if (qrLinksCache.length) renderProps(container); }).catch(() => {});
    }
    bindCfg('#pFit', (v) => { e.fit = v; });
    bindCfg('#pQrFg', (v) => { e.qr_fg = v; });
    bindCfg('#pQrBg', (v) => { e.qr_bg = v; });
    bindCfg('#pFmt', (v) => { if (e.kind === 'clock') e.clock_format = v; else e.date_format = v; });
    bindCfg('#pTz', (v) => { e.tz = v.trim(); });
    bindCfg('#pLoc', (v) => { e.locale = v.trim(); });
    bindCfg('#pTarget', (v) => {
      /*
       * ⚠️ STORED AS EPOCH MILLISECONDS. A datetime-local input yields a string with no zone, so
       * keeping it verbatim would mean the countdown resolved against whatever zone the PANEL is
       * in — the same poster ending at different moments in two buildings. Date.parse of a
       * zoneless string uses the AUTHOR's zone here, which is the one they meant.
       */
      const ms = Date.parse(v);
      e.target = Number.isFinite(ms) ? ms : null;
    });
    if (host.querySelector('#pImg')) {
      // A select is not a control you are mid-drag on, and swapping the photo changes nothing else
      // in this panel — but there is no reason to rebuild it either.
      host.querySelector('#pImg').onchange = (ev) => { e.content_id = ev.target.value || null; touchValue(container); };
    }
    host.querySelector('#pFwd').onclick = () => applyOrder(container, 'forward');
    host.querySelector('#pDel').onclick = () => deleteSelection(container);
    return;
  }

  if (state.tab === 'style') {
    const st = e.style;
    const grp = (legend, inner) => `<div class="sl-group"><p class="sl-legend">${legend}</p>${inner}</div>`;
    /*
     * ⚠️ A SLIDER *AND* A NUMBER BOX FOR EVERY VALUE. Dragging is for finding a look; typing is for
     * matching one. A 290px panel gives a slider about 120px of travel, so "x = 64%" is roughly the
     * best you can do by dragging — which is fine until two slides need the same margin and you
     * cannot say so.
     */
    const pair = (label, id, min, max, step, v, unit) => `
      <div class="sl-row"><label for="${id}">${label}</label>
        <div class="sl-slide">
          <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}">
          <input type="number" class="sl-num" id="${id}n" min="${min}" max="${max}" step="${step}"
                 value="${(+v).toFixed(step < 1 ? 2 : 0)}" aria-label="${label}${unit ? ' in ' + unit : ''}">
        </div></div>`;

    host.innerHTML =
      grp('Position &amp; size',
        pair('X', 'pX', -20, 110, 1, e.box.x, '%')
        + pair('Y', 'pY', -20, 110, 1, e.box.y, '%')
        + pair('Width', 'pW', 1, 120, 1, e.box.w, '%')
        + (e.box.h != null ? pair('Height', 'pH', 0.2, 110, 0.2, e.box.h, '%') : ''))

      + (GLYPH_KINDS.includes(e.kind) ? grp('Type',
          `<div class="sl-row"><label for="pFont">Font</label>
             <select class="input" id="pFont">${FONT_CATALOGUE.map((f) =>
               `<option value="${esc(f.id)}" ${f.id === resolveFont(st.font) ? 'selected' : ''}>${
                 esc(f.label)} — ${esc(f.role)}</option>`).join('')}</select></div>`
          + `<p class="sl-note">${esc((FONT_CATALOGUE.find((f) => f.id === resolveFont(st.font)) || {}).note || '')}
               <button class="sl-link" id="pUpFont">Upload a font…</button>
               <input type="file" id="pFontFile" accept=".woff2,.woff,.ttf,.otf,font/*" hidden>
               <span id="pFontMsg"></span></p>`
          + pair('Size', 'pSize', 0.5, 30, 0.2, st.size_cqw, '')
          + (isUploadedFont(st.font)
              // ⚠️ Hidden rather than shown-and-ignored: an uploaded face ships at one weight, so
              // offering 400–800 would be a control that silently does nothing.
              ? '<p class="sl-note">An uploaded font has one weight. Upload the bold separately to use both.</p>'
              : `<div class="sl-row"><label>Weight</label><div class="sl-seg">${
                  [400, 600, 700, 800].map((w) =>
                    `<button data-w="${w}" aria-pressed="${w === st.weight}">${w}</button>`).join('')}</div></div>`)
          + `<div class="sl-row"><label>Align</label><div class="sl-seg">${
              ['left', 'center', 'right'].map((a) =>
                `<button data-a="${a}" aria-pressed="${a === st.align}">${a[0].toUpperCase()}${a.slice(1)}</button>`).join('')}</div></div>`)
        : '')

      + grp('Appearance',
        `<div class="sl-row"><label for="pColor">Colour</label>
           <input type="color" class="sl-colour" id="pColor" value="${esc(st.color)}"></div>`
        + ((e.kind === 'image' || e.kind === 'box') ? pair('Corner', 'pRad', 0, 12, 0.2, st.radius_cqw || 0, '') : '')
        + pair('Opacity', 'pOp', 0.1, 1, 0.05, st.opacity == null ? 1 : st.opacity, ''))

      + `<p class="sl-note" style="margin-top:9px">Sizes are relative to the screen, so a slide looks
           the same on a 720p panel and a 4K one.</p>`;

    /*
     * ⚠️ touchValue, NEVER touch — and the two inputs update EACH OTHER rather than re-rendering.
     * Rebuilding this panel on input destroys the control under the pointer, which is what made
     * every slider here move exactly one step and stop.
     */
    const bindPair = (id, set, decimals) => {
      const r = host.querySelector(`#${id}`);
      const n = host.querySelector(`#${id}n`);
      if (!r || !n) return;
      const apply = (v, from) => {
        const num = Number(v);
        if (!Number.isFinite(num)) return;
        set(num);
        if (from !== 'range') r.value = num;
        if (from !== 'num') n.value = num.toFixed(decimals);
        touchValue(container);
      };
      r.oninput = (ev) => apply(ev.target.value, 'range');
      // `change`, not `input`: on `input` a half-typed "-" or "1." reads as 0 and yanks the element
      // across the stage while somebody is still typing.
      n.onchange = (ev) => apply(ev.target.value, 'num');
    };
    bindPair('pX', (v) => { e.box.x = v; }, 0);
    bindPair('pY', (v) => { e.box.y = v; }, 0);
    bindPair('pW', (v) => { e.box.w = v; }, 0);
    bindPair('pH', (v) => { e.box.h = v; }, 1);
    bindPair('pSize', (v) => { st.size_cqw = v; }, 1);
    bindPair('pRad', (v) => { st.radius_cqw = v; }, 1);
    bindPair('pOp', (v) => { st.opacity = v; }, 2);

    host.querySelector('#pColor').oninput = (ev) => { st.color = ev.target.value; touchValue(container); };

    const pFont = host.querySelector('#pFont');
    // The font note and the weight control both depend on which font is chosen, so this one DOES
    // rebuild the panel — a select is not a control you are mid-drag on.
    if (pFont) pFont.onchange = (ev) => { st.font = ev.target.value; state.dirty = true; paintAll(container); };

    host.querySelectorAll('[data-w]').forEach((b) => b.onclick = () => {
      st.weight = +b.dataset.w;
      host.querySelectorAll('[data-w]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      touchValue(container);
    });
    host.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
      st.align = b.dataset.a;
      host.querySelectorAll('[data-a]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      touchValue(container);
    });

    const upBtn = host.querySelector('#pUpFont');
    if (upBtn) {
      const file = host.querySelector('#pFontFile');
      const msg = host.querySelector('#pFontMsg');
      upBtn.onclick = () => file.click();
      file.onchange = async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        msg.style.color = 'var(--text-muted)';
        msg.textContent = ' Uploading…';
        try {
          const fd = new FormData();
          fd.append('font', f);
          fd.append('name', f.name.replace(/\.[a-z0-9]+$/i, ''));
          /*
           * ⚠️ Asked at the point of upload, not buried in settings. This server redistributes the
           * file to every screen showing a slide in it, so "where did this come from" needs an
           * answer somebody can give later.
           */
          const note = prompt(                               // eslint-disable-line no-alert
            'Where is this font licensed from?\n\nEvery screen showing a slide in it downloads the '
            + 'file from this server, so it helps to record what you are allowed to do with it.', '') || '';
          fd.append('licence_note', note.slice(0, 300));
          const added = await api.postForm('/fonts', fd);
          FONT_CATALOGUE = FONT_CATALOGUE.concat([added]);
          document.getElementById('stSlideFonts')?.remove();  // rebuild with the new face in it
          ensureFontFaces();
          st.font = added.id;
          touch(container);
          showToast(`Added ${added.label}`, 'success');
        } catch (err) {
          msg.style.color = 'var(--danger)';
          msg.textContent = ` ${err.message || 'Could not upload that font'}`;
        }
      };
    }
    return;
  }

  // ---------------------------------------------------------------- motion
  const m = e.motion || { animation: 'none', delay: 0, duration: 0.5, easing: 'ease-out' };
  const grpM = (legend, inner) => `<div class="sl-group"><p class="sl-legend">${legend}</p>${inner}</div>`;
  const pairM = (label, id, min, max, step, v, dec) => `
    <div class="sl-row"><label for="${id}">${label}</label>
      <div class="sl-slide">
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}">
        <input type="number" class="sl-num" id="${id}n" min="${min}" max="${max}" step="${step}"
               value="${(+v).toFixed(dec)}">
      </div></div>`;

  const none = m.animation === 'none' || !e.motion;

  host.innerHTML =
    grpM('Entrance',
      `<div class="sl-row"><label for="mAnim">Effect</label>
         <select class="input" id="mAnim">${Object.entries(ANIMS).map(([k, v]) =>
           `<option value="${k}" ${k === m.animation ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`
      + (none
        ? '<p class="sl-note">This element is simply there from the first frame.</p>'
        : pairM('Delay', 'mDelay', 0, 10, 0.05, m.delay, 2)
          + pairM('Duration', 'mDur', 0.1, 5, 0.05, m.duration, 2)
          + `<div class="sl-row"><label for="mEase">Easing</label>
               <select class="input" id="mEase">${Object.entries(EASES).map(([k, v]) =>
                 `<option value="${k}" ${k === m.easing ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`))
    + grpM('Timing', `<div id="mTimeline"></div>`);

  renderMiniTimeline(container);

  host.querySelector('#mAnim').onchange = (ev) => {
    // Structural for this panel: choosing "None" removes the delay, duration and easing rows.
    e.motion = ev.target.value === 'none' ? null : { ...m, animation: ev.target.value };
    state.dirty = true; paintAll(container); play();
  };

  /*
   * ⚠️ touchValue, and the timeline redrawn by hand — NOT a panel rebuild.
   *
   * This tab had exactly the bug the Style tab had: every slider called touch(), which repaints the
   * props panel and replaces the innerHTML of the control being dragged. The slider died on its
   * first input event, so delay and duration each moved one step and stopped.
   *
   * Only the timeline needs redrawing as a value changes, and it is a separate element, so it can
   * be replaced without touching the inputs.
   */
  const bindMotion = (id, key, dec) => {
    const r = host.querySelector(`#${id}`);
    const n = host.querySelector(`#${id}n`);
    if (!r || !n) return;
    const apply = (v, from) => {
      const num = Number(v);
      if (!Number.isFinite(num)) return;
      if (!e.motion) e.motion = { ...m };
      e.motion[key] = num;
      if (from !== 'range') r.value = num;
      if (from !== 'num') n.value = num.toFixed(dec);
      touchValue(container);
      renderMiniTimeline(container);
    };
    r.oninput = (ev) => apply(ev.target.value, 'range');
    n.onchange = (ev) => apply(ev.target.value, 'num');
    // ⚠️ `change` fires on RELEASE, so the entrance replays once you have finished choosing rather
    // than restarting on every pixel of the drag.
    r.onchange = () => play();
  };
  bindMotion('mDelay', 'delay', 2);
  bindMotion('mDur', 'duration', 2);

  const mEase = host.querySelector('#mEase');
  if (mEase) mEase.onchange = (ev) => {
    if (!e.motion) e.motion = { ...m };
    e.motion.easing = ev.target.value;
    touchValue(container); play();
  };
}

/*
 * Where this element's entrance sits against the slide's dwell, with the others behind it.
 *
 * ⚠️ THE ONE THING A MOTION PANEL HAS TO SHOW. Delay and duration are meaningless in isolation: a
 * 0.8s delay is fine on a ten-second slide and is most of a two-second one, and an element that
 * settles after the slide is replaced reads on a wall as text that never arrives. The numbers alone
 * cannot tell you that; the picture can.
 *
 * The other elements are drawn too, because motion is choreography — you are choosing when THIS
 * element lands relative to the ones around it, not in a vacuum.
 */
function renderMiniTimeline(container) {
  const host = container.querySelector('#mTimeline');
  const s = slide();
  if (!host || !s) return;

  const els = elementsOf(s);
  const endOf = (x) => (x.motion && x.motion.animation !== 'none'
    ? x.motion.delay + x.motion.duration : 0);
  const settle = els.reduce((mx, x) => Math.max(mx, endOf(x)), 0);
  const span = Math.max(s.dwell_sec, settle) * 1.02 || 1;
  const dwellPct = (s.dwell_sec / span) * 100;

  const rows = els.map((x, i) => {
    const sel = i === state.ei;
    const anim = x.motion && x.motion.animation !== 'none';
    const left = anim ? (x.motion.delay / span) * 100 : 0;
    const width = anim ? Math.max((x.motion.duration / span) * 100, 1) : 100;
    const over = anim && endOf(x) > s.dwell_sec + 0.001;
    const bg = !anim ? 'var(--border)' : over ? 'var(--danger)' : (sel ? 'var(--primary)' : 'var(--text-muted)');
    return `<div style="position:relative;height:${sel ? 11 : 7}px;margin-bottom:3px;
              background:var(--bg-hover,rgba(127,127,127,.14));border-radius:2px">
        <div style="position:absolute;top:0;bottom:0;left:${left}%;width:${width}%;
             background:${bg};border-radius:2px;opacity:${anim ? (sel ? 1 : .55) : .35}"></div>
        ${dwellPct < 99.5 ? `<div style="position:absolute;top:-2px;bottom:-2px;left:${dwellPct}%;
             width:2px;background:var(--danger)"></div>` : ''}
      </div>`;
  }).join('');

  const mine = els[state.ei];
  const mineEnd = mine ? endOf(mine) : 0;
  const overruns = els.filter((x) => endOf(x) > s.dwell_sec + 0.001).length;

  host.innerHTML = rows + `<p class="sl-note" style="margin-top:6px">${
    mine && mine.motion && mine.motion.animation !== 'none'
      ? `This element lands at <strong>${mineEnd.toFixed(2)}s</strong>. `
      : 'This element is present from the start. '}
    The slide is replaced at <strong>${s.dwell_sec}s</strong>${
      settle > 0 ? `, everything settled by <strong>${settle.toFixed(2)}s</strong>` : ''}.${
      overruns ? ` <span style="color:var(--danger)">${overruns} never finish${
        overruns > 1 ? '' : 'es'} — raise the dwell on the Slide tab.</span>` : ''}</p>`;
}


/* ============================================================ status, save, publish */

function renderStatus(container) {
  const d = state.deck;
  const total = d.doc.slides.reduce((a, s) => a + s.dwell_sec, 0);
  container.querySelector('#deckStatus').textContent =
    `${d.doc.slides.length} slide${d.doc.slides.length === 1 ? '' : 's'} · ${total}s total`
    + (state.dirty ? ' · unsaved changes' : '');

  // Warnings are computed locally so they track the edit, and re-checked by the server on save.
  const warn = d.doc.slides
    .map((s) => ({ s, settle: settleOf(s) }))
    .filter((x) => x.settle > x.s.dwell_sec);
  container.querySelector('#warnBox').innerHTML = warn.length ? `
    <div class="settings-section" style="border-left:3px solid var(--danger);margin-bottom:12px;padding:10px 13px">
      <strong style="font-size:13px">Some motion never finishes</strong>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--text-muted)">
        ${warn.map((x) => `<li>“${esc(x.s.name)}” settles at ${x.settle.toFixed(2)}s but is replaced at
           ${x.s.dwell_sec}s — on a screen that reads as text that never arrives.</li>`).join('')}
      </ul></div>` : '';
}

async function save(container) {
  if (state.saving) return;
  state.saving = true;
  try {
    const d = state.deck;
    const sent = snapshot();
    const fresh = await api.put(`/slide-decks/${d.id}`, { name: d.name, doc: d.doc });
    /*
     * ⚠️ EDITED WHILE THE SAVE WAS IN FLIGHT — or mid-drag when it landed: keep the editor's own
     * document. Swapping in the server's copy here would throw the newer edit away, and a drag in
     * progress would go on moving an element that is no longer in the deck.
     */
    if (snapshot() !== sent || gesture) {
      state.deck = { ...fresh, name: d.name, doc: d.doc };
      renderStatus(container);
      showToast('Saved', 'success');
      return;
    }
    state.deck = fresh; state.dirty = false;
    // What the server stored is now the current state, not an edit to undo.
    undoHistory.rebase(snapshot());
    paintAll(container);
    showToast('Saved', 'success');
  } catch (e) {
    showToast(e.message || 'Could not save', 'error');
  } finally { state.saving = false; }
}

async function publish(container) {
  if (state.dirty) await save(container);
  // 3.0 accessibility: list errors/warnings first, with "Publish anyway".
  if (!(await confirmAccessibility('slide_deck', state.deck.id))) return;
  try {
    const out = await api.post(`/slide-decks/${state.deck.id}/publish`, {});
    state.deck = out;
    undoHistory.rebase(snapshot());
    paintAll(container);
    const n = out.published ? out.published.slides : state.deck.doc.slides.length;
    // ⚠️ Says what actually happened, including that it is now a playlist — an operator who does not
    // know that has no idea where to go to put these on a screen.
    showToast(`Published ${n} slide${n === 1 ? '' : 's'} to a playlist`, 'success');
  } catch (e) {
    showToast(e.message || 'Could not publish', 'error');
  }
}

/*
 * Generate the CURRENT slide from a sentence.
 *
 * ⚠️ IT REPLACES THE SLIDE, AND SAYS SO BEFORE IT DOES. The server returns a whole {template,
 * fields} pair — layout and words together — so applying it discards whatever was there. Ctrl+Z
 * now brings the old slide back, but the confirmation stays: an operator who does not know that
 * should still not lose a good hand-built slide to a mediocre generated one without being asked. An EMPTY slide (one default
 * element, no words typed) is not worth asking about, so it is replaced without ceremony.
 *
 * ⚠️ THE DECK IS NOT SAVED HERE. The result lands as an unsaved edit like any other, so an operator
 * who dislikes it can navigate away and lose nothing. Generating straight into a save would make
 * the model's output authoritative before anyone had looked at it.
 */
let aiBusy = false;
let aiBgBusy = false;   // an image generation costs money per click; never let two run
let aiLayerBusy = false; // and this one is up to FIVE generations per click
/*
 * The hosted-images picker for the open editor, or null (hosted AI off / not loaded yet). Only the
 * single-image background uses it: layered generation is several images plus a text-model plan,
 * and stays on the workspace's own endpoints in this version.
 */
let hostedCtl = null;

/*
 * Generate a background PICTURE for the slide you are on.
 *
 * ⚠️ SEPARATE FROM aiGenerate ON PURPOSE. That one replaces the whole slide — layout, words,
 * colours — and is destructive enough to confirm first. This only sets a background behind whatever
 * is already there, so it needs no confirmation and must never touch the elements: the common case
 * is "I like this slide, give it a photo".
 */
async function aiGenerateBackground(container) {
  const promptEl = container.querySelector('#aiPrompt');
  const statusEl = container.querySelector('#aiStatus');
  const btn = container.querySelector('#aiBgBtn');
  const prompt = (promptEl.value || '').trim();
  const say = (msg, bad) => {
    statusEl.textContent = msg;
    statusEl.style.color = bad ? 'var(--danger, #e05252)' : 'var(--text-muted)';
  };
  if (!prompt) { say('Describe the background first.', true); promptEl.focus(); return; }
  if (aiBgBusy) return;                    // single-flight: an image costs money per call
  if (!state.deck.doc.slides.length) { say('Add a slide first.', true); return; }

  /*
   * ⚠️ REMEMBER WHICH SLIDE THIS WAS FOR. Generation takes tens of seconds and the operator can
   * click another slide meanwhile; applying to state.si on return would drop the picture onto
   * whatever they happen to be looking at. Resolved by identity afterwards, the same way
   * aiGenerate relocates its target.
   */
  const target = state.deck.doc.slides[state.si];

  aiBgBusy = true;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Generating…';
  say('Generating a background — this can take a minute.');
  try {
    /*
     * ⚠️ ASK FOR THE DECK'S SHAPE, not a fixed 16:9. A portrait deck given a landscape background
     * crops to a centre band, which is exactly the complaint that made xAI's aspect_ratio matter
     * in the first place — repeating it locally would be worse, because here we know the answer.
     */
    let out;
    if (hostedCtl && hostedCtl.isHosted()) {
      // Confirms the exact cost first; null = the user declined or was sent to buy credits.
      out = await hostedCtl.generate(prompt, aspectPixels());
      if (!out) { say(''); return; }
    } else {
      out = await api.aiGenerateBackground(prompt, aspectPixels());
    }
    if (!out || !out.content_id) throw new Error('no image came back');
    const idx = state.deck.doc.slides.indexOf(target);
    if (idx < 0) { say('That slide is gone — nothing changed.', true); return; }
    target.template = target.template || {};
    target.template.background_content_id = out.content_id;
    /*
     * ⚠️ REFRESH THE CONTENT INDEX, or the picture is invisible. contentUrl() resolves an id
     * against state.contentIndex — a list cached when the editor opened — so a file created a
     * moment ago is not in it and the lookup returns null. The slide would carry a correct
     * background_content_id, save it, publish it, and show a blank stage the whole time: right
     * data, and an editor that cannot see it. The dropdowns in the Slide tab read the same list,
     * so they would not offer it either.
     */
    await loadContent();
    /*
     * A readable default scrim. Text sits over this, and a photo at full brightness behind pale
     * type is the single most common way a generated background makes a slide unreadable — the
     * operator can take it back to 0 in the Slide tab if they want the picture untouched.
     */
    if (!(target.template.background_dim > 0)) target.template.background_dim = 0.35;
    touch(container);
    /*
     * ⚠️ paintAll, NOT render(). render() is this MODULE'S VIEW ENTRY POINT — it replaces
     * container.innerHTML with the deck LIST. Calling it here set the background on the model,
     * marked the deck dirty, then destroyed the editor and threw the unsaved change away: the
     * operator saw "it generated something but nothing happened to my slide", and the Generate
     * button they clicked next belonged to a view that no longer existed. One wrong function name,
     * two symptoms, and the half-committed state made it look like two separate bugs.
     */
    paintAll(container);
    say(out.credits_spent ? `Background applied — ${out.credits_spent} credits spent, ${out.balance} left.` : 'Background applied.');
  } catch (e) {
    say(String((e && e.message) || e).slice(0, 200), true);
  } finally {
    aiBgBusy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

/*
 * A background plus cut-out objects, each landing as its own element with its own entrance.
 *
 * ⚠️ THE EXPENSIVE ONE. A press is one generation for the background and one per object, all on the
 * operator's metered endpoint, so this is single-flight on its own flag and says what it is about
 * to spend before it spends it.
 */
async function aiGenerateLayered(container) {
  const promptEl = container.querySelector('#aiPrompt');
  const statusEl = container.querySelector('#aiStatus');
  const btn = container.querySelector('#aiLayerBtn');
  const prompt = (promptEl.value || '').trim();
  const say = (msg, bad) => {
    statusEl.textContent = msg;
    statusEl.style.color = bad ? 'var(--danger, #e05252)' : 'var(--text-muted)';
  };
  if (!prompt) { say('Describe the scene first.', true); promptEl.focus(); return; }
  if (aiLayerBusy) return;
  if (!state.deck.doc.slides.length) { say('Add a slide first.', true); return; }

  const OBJECTS = 3;
  /*
   * ⚠️ ASKED, NOT ASSUMED. Every other button here costs at most one generation; this one costs
   * four and replaces the whole slide. Both of those are surprises worth one click to avoid.
   */
  if (!window.confirm(
    `Generate a layered slide?\n\nThis makes ${OBJECTS + 1} images on your image endpoint `
    + '(one background and one per object) and replaces the current slide.')) return;

  // Same identity trick as the background button: this takes a minute and the operator can move.
  const target = state.deck.doc.slides[state.si];

  aiLayerBusy = true;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Generating…';
  say(`Generating ${OBJECTS + 1} images and cutting the objects out — this takes a few minutes.`);
  try {
    const out = await api.aiGenerateLayered(prompt, aspectPixels(), OBJECTS);
    if (!out || !out.template) throw new Error('nothing came back');
    const idx = state.deck.doc.slides.indexOf(target);
    if (idx < 0) { say('That slide is gone — nothing changed.', true); return; }
    target.template = out.template;
    target.fields = out.fields || {};
    // The new cut-outs are content created seconds ago, so the cached index cannot resolve them and
    // every layer would render as an empty placeholder. Same trap as the background button.
    await loadContent();
    touch(container);
    paintAll(container);
    /*
     * ⚠️ SAY WHAT DID NOT ARRIVE. An object whose backdrop came back as a gradient is refused
     * server-side rather than laid on as a torn cut-out — so the operator can get four layers, or
     * two, and the difference must not be something they have to notice for themselves.
     */
    const short = out.generated === out.requested
      ? `Built ${out.generated} layers.`
      : `Built ${out.generated} of ${out.requested} layers.`;
    say(out.notes && out.notes.length ? `${short} ${out.notes[0]}` : short, out.generated < out.requested);
  } catch (e) {
    say(String((e && e.message) || e).slice(0, 200), true);
  } finally {
    aiLayerBusy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function aiGenerate(container) {
  /*
   * ⚠️ ONE AT A TIME, AND THE FLAG IS NOT btn.disabled. A disabled button ignores clicks but the
   * Enter binding calls this directly, and key auto-repeat fires it continuously — so a held Enter
   * launched one 180-second request per repeat. It also corrupted the button permanently: the
   * second call read `label` from the DOM AFTER the first had set it to "Generating…", so `finally`
   * restored that as the resting text for ever.
   */
  if (aiBusy) return;
  const promptEl = container.querySelector('#aiPrompt');
  const statusEl = container.querySelector('#aiStatus');
  const btn = container.querySelector('#aiGenBtn');
  const prompt = (promptEl.value || '').trim();
  const say = (msg, bad) => {
    statusEl.textContent = msg || '';
    statusEl.style.color = bad ? '#ff6b6b' : 'var(--text-muted)';
  };
  if (!prompt) { say(t('slides.ai.need_prompt'), true); promptEl.focus(); return; }

  /*
   * ⚠️ A DECK CAN HAVE NO SLIDES, and this used to return silently when it did — a Generate button
   * that does nothing, on the one occasion (an empty deck) when generating is most obviously what
   * you want. A deck created through the API carries no slides at all unless a doc is supplied, so
   * this is a reachable state and not a theoretical one. Make the slide, then fill it.
   */
  if (!slide()) {
    state.deck.doc.slides.push(newSlide(`Slide ${state.deck.doc.slides.length + 1}`));
    state.si = state.deck.doc.slides.length - 1;
    state.ei = 0; state.sel = [];
    /*
     * ⚠️ MARKED AND PAINTED BEFORE THE REQUEST, NOT AFTER. Without this the strip and the header
     * describe the old empty deck for the whole generation, and if the generation then FAILS the
     * slide stays in the document with dirty still false — invisible, unwarned, and swept into
     * whatever save happens next.
     */
    touch(container);
  }
  const s = slide();
  const untouched = elementsOf(s).length <= 1
    && Object.values(s.fields || {}).every((v) => !String(v || '').trim() || String(v) === 'New slide');
  if (!untouched && !window.confirm(t('slides.ai.replace_warn'))) return;

  aiBusy = true;
  btn.disabled = true;
  btn.textContent = t('slides.ai.working');
  say('');
  /* The slide is identified by ID, not by object, for the re-check after the await below. */
  const targetId = s.id;
  const targetDeckId = state.deck && state.deck.id;
  try {
    const out = await api.aiGenerateSlide(prompt);

    /*
     * ⚠️ THE USER HAS HAD UP TO 180 SECONDS TO MOVE. Writing to the captured slide object would
     * replace whichever slide they navigated to — or one they deleted, or a slide in another deck —
     * silently, while repainting something else and reporting success. The confirmation they gave
     * was about THIS slide; if it is no longer the one in front of them, the answer is dropped and
     * said so, not applied somewhere they did not ask for.
     */
    if (!state.deck || state.deck.id !== targetDeckId) return;
    const idx = state.deck.doc.slides.findIndex((x) => x.id === targetId);
    if (idx === -1 || idx !== state.si) { say(t('slides.ai.moved_on'), true); return; }
    const s2 = state.deck.doc.slides[idx];
    /*
     * ⚠️ The slide KEEPS ITS OWN identity — id, name and dwell. Those belong to the deck, not to
     * the generated content, and replacing them would renumber the strip and reset a dwell the
     * operator had already tuned for this slot.
     */
    /*
     * ⚠️ KEEP A BACKGROUND PICTURE THE OPERATOR ALREADY HAS. The model returns a whole template, so
     * assigning it wholesale silently discarded background_content_id — generate a background, then
     * regenerate the words, and the photo vanished with no mention of it. The two buttons have to
     * be symmetrical: "Generate background" never touches the elements, so "Generate" must not
     * throw away the background.
     *
     * The generated background COLOUR is still taken: it sits behind the photo and shows through
     * wherever the image does not cover, so honouring it costs nothing and keeps the palette the
     * model chose. Only the picture and its scrim are carried across.
     */
    const keptBg = s2.template && s2.template.background_content_id;
    const keptDim = s2.template && s2.template.background_dim;
    s2.template = out.template;
    if (keptBg) {
      s2.template.background_content_id = keptBg;
      if (keptDim != null) s2.template.background_dim = keptDim;
    }
    s2.fields = out.fields || {};
    state.ei = 0; state.sel = [];
    // touch(), not a bare repaint: it records the step, so Undo brings the old slide back even
    // when nothing was edited before (a fresh history had no step to undo).
    touch(container);
    say(t('slides.ai.done', { n: out.elements != null ? out.elements : elementsOf(s2).length }));
  } catch (err) {
    // The server distinguishes "AI is not configured" from "timed out" from "returned nonsense",
    // and each needs a different action from the person reading it.
    say((err && err.message) || t('slides.ai.failed'), true);
  } finally {
    aiBusy = false;
    // Read the resting label from i18n rather than from a variable captured mid-flight.
    btn.disabled = false;
    btn.textContent = t('slides.ai.generate');
  }
}

/* ============================================================ content */

/*
 * The deck's authoring shape as a CSS aspect-ratio.
 *
 * ⚠️ EDITOR-ONLY. The renderer is already shape-agnostic — width:100%/height:100% with every size
 * in cqw — so a slide fills whatever container a screen gives it. This exists so the operator
 * designs on the canvas they will actually get: laying a portrait screen out on a 16:9 stage looks
 * right here and wrong on the wall.
 */
const ASPECT_CHOICES = [
  ['16:9', 'Landscape 16:9'], ['9:16', 'Portrait 9:16'],
  ['4:3', 'Landscape 4:3'], ['3:4', 'Portrait 3:4'],
  // Tablet room-signs are commonly 3:2 / 2:3 (e.g. a 800x1200 ThinkSmart panel is exactly 2:3) or
  // 16:10 / 10:16. Without these a 16:9 deck can never fill such a panel — it always letterboxes.
  ['3:2', 'Landscape 3:2 (tablet)'], ['2:3', 'Portrait 2:3 (tablet)'],
  ['16:10', 'Landscape 16:10'], ['10:16', 'Portrait 10:16'],
  ['1:1', 'Square'], ['21:9', 'Ultrawide 21:9'],
  ['5:3', 'E-Paper 5:3'],
];

function deckAspect() {
  const a = state.deck && state.deck.doc && state.deck.doc.aspect;
  return ASPECT_CHOICES.some(([v]) => v === a) ? a : '16:9';
}

/** CSS wants `16/9`, the stored value is `16:9`. */
function aspectCss() { return deckAspect().replace(':', '/'); }

/** Pixel dimensions to ask an image generator for, in the deck's shape. */
function aspectPixels() {
  const [w, h] = deckAspect().split(':').map(Number);
  const long = 1792;
  return w >= h ? { width: long, height: Math.round(long * h / w) }
    : { height: long, width: Math.round(long * w / h) };
}

function contentUrl(id) {
  if (!id) return null;
  const c = (state.contentIndex || []).find((x) => x.id === id);
  if (!c) return null;
  return c.remote_url || (c.filepath ? `/uploads/content/${encodeURIComponent(c.filepath)}` : null);
}

async function loadFonts() {
  try {
    const r = await api.get('/widgets/slide-fonts');
    const bundled = Array.isArray(r && r.fonts) ? r.fonts : [];
    // Uploaded fonts sit after the bundled ones. A failure here must not lose the bundled list —
    // an operator with no uploads should never notice this call exists.
    let custom = [];
    try {
      const u = await api.get('/fonts');
      custom = Array.isArray(u && u.fonts) ? u.fonts : [];
    } catch (e2) { custom = []; }
    FONT_CATALOGUE = bundled.concat(custom);
    ensureFontFaces();
  } catch (e) {
    // Not fatal: the picker falls back to whatever is stored and the stage uses a generic. A deck
    // is still fully editable without the list.
    FONT_CATALOGUE = [];
  }
}

async function loadContent() {
  try {
    /*
     * ⚠️ ONE REQUEST PER KIND, AND THE SERVER'S MAXIMUM ON EACH. `/content` with no query returns
     * the 100 newest rows of EVERY type, so a workspace whose last hundred uploads were videos
     * would offer an empty image list while its library is full of pictures. Asking per type is
     * what makes each picker complete.
     *
     * ⚠️ AND IT IS THREE KINDS, NOT ONE. This used to fetch images alone, which quietly emptied
     * every other picker built on this index: videoContent() filters it for the background-video
     * selector and could never match, because the only rows in it were images. The audio pickers
     * added for voiceovers and music beds would have been the third casualty of the same line.
     *
     * mime_type is CARRIED, because the filters key on it. The previous shape dropped it, so those
     * filters were reduced to guessing from the filename — which fails outright for remote URLs,
     * where the name is whatever the operator typed and carries no extension at all.
     */
    const [images, videos, audios] = await Promise.all([
      api.get('/content?type=image&limit=500').catch(() => []),
      api.get('/content?type=video&limit=500').catch(() => []),
      api.get('/content?type=audio&limit=500').catch(() => []),
    ]);
    state.contentIndex = [images, videos, audios]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .map((c) => ({
        id: c.id, filename: c.filename, filepath: c.filepath, remote_url: c.remote_url, mime_type: c.mime_type,
      }));
  } catch (e) { state.contentIndex = []; }
}
