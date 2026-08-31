'use strict';

/*
 * Decks: authored as one document, published as things the rest of the product already understands.
 *
 * ⚠️ THE DECISION THIS FILE ENCODES. Every survey of how signage vendors handle multi-page content
 * came back the same way — one template is ONE slide, and a sequence of slides is a playlist. So the
 * temptation is to say "decks are playlists, don't build a deck editor" and stop. That is right
 * about the DATA and wrong about the AUTHORING: building six slides that share a look, one widget at
 * a time, and then assembling a playlist by hand, is a worse job than it needs to be.
 *
 * Both halves are available. A deck is an editable SOURCE document; publishing it emits one slide
 * widget per page plus a playlist that orders them. Nothing downstream learns a new content type —
 * scheduling, groups, inheritance, the resolver and every player keep working because what reaches
 * them is a playlist of widgets, which is a thing that already existed. The deck row is the only
 * new object, and nothing but the editor reads it.
 *
 * ⚠️ LEAST-DESTRUCTIVE ON REPUBLISH. Publishing touches only the items whose widget this deck owns.
 * If an operator has added other content to the deck's playlist by hand, it is left exactly where it
 * is rather than being swept away by the next publish — a rebuild-from-scratch would be simpler to
 * write and would silently delete somebody's work.
 */

const { v4: uuidv4 } = require('uuid');
const { normalizeSlide, settleTime } = require('./slide-render');

const MAX_SLIDES = 100;
const MAX_NAME = 120;
const MIN_DWELL = 1;
const MAX_DWELL = 3600;

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Validate a deck document into the shape publish can rely on.
 *
 * ⚠️ Total, like normalizeSlide and for the same reason: an operator's deck must not become
 * unopenable because one field went strange. Anything unrecognised is dropped, anything out of
 * range is clamped, and what comes back is always publishable.
 */
/**
 * Shapes a deck may be authored in. The RENDERER needs none of this — it is width:100%/height:100%
 * with every size in cqw, so a slide already fills whatever container a screen gives it. This
 * exists so the EDITOR can show the operator the canvas they are actually designing for: a portrait
 * screen laid out on a 16:9 stage looks right in the editor and wrong on the wall.
 */
const ASPECTS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'];

function normalizeDeck(raw) {
  const doc = (raw && typeof raw === 'object') ? raw : {};
  const slidesIn = Array.isArray(doc.slides) ? doc.slides.slice(0, MAX_SLIDES) : [];

  const seen = new Set();
  const slides = slidesIn.map((s, i) => {
    const src = (s && typeof s === 'object') ? s : {};
    // ⚠️ Slide ids must be unique WITHIN the deck: they are how a republish recognises a slide it
    // has already made a widget for. A duplicate would make two slides fight over one widget, and
    // the loser would silently stop updating.
    let id = typeof src.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(src.id) ? src.id : null;
    if (!id || seen.has(id)) id = `s_${uuidv4().slice(0, 8)}`;
    seen.add(id);

    const dwell = Number(src.dwell_sec);
    return {
      id,
      name: String(src.name == null ? '' : src.name).slice(0, MAX_NAME) || `Slide ${i + 1}`,
      dwell_sec: Number.isFinite(dwell) ? Math.min(MAX_DWELL, Math.max(MIN_DWELL, Math.round(dwell))) : 10,
      // Carried through publish so a republish updates the same widget rather than making another.
      // Never trusted for authorization — publish re-checks that the widget is this workspace's.
      widget_id: typeof src.widget_id === 'string' && src.widget_id.length <= 64 ? src.widget_id : null,
      ...sanitizeStored(src.template, src.fields),
    };
  });

  /*
   * ⚠️ ASPECT IS RETURNED EXPLICITLY, because this function returns a NEW object rather than
   * editing the one it was given — anything not named here is dropped on every save. That is the
   * same mechanism that once lost background_content_id, documented at length below, and a deck
   * silently reverting to landscape every time it was saved would be the identical bug wearing a
   * different hat.
   *
   * Whitelisted rather than free-form: it goes straight into a CSS aspect-ratio in the editor, and
   * an arbitrary string there is both a rendering accident and an injection point.
   */
  const aspect = ASPECTS.includes(doc.aspect) ? doc.aspect : '16:9';

  return { slides, aspect };
}

