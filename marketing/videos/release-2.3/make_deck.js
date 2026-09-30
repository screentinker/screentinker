/* Runs INSIDE the alpha container. Builds the 12 scenes as a REAL SLIDE DECK (slide_decks row that
 * shows up in the Slides section), publishes it through the product's own deckLib.publishDeck (which
 * creates the slide widgets + playlist), and points the watch display at that playlist.
 * Cleans up the earlier hand-made widget approach (vid21-s*, vid21-slides-pl). */
const fs = require('fs');
const m = require('/app/server/db/database'); const D = m.db || m;
const deckLib = require('/app/server/lib/slide-deck');
const { publishPlaylist } = require('/app/server/routes/playlists');
const WS='4fd37c57-d8ce-4c30-b944-97d296d8b2d0';
const USER='ac1f96de-f321-4d24-9980-b79407d50a45';
const DECK='vid21-deck', DID='vid21-launch-dev';
const now = Math.floor(Date.now()/1000);
const durs = JSON.parse(fs.readFileSync('/tmp/durations.json','utf8'));
const slides = JSON.parse(fs.readFileSync('/tmp/slides.json','utf8'));

const NAMES={s01:'Everything new',s02:'Live view',s03:'Talk',s04:'Data sources',s05:'Meeting-room signs',
 s06:'Plugins',s07:'Plugins — approve to run',s08:'PDF to playlist',s09:'Review & version history',
 s10:'More screens',s11:'Player polish',s12:'Hosted or self-host',s13:'Built & tested in ScreenTinker'};

// deck document: slides carry their own VO; the bed + aspect are deck-level.
const doc = { aspect:'16:9', music:'vid21-music', music_volume:0.28, slides:[] };
for (const [sid,v] of Object.entries(slides)){
  const t=v.config.template, num=sid.slice(1);
  doc.slides.push({
    id: sid,
    name: NAMES[sid] || sid,
    dwell_sec: Math.round((durs[num]||14)+2),
    template: { background:t.background, audio:{ vo:t.audio.vo, vo_volume:1 }, elements:t.elements },
    fields: v.config.fields,
  });
}

// remove the earlier widget-based approach
D.prepare("DELETE FROM playlist_items WHERE playlist_id = 'vid21-slides-pl'").run();
D.prepare("DELETE FROM playlists WHERE id = 'vid21-slides-pl'").run();
D.prepare("DELETE FROM widgets WHERE id LIKE 'vid21-s%'").run();

// (re)create the deck row
D.prepare("DELETE FROM slide_decks WHERE id = ?").run(DECK);
D.prepare(`INSERT INTO slide_decks (id,workspace_id,user_id,name,doc,created_at,updated_at,published_widget_ids)
  VALUES (?,?,?,?,?,?,?,?)`).run(DECK, WS, USER, 'ScreenTinker 2.1 — What’s New', JSON.stringify(doc), now, now, '[]');

const deck = D.prepare('SELECT * FROM slide_decks WHERE id = ?').get(DECK);
const out = deckLib.publishDeck(D, { deck, doc, userId:USER, publishedWidgetIds:[] });
D.prepare('UPDATE slide_decks SET doc=?, playlist_id=?, published_widget_ids=?, updated_at=? WHERE id=?')
  .run(JSON.stringify(out.doc), out.playlistId, JSON.stringify(out.publishedWidgetIds), now, DECK);
try { publishPlaylist(out.playlistId, null); } catch(e){ console.log('pl push warn:', e.message); }

// point the watch display at the deck's playlist
D.prepare("UPDATE devices SET playlist_id=?, updated_at=? WHERE id=?").run(out.playlistId, now, DID);
const key = D.prepare('SELECT enrol_key FROM devices WHERE id = ?').get(DID).enrol_key;
// ordered widget ids straight from the published playlist (for frame rendering the mp4)
const ordered = D.prepare('SELECT widget_id FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order ASC').all(out.playlistId).map(r=>r.widget_id);
fs.writeFileSync('/tmp/deck_widgets.json', JSON.stringify(ordered));
console.log('deck', DECK, '-> playlist', out.playlistId, 'widgets', out.publishedWidgetIds.length);
console.log('ORDERED=' + JSON.stringify(ordered));
console.log('WATCH_URL=https://alpha.screentinker.com/player?k=' + key);
