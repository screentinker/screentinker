'use strict';
// Assembles a self-contained interactive demo (demo.html) from the REAL renderer.js + params.js +
// the shader library, so scrubbing it exercises the exact compositor the player will ship. Two
// signage-like images are drawn procedurally (no network assets). `node shared/Transitions/build-demo.js`.

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const gen = require('./generate-manifest.js');

const rendererSrc = fs.readFileSync(path.join(DIR, 'renderer.js'), 'utf8');
const paramsSrc = fs.readFileSync(path.join(DIR, 'params.js'), 'utf8');
const shaders = gen.build().map((e) => ({
  id: e.id, name: e.name, blurb: e.blurb, params: e.params,
  src: fs.readFileSync(path.join(DIR, e.file), 'utf8'),
}));

const DATA = JSON.stringify(shaders);

const html = `<title>Transition Compositor — live</title>
<style>
  :root{
    --bg:#f4f5f7; --panel:#ffffff; --ink:#1a1f2b; --muted:#5b6472; --line:#e2e6ec;
    --accent:#0891b2; --accent-ink:#ffffff; --shadow:0 1px 3px rgba(16,24,40,.08),0 8px 24px rgba(16,24,40,.06);
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0d1117; --panel:#161b22; --ink:#e6edf3; --muted:#8b949e; --line:#232b36; --accent:#22d3ee; --accent-ink:#04121a; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35); }
  }
  :root[data-theme="dark"]{ --bg:#0d1117; --panel:#161b22; --ink:#e6edf3; --muted:#8b949e; --line:#232b36; --accent:#22d3ee; --accent-ink:#04121a; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35); }
  :root[data-theme="light"]{ --bg:#f4f5f7; --panel:#ffffff; --ink:#1a1f2b; --muted:#5b6472; --line:#e2e6ec; --accent:#0891b2; --accent-ink:#ffffff; --shadow:0 1px 3px rgba(16,24,40,.08),0 8px 24px rgba(16,24,40,.06); }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 48px}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}
  h1{font-size:20px;letter-spacing:-.01em;margin:0;font-weight:650}
  .tag{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);border:1px solid var(--line);padding:5px 8px;border-radius:999px}
  .sub{color:var(--muted);margin:0 0 20px;font-size:13.5px}
  .stage{background:#000;border-radius:14px;overflow:hidden;box-shadow:var(--shadow);position:relative;aspect-ratio:16/9}
  canvas#gl{width:100%;height:100%;display:block}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:18px;margin-top:18px}
  .row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .row+.row{margin-top:16px}
  label.k{font-size:12px;color:var(--muted);min-width:76px;font-weight:600}
  select,button{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 12px}
  button.play{background:var(--accent);color:var(--accent-ink);border-color:transparent;font-weight:650;cursor:pointer;min-width:96px}
  select{cursor:pointer;min-width:190px}
  input[type=range]{flex:1;accent-color:var(--accent);min-width:180px}
  .val{font:600 12px/1 ui-monospace,Menlo,monospace;color:var(--muted);min-width:46px;text-align:right;font-variant-numeric:tabular-nums}
  .blurb{color:var(--muted);font-size:13px;margin:2px 0 0}
  .params{display:grid;grid-template-columns:1fr 1fr;gap:12px 22px;margin-top:4px}
  @media (max-width:640px){.params{grid-template-columns:1fr}}
  .p{display:flex;align-items:center;gap:10px}
  .p label{font-size:12px;min-width:88px;color:var(--muted)}
  .thumbs{display:flex;gap:12px;margin-top:14px}
  .thumb{flex:1}
  .thumb canvas{width:100%;border-radius:9px;border:1px solid var(--line);display:block;aspect-ratio:16/9}
  .thumb span{font-size:11px;color:var(--muted);display:block;margin-top:5px;letter-spacing:.04em;text-transform:uppercase;font-weight:600}
  .note{font-size:12px;color:var(--muted);margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
  code{font:600 12px ui-monospace,Menlo,monospace;color:var(--accent)}
</style>

<div class="wrap">
  <header>
    <h1>Transition Compositor</h1><span class="tag">live · renderer.js</span>
  </header>
  <p class="sub">The actual WebGL compositor the player will ship — running in <em>your</em> browser (real GPU). Two local images, one shader, scrub <code>progress</code> 0 → 1.</p>

  <div class="stage"><canvas id="gl" width="1280" height="720"></canvas></div>

  <div class="panel">
    <div class="row">
      <label class="k" for="shader">Shader</label>
      <select id="shader"></select>
      <button class="play" id="play">Play</button>
    </div>
    <p class="blurb" id="blurb"></p>
    <div class="row">
      <label class="k" for="prog">progress</label>
      <input type="range" id="prog" min="0" max="1000" value="0">
      <span class="val" id="progv">0.000</span>
    </div>
    <div class="params" id="params"></div>
    <div class="thumbs">
      <div class="thumb"><canvas id="thA" width="320" height="180"></canvas><span>uFrom — image A</span></div>
      <div class="thumb"><canvas id="thB" width="320" height="180"></canvas><span>uTo — image B</span></div>
    </div>
    <p class="note">progress 0 = pure A, 1 = pure B. A stays live in <code>uFrom</code> the whole time — no blank seam. Shader source, params, and this compositor are the exact files under <code>shared/Transitions/</code>.</p>
  </div>
</div>

<script>${paramsSrc}</script>
<script>${rendererSrc}</script>
<script>
const SHADERS = ${DATA};
// PREAMBLE / EPILOGUE / VERTEX / resolveParams are globals from the inlined params.js above.

// --- draw two distinct signage-like source images (no network assets) ---
function paint(cvs, variant){
  const c = cvs.getContext('2d'), w = cvs.width, h = cvs.height;
  const g = c.createLinearGradient(0,0,w,h);
  if(variant==='A'){ g.addColorStop(0,'#f97316'); g.addColorStop(1,'#b91c1c'); }
  else { g.addColorStop(0,'#0ea5e9'); g.addColorStop(1,'#155e75'); }
  c.fillStyle=g; c.fillRect(0,0,w,h);
  c.fillStyle='rgba(255,255,255,.14)';
  for(let i=0;i<6;i++){ c.beginPath(); c.arc(variant==='A'?w*0.8:w*0.2, h*0.5, (i+1)*h*0.11, 0, 7); c.fill(); }
  c.fillStyle='#fff'; c.textBaseline='middle';
  c.font='700 '+Math.round(h*0.16)+'px ui-sans-serif,system-ui,sans-serif';
  c.fillText(variant==='A'?'MORNING':'NOW', w*0.09, h*0.4);
  c.fillText(variant==='A'?'MENU':'OPEN',    w*0.09, h*0.62);
  c.font='600 '+Math.round(h*0.07)+'px ui-monospace,monospace';
  c.fillStyle='rgba(255,255,255,.8)';
  c.fillText(variant==='A'?'image A · uFrom':'image B · uTo', w*0.09, h*0.85);
}
const gl = document.getElementById('gl');
const imgA = document.createElement('canvas'); imgA.width=1280; imgA.height=720; paint(imgA,'A');
const imgB = document.createElement('canvas'); imgB.width=1280; imgB.height=720; paint(imgB,'B');
paint(document.getElementById('thA'),'A'); paint(document.getElementById('thB'),'B');

let renderer, lostBanner=false;
try {
  renderer = TransitionRenderer.createRenderer(gl, { PREAMBLE, EPILOGUE, VERTEX }, {
    preserveDrawingBuffer:true,
    onContextLost:()=>{ lostBanner=true; },
  });
  renderer.setFrom(imgA); renderer.setTo(imgB);
} catch(e){ document.querySelector('.stage').innerHTML = '<div style="color:#fff;padding:24px;font:14px monospace">WebGL unavailable: '+e.message+'</div>'; }

const sel=document.getElementById('shader'), prog=document.getElementById('prog'),
      progv=document.getElementById('progv'), blurb=document.getElementById('blurb'),
      paramsBox=document.getElementById('params'), playBtn=document.getElementById('play');
SHADERS.forEach((s,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=s.name; sel.appendChild(o); });

let cur, curParams={};
function selectShader(i){
  cur=SHADERS[i];
  try { renderer.setShader(cur.src); } catch(e){ blurb.textContent='compile error: '+e.message; return; }
  blurb.textContent=cur.blurb;
  curParams=resolveParams(cur.params.map(p=>({name:p.name,default:p.default,min:p.min,max:p.max})), {});
  paramsBox.innerHTML='';
  cur.params.forEach(p=>{
    const wrap=document.createElement('div'); wrap.className='p';
    const lab=document.createElement('label'); lab.textContent=p.name;
    const r=document.createElement('input'); r.type='range';
    r.min=p.min; r.max=p.max; r.step=(p.max-p.min)/200||0.001; r.value=curParams[p.name];
    const v=document.createElement('span'); v.className='val'; v.textContent=(+curParams[p.name]).toFixed(2);
    r.oninput=()=>{ curParams[p.name]=+r.value; v.textContent=(+r.value).toFixed(2); draw(); };
    wrap.appendChild(lab); wrap.appendChild(r); wrap.appendChild(v); paramsBox.appendChild(wrap);
  });
  draw();
}
function draw(){
  if(!renderer) return;
  const p=+prog.value/1000; progv.textContent=p.toFixed(3);
  renderer.render(p, curParams);
}
sel.onchange=()=>selectShader(+sel.value);
prog.oninput=draw;

let playing=false, raf=0, t0=0;
const DUR=2200, HOLD=550;
function loop(ts){
  if(!t0) t0=ts;
  const cycle=DUR+HOLD*2, e=(ts-t0)%cycle;
  let p = e<HOLD?0 : e>HOLD+DUR?1 : (e-HOLD)/DUR;
  p = p<=0?0 : p>=1?1 : (1-Math.cos(p*Math.PI))/2; // ease in-out
  prog.value=Math.round(p*1000); draw();
  if(playing) raf=requestAnimationFrame(loop);
}
playBtn.onclick=()=>{
  playing=!playing; playBtn.textContent=playing?'Pause':'Play';
  if(playing){ t0=0; raf=requestAnimationFrame(loop); } else cancelAnimationFrame(raf);
};
selectShader(0);
</script>
`;

fs.writeFileSync(path.join(DIR, 'demo.html'), html);
console.log('Wrote demo.html (' + shaders.length + ' shaders, self-contained).');
