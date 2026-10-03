#!/usr/bin/env node
/*
 * Build the 12 video scenes AS REAL SCREENTINKER SLIDES, with every element's entrance timed to
 * WHEN IT IS SPOKEN (cue -> word timestamp from timings.json), and each slide carrying its own
 * voiceover + a shared music bed so the alpha PLAYER narrates the real slides.
 *
 * Output slides.json: { "s01": {content_ids:[...], config:{template,fields}}, ... }
 * Colours MUST be #hex. Sizes are cqw (~% of 1920). Motion delays are seconds into the scene.
 */
const fs = require('fs');
const TIM = JSON.parse(fs.readFileSync('timings.json', 'utf8'));

const BG='#0e1420', INK='#e9eef5', SUB='#93a1b4', GREEN='#34d399', BLUE='#5aa0ff';
const FRAME='#1c2b40', CARD='#0b1220', CHIP='#16233a', CHIPINK='#7fe3b0';
const FDISP='archivo', FTEXT='inter', FMONO='jetbrains-mono';
const MUSIC_VOL = 0.28;

// cue resolver: forward-only match of a phrase's first word to its spoken timestamp.
function mkcue(sid){
  const words = (TIM[sid]||[]).map(([w,t]) => [w.toLowerCase().replace(/[^a-z0-9]/g,''), t]);
  const last = words.length ? words[words.length-1][1] : 12;
  let idx = 0;
  return (phrase, lead=0.18) => {
    if (phrase == null) return 0;
    const first = phrase.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g,'');
    for (let i=idx;i<words.length;i++){
      const w = words[i][0];
      if (w===first || w.startsWith(first) || (first.length>=3 && first.startsWith(w))){ idx=i+1; return Math.max(0, +(words[i][1]-lead).toFixed(2)); }
    }
    return Math.min(last, idx<words.length ? words[idx][1] : last);
  };
}

const M = {
  fade:(d,dur=0.7)=>({animation:'fade',delay:d,duration:dur,easing:'ease-out'}),
  up:(d,dur=0.65)=>({animation:'slideU',delay:d,duration:dur,easing:'soft'}),
  down:(d,dur=0.6)=>({animation:'slideD',delay:d,duration:dur,easing:'soft'}),
  left:(d,dur=0.8)=>({animation:'slideL',delay:d,duration:dur,easing:'soft'}),
  right:(d,dur=0.6)=>({animation:'slideR',delay:d,duration:dur,easing:'soft'}),
  zoom:(d,dur=0.8)=>({animation:'zoom',delay:d,duration:dur,easing:'soft'}),
  wipe:(d,dur=0.55)=>({animation:'wipe',delay:d,duration:dur,easing:'ease-out'}),
};

function Slide(sid){
  const els=[], fields={}; let n=0; const cids=[];
  const api={
    txt(kind,text,box,style,motion){ const slot='t'+(n++); fields[slot]=text; const e={kind,slot,box,style}; if(motion)e.motion=motion; els.push(e); return e; },
    box(box,color,radius,motion){ const e={kind:'box',box,style:{color,radius_cqw:radius||0}}; if(motion)e.motion=motion; els.push(e); return e; },
    img(cid,box,radius,motion){ cids.push(cid); const e={kind:'image',content_id:cid,box,style:{radius_cqw:radius||0}}; if(motion)e.motion=motion; els.push(e); return e; },
    build(){ return { content_ids:cids, config:{ template:{ aspect:'16:9', background:BG,
        audio:{ vo:`vid21-vo-${sid}`, vo_volume:1, music:'vid21-music', music_volume:MUSIC_VOL },
        elements:els }, fields } }; },
  };
  return api;
}

// chrome (fixed early reveals)
const eyebrow=(s,t)=>s.txt('body',t,{x:6.5,y:7.4,w:60},{color:GREEN,font:FMONO,size_cqw:1.15,weight:700,align:'left'},M.right(0.12));
function verchip(s){ s.box({x:88.5,y:6.6,w:5,h:4.6},GREEN,0.9,M.down(0.08,0.5)); s.txt('body','2.1',{x:88.5,y:7.4,w:5},{color:'#08110b',font:FMONO,size_cqw:1.5,weight:700,align:'center'},M.down(0.16,0.5)); }
const accentbar=(s,d=0.25,y=19.2)=>s.box({x:6.6,y,w:7,h:0.55},GREEN,0.3,M.wipe(d));

