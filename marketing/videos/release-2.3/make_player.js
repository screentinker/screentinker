/* Runs INSIDE the alpha container. Publishes the 2.1 launch video onto a web-player display so it
 * can be watched in-system. content -> playlist(published) -> device(playlist assigned) + enrol key.
 * Idempotent: removes any prior vid21-launch-* rows first. Prints the /player?k= watch URL. */
const fs = require('fs');
const m = require('/app/server/db/database'); const D = m.db || m;
const WS = '4fd37c57-d8ce-4c30-b944-97d296d8b2d0';
const USER = 'ac1f96de-f321-4d24-9980-b79407d50a45';
const crypto = require('crypto');

const CID = 'vid21-launch-video';
const PID = 'vid21-launch-pl';
const DID = 'vid21-launch-dev';
const FILE = 'vid21-launch.mp4';
const ABS = '/data/uploads/content/' + FILE;
const DUR = 175;

// clean any prior run
D.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(PID);
D.prepare('DELETE FROM playlists WHERE id = ?').run(PID);
D.prepare('DELETE FROM devices WHERE id = ?').run(DID);
D.prepare('DELETE FROM content WHERE id = ?').run(CID);

const size = fs.statSync(ABS).size;
D.prepare(`INSERT INTO content
  (id,user_id,filename,filepath,mime_type,file_size,duration_sec,width,height,workspace_id,is_active,unstable_connection,captions_enabled,created_at,updated_at)
  VALUES (@id,@u,@fn,@fp,'video/mp4',@sz,@dur,1920,1080,@ws,1,0,0,strftime('%s','now'),strftime('%s','now'))`)
  .run({ id:CID, u:USER, fn:'ScreenTinker 2.1 launch.mp4', fp:FILE, sz:size, dur:DUR, ws:WS });

D.prepare(`INSERT INTO playlists
  (id,user_id,name,is_auto_generated,status,workspace_id,created_at,updated_at)
  VALUES (@id,@u,@name,0,'draft',@ws,strftime('%s','now'),strftime('%s','now'))`)
  .run({ id:PID, u:USER, name:'ScreenTinker 2.1 Launch Video', ws:WS });

D.prepare(`INSERT INTO playlist_items
  (playlist_id,content_id,sort_order,duration_sec,muted,created_at,updated_at)
  VALUES (@pl,@c,0,@dur,0,strftime('%s','now'),strftime('%s','now'))`)
  .run({ pl:PID, c:CID, dur:DUR });

// publish via the app's own path (writes published_snapshot). Socket push may no-op offline — the
// snapshot is committed before that, so wrap it.
const { publishPlaylist } = require('/app/server/routes/playlists');
try { const r = publishPlaylist(PID, null); console.log('published:', JSON.stringify(r)); }
catch (e) { console.log('publish push warned (snapshot still written):', e.message); }

// web-player display, playlist assigned, with a device_token + enrol key
D.prepare(`INSERT INTO devices (id,name,user_id,workspace_id,status,playlist_id,device_token,settings_pin,client_type,created_at,updated_at)
  VALUES (@id,@name,@u,@ws,'offline',@pl,@tok,@pin,'web',strftime('%s','now'),strftime('%s','now'))`)
  .run({ id:DID, name:'2.1 Launch Video (watch)', u:USER, ws:WS, pl:PID,
         tok:crypto.randomBytes(32).toString('hex'), pin:String(Math.floor(100000+Math.random()*900000)) });

const enrol = require('/app/server/lib/enrol-key');
const key = enrol.setEnrolKey(D, DID);
console.log('WATCH_URL=https://alpha.screentinker.com/player?k=' + key);
