/* Runs INSIDE the alpha container. Removes ONLY the 2.1 video demo objects, scoped to workspace
 * 4fd37c57 and the vid21-/"ScreenTinker 2.1" naming. Protects the pre-existing 2.0 deck. Reports
 * counts. */
const m = require('/app/server/db/database'); const D = m.db || m;
const WS = '4fd37c57-d8ce-4c30-b944-97d296d8b2d0';
const rep = {};

// --- collect deck-published playlists + widgets (uuid ids), by the deck's own name
const DECK_NAME = 'ScreenTinker 2.1 — What’s New';
const plRows = D.prepare(
  "SELECT id FROM playlists WHERE workspace_id=? AND (id LIKE 'vid21-%' OR name=? OR name='ScreenTinker 2.1 — Slides (narrated)' OR name='ScreenTinker 2.1 Launch Video')"
).all(WS, DECK_NAME).map(r=>r.id);

const wRows = D.prepare(
  "SELECT id FROM widgets WHERE workspace_id=? AND (id LIKE 'vid21-%' OR name LIKE ? )"
).all(WS, DECK_NAME + ' — %').map(r=>r.id);

// --- deletes (children first)
let n=0;
for (const pid of plRows) n += D.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(pid).changes;
rep.playlist_items = n;
rep.playlists = plRows.reduce((a,pid)=>a+D.prepare('DELETE FROM playlists WHERE id=?').run(pid).changes,0);
rep.widgets = wRows.reduce((a,wid)=>a+D.prepare('DELETE FROM widgets WHERE id=?').run(wid).changes,0);
rep.revisions = D.prepare("DELETE FROM revisions WHERE workspace_id=? AND resource_id LIKE 'vid21-%'").run(WS).changes;
rep.slide_decks = D.prepare("DELETE FROM slide_decks WHERE workspace_id=? AND id LIKE 'vid21-%'").run(WS).changes;
rep.devices = D.prepare("DELETE FROM devices WHERE workspace_id=? AND id LIKE 'vid21-%'").run(WS).changes;
rep.content = D.prepare("DELETE FROM content WHERE workspace_id=? AND id LIKE 'vid21-%'").run(WS).changes;

console.log('DELETED ' + JSON.stringify(rep));
// leftover check
const left = {
  widgets: D.prepare("SELECT COUNT(*) c FROM widgets WHERE id LIKE 'vid21-%' OR name LIKE ?").get(DECK_NAME+' — %').c,
  playlists: D.prepare("SELECT COUNT(*) c FROM playlists WHERE id LIKE 'vid21-%' OR name=? OR name LIKE 'ScreenTinker 2.1 —%' OR name='ScreenTinker 2.1 Launch Video'").get(DECK_NAME).c,
  content: D.prepare("SELECT COUNT(*) c FROM content WHERE id LIKE 'vid21-%'").get().c,
  decks: D.prepare("SELECT COUNT(*) c FROM slide_decks WHERE id LIKE 'vid21-%'").get().c,
  devices: D.prepare("SELECT COUNT(*) c FROM devices WHERE id LIKE 'vid21-%'").get().c,
};
console.log('LEFTOVER ' + JSON.stringify(left));
// confirm the 2.0 deck is untouched
const twoO = D.prepare("SELECT COUNT(*) c FROM slide_decks WHERE name LIKE '%2.0%'").get().c;
console.log('protected 2.0 decks still present:', twoO);
