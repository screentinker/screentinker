'use strict';

/*
 * The menu board widget (widget_type 'menu-board'): sections of items with prices, rendered for a
 * screen across a room.
 *
 * Content comes from the widget's own config (the dashboard editor) or, when `source.slug` names a
 * data source, from that source's rows — a Google Sheet or CSV whose header row says section,
 * item, price, and so on. The data-source sync already bumps every widget whose config contains
 * `"slug":"<slug>"` (lib/data-sources/service.js), so a sheet edit reaches the screens with no
 * code here.
 *
 * The server builds the markup (everything escaped: an operator's text, and a sheet's text even
 * more so) and the page's small script only arranges it: it hides sections outside their time
 * window by the SCREEN's own clock, fits the columns, and when the menu is longer than the screen
 * it pages instead of cutting the bottom off.
 */

const MAX_SECTIONS = 40;
const MAX_ITEMS = 120;          // per section
const MAX_PRICES = 4;
const THEMES = {
  dark: { bg: '#111318', fg: '#f4f4f5', muted: '#a1a1aa', rule: 'rgba(255,255,255,.14)', font: 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif', head: 'inherit' },
  light: { bg: '#faf7f2', fg: '#1c1917', muted: '#57534e', rule: 'rgba(0,0,0,.14)', font: 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif', head: 'Georgia,"Times New Roman",serif' },
  chalkboard: { bg: '#1f2a24', fg: '#f5f5f0', muted: '#c7cfc4', rule: 'rgba(255,255,255,.22)', font: '"Trebuchet MS","Segoe UI",sans-serif', head: '"Marker Felt","Comic Sans MS","Trebuchet MS",cursive' },
  bold: { bg: '#0b0b0b', fg: '#ffffff', muted: '#d4d4d4', rule: 'rgba(255,255,255,.25)', font: 'Impact,"Arial Narrow","Helvetica Neue",Arial,sans-serif', head: 'Impact,"Arial Narrow",Arial,sans-serif' },
};
// Short codes, never emoji: Tizen and BrightSign do not reliably carry an emoji font.
const KNOWN_TAGS = {
  v: 'Vegetarian', vg: 'Vegan', gf: 'Gluten-free', df: 'Dairy-free', n: 'Contains nuts',
  h: 'Halal', spicy: 'Spicy', new: 'New', popular: 'Popular',
};
const TAG_ALIASES = { vegetarian: 'v', vegan: 'vg', 'gluten-free': 'gf', glutenfree: 'gf', 'dairy-free': 'df', nuts: 'n', halal: 'h', hot: 'spicy' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const str = (v, n = 300) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const truthy = (v) => v === true || /^(1|y|yes|true|x|sold ?out|86)$/i.test(String(v == null ? '' : v).trim());
const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim()) ? String(v).trim() : '');

/** Only an image the page can safely point at: http(s), or a path on this server. */
function safeImg(u) {
  const s = str(u, 2000);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/(?:uploads|api)\/[\w\-./%?=&]+$/.test(s)) return s;
  return '';
}

