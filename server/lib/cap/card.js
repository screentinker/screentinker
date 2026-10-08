'use strict';

/*
 * The full-screen card a screen shows for a live CAP alert (served as the feed's hidden
 * 'cap_alert' widget by routes/widgets.js).
 *
 * ⚠️ EVERY STRING ON IT CAME FROM A THIRD-PARTY FEED. All of it is HTML-escaped, and the page's
 * only script is our own (rotation between several alerts and local-time formatting), inlined
 * here with nothing interpolated into it except JSON we encoded.
 *
 * Built for a screen across a room: large type, the severity as a colour band and a word (never
 * colour alone), the instruction before the description because it is what people need to do.
 */

const COLORS = {
  Extreme: { bg: '#7f1d1d', band: '#dc2626', fg: '#ffffff' },
  Severe: { bg: '#7c2d12', band: '#ea580c', fg: '#ffffff' },
  Moderate: { bg: '#713f12', band: '#eab308', fg: '#ffffff' },
  Minor: { bg: '#1e3a8a', band: '#3b82f6', fg: '#ffffff' },
  Unknown: { bg: '#1f2937', band: '#6b7280', fg: '#ffffff' },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/*
 * One slide per distinct warning. Agencies issue the same warning as a separate alert for each zone
 * it covers (the NWS does this for marine zones), which would otherwise fill the rotation with
 * identical slides; those are merged and their areas joined.
 */
function groupForDisplay(alerts) {
  const out = [];
  const byKey = new Map();
  for (const a of alerts || []) {
    const k = `${a.event}|${a.headline}|${a.severity}`;
    const g = byKey.get(k);
    if (!g) { const c = { ...a, _areas: a.areaDesc ? [a.areaDesc] : [] }; byKey.set(k, c); out.push(c); continue; }
    if (a.areaDesc && !g._areas.includes(a.areaDesc)) g._areas.push(a.areaDesc);
    const end = (x) => x.ends || x.expires || '';
    if (end(a) > end(g)) { g.ends = a.ends; g.expires = a.expires; }
  }
  for (const g of out) { g.areaDesc = g._areas.join('; '); delete g._areas; }
  return out;
}

function trim(s, n) { const v = String(s || ''); return v.length > n ? v.slice(0, n - 1).trimEnd() + '…' : v; }

function slide(a, i, total) {
  const c = COLORS[a.severity] || COLORS.Unknown;
  const body = a.instruction || a.description || '';
  const extra = a.instruction && a.description ? a.description : '';
  return `
  <section class="s" data-i="${i}" style="background:${c.bg};color:${c.fg}${i ? ';display:none' : ''}">
    <div class="band" style="background:${c.band}">
      <span class="sev">${esc(a.severity === 'Unknown' ? 'ALERT' : a.severity.toUpperCase())}</span>
      <span class="ev">${esc(trim(a.event, 120))}</span>
      ${total > 1 ? `<span class="n">${i + 1} / ${total}</span>` : ''}
    </div>
    <div class="main">
      <h1>${esc(trim(a.headline || a.event, 240))}</h1>
      ${a.areaDesc ? `<p class="area">${esc(trim(a.areaDesc, 400))}</p>` : ''}
      ${body ? `<p class="body">${esc(trim(body, 900))}</p>` : ''}
      ${extra ? `<p class="extra">${esc(trim(extra, 700))}</p>` : ''}
    </div>
    <div class="foot">
      ${(a.ends || a.expires) ? `<span>Until <time data-t="${esc(a.ends || a.expires)}">${esc((a.ends || a.expires).replace('T', ' ').slice(0, 16))} UTC</time></span>` : '<span></span>'}
      <span>${esc(trim(a.senderName || a.sender, 120))}</span>
    </div>
  </section>`;
}

/** `alerts` are lib/cap/parse.js shapes, most severe first. */
function renderCard(alerts, { title = 'Emergency alert' } = {}) {
  const list = groupForDisplay(alerts).slice(0, 10);
  const slides = list.length
    ? list.map((a, i) => slide(a, i, list.length)).join('')
    : `<section class="s" style="background:#111827;color:#9ca3af"><div class="main"><h1>${esc(title)}</h1><p class="body">No active alerts.</p></div></section>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
  .s{position:absolute;inset:0;display:flex;flex-direction:column}
  .band{display:flex;align-items:center;gap:3vw;padding:2.2vh 4vw;font-weight:800;letter-spacing:.04em}
  .sev{font-size:4.2vh;padding:.6vh 1.6vw;border:.35vh solid currentColor;border-radius:1vh}
  .ev{font-size:4.2vh;flex:1}
  .n{font-size:3vh;opacity:.85}
  .main{flex:1;padding:4vh 4vw;overflow:hidden;display:flex;flex-direction:column;min-height:0}
  h1{font-size:7vh;line-height:1.1;margin:0 0 2.5vh}
  .area{font-size:3.6vh;font-weight:600;margin:0 0 3vh;opacity:.95}
  /* Whole lines only: a long description is clamped, never cut through the middle of a line. */
  .body{font-size:3.8vh;line-height:1.35;margin:0 0 2.5vh;white-space:pre-line;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:8;overflow:hidden}
  .extra{font-size:2.8vh;line-height:1.35;margin:0;opacity:.85;white-space:pre-line;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}
  .foot{display:flex;justify-content:space-between;gap:4vw;padding:2vh 4vw;font-size:2.8vh;opacity:.9;border-top:.2vh solid rgba(255,255,255,.3)}
</style></head><body>
${slides}
<script>
(function(){
  var ts=document.querySelectorAll('time[data-t]');
  for(var i=0;i<ts.length;i++){try{var d=new Date(ts[i].getAttribute('data-t'));if(!isNaN(d))ts[i].textContent=d.toLocaleString([], {weekday:'short',hour:'2-digit',minute:'2-digit',day:'numeric',month:'short'});}catch(e){}}
  var s=document.querySelectorAll('section.s');if(s.length<2)return;var k=0;
  setInterval(function(){s[k].style.display='none';k=(k+1)%s.length;s[k].style.display='flex';},15000);
})();
</script>
</body></html>`;
}

module.exports = { renderCard, groupForDisplay, COLORS, _esc: esc };
