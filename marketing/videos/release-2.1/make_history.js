/* Runs INSIDE the alpha container. Creates one nice demo slide widget with a realistic 4-entry
 * version history, so the review scene can show the real version-history modal. Tagged vid21-. */
const crypto = require('crypto');
const m = require('/app/server/db/database'); const D = m.db || m;
const WS = '4fd37c57-d8ce-4c30-b944-97d296d8b2d0';
const USER = 'ac1f96de-f321-4d24-9980-b79407d50a45';
const WID = 'vid21-hist';

const BG='#0e1420', INK='#e9eef5', SUB='#93a1b4', GREEN='#34d399';
const el=(kind,slot,x,y,w,h,style)=>({kind,slot,box:{x,y,w,h},style});
function menuConfig(special){
  const els=[
    el('body','eyebrow',6,7,60,6,{color:GREEN,font:'jetbrains-mono',size_cqw:1.2,weight:700}),
    el('head','title',6,13,80,12,{color:INK,font:'archivo',size_cqw:4.2,weight:800}),
    el('box',null,6,26,40,0.5,{color:GREEN,radius_cqw:0.3}),
  ];
  const items=[['Roast chicken & greens','9.50'],['Butternut soup',special],['Pasta primavera','8.00'],['Chef salad','7.25']];
  items.forEach((it,i)=>{
    const y=32+i*11;
    els.push(el('body','i'+i,6,y,60,8,{color:INK,font:'inter',size_cqw:1.9,weight:400}));
    els.push(el('body','p'+i,72,y,20,8,{color:GREEN,font:'jetbrains-mono',size_cqw:1.9,weight:700,align:'right'}));
  });
  els.push(el('body','foot',6,82,80,8,{color:SUB,font:'inter',size_cqw:1.2,weight:400}));
  const fields={eyebrow:'TODAY · CAFETERIA',title:'Cafeteria Menu',foot:'Served 11:30 to 14:00 · Level 2 dining hall',
    i0:'Roast chicken & greens',p0:'9.50',i1:'Butternut soup',p1:special,i2:'Pasta primavera',p2:'8.00',i3:'Chef salad',p3:'7.25'};
  return {template:{aspect:'16:9',background:BG,elements:els},fields};
}
const state=(special)=>({name:'Cafeteria Menu',widget_type:'slide',config:menuConfig(special)});

// clean prior
D.prepare('DELETE FROM revisions WHERE resource_id = ?').run(WID);
D.prepare('DELETE FROM widgets WHERE id = ?').run(WID);

// current widget = latest state
const live = state('3.50');
D.prepare(`INSERT INTO widgets (id,user_id,widget_type,name,config,workspace_id,created_at,updated_at)
  VALUES (?,?,'slide','Cafeteria Menu',?,?,strftime('%s','now'),strftime('%s','now'))`)
  .run(WID, USER, JSON.stringify(live.config), WS);

const now = Math.floor(Date.now()/1000);
const DAY=86400;
const revs=[
  {rev_no:1, ago:6*DAY, kind:'baseline', label:null, summary:'Baseline: imported from last term', special:'4.00', baseline:1, pub:false},
  {rev_no:2, ago:3*DAY, kind:'user', label:'Dana Powell', summary:'Autumn menu + new dishes', special:'4.00', baseline:0, pub:false},
  {rev_no:3, ago:1*DAY, kind:'user', label:'Marco Reyes', summary:'Corrected soup price', special:'3.75', baseline:0, pub:false},
  {rev_no:4, ago:2*3600, kind:'user', label:'Dana Powell', summary:'Lowered soup to weekly special', special:'3.50', baseline:0, pub:true},
];
const ins=D.prepare(`INSERT INTO revisions
 (id,workspace_id,resource_type,resource_id,rev_no,created_at,actor_user_id,actor_kind,actor_label,summary,state,state_hash,file_ref,thumb_ref,parent_id,submission_id,published_at,published_by,is_baseline)
 VALUES (@id,@ws,'widget',@rid,@rev,@created,@auid,@kind,@label,@summary,@state,@hash,NULL,NULL,@parent,NULL,@pub,@pubby,@baseline)`);
let parent=null;
for(const r of revs){
  const st=JSON.stringify(state(r.special));
  const id=crypto.randomUUID();
  ins.run({id,ws:WS,rid:WID,rev:r.rev_no,created:now-r.ago,
    auid:r.kind==='user'?USER:null,kind:r.kind,label:r.label,summary:r.summary,
    state:st,hash:crypto.createHash('sha256').update(st).digest('hex'),
    parent,pub:r.pub?(now-r.ago):null,pubby:r.pub?USER:null,baseline:r.baseline});
  parent=id;
}
console.log('created widget', WID, 'with', revs.length, 'revisions');
