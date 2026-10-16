'use strict';

/*
 * 3.0 Auto-translate: a sign or slide deck's words in other languages, reviewed by a person, then
 * shown per screen as a fixed language or rotating through languages. docs/private-ai.md.
 *
 * ⚠️ A TRANSLATION IS A COPY OF THE DECK'S WORDS, NOT OF ITS LAYOUT. Only `fields` change, and only
 * the fields of text elements (head, body, stat, a countdown's message). QR payloads, lettering
 * artwork, colours and every layout number are carried over untouched, so a translated sign cannot
 * be a different design, a different link or anything a template did not already allow.
 *
 * ⚠️ PLACEHOLDERS ARE MASKED BEFORE A MODEL SEES THEM. {{ds:slug.field}} data-source tokens, {name}
 * style placeholders, printf tokens, links and e-mail addresses are replaced by [[n]] markers, and a
 * translation is accepted only if every marker comes back exactly as often as it went out. One that
 * loses or duplicates a marker is retried once and otherwise kept in the original language, with a
 * note the reviewer sees. A translated menu whose price token became the word "price" is the
 * failure this exists to prevent.
 *
 * ⚠️ NOTHING IS ON A SCREEN UNTIL A PERSON APPROVES IT. Translating writes a draft. Approving builds
 * the language's slide widgets; only then can a screen set to that language show them. Editing an
 * approved translation updates those widgets, and the reviewer is the person who made the edit.
 *
 * Screens: device_languages says what one shows — 'fixed' (one language; slides without a
 * translation play as they are) or 'rotate' (each translated slide is followed by its translations,
 * so the screen alternates languages item by item). Applied when the device payload is built
 * (ws/deviceSocket.js), on the ordinary playlist path only: head-office, emergency and automation
 * playlists play exactly as published.
 */

const { v4: uuidv4 } = require('uuid');
const deckLib = require('./slide-deck');
const slideRender = require('./slide-render');
const { stripTags } = require('./strip-tags');

const MAX_LANGS = 6;
const MAX_STRINGS = 300;
const CHUNK = 20;
const TRANSLATABLE_KINDS = new Set(['head', 'body', 'stat', 'countdown']);
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const nowSec = () => Math.floor(Date.now() / 1000);

function normLang(raw) {
  const s = String(raw || '').trim();
  if (!LANG_RE.test(s)) return null;
  const [a, b] = s.split('-');
  return b ? `${a}-${b.length === 2 ? b.toUpperCase() : b}` : a;
}

function langName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}

/* ============================================================ placeholders */