// timed content
function headL(s,l1,l2,d1,d2,y=27){
  s.txt('head',l1,{x:6.5,y,w:44},{color:INK,font:FDISP,size_cqw:3.5,weight:800,align:'left'},M.up(d1));
  s.txt('head',l2,{x:6.5,y:y+6.8,w:44},{color:GREEN,font:FDISP,size_cqw:3.5,weight:800,align:'left'},M.up(d2));
}
const subL=(s,t,d,y=49)=>s.txt('body',t,{x:6.6,y,w:40},{color:SUB,font:FTEXT,size_cqw:1.55,weight:400,align:'left'},M.fade(d));
function headBig(s,l1,l2,d1,d2,y=22){
  s.txt('head',l1,{x:6.5,y,w:86},{color:INK,font:FDISP,size_cqw:4.6,weight:800,align:'left'},M.up(d1));
  s.txt('head',l2,{x:6.5,y:y+8.2,w:86},{color:GREEN,font:FDISP,size_cqw:4.6,weight:800,align:'left'},M.up(d2));
}
function shot(s,cid,d,y=15.5){
  s.box({x:49.4,y:y-0.7,w:47.4,h:47.4},FRAME,1.2,M.left(Math.max(0,d-0.08)));
  s.img(cid,{x:50,y,w:46,h:46},0.9,M.left(d));
}
// pill row: each chip reveals at its own cue [display, delay]
function pills(s,items,y=61,x0=6.6){
  let x=x0;
  for(const [txt,d] of items){
    const w=Math.max(4.2, txt.length*0.6+1.7);
    s.box({x,y,w,h:3.3},CHIP,0.7,M.up(d,0.45));
    s.txt('body',txt,{x,y:y+0.7,w},{color:CHIPINK,font:FMONO,size_cqw:1.0,weight:700,align:'center'},M.up(d,0.45));
    x+=w+1.0;
  }
}
// card row: [title, sub, delay]
function cards(s,items,accent=GREEN,y0=52){
  const gap=1.6, w=(86-gap*(items.length-1))/items.length;
  items.forEach((it,i)=>{ const x=6.5+i*(w+gap), d=it[2];
    s.box({x,y:y0,w,h:26},CARD,1.1,M.up(d));
    s.box({x,y:y0,w,h:0.5},accent,0.3,M.wipe(d+0.12));
    s.txt('body',it[0],{x:x+1.6,y:y0+3.0,w:w-3.2},{color:INK,font:FDISP,size_cqw:1.7,weight:800,align:'left'},M.up(d+0.06));
    s.txt('body',it[1],{x:x+1.6,y:y0+9.5,w:w-3.2},{color:SUB,font:FTEXT,size_cqw:1.15,weight:400,align:'left'},M.up(d+0.12));
  });
}

const S={};
// ---- 01 opener
{ const s=Slide('01'), c=mkcue('01');
  eyebrow(s,'SCREENTINKER  ·  2.1'); verchip(s); accentbar(s);
  headL(s,'Everything new','since 2.0', c('Since'), c('two point oh'));
  subL(s,'The open-source signage platform picked up live video, voice, live data and a plugin system.', c('open-source'));
  shot(s,'vid21-cap-dashboard', c('signage platform'));
  pills(s,[['Live video',c('live video')],['Talk',c('voice')],['Data sources',c('live data')],['Plugins',c('plugin system')]]);
  S.s01=s.build(); }
// ---- 02 live view
{ const s=Slide('02'), c=mkcue('02');
  eyebrow(s,"WHAT'S NEW  ·  LIVE VIEW"); verchip(s); accentbar(s);
  headL(s,'Watch what a screen','is actually showing', c('watch'), c('actually showing'));
  subL(s,"A display's real output, streamed sub-second. Not a thumbnail from a minute ago.", c('Live view'));
  shot(s,'vid21-cap-dashboard', c('real output'));
  pills(s,[['WebRTC',c('web')],['Real output',c('not a thumbnail')],['Off by default',c('off until')]]);
  S.s02=s.build(); }
