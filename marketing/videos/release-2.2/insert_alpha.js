/* Runs INSIDE the alpha container. Inserts: image content (screenshots), audio content (12 VO clips
 * + 1 music bed), and the 12 slide widgets. All tagged vid21- for clean deletion. Idempotent. */
const fs = require('fs');
const m = require('/app/server/db/database'); const D = m.db || m;
const WS = '4fd37c57-d8ce-4c30-b944-97d296d8b2d0';
const USER = 'ac1f96de-f321-4d24-9980-b79407d50a45';
const now = () => Math.floor(Date.now()/1000);
const CDIR = '/data/uploads/content/';

// content only — the slide DECK (make_deck.js) owns the widgets + playlist.
D.prepare("DELETE FROM content WHERE id LIKE 'vid21-cap-%' OR id LIKE 'vid21-vo-%' OR id = 'vid21-music'").run();

const slides = JSON.parse(fs.readFileSync('/tmp/slides.json','utf8'));

const cContent = D.prepare(`INSERT INTO content
  (id,user_id,filename,filepath,mime_type,file_size,width,height,workspace_id,is_active,unstable_connection,captions_enabled,created_at,updated_at)
  VALUES (@id,@u,@fn,@fp,@mime,@sz,@w,@h,@ws,1,0,0,@t,@t)`);

// images referenced by slides
const caps = new Set(); Object.values(slides).forEach(s => s.content_ids.forEach(c => caps.add(c)));
for (const id of caps) {
  const fp = id + '.png'; const abs = CDIR + fp;
  cContent.run({ id, u:USER, fn:fp, fp, mime:'image/png', sz:fs.statSync(abs).size, w:3200, h:1800, ws:WS, t:now() });
}
// audio: 13 VO + music (mp3 bytes)
for (let i=1;i<=13;i++){ const sid=`${i}`.padStart(2,'0'); const id=`vid21-vo-${sid}`; const fp=id+'.mp3';
  cContent.run({ id, u:USER, fn:`ScreenTinker 2.1 VO ${sid}.mp3`, fp, mime:'audio/mpeg', sz:fs.statSync(CDIR+fp).size, w:null, h:null, ws:WS, t:now() }); }
cContent.run({ id:'vid21-music', u:USER, fn:'Quiet Tech Pulse.mp3', fp:'vid21-music.mp3', mime:'audio/mpeg', sz:fs.statSync(CDIR+'vid21-music.mp3').size, w:null, h:null, ws:WS, t:now() });
console.log('content:', caps.size, 'img + 13 audio + music');