const PLACEHOLDER = /\{\{[^{}]{1,200}\}\}|\{[A-Za-z0-9_.:-]{1,60}\}|%(?:\d+\$)?[sdif]|https?:\/\/[^\s<>"]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MARK = /\[\[(\d{1,3})\]\]/g;

/** Replace every placeholder with [[n]]; the originals come back from `tokens`. */
function mask(text) {
  const tokens = [];
  const masked = String(text).replace(PLACEHOLDER, (m) => {
    let i = tokens.indexOf(m);
    if (i < 0) { tokens.push(m); i = tokens.length - 1; }
    return `[[${i + 1}]]`;
  });
  return { masked, tokens };
}

function markerCounts(s) {
  const c = new Map();
  for (const m of String(s).matchAll(MARK)) c.set(m[1], (c.get(m[1]) || 0) + 1);
  return c;
}

/** Same markers, same number of times each — or null. */
function unmask(translated, masked, tokens) {
  const want = markerCounts(masked);
  const got = markerCounts(translated);
  if (want.size !== got.size) return null;
  for (const [k, n] of want) if (got.get(k) !== n) return null;
  return String(translated).replace(MARK, (m, n) => tokens[Number(n) - 1] ?? m);
}

const digitsOf = (s) => (String(s).match(/\d+/g) || []).sort().join(',');
const linesOf = (s) => String(s).split('\n').length;

/* ============================================================ which words */

function hasWords(s) { return /\p{L}/u.test(String(s || '')); }

/** Every translatable string in a deck document, with where it lives. */
function collectStrings(doc) {
  const out = [];
  for (const slide of (doc && Array.isArray(doc.slides) ? doc.slides : [])) {
    const fields = slide.fields || {};
    for (const el of (slide.template && Array.isArray(slide.template.elements) ? slide.template.elements : [])) {
      if (!el || !TRANSLATABLE_KINDS.has(el.kind)) continue;
      if (!Object.prototype.hasOwnProperty.call(fields, el.slot)) continue;
      const source = fields[el.slot];
      if (typeof source !== 'string' || !hasWords(source)) continue;
      // Text that is only placeholders (a data-source value, a link) has nothing to translate.
      if (!hasWords(source.replace(PLACEHOLDER, ''))) continue;
      out.push({ slide_id: slide.id, slot: el.slot, source });
      if (out.length >= MAX_STRINGS) return out;
    }
  }
  return out;
}

/* ============================================================ asking a model */

function systemPrompt(lang) {
  return [
    `You translate short texts for digital signs into ${langName(lang)} (${lang}).`,
    'Answer with ONLY one JSON object that maps each id to its translation, e.g. {"1":"...","2":"..."}.',
    'No prose, no markdown, no notes.',
    'Keep every marker like [[1]] exactly as written; never translate, remove or repeat a marker.',
    'Keep numbers, prices, times and line breaks (\\n). Keep each translation about as short as the original.',
    'If a text is a name or already in the target language, return it unchanged.',
  ].join('\n');
}

/**
 * Translate distinct strings into one language. `ask(system, user)` is the model call.
 * Returns Map(source → {text, note?}); a string that cannot be translated safely maps to itself
 * with a note, so the reviewer sees exactly which ones need a human.
 */
async function translateStrings({ sources, lang, ask }) {
  const result = new Map();
  const items = sources.map((source, i) => ({ id: String(i + 1), source, ...mask(source) }));
  let lastError = null;

  for (let at = 0; at < items.length; at += CHUNK) {
    let pending = items.slice(at, at + CHUNK);
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const payload = {};
      for (const it of pending) payload[it.id] = it.masked;
      const user = (attempt ? 'Some translations lost or changed a [[n]] marker. Translate these again and keep every marker exactly.\n' : '')
        + JSON.stringify(payload);
      const r = await ask(systemPrompt(lang), user);
      if (r.error) {
        if (r.code !== 'bad_json') return { error: r.error, status: r.status, code: r.code };
        lastError = r;
        continue;
      }
      const reply = r.parsed && typeof r.parsed === 'object' && !Array.isArray(r.parsed) ? r.parsed : {};
      const failed = [];
      for (const it of pending) {
        const raw = Object.prototype.hasOwnProperty.call(reply, it.id) ? reply[it.id] : undefined;
        const text = typeof raw === 'string' ? stripTags(raw).trim() : '';
        const restored = text ? unmask(text, it.masked, it.tokens) : null;
        const tooLong = restored != null && restored.length > Math.min(slideRender.MAX_FIELD_CHARS, it.source.length * 3 + 40);
        if (restored == null || tooLong) { failed.push(it); continue; }
        const notes = [];
        if (digitsOf(restored) !== digitsOf(it.source)) notes.push('numbers_changed');
        if (linesOf(restored) !== linesOf(it.source)) notes.push('lines_changed');
        result.set(it.source, { text: restored, ...(notes.length ? { note: notes.join(',') } : {}) });
      }
      pending = failed;
    }
    for (const it of pending) result.set(it.source, { text: it.source, note: 'kept_original' });
  }
  if (lastError && ![...result.values()].some((v) => v.note !== 'kept_original')) {
    return { error: 'The AI did not answer with usable translations. Try again.', status: 400, code: 'bad_json' };
  }
  return { map: result };
}

/* ============================================================ documents */

function parseDoc(raw) {
  try { return deckLib.normalizeDeck(JSON.parse(raw || '{"slides":[]}')); } catch { return deckLib.normalizeDeck({}); }
}

/** The source deck with translated words dropped into its fields. Nothing else changes. */
function variantDoc(srcDoc, strings, map) {
  const doc = JSON.parse(JSON.stringify(srcDoc));
  const notes = [];
  for (const s of strings) {
    const slide = doc.slides.find((x) => x.id === s.slide_id);
    const t = map.get(s.source);
    if (!slide || !t) continue;
    slide.fields[s.slot] = t.text;
    if (t.note) notes.push({ slide_id: s.slide_id, slot: s.slot, note: t.note });
  }
  for (const sl of doc.slides) delete sl.widget_id;   // a variant owns its own widgets (widget_map)
  return { doc, notes };
}

/** The review view of a translation: each string, original beside translation. */
function reviewRows(srcDoc, row) {
  const doc = parseDoc(row.doc);
  let notes = [];
  try { notes = JSON.parse(row.notes || '[]'); } catch { notes = []; }
  return collectStrings(srcDoc).map((s) => {
    const slide = doc.slides.find((x) => x.id === s.slide_id);
    const text = slide && typeof slide.fields[s.slot] === 'string' ? slide.fields[s.slot] : s.source;
    const n = notes.find((x) => x.slide_id === s.slide_id && x.slot === s.slot);
    return { slide_id: s.slide_id, slot: s.slot, source: s.source, text, ...(n ? { note: n.note } : {}) };
  });
}