// ---- 03 Talk (statement)
{ const s=Slide('03'), c=mkcue('03');
  eyebrow(s,"WHAT'S NEW  ·  TALK"); verchip(s); accentbar(s);
  headBig(s,'Talk to','your screens', c('talk back'), c('your screens'));
  cards(s,[
    ['Page a lobby','Or make an announcement across a whole building.', c('Page a single')],
    ['Off by default','Enabled per organization when you want it.', c('Off by default')],
    ['Your own relay','Per-org TURN / STUN — the audio path is yours.', c('your own relay')],
  ]);
  S.s03=s.build(); }
// ---- 04 data sources
{ const s=Slide('04'), c=mkcue('04');
  eyebrow(s,"WHAT'S NEW  ·  DATA SOURCES"); verchip(s); accentbar(s);
  headL(s,'Live data,','right on your slides', c('Slides can'), c('live data'));
  subL(s,'Register a calendar or any JSON feed, then bind its values straight into a slide.', c('Register'));
  shot(s,'vid21-cap-data-sources', c('bind its values'));
  pills(s,[['{{ds:slug.field}}',c('simple tag')],['Calendar or JSON',c('calendar')],['Refreshes on schedule',c('refreshes')]]);
  S.s04=s.build(); }
// ---- 05 room signs (cards)
{ const s=Slide('05'), c=mkcue('05');
  eyebrow(s,"WHAT'S NEW  ·  MEETING-ROOM SIGNS"); verchip(s); accentbar(s);
  headBig(s,'Busy or Available,','in every language', c('Busy or'), c('every language'), 20);
  const langs=[['ENGLISH','Available','Free all day'],['NEDERLANDS','Beschikbaar','De hele dag vrij'],
               ['ESPANOL','Disponible','Libre todo el dia'],['DEUTSCH','Frei','Ganztaegig frei']];
  const base=c('shows Busy'), gap=1.6, w=(86-gap*3)/4;
  langs.forEach((l,i)=>{ const x=6.5+i*(w+gap), y=50, d=base+i*0.28;
    s.box({x,y,w,h:30},CARD,1.1,M.up(d));
    s.box({x,y,w,h:0.5},BLUE,0.3,M.wipe(d+0.12));
    s.txt('body',l[0],{x:x+1.5,y:y+2.6,w:w-3},{color:BLUE,font:FMONO,size_cqw:1.0,weight:700,align:'left'},M.up(d+0.05));
    s.txt('body','Green Room',{x:x+1.5,y:y+6.5,w:w-3},{color:SUB,font:FTEXT,size_cqw:1.05,weight:400,align:'left'},M.up(d+0.08));
    s.txt('body',l[1],{x:x+1.5,y:y+12.0,w:w-3},{color:GREEN,font:FDISP,size_cqw:2.0,weight:800,align:'left'},M.up(d+0.12));
    s.txt('body',l[2],{x:x+1.5,y:y+19.5,w:w-3},{color:INK,font:FTEXT,size_cqw:1.1,weight:400,align:'left'},M.up(d+0.16));
  });
  S.s05=s.build(); }
// ---- 06 plugins
{ const s=Slide('06'), c=mkcue('06');
  eyebrow(s,'2.1  ·  PLUGINS'); verchip(s); accentbar(s);
  headL(s,'Extend it','without forking', c('plugin system'), c('without forking'));
  subL(s,'Add new widget types, data connectors and event hooks on a server you host.', c('server you host'));
  shot(s,'vid21-cap-plugins', c('widget types'));
  pills(s,[['Widgets',c('widget types')],['Data connectors',c('data connectors')],['Hooks',c('event hooks')],['Off by default',c('off by default')]]);
  S.s06=s.build(); }
