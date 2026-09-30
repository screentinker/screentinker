/* Runs INSIDE the alpha container. Builds a playlist of the 12 real slide widgets (each narrated by
 * its own VO + shared music bed) and points the watch display at it, so the PLAYER plays the actual
 * slides driven from alpha. Tagged vid21-. Prints the watch URL. */
const fs = require('fs');
const m = require('/app/server/db/database'); const D = m.db || m;
const WS = '4fd37c57-d8ce-4c30-b944-97d296d8b2d0';
const USER = 'ac1f96de-f321-4d24-9980-b79407d50a45';
const PID = 'vid21-slides-pl';
const DID = 'vid21-launch-dev';
const now = Math.floor(Date.now()/1000);
const durs = JSON.parse(fs.readFileSync('/tmp/durations.json','utf8'));

D.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(PID);
D.prepare('DELETE FROM playlists WHERE id = ?').run(PID);

D.prepare(`INSERT INTO playlists (id,user_id,name,is_auto_generated,status,workspace_id,created_at,updated_at)
  VALUES (?,?,?,0,'draft',?,?,?)`).run(PID, USER, 'ScreenTinker 2.1 — Slides (narrated)', WS, now, now);

const it = D.prepare(`INSERT INTO playlist_items (playlist_id,widget_id,sort_order,duration_sec,muted,created_at,updated_at)
  VALUES (?,?,?,?,0,?,?)`);
for (let i=1;i<=12;i++){ const sid=`${i}`.padStart(2,'0');
  const dur = Math.round((durs[sid]||14) + 2);       // narration + ~2s hold
  it.run(PID, 'vid21-s'+sid, i-1, dur, now, now);
}

const { publishPlaylist } = require('/app/server/routes/playlists');
try { console.log('published:', JSON.stringify(publishPlaylist(PID, null))); }
catch(e){ console.log('publish push warned (snapshot written):', e.message); }

// point the existing watch display at the slides playlist
D.prepare("UPDATE devices SET playlist_id = ?, updated_at = ? WHERE id = ?").run(PID, now, DID);
const key = D.prepare('SELECT enrol_key FROM devices WHERE id = ?').get(DID).enrol_key;
console.log('WATCH_URL=https://alpha.screentinker.com/player?k=' + key);