function present(db, row, srcDeck) {
  const srcDoc = srcDeck ? parseDoc(srcDeck.doc) : { slides: [] };
  let map = {};
  try { map = JSON.parse(row.widget_map || '{}'); } catch { map = {}; }
  return {
    id: row.id, deck_id: row.source_deck_id, lang: row.lang, status: row.status,
    on_screens: Object.keys(map).length > 0,
    stale: !!(srcDeck && row.source_rev && srcDeck.updated_at > row.source_rev),
    unpublished: !srcDoc.slides.some((s) => s.widget_id),
    updated_at: row.updated_at,
    strings: reviewRows(srcDoc, row),
  };
}

function saveDraft(db, { workspaceId, deck, lang, doc, notes, userId }) {
  const existing = db.prepare('SELECT id FROM sign_translations WHERE source_deck_id = ? AND lang = ? AND workspace_id = ?').get(deck.id, lang, workspaceId);
  const ts = nowSec();
  if (existing) {
    db.prepare(`UPDATE sign_translations SET doc = ?, notes = ?, status = 'draft', source_rev = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(doc), JSON.stringify(notes), deck.updated_at || ts, ts, existing.id);
    return existing.id;
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO sign_translations (id, workspace_id, source_deck_id, lang, status, doc, notes, widget_map, source_rev, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'draft',?,?,'{}',?,?,?,?)`)
    .run(id, workspaceId, deck.id, lang, JSON.stringify(doc), JSON.stringify(notes), deck.updated_at || ts, userId || null, ts, ts);
  return id;
}

/**
 * A reviewer's edits. Each must keep the original's placeholders; a string that lost one is refused
 * by name, so the reviewer cannot publish a menu whose price token was typed over.
 */
function applyEdits(srcDoc, row, edits) {
  const doc = parseDoc(row.doc);
  let notes = [];
  try { notes = JSON.parse(row.notes || '[]'); } catch { notes = []; }
  const strings = collectStrings(srcDoc);
  const errors = [];
  for (const e of (Array.isArray(edits) ? edits : []).slice(0, MAX_STRINGS)) {
    if (!e || typeof e !== 'object') continue;
    const s = strings.find((x) => x.slide_id === e.slide_id && x.slot === e.slot);
    const slide = s && doc.slides.find((x) => x.id === s.slide_id);
    if (!s || !slide || typeof e.text !== 'string') continue;
    const text = e.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim().slice(0, slideRender.MAX_FIELD_CHARS);
    // Every placeholder of the original, exactly as often as the original has it.
    const { tokens } = mask(s.source);
    if (text && !tokens.every((tk) => text.split(tk).length === s.source.split(tk).length)) {
      errors.push({ slide_id: s.slide_id, slot: s.slot, code: 'placeholder_lost' });
      continue;
    }
    // Cleared means "use the original", never an empty headline on the wall.
    slide.fields[s.slot] = text || s.source;
    notes = notes.filter((n) => !(n.slide_id === s.slide_id && n.slot === s.slot));
  }
  return { doc, notes, errors };
}

/**
 * Approve: build (or update) one slide widget per published source slide, recorded in widget_map.
 * Unpublished source slides have no widget a screen could be showing, so nothing maps to them yet;
 * approving again after the deck is published adds them.
 */
function approve(db, { row, srcDeck, userId }) {
  const srcDoc = parseDoc(srcDeck.doc);
  const doc = parseDoc(row.doc);
  let map = {};
  try { map = JSON.parse(row.widget_map || '{}'); } catch { map = {}; }
  const next = {};
  const ts = nowSec();
  const own = db.prepare("SELECT id FROM widgets WHERE id = ? AND workspace_id = ? AND widget_type = 'slide'");
  const upd = db.prepare('UPDATE widgets SET config = ?, name = ?, updated_at = ? WHERE id = ?');
  const ins = db.prepare(`INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, created_at, updated_at)
    VALUES (?,?,?,'slide',?,?,?,?)`);
  // The variant carries the SOURCE deck's shape and soundtrack: only the words differ.
  const shaped = { ...srcDoc, slides: doc.slides };
  db.transaction(() => {
    for (const src of srcDoc.slides) {
      if (!src.widget_id) continue;
      const slide = doc.slides.find((x) => x.id === src.id);
      if (!slide) continue;
      const cfg = deckLib.slideWidgetConfig(shaped, slide);
      const name = `${String(slide.name || srcDeck.name || 'Slide').slice(0, 180)} · ${row.lang}`;
      const existing = map[src.widget_id] && own.get(map[src.widget_id], row.workspace_id);
      if (existing) { upd.run(cfg, name, ts, existing.id); next[src.widget_id] = existing.id; }
      else {
        const id = uuidv4();
        ins.run(id, userId || null, row.workspace_id, name, cfg, ts, ts);
        next[src.widget_id] = id;
      }
    }
    db.prepare(`UPDATE sign_translations SET status = 'approved', widget_map = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(next), ts, row.id);
  })();
  return next;
}

/** Remove a translation and the widgets only it uses. A widget somebody put in a playlist stays. */
function remove(db, row) {
  let map = {};
  try { map = JSON.parse(row.widget_map || '{}'); } catch { map = {}; }
  db.transaction(() => {
    for (const wid of Object.values(map)) {
      const used = db.prepare('SELECT 1 FROM playlist_items WHERE widget_id = ? LIMIT 1').get(wid);
      if (!used) db.prepare("DELETE FROM widgets WHERE id = ? AND workspace_id = ? AND widget_type = 'slide'").run(wid, row.workspace_id);
    }
    db.prepare('DELETE FROM sign_translations WHERE id = ?').run(row.id);
  })();
}

/* ============================================================ screens */

function screenLanguage(db, deviceId, workspaceId) {
  const r = db.prepare('SELECT mode, langs FROM device_languages WHERE device_id = ? AND workspace_id = ?').get(deviceId, workspaceId);
  if (!r) return null;
  let langs = [];
  try { langs = JSON.parse(r.langs || '[]'); } catch { langs = []; }
  return { mode: r.mode, langs: (Array.isArray(langs) ? langs : []).map(normLang).filter(Boolean).slice(0, MAX_LANGS) };
}

function setScreenLanguage(db, { deviceId, workspaceId, mode, langs }) {
  if (!mode || mode === 'original') {
    db.prepare('DELETE FROM device_languages WHERE device_id = ? AND workspace_id = ?').run(deviceId, workspaceId);
    return null;
  }
  db.prepare(`INSERT INTO device_languages (device_id, workspace_id, mode, langs, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET workspace_id = excluded.workspace_id, mode = excluded.mode, langs = excluded.langs, updated_at = excluded.updated_at`)
    .run(deviceId, workspaceId, mode, JSON.stringify(langs), nowSec());
  return { mode, langs };
}

/**
 * The device payload's items with this screen's language applied. Total: anything unexpected
 * returns the items exactly as they were, because a translation must never cost a screen its loop.
 */
function applyScreenLanguage(db, deviceId, workspaceId, items) {
  if (!Array.isArray(items) || !items.length || !deviceId || !workspaceId) return items;
  const pref = screenLanguage(db, deviceId, workspaceId);
  if (!pref || !pref.langs.length) return items;

  // source widget id → { lang: variant widget id }, approved translations in THIS workspace only.
  const variants = new Map();
  for (const r of db.prepare("SELECT lang, widget_map FROM sign_translations WHERE workspace_id = ? AND widget_map != '{}'").all(workspaceId)) {
    if (!pref.langs.includes(r.lang)) continue;
    let map = {};
    try { map = JSON.parse(r.widget_map || '{}'); } catch { continue; }
    for (const [src, dst] of Object.entries(map)) {
      if (!variants.has(src)) variants.set(src, {});
      variants.get(src)[r.lang] = dst;
    }
  }
  if (!variants.size) return items;

  const widgetRow = db.prepare("SELECT id, name, config, updated_at FROM widgets WHERE id = ? AND workspace_id = ? AND widget_type = 'slide'");
  const swap = (item, wid) => {
    const w = widgetRow.get(wid, workspaceId);
    if (!w) return null;
    return { ...item, widget_id: w.id, widget_name: w.name, filename: w.name, widget_config: w.config, widget_rev: w.updated_at };
  };

  const out = [];
  for (const it of items) {
    const v = it && it.widget_id ? variants.get(it.widget_id) : null;
    if (!v) { out.push(it); continue; }
    if (pref.mode === 'fixed') {
      out.push((v[pref.langs[0]] && swap(it, v[pref.langs[0]])) || it);
    } else {
      // Rotate: the original, then each translation, so languages alternate item by item.
      out.push(it);
      for (const l of pref.langs) { const s = v[l] && swap(it, v[l]); if (s) out.push(s); }
    }
  }
  return out;
}

module.exports = {
  MAX_LANGS, TRANSLATABLE_KINDS, normLang, langName,
  mask, unmask, collectStrings, translateStrings, variantDoc, parseDoc, present, saveDraft, applyEdits, approve, remove,
  screenLanguage, setScreenLanguage, applyScreenLanguage,
};