// ---- 07 plugins trust
{ const s=Slide('07'), c=mkcue('07');
  eyebrow(s,'2.1  ·  PLUGINS'); verchip(s); accentbar(s);
  headL(s,'Approve the exact','bytes that run', c('administrator sees'), c('exact bytes'));
  shot(s,'vid21-cap-plugins', c('one place'));
  subL(s,"An admin sees each plugin, what it may do, and the precise tree — before it runs.", c('allowed to do'));
  pills(s,[['No marketplace',c('No marketplace')],['No phone-home',c('phone-home')],['Code you trust',c('chose to trust')]]);
  S.s07=s.build(); }
// ---- 08 PDF (statement)
{ const s=Slide('08'), c=mkcue('08');
  eyebrow(s,'2.1  ·  PDF TO PLAYLIST'); verchip(s); accentbar(s);
  headBig(s,'Drop a PDF,','get a playlist', c('Drop it'), c('every page'));
  cards(s,[
    ['One slide per page','In order, full-screen, exactly as the deck reads.', c('every page')],
    ['No conversion step','Rendered right in your browser. No extra tools.', c('right in your browser')],
    ['A deck, ready to play','Export a presentation to PDF and drop it in.', c('ready to play')],
  ]);
  S.s08=s.build(); }
// ---- 09 teams / version history
{ const s=Slide('09'), c=mkcue('09');
  eyebrow(s,"WHAT'S NEW  ·  TEAMS"); verchip(s); accentbar(s);
  headL(s,'Review before','it goes live', c('approval'), c('goes live'));
  shot(s,'vid21-cap-history', c('version history'));
  subL(s,'Require approval on a change, and keep every past version to roll back to.', c('past versions'));
  pills(s,[['Approval',c('approval and')],['Version history',c('version history')],['Roll back',c('roll back')]]);
  S.s09=s.build(); }
// ---- 10 more screens
{ const s=Slide('10'), c=mkcue('10');
  eyebrow(s,"WHAT'S NEW  ·  MORE SCREENS"); verchip(s); accentbar(s);
  headL(s,'More screens,','and a tested list', c('more screens'), c('certified hardware'));
  subL(s,'webOS panels, e-paper and microcontrollers — plus a published certified-hardware list.', c('webOS'));
  shot(s,'vid21-cap-certified', c('certified hardware'));
  pills(s,[['LG webOS',c('webOS')],['e-paper',c('e-paper')],['Certified list',c('certified')]]);
  S.s10=s.build(); }
// ---- 11 polish (statement)
{ const s=Slide('11'), c=mkcue('11');
  eyebrow(s,"WHAT'S NEW  ·  PLAYER POLISH"); verchip(s); accentbar(s);
  headBig(s,'Quieter,','sharper playback', c('quieter'), c('sharper'));
  cards(s,[
    ['Your own transition','Bring a transition shader, or use the crossfade.', c('transition shader')],
    ['No black flash','Video holds the last frame between clips.', c('flashes black')],
    ['Portrait, filled','Portrait panels driven in landscape fill the screen.', c('portrait panel')],
  ]);
  S.s11=s.build(); }