/*
 * Store only what the RENDERER would accept.
 *
 * ⚠️ THIS USED TO KEEP `template` EXACTLY AS SENT, AND THAT WAS STORED XSS. The slide editor draws
 * the filmstrip by interpolating a style string into an innerHTML attribute, so a colour of
 * `x" onmouseover="…` in a saved deck broke out of `style="…"` and ran script in the DASHBOARD
 * origin — where the session JWT lives — for whoever opened the deck next. An editor could write
 * it; an admin would run it. The wall was never at risk (routes/widgets.js re-normalises before
 * rendering), which is exactly why it could sit here unnoticed.
 *
 * ⚠️ NORMALIZE, THEN MAP BACK TO THE STORED SHAPE — do not simply store normalizeSlide's output.
 * That function is the renderer's view of a slide and renames things on the way (`backgroundDim`,
 * `backgroundContentId`, `contentId`); writing its output straight back would silently drop the
 * picture background an operator had set, because the editor reads the snake_case keys. So the
 * values are validated by the one authority that matters and then rewritten in the shape the
 * document has always used.
 */
/**
 * normalizeSlide's `cfg`, written back in the snake_case keys the document uses.
 *
 * ⚠️ THE FAILURE THIS EXISTS TO PREVENT IS SILENT. The map below rebuilds each element key by key,
 * so anything not named here is DROPPED on every save — a clock would lose its time zone and a
 * countdown its target the moment the deck was touched for an unrelated reason, with no error
 * anywhere and the editor showing the operator's own choice until they reloaded. Every field the
 * renderer accepts is a duty here too; the round-trip test in test/slide-deck-config-roundtrip.js
 * is what holds the two lists together.
 */
function storedCfg(e) {
  if (!e.cfg) return {};
  switch (e.kind) {
    case 'clock': return { clock_format: e.cfg.format, tz: e.cfg.tz, locale: e.cfg.locale };
    case 'date': return { date_format: e.cfg.format, tz: e.cfg.tz, locale: e.cfg.locale };
    case 'countdown': return { target: e.cfg.target };
    case 'image': return { fit: e.cfg.fit };
    case 'qr': return { qr_ec: e.cfg.ec, qr_fg: e.cfg.fg, qr_bg: e.cfg.bg };
    default: return {};
  }
}

function sanitizeStored(templateIn, fieldsIn) {
  const rawTemplate = (templateIn && typeof templateIn === 'object' && !Array.isArray(templateIn)) ? templateIn : { elements: [] };
  const rawFields = (fieldsIn && typeof fieldsIn === 'object' && !Array.isArray(fieldsIn)) ? fieldsIn : {};
  const settled = normalizeSlide({ template: rawTemplate, fields: rawFields });

  const template = {
    background: settled.background,
    background_content_id: settled.backgroundContentId,
    background_dim: settled.backgroundDim,
    elements: settled.elements.map((e) => ({
      slot: e.slot,
      kind: e.kind,
      box: { x: e.x, y: e.y, w: e.w, ...(e.h == null ? {} : { h: e.h }) },
      content_id: e.contentId,
      style: {
        color: e.style.color,
        font: e.style.font,
        size_cqw: e.style.size,
        weight: e.style.weight,
        align: e.style.align,
        radius_cqw: e.style.radius,
        opacity: e.style.opacity,
      },
      motion: e.motion,
      ...storedCfg(e),
    })),
  };

  /* Words survive only for slots that survived, and only as the renderer accepted them. */
  const fields = {};
  for (const e of template.elements) {
    if (Object.prototype.hasOwnProperty.call(settled.fields, e.slot)) fields[e.slot] = settled.fields[e.slot];
  }
  return { template, fields };
}

/**
 * What a slide is worth warning about before it goes on a wall.
 *
 * ⚠️ THE COUPLING NOTHING ELSE IN THE PRODUCT KNOWS ABOUT: a slide's motion has to finish inside the
 * playlist item's duration. An animation that outlives its dwell is not a subtle defect — the text
 * is still arriving when the slide is replaced, so on the wall it reads as content that never
 * appears, and it looks like a broken player rather than a slide someone mis-timed.
 *
 * Returned rather than enforced. Refusing the save would be worse: an operator mid-edit has every
 * right to a slide that does not add up yet, and the editor can show this while they work.
 */