function normTag(t) {
  const k = str(t, 30).toLowerCase().replace(/^#/, '');
  if (!k) return null;
  const code = TAG_ALIASES[k] || k;
  return { code, label: KNOWN_TAGS[code] ? code.toUpperCase() : str(t, 30), known: !!KNOWN_TAGS[code] };
}

function normItem(it, i) {
  if (!it || typeof it !== 'object') return null;
  const name = str(it.name || it.item, 120);
  if (!name) return null;
  let prices = Array.isArray(it.prices) ? it.prices : (it.price != null && it.price !== '' ? [it.price] : []);
  prices = prices.map((p) => str(p, 20)).filter((p) => p !== '').slice(0, MAX_PRICES);
  const tags = (Array.isArray(it.tags) ? it.tags : String(it.tags || '').split(/[,;]/)).map(normTag).filter(Boolean).slice(0, 8);
  return {
    id: str(it.id, 40) || `i${i}`,
    name,
    description: str(it.description, 400),
    prices,
    tags,
    image: safeImg(it.image_url || it.image),
    sold_out: !!it.sold_out,
    hidden: !!it.hidden,
  };
}

function normSection(s, i) {
  if (!s || typeof s !== 'object') return null;
  const items = (Array.isArray(s.items) ? s.items : []).slice(0, MAX_ITEMS).map(normItem).filter(Boolean);
  return {
    id: str(s.id, 40) || `s${i}`,
    name: str(s.name, 120),
    note: str(s.note, 200),
    show_from: hhmm(s.show_from),
    show_until: hhmm(s.show_until),
    items,
  };
}

/**
 * Sections from a tabular data source's flattened rows (lib/data-sources/tabular.js: row_count,
 * row<N>_<column key>). Columns are found by name, so a sheet only needs sensible headers.
 */
function sectionsFromData(data) {
  if (!data || typeof data !== 'object') return [];
  const n = Math.min(parseInt(data.row_count, 10) || 0, 1000);
  const keys = Object.keys(data);
  const colsOf = (re) => {
    const found = new Set();
    for (const k of keys) { const m = /^row\d+_(.+)$/.exec(k); if (m && re.test(m[1])) found.add(m[1]); }
    return [...found];
  };
  const one = (re) => colsOf(re)[0];
  const col = {
    section: one(/^(section|category|group|menu)$/),
    name: one(/^(item|name|dish|product|title)$/),
    description: one(/^(description|desc|details|notes?)$/),
    tags: one(/^(tags?|dietary|labels?)$/),
    sold_out: one(/^(sold_?out|soldout|unavailable|86)$/),
    available: one(/^(available|in_?stock)$/),
    image: one(/^(image|photo|picture|image_?url)$/),
    from: one(/^(show_?from|from|available_?from)$/),
    until: one(/^(show_?until|until|to|available_?until)$/),
  };
  const priceCols = colsOf(/^price(_?\d+)?$|^(small|medium|large|regular|half|full|glass|bottle)$/);
  priceCols.sort();
  const sections = [];
  const bySection = new Map();
  for (let r = 1; r <= n; r++) {
    const cell = (c) => (c ? data[`row${r}_${c}`] : '');
    const name = str(cell(col.name), 120);
    if (!name) continue;
    const secName = str(cell(col.section), 120) || 'Menu';
    let sec = bySection.get(secName);
    if (!sec) {
      sec = { id: `ds${sections.length}`, name: secName, note: '', show_from: hhmm(cell(col.from)), show_until: hhmm(cell(col.until)), items: [] };
      bySection.set(secName, sec);
      sections.push(sec);
    }
    const soldOut = col.sold_out ? truthy(cell(col.sold_out)) : (col.available ? !truthy(cell(col.available)) && String(cell(col.available)).trim() !== '' : false);
    const it = normItem({
      id: `r${r}`, name, description: cell(col.description), tags: cell(col.tags),
      prices: priceCols.map((c) => cell(c)), image: cell(col.image), sold_out: soldOut,
    }, r);
    if (it && sec.items.length < MAX_ITEMS) sec.items.push(it);
  }
  return sections.slice(0, MAX_SECTIONS);
}

/** The config as the page will show it: validated, clamped, data source applied. */
function normalise(config, { dataMap = null } = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const theme = THEMES[c.theme] ? c.theme : 'dark';
  const slug = c.source && typeof c.source === 'object' ? str(c.source.slug, 80) : '';
  const sections = slug && dataMap
    ? sectionsFromData(dataMap[slug] || dataMap[slug.toLowerCase()])
    : (Array.isArray(c.sections) ? c.sections : []).slice(0, MAX_SECTIONS).map(normSection).filter(Boolean);
  const cols = parseInt(c.columns, 10);
  return {
    title: str(c.title, 120),
    subtitle: str(c.subtitle, 200),
    footer: str(c.footer, 300),
    theme,
    accent: /^#[0-9a-f]{6}$/i.test(c.accent || '') ? c.accent : (theme === 'light' ? '#b45309' : '#f59e0b'),
    currency: str(c.currency == null ? '$' : c.currency, 6),
    currency_after: !!c.currency_after,
    decimals: [0, 1, 2, 3].includes(Number(c.decimals)) ? Number(c.decimals) : 2,
    price_labels: (Array.isArray(c.price_labels) ? c.price_labels : String(c.price_labels || '').split(','))
      .map((s) => str(s, 20)).filter(Boolean).slice(0, MAX_PRICES),
    columns: cols >= 1 && cols <= 4 ? cols : 0,
    font_scale: Math.max(0.6, Math.min(1.8, Number(c.font_scale) || 1)),
    show_images: c.show_images !== false,
    show_descriptions: c.show_descriptions !== false,
    sold_out: c.sold_out === 'hide' ? 'hide' : 'mark',
    page_seconds: Math.max(5, Math.min(120, parseInt(c.page_seconds, 10) || 12)),
    logo: safeImg(c.logo_url),
    background: safeImg(c.background_url),
    source_slug: slug,
    sections,
  };
}

function formatPrice(p, m) {
  const raw = String(p).trim();
  const num = /^-?\d+(?:[.,]\d+)?$/.test(raw) ? Number(raw.replace(',', '.')) : NaN;
  if (!Number.isFinite(num)) return raw;   // "Market price", "2 for 5": shown as written
  const v = num.toFixed(m.decimals);
  return m.currency_after ? `${v}${m.currency ? ' ' + m.currency : ''}` : `${m.currency}${v}`;
}

function itemHtml(it, m) {
  if (it.hidden) return '';
  if (it.sold_out && m.sold_out === 'hide') return '';
  // With price columns, an item with fewer prices is padded so each price sits under its label
  // (a single price under "Single", not under the last column).
  const slots = Math.max(it.prices.length, m.price_labels.length);
  const cells = [];
  for (let k = 0; k < slots; k++) cells.push(it.prices[k] != null ? `<span class="pr">${esc(formatPrice(it.prices[k], m))}</span>` : '<span class="pr"></span>');
  const prices = cells.length ? `<span class="prs">${cells.join('')}</span>` : '';
  const tags = it.tags.map((t) => `<span class="tg${t.known ? ' k' : ''}">${esc(t.label)}</span>`).join('');
  return `<div class="it${it.sold_out ? ' so' : ''}">
    ${m.show_images && it.image ? `<img class="ph" src="${esc(it.image)}" alt="" loading="lazy">` : ''}
    <div class="tx">
      <div class="ln"><span class="nm">${esc(it.name)}</span>${tags}<span class="dots"></span>${it.sold_out ? '<span class="sob">Sold out</span>' : prices}</div>
      ${m.show_descriptions && it.description ? `<div class="ds">${esc(it.description)}</div>` : ''}
    </div>
  </div>`;
}

function sectionHtml(s, m) {
  const items = s.items.map((it) => itemHtml(it, m)).join('');
  if (!items) return '';
  const head = m.price_labels.length ? `<span class="pl">${m.price_labels.map((l) => `<span>${esc(l)}</span>`).join('')}</span>` : '';
  return `<section class="sec" data-from="${esc(s.show_from)}" data-until="${esc(s.show_until)}">
    <h2><span>${esc(s.name)}</span>${head}</h2>
    ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
    ${items}
  </section>`;
}

function legendHtml(m) {
  const used = new Set();
  for (const s of m.sections) for (const it of s.items) for (const t of it.tags) if (t.known) used.add(t.code);
  if (!used.size) return '';
  return [...used].map((c) => `<span><b>${esc(c.toUpperCase())}</b> ${esc(KNOWN_TAGS[c])}</span>`).join('');
}

function renderMenuBoard(config, opts = {}) {
  const m = normalise(config, opts);
  const th = THEMES[m.theme];
  // vmin, not vh: the same type size in portrait as in landscape, and widths that line up with it.
  const fs = (n) => `${(n * m.font_scale).toFixed(2)}vmin`;
  const body = m.sections.map((s) => sectionHtml(s, m)).join('');
  const legend = legendHtml(m);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title || 'Menu')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;overflow:hidden;background:${th.bg};color:${th.fg};font-family:${th.font}}
  ${m.background ? `body{background:${th.bg} url("${esc(m.background)}") center/cover no-repeat}
  body::before{content:"";position:fixed;inset:0;background:${th.bg};opacity:.78}` : ''}
  .wrap{position:fixed;inset:0;display:flex;flex-direction:column;padding:3.5vmin 3.5vmin}
  header{display:flex;align-items:center;gap:2.5vmin;margin-bottom:2.2vmin}
  header img{max-height:12vmin;max-width:22vmin;object-fit:contain}
  h1{font-family:${th.head};font-size:${fs(7)};line-height:1.05;color:${m.accent};letter-spacing:.01em}
  .sub{font-size:${fs(2.6)};color:${th.muted};margin-top:.6vmin}
  .pages{flex:1;position:relative;min-height:0}
  .page{position:absolute;inset:0;display:grid;gap:0 3.5vmin;align-content:start;grid-auto-flow:row;opacity:0;transition:opacity .8s}
  .page.on{opacity:1}
  .col{display:flex;flex-direction:column;gap:2.2vmin;min-width:0}
  .sec h2{font-family:${th.head};font-size:${fs(3.6)};color:${m.accent};border-bottom:.25vmin solid ${th.rule};padding-bottom:.6vmin;margin-bottom:1vmin;display:flex;align-items:flex-end;gap:1vmin}
  .sec h2>span:first-child{flex:1}
  .pl{display:flex;font-size:${fs(1.8)};color:${th.muted};font-family:${th.font}}
  .pl span,.pr{min-width:${fs(10)};text-align:right}
  .pl span{margin-left:1.2vmin}
  .note{font-size:${fs(1.9)};color:${th.muted};margin:-.4vmin 0 1vmin;font-style:italic}
  .it{display:flex;gap:1.2vmin;align-items:flex-start;padding:.7vmin 0;break-inside:avoid}
  .ph{width:9vmin;height:9vmin;object-fit:cover;border-radius:.8vmin;flex:none}
  .tx{flex:1;min-width:0}
  .ln{display:flex;align-items:baseline;gap:.8vmin;font-size:${fs(2.7)}}
  .nm{font-weight:650;min-width:0;flex:0 1 auto;overflow-wrap:break-word}
  .prs{display:flex;flex:none}
  .dots{flex:1;border-bottom:.2vmin dotted ${th.rule};transform:translateY(-.5vmin);min-width:2vmin}
  .pr{font-weight:700;display:inline-block;margin-left:1.2vmin;white-space:nowrap;text-align:right}
  .tg{font-size:${fs(1.45)};font-weight:700;border:.15vmin solid currentColor;border-radius:.6vmin;padding:.05vmin .45vmin;color:${th.muted};white-space:nowrap}
  .tg.k{color:${m.accent}}
  .ds{font-size:${fs(1.95)};color:${th.muted};line-height:1.3;margin-top:.3vmin}
  .so .nm,.so .ds{opacity:.45;text-decoration:line-through}
  .sob{font-size:${fs(1.8)};font-weight:800;color:#fff;background:#b91c1c;border-radius:.6vmin;padding:.2vmin .7vmin;white-space:nowrap}
  footer{display:flex;justify-content:space-between;gap:3vmin;margin-top:1.6vmin;font-size:${fs(1.8)};color:${th.muted};flex-wrap:wrap}
  .lg{display:flex;gap:1.6vmin;flex-wrap:wrap}
  .lg b{color:${m.accent}}
  .dotsnav{display:flex;gap:.6vmin;align-items:center}
  .dotsnav i{width:1vmin;height:1vmin;border-radius:50%;background:${th.muted};opacity:.35;display:inline-block}
  .dotsnav i.on{opacity:1;background:${m.accent}}
  .empty{font-size:${fs(3)};color:${th.muted}}
</style></head><body>
<div class="wrap">
  ${m.title || m.logo || m.subtitle ? `<header>${m.logo ? `<img src="${esc(m.logo)}" alt="">` : ''}<div>${m.title ? `<h1>${esc(m.title)}</h1>` : ''}${m.subtitle ? `<div class="sub">${esc(m.subtitle)}</div>` : ''}</div></header>` : ''}
  <div class="pages" id="pages"></div>
  <footer><div class="lg">${legend}</div><div>${esc(m.footer)}</div><div class="dotsnav" id="nav"></div></footer>
</div>
<template id="src">${body || '<div class="empty">The menu is empty.</div>'}</template>
<script>
(function(){
  var COLS=${m.columns}, PAGE_MS=${m.page_seconds * 1000};
  var pagesEl=document.getElementById('pages'), nav=document.getElementById('nav'), src=document.getElementById('src');
  var timer=null, cur=0, lastKey='';
  function mins(s){ if(!s) return null; var p=s.split(':'); return (+p[0])*60+(+p[1]); }
  function inWindow(el, now){
    var f=mins(el.getAttribute('data-from')), u=mins(el.getAttribute('data-until'));
    if(f===null && u===null) return true;
    if(f===null) f=0; if(u===null) u=24*60;
    return f<=u ? (now>=f && now<u) : (now>=f || now<u);   // a window may run past midnight
  }
  function colCount(){
    if(COLS) return COLS;
    var w=pagesEl.clientWidth, h=pagesEl.clientHeight;
    return w/h > 2.4 ? 4 : w/h > 1.5 ? 3 : w/h > 1 ? 2 : 1;
  }
  function build(){
    var d=new Date(), now=d.getHours()*60+d.getMinutes();
    var secs=[].slice.call(src.content.children).filter(function(el){ return !el.classList.contains('sec') || inWindow(el, now); });
    var key=secs.length+':'+pagesEl.clientWidth+'x'+pagesEl.clientHeight+':'+secs.map(function(s){return s.getAttribute('data-from')+s.getAttribute('data-until');}).join(',');
    if(key===lastKey) return; lastKey=key;
    pagesEl.innerHTML=''; nav.innerHTML='';
    var n=colCount(), H=pagesEl.clientHeight, pages=[], page=null, col=null, ci=0;
    // Measure everything stacked in one column. If it all fits on one page, fill each column only to
    // an even share, so a short menu spreads across the screen instead of stacking in column one.
    var probe=document.createElement('div'); probe.className='page on'; probe.style.gridTemplateColumns='repeat('+n+',minmax(0,1fr))';
    var pc=document.createElement('div'); pc.className='col'; probe.appendChild(pc); pagesEl.appendChild(probe);
    var tallest=0; for(var j=0;j<secs.length;j++){ var c1=secs[j].cloneNode(true); pc.appendChild(c1); tallest=Math.max(tallest,c1.offsetHeight); }
    var total=pc.scrollHeight; pagesEl.removeChild(probe);
    if(total<=H*n*0.92 && n>1){ H=Math.min(H, Math.max(tallest, Math.ceil(total/n*1.08))); }
    function newPage(){ page=document.createElement('div'); page.className='page'; page.style.gridTemplateColumns='repeat('+n+',minmax(0,1fr))';
      for(var i=0;i<n;i++){ var c=document.createElement('div'); c.className='col'; page.appendChild(c); }
      pagesEl.appendChild(page); pages.push(page); ci=0; col=page.children[0]; page.classList.add('on'); }
    newPage();
    function place(node){
      col.appendChild(node);
      if(col.scrollHeight<=H || col.children.length===1 && node.classList && node.classList.contains('sec') && splitSection(node)) return;
      if(col.scrollHeight>H && col.children.length>1){ col.removeChild(node); ci++;
        if(ci>=n){ newPage(); } else { col=page.children[ci]; }
        col.appendChild(node);
        if(col.scrollHeight>H && node.classList && node.classList.contains('sec')) splitSection(node);
      }
    }
    // A section taller than a whole column continues in the next column under the same heading.
    function splitSection(sec){
      var items=[].slice.call(sec.querySelectorAll(':scope > .it'));
      if(items.length<2) return false;
      var rest=[]; while(col.scrollHeight>H && items.length>1){ var it=items.pop(); rest.unshift(it); sec.removeChild(it); }
      if(!rest.length) return false;
      var cont=sec.cloneNode(false); var h=sec.querySelector('h2'); if(h) cont.appendChild(h.cloneNode(true));
      for(var i=0;i<rest.length;i++) cont.appendChild(rest[i]);
      ci++; if(ci>=n){ newPage(); } else { col=page.children[ci]; }
      col.appendChild(cont);
      if(col.scrollHeight>H) splitSection(cont);
      return true;
    }
    for(var i=0;i<secs.length;i++) place(secs[i].cloneNode(true));
    for(var p=0;p<pages.length;p++){ pages[p].classList.toggle('on', p===0); }
    if(pages.length>1){ for(var q=0;q<pages.length;q++){ var dot=document.createElement('i'); if(q===0) dot.className='on'; nav.appendChild(dot); } }
    cur=0; if(timer) clearInterval(timer);
    if(pages.length>1) timer=setInterval(function(){
      pages[cur].classList.remove('on'); nav.children[cur].classList.remove('on');
      cur=(cur+1)%pages.length; pages[cur].classList.add('on'); nav.children[cur].classList.add('on');
    }, PAGE_MS);
  }
  function go(){ lastKey=''; build(); }
  if(document.readyState==='complete') go(); else window.addEventListener('load', go);
  window.addEventListener('resize', function(){ clearTimeout(window.__mbR); window.__mbR=setTimeout(go, 200); });
  setInterval(build, 30000);   // time windows open and close on the screen's own clock
})();
</script>
</body></html>`;
}

/** Find an item by id in a config's own sections (not a data source's rows). */
function findItem(config, itemId) {
  for (const s of (config && Array.isArray(config.sections) ? config.sections : [])) {
    for (const it of (Array.isArray(s.items) ? s.items : [])) if (it && String(it.id) === String(itemId)) return it;
  }
  return null;
}

module.exports = { renderMenuBoard, normalise, sectionsFromData, formatPrice, findItem, THEMES, KNOWN_TAGS, _esc: esc };