// ---- 12 CTA: hosted FIRST, then self-host
{ const s=Slide('12'), c=mkcue('12');
  s.txt('head','ScreenTinker 2.1',{x:6,y:9,w:88},{color:INK,font:FDISP,size_cqw:5.2,weight:800,align:'center'},M.up(0.2));
  s.box({x:36,y:20.5,w:28,h:0.55},GREEN,0.3,M.wipe(c('open source')));
  const dh=c('hosted option');
  s.box({x:9,y:27,w:38,h:34},CARD,1.4,M.up(dh));
  s.box({x:9,y:27,w:38,h:0.6},GREEN,0.3,M.wipe(dh+0.12));
  s.txt('body','HOSTED',{x:11,y:30,w:34},{color:GREEN,font:FMONO,size_cqw:1.1,weight:700,align:'left'},M.up(dh+0.06));
  s.txt('body','We run it for you',{x:11,y:34,w:34},{color:INK,font:FDISP,size_cqw:2.4,weight:800,align:'left'},M.up(dh+0.1));
  s.txt('body','Fully managed. Sign up and start putting things on screens — no server to keep.',{x:11,y:42,w:34},{color:SUB,font:FTEXT,size_cqw:1.2,weight:400,align:'left'},M.up(dh+0.16));
  s.txt('body','screentinker.com',{x:11,y:55,w:34},{color:GREEN,font:FMONO,size_cqw:1.25,weight:700,align:'left'},M.up(dh+0.22));
  const ds=c('host it yourself');
  s.box({x:53,y:27,w:38,h:34},CARD,1.4,M.up(ds));
  s.box({x:53,y:27,w:38,h:0.6},BLUE,0.3,M.wipe(ds+0.12));
  s.txt('body','SELF-HOST',{x:55,y:30,w:34},{color:BLUE,font:FMONO,size_cqw:1.1,weight:700,align:'left'},M.up(ds+0.06));
  s.txt('body','Run it yourself',{x:55,y:34,w:34},{color:INK,font:FDISP,size_cqw:2.4,weight:800,align:'left'},M.up(ds+0.1));
  s.txt('body','Open source, MIT. Upgrading is a pull and a restart, and your screens keep playing.',{x:55,y:42,w:34},{color:SUB,font:FTEXT,size_cqw:1.2,weight:400,align:'left'},M.up(ds+0.16));
  s.txt('body','github.com/screentinker/screentinker',{x:55,y:55,w:36},{color:BLUE,font:FMONO,size_cqw:1.1,weight:700,align:'left'},M.up(ds+0.22));
  s.txt('body','A star on the repository genuinely helps.',{x:6,y:66,w:88},{color:SUB,font:FTEXT,size_cqw:1.25,weight:400,align:'center'},M.fade(c('Links below')));
  S.s12=s.build(); }
// ---- 13 dogfood closer, with the deck running "on a screen" (browser bezel).
// The bezel + screen are STATIC (present from frame 0); in the mp4 a live recording of the deck is
// overlaid onto the screen rect (25%,23.5% .. 50%x50% => px 480,254,960,540). The text flies in.
{ const s=Slide('13'), c=mkcue('13');
  s.txt('body','DOGFOOD',{x:6,y:5.5,w:88},{color:GREEN,font:FMONO,size_cqw:1.2,weight:700,align:'center'},M.fade(c('One more')));
  s.txt('head','Built & tested in ScreenTinker',{x:4,y:9,w:92},{color:INK,font:FDISP,size_cqw:3.4,weight:800,align:'center'},M.up(c('built and')));
  // browser bezel (static)
  s.box({x:24,y:17.5,w:52,h:59},'#0a1017',1.3);
  s.box({x:24,y:17.5,w:52,h:5},'#141d2b',1.3);
  s.box({x:26,y:19.4,w:0.75,h:1.3},'#f2565b',0.6);
  s.box({x:27.3,y:19.4,w:0.75,h:1.3},'#f5b23c',0.6);
  s.box({x:28.6,y:19.4,w:0.75,h:1.3},'#34d399',0.6);
  s.txt('body','alpha.screentinker.com/player',{x:31,y:19.3,w:44},{color:'#6b7889',font:FMONO,size_cqw:0.95,weight:400,align:'left'});
  s.img('vid21-cap-console',{x:25,y:23.5,w:50,h:50},0.6);
  // sub
  s.txt('body','Every slide here is a real ScreenTinker slide, playing live on a ScreenTinker screen.',{x:10,y:79,w:80},{color:SUB,font:FTEXT,size_cqw:1.35,weight:400,align:'center'},M.fade(c('Every slide')));
  S.s13=s.build(); }

fs.writeFileSync('slides.json', JSON.stringify(S, null, 1));
// report the reveal schedule so timing is reviewable
for(const [sid,v] of Object.entries(S)){
  const ds=v.config.template.elements.filter(e=>e.motion).map(e=>e.motion.delay);
  console.log(`${sid}: ${v.config.template.elements.length} els, reveals ${Math.min(...ds).toFixed(1)}s..${Math.max(...ds).toFixed(1)}s`);
}
const ids=new Set(); Object.values(S).forEach(v=>v.content_ids.forEach(c=>ids.add(c)));
console.log('images:', [...ids].join(', '));