/*
 * Relative luminance and contrast ratio, the WCAG definitions.
 *
 * ⚠️ HERE BECAUSE A QR IS THE ONE ELEMENT THAT CAN BE DRAWN PERFECTLY AND STILL NOT WORK. A camera
 * decodes it by thresholding light against dark, so a low-contrast pair produces a picture that is
 * unmistakably a QR code and that no phone will read — and the person who made it has no way to
 * tell by looking. Every other warning in this file is about something the author could eventually
 * notice on a screen; this one they could not.
 */
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastRatio(a, b) {
  const la = luminance(a); const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Below this a code is unreliable in the field even when it renders perfectly. */
const QR_MIN_CONTRAST = 3;

function deckWarnings(deck) {
  const out = [];
  for (const s of deck.slides) {
    for (const e of normalizeSlide({ template: s.template, fields: s.fields }).elements) {
      if (e.kind !== 'qr' || !e.cfg) continue;
      const ratio = contrastRatio(e.cfg.fg, e.cfg.bg);
      if (ratio >= QR_MIN_CONTRAST) continue;
      out.push({
        slide_id: s.id,
        kind: 'qr-contrast',
        message: `A QR code on "${s.name}" is ${e.cfg.fg} on ${e.cfg.bg} — a contrast of `
          + `${ratio.toFixed(1)}:1. It will render, but a camera is unlikely to read it. `
          + `Dark modules on a light panel scan best.`,
        contrast: Number(ratio.toFixed(2)),
      });
    }
    const settle = settleTime(normalizeSlide({ template: s.template, fields: s.fields }));
    if (settle > s.dwell_sec) {
      out.push({
        slide_id: s.id,
        kind: 'motion-outlives-dwell',
        message: `"${s.name}" is still animating at ${settle.toFixed(2)}s but is replaced at `
          + `${s.dwell_sec}s — some of it will never finish arriving.`,
        settle_sec: Number(settle.toFixed(2)),
        dwell_sec: s.dwell_sec,
      });
    }
  }
  return out;
}

/**
 * Publish a deck: one slide widget per page, ordered by a playlist.
 *
 * Returns a summary and the (possibly updated) document — slides that had no widget now carry the
 * one they were given, so the caller must persist what comes back or the next publish will make
 * duplicates.
 */
function publishDeck(db, { deck, doc, userId, playlistId, publishedWidgetIds }) {
  const normalized = normalizeDeck(doc);
  const wsId = deck.workspace_id;
  const ts = nowSec();

  const run = db.transaction(() => {
    // ---------------------------------------------------------------- the playlist
    let plId = playlistId || deck.playlist_id;
    let playlist = plId ? db.prepare('SELECT * FROM playlists WHERE id = ?').get(plId) : null;
    /*
     * ⚠️ RE-CHECKED, NOT TRUSTED. playlist_id lives on the deck row, but a playlist can be deleted
     * out from under it, and a deck could in principle be pointed at a playlist in another
     * workspace. Either way the answer is to make a fresh one rather than write into it.
     */
    if (playlist && playlist.workspace_id !== wsId) playlist = null;
    if (!playlist) {
      plId = uuidv4();
      db.prepare(`INSERT INTO playlists (id, user_id, workspace_id, name, description, created_at, updated_at, status)
                  VALUES (?,?,?,?,?,?,?,'draft')`)
        .run(plId, userId, wsId, deck.name, 'Published from a slide deck', ts, ts);
      playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(plId);
    }

    // ---------------------------------------------------------------- widgets, one per slide
    const ownedNow = [];
    normalized.slides.forEach((s, i) => {
      const config = JSON.stringify({ template: s.template, fields: s.fields });
      const name = `${deck.name} — ${s.name}`.slice(0, 200);

      let existing = s.widget_id
        ? db.prepare("SELECT * FROM widgets WHERE id = ? AND widget_type = 'slide'").get(s.widget_id)
        : null;
      // Same reasoning as the playlist above: the id came out of a document, so it is checked
      // against this workspace before anything is written through it.
      if (existing && existing.workspace_id !== wsId) existing = null;

      if (existing) {
        /*
         * ⚠️ updated_at IS widget_rev — the value the player keys its render URL on. Bumping it
         * when nothing changed would hand every screen a new URL for identical bytes, so the
         * write is conditional on the content actually differing. Bumping it when something DID
         * change is equally load-bearing: without it the player reuses the WebView and the edit
         * never reaches the screen.
         */
        if (existing.config !== config || existing.name !== name) {
          db.prepare('UPDATE widgets SET name = ?, config = ?, updated_at = ? WHERE id = ?')
            .run(name, config, ts, existing.id);
        }
        s.widget_id = existing.id;
      } else {
        const id = uuidv4();
        db.prepare(`INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, created_at, updated_at)
                    VALUES (?,?,?,'slide',?,?,?,?)`).run(id, userId, wsId, name, config, ts, ts);
        s.widget_id = id;
      }
      ownedNow.push({ widgetId: s.widget_id, sort: i, dwell: s.dwell_sec });
    });

    // ---------------------------------------------------------------- items this deck used to own
    /*
     * ⚠️ THE PRIOR SET COMES FROM THE DECK ROW, NOT FROM THE DOCUMENT — and a test is the reason.
     *
     * The first version diffed the incoming doc's `widget_id` fields against the new set. That is
     * wrong twice over. It cannot see a slide the operator removed BEFORE saving, because the
     * document has already forgotten it; and worse, widget_id sits inside a blob the caller
     * supplies, so putting another workspace's widget id on a slide made publish delete that
     * widget. Publishing must never be a way to reach outside the deck.
     *
     * published_widget_ids is written only by this function, so it is the server's own record of
     * what it made. Diffing against it is both complete and unforgeable.
     */
    const priorIds = Array.isArray(publishedWidgetIds) ? publishedWidgetIds.filter((v) => typeof v === 'string') : [];
    const keep = new Set(ownedNow.map((o) => o.widgetId));
    const dropped = priorIds.filter((id) => !keep.has(id));

    for (const widgetId of dropped) {
      db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND widget_id = ?').run(plId, widgetId);
      /*
       * ⚠️ THE WIDGET ITSELF GOES ONLY IF NOTHING ELSE PLAYS IT. A slide removed from a deck is
       * usually rubbish nobody wants, but "usually" is not a licence to delete: the same widget can
       * have been added to another playlist by hand, and deleting it there would blank a screen
       * somebody else owns. Checked against every playlist, not just this one.
       */
      const stillUsed = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE widget_id = ?').get(widgetId).n;
      // ⚠️ Belt and braces on the workspace even here. priorIds is server-written so it should
      // never name a foreign widget — but a delete is the one operation where "should never" is
      // not good enough, and the clause costs nothing.
      if (!stillUsed) {
        db.prepare("DELETE FROM widgets WHERE id = ? AND widget_type = 'slide' AND workspace_id IS ?")
          .run(widgetId, wsId);
      }
    }

    // ---------------------------------------------------------------- order and dwell
    /*
     * ⚠️ UPSERT, NOT REBUILD. Deleting every row and re-inserting would be three lines shorter and
     * would throw away per-item state the deck does not model — schedules, zone, mute — which an
     * operator may have set on these items by hand. It would also churn item ids for no reason.
     */
    for (const o of ownedNow) {
      const row = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? AND widget_id = ?')
        .get(plId, o.widgetId);
      if (row) {
        db.prepare('UPDATE playlist_items SET sort_order = ?, duration_sec = ?, updated_at = ? WHERE id = ?')
          .run(o.sort, o.dwell, ts, row.id);
      } else {
        db.prepare(`INSERT INTO playlist_items (playlist_id, widget_id, sort_order, duration_sec, created_at, updated_at)
                    VALUES (?,?,?,?,?,?)`).run(plId, o.widgetId, o.sort, o.dwell, ts, ts);
      }
    }

    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(ts, plId);
    return {
      playlistId: plId,
      slideCount: normalized.slides.length,
      removed: dropped.length,
      // The caller MUST persist this — it is the only record of what publish created, and the next
      // publish cannot work out what to remove without it.
      publishedWidgetIds: ownedNow.map((o) => o.widgetId),
    };
  });

  const result = run();
  return { ...result, doc: normalized, warnings: deckWarnings(normalized) };
}

module.exports = {
  MAX_SLIDES, MIN_DWELL, MAX_DWELL,
  normalizeDeck, deckWarnings, publishDeck,
  ASPECTS,
};
