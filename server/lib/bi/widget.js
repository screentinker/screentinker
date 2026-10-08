'use strict';

/*
 * The 'bi-dashboard' widget: a Grafana, Power BI or Tableau dashboard on a screen.
 *
 *   mode 'connection' — through the organization's BI connection (lib/bi/connections.js):
 *       Grafana  → the server renders PNGs; the page shows /api/widgets/:id/bi-image.png
 *       Power BI → the page embeds the report with an embed token from /api/widgets/:id/bi-token
 *       Tableau  → the page embeds the view with a connected-app JWT from the same endpoint
 *   mode 'public' — a link that needs no credentials: a Grafana public/kiosk address, a Power BI
 *       "Publish to web" link, or a Tableau Public view.
 *
 * ⚠️ THE PAGE CARRIES NO TOKEN. It is cached by players (rev-pinned) and served to anyone holding the
 * widget's address, so tokens are fetched at run time from no-store endpoints instead. What those
 * endpoints hand out is deliberately small: a PNG, a view-only Power BI embed token for one report,
 * or a five-minute Tableau JWT scoped to embedding views. The connection's secret is never in any.
 */

const { escapeHtml } = require('../widget-sanitize');
const connections = require('./connections');
const grafana = require('./grafana');
const powerbi = require('./powerbi');
const tableau = require('./tableau');

const PROVIDERS = ['grafana', 'powerbi', 'tableau'];
const FITS = ['contain', 'cover', 'fill'];

function bounded(v, lo, hi, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return n === 0 ? 0 : Math.max(lo, Math.min(hi, n));
}

/** A public (no-credentials) link, checked per provider. Returns the URL or throws. */
function publicUrlFor(provider, raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Enter the dashboard address.'); }
  if (u.username || u.password) throw new Error('The address must not contain a user name or password.');
  if (provider === 'powerbi') {
    if (u.protocol !== 'https:' || !/(^|\.)powerbi\.com$/i.test(u.hostname) || !/^\/view/i.test(u.pathname)) {
      throw new Error('Use the "Publish to web" link from Power BI (https://app.powerbi.com/view?r=…).');
    }
  } else if (provider === 'tableau') {
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'public.tableau.com') {
      throw new Error('A public Tableau view lives on https://public.tableau.com. For Tableau Cloud or Server, use a connection.');
    }
    // /app/profile/<user>/viz/<Workbook>/<Sheet> is the page around a view; the view itself is /views/W/S.
    const m = /\/viz\/([^/]+)\/([^/?#]+)/.exec(u.pathname);
    if (m) return `https://public.tableau.com/views/${m[1]}/${m[2]}`;
    if (!/^\/views\/[^/]+\/[^/]+/.test(u.pathname)) throw new Error('Paste the address of a Tableau Public view.');
  } else if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('The address must start with https://.');
  }
  return u.toString();
}

/**
 * Validate a widget config at save time. Throws an Error whose message an editor can act on.
 * `orgId` is the widget's organization: a connection from any other org is refused.
 */
function normaliseConfig(db, orgId, raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const provider = String(c.provider || '');
  if (!PROVIDERS.includes(provider)) throw new Error('Choose Grafana, Power BI or Tableau.');
  const mode = c.mode === 'public' ? 'public' : 'connection';
  const out = {
    provider,
    mode,
    refresh_sec: bounded(c.refresh_sec, provider === 'grafana' ? 30 : 300, 86400, provider === 'grafana' ? 300 : 0),
    rotate_sec: bounded(c.rotate_sec, 10, 3600, 0),
    fit: FITS.includes(c.fit) ? c.fit : 'contain',
    background: /^#[0-9a-f]{3,8}$/i.test(String(c.background || '')) ? c.background : '#000000',
  };
  if (mode === 'public') {
    out.public_url = publicUrlFor(provider, c.public_url);
    if (provider === 'tableau') Object.assign(out, { rotate_sheets: !!c.rotate_sheets, hide_tabs: c.hide_tabs !== false });
    return out;
  }
  const conn = connections.forOrg(db, orgId, c.connection_id);
  if (!conn) throw new Error('Choose one of your organization\'s BI connections.');
  if (conn.kind !== provider) throw new Error(`That connection is for ${conn.kind}, not ${provider}.`);
  out.connection_id = conn.id;
  const specific = provider === 'grafana' ? grafana.normaliseWidgetConfig(c)
    : provider === 'powerbi' ? powerbi.normaliseWidgetConfig(c) : tableau.normaliseWidgetConfig(c);
  return { ...out, ...specific };
}

const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');
// JSON for an inline <script>: no </script> breakout, no raw line separators.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');

function shell(bg, body, extraStyle = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;background:${bg}}#st{position:fixed;right:8px;bottom:6px;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:3px 8px;border-radius:4px;display:none}${extraStyle}</style>
</head><body>${body}<div id="st"></div></body></html>`;
}

function messagePage(bg, text) {
  return shell(bg, `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#ccc;font:24px sans-serif;text-align:center;padding:24px;box-sizing:border-box">${escapeHtml(text)}</div>`);
}

/*
 * ⚠️ EVERY DASHBOARD PAGE IS SANDBOXED TO AN OPAQUE ORIGIN, whoever opens it. It is served from this
 * server at /api/widgets/:id/render, and without the sandbox it runs AS this server's origin — the
 * one whose localStorage holds the dashboard session. The Tableau page loads a script from the
 * connection's Tableau host, which an org admin typed, so an unsandboxed page was a script of their
 * choosing in the dashboard's origin the moment a platform admin opened the link. Never add
 * allow-same-origin here. What the pages fetch from this server (bi-token, bi-image.png, the
 * vendored Power BI client) answers an opaque (Origin: null) caller for that reason, and nothing in
 * these pages touches localStorage, sessionStorage or cookies, which throw in an opaque origin.
 */
const SANDBOX = 'sandbox allow-scripts';

/* The status chip in the corner, shared by every provider page. */
const STATUS_JS = 'function st(t){var e=document.getElementById("st");if(!e)return;e.textContent=t||"";e.style.display=t?"block":"none";}';
/* GET JSON with retry, from an opaque-origin page (the endpoint answers with ACAO *). */
const GET_JS = 'function getJson(u,ok){var x=new XMLHttpRequest();x.open("GET",u+(u.indexOf("?")<0?"?":"&")+"t="+Date.now());x.onload=function(){if(x.status===200){try{ok(JSON.parse(x.responseText));st("");}catch(e){again();}}else again();};x.onerror=again;x.send();function again(){st("Reconnecting\\u2026");setTimeout(function(){getJson(u,ok);},60000);}}';

function grafanaImagePage(widget, cfg, origin) {
  const base = `${origin}/api/widgets/${encodeURIComponent(widget.id)}/bi-image.png`;
  const fit = cfg.fit;
  const html = shell(cfg.background, `<img id="i" alt="" style="width:100vw;height:100vh;object-fit:${fit};display:block">
<script>(function(){${STATUS_JS}
var base=${js(base)},every=${js(Math.max(30, cfg.refresh_sec || 300) * 1000)},img=document.getElementById("i");
function load(){var r=window.devicePixelRatio||1,w=Math.round(innerWidth*r),h=Math.round(innerHeight*r);var n=new Image();
n.onload=function(){img.src=n.src;st("");};n.onerror=function(){st(img.src?"Showing the last image \\u2014 the dashboard is not answering":"Waiting for the dashboard\\u2026");};
n.src=base+"?w="+w+"&h="+h+"&t="+Date.now();}
load();setInterval(load,every);})();</script>`);
  return { html, csp: `default-src 'none'; img-src ${origin} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; ${SANDBOX}` };
}

function framePage(cfg, url, iframeSandbox) {
  let frameOrigin;
  try { frameOrigin = new URL(url).origin; } catch { frameOrigin = "'none'"; }
  const reload = cfg.refresh_sec > 0 ? `<script>setInterval(function(){var f=document.getElementById("f");f.src=f.src;},${cfg.refresh_sec * 1000});</script>` : '';
  const html = shell(cfg.background, `<iframe id="f" src="${escapeHtml(url)}" sandbox="${escapeHtml(iframeSandbox)}" allowfullscreen style="border:0;width:100vw;height:100vh;display:block"></iframe>${reload}`);
  return { html, csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src ${frameOrigin}; ${SANDBOX}` };
}

function powerBiPage(widget, cfg, origin) {
  const tokenUrl = `${origin}/api/widgets/${encodeURIComponent(widget.id)}/bi-token`;
  // Power BI has no "stretch": fill and cover both fit the width (the report scrolls if it is tall).
  // powerbi-models DisplayOption: FitToPage = 0, FitToWidth = 1.
  const fitOption = cfg.fit === 'contain' ? 0 : 1;
  const html = shell(cfg.background, `<div id="r" style="position:fixed;inset:0"></div>
<script src="${origin}/vendor/powerbi/powerbi.min.js"></script>
<script>(function(){${STATUS_JS}${GET_JS}
var tokenUrl=${js(tokenUrl)},pages=${js(cfg.pages || [])},rotateAll=${js(!!cfg.rotate_pages)},rotateMs=${js((cfg.rotate_sec || 0) * 1000)},reloadMs=${js((cfg.refresh_sec || 0) * 1000)};
// Only window.powerbi is relied on: where the page has a CommonJS module object (BrightSign with
// Node enabled) the UMD bundle exports there, not to window. So the powerbi-models enum values are
// written out: TokenType.Embed 1, BackgroundType.Default 0, LayoutType.Custom 1.
if(!window.powerbi){st("The Power BI library did not load");return;}
var report=null;
function schedule(exp){var ms=Math.max(60000,Date.parse(exp)-Date.now()-5*60000);setTimeout(function(){getJson(tokenUrl,function(t){report.setAccessToken(t.token)["catch"](function(){});schedule(t.expiration);});},ms);}
function rotate(){report.getPages().then(function(all){var list=pages.length?pages:(rotateAll?all.filter(function(p){return p.visibility===0;}).map(function(p){return p.name;}):[]);
if(list.length<2||!rotateMs)return;var i=0;setInterval(function(){i=(i+1)%list.length;report.setPage(list[i])["catch"](function(){});},rotateMs);})["catch"](function(){});}
getJson(tokenUrl,function(t){
report=window.powerbi.embed(document.getElementById("r"),{type:"report",tokenType:1,accessToken:t.token,embedUrl:t.embedUrl,id:t.reportId,pageName:pages[0]||undefined,
settings:{panes:{filters:{visible:false},pageNavigation:{visible:false}},bars:{actionBar:{visible:false}},background:0,layoutType:1,customLayout:{displayOption:${fitOption}}}});
var once=false;report.on("loaded",function(){if(once)return;once=true;rotate();});
report.on("error",function(){st("Power BI reported an error \\u2014 retrying");});
schedule(t.expiration);
if(reloadMs>0)setInterval(function(){report.reload()["catch"](function(){});},reloadMs);
});})();</script>`);
  return {
    html,
    csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${origin}; connect-src ${origin}; frame-src https://app.powerbi.com https://*.powerbi.com; img-src data:; ${SANDBOX}`,
  };
}

function tableauHostSources(host) {
  try {
    const u = new URL(host);
    const extra = /\.online\.tableau\.com$/i.test(u.hostname) ? ' https://*.online.tableau.com' : '';
    return `${u.origin}${extra}`;
  } catch { return "'none'"; }
}

function tableauPage(widget, cfg, origin, { publicSrc = null } = {}) {
  const tokenUrl = `${origin}/api/widgets/${encodeURIComponent(widget.id)}/bi-token`;
  const host = publicSrc ? 'https://public.tableau.com' : null;
  return (conn) => {
    const hostUrl = host || String(conn.config.server_url);
    const apiUrl = host ? 'https://public.tableau.com/javascripts/api/tableau.embedding.3.latest.min.js' : tableau.embeddingApiUrl(conn);
    const src = tableauHostSources(hostUrl);
    const html = shell(cfg.background, `<div id="v" style="position:fixed;inset:0"></div>
<script type="module" src="${escapeHtml(apiUrl)}"></script>
<script>(function(){${STATUS_JS}${GET_JS}
var tokenUrl=${js(tokenUrl)},publicSrc=${js(publicSrc)},hideTabs=${js(cfg.hide_tabs !== false)},rotate=${js(!!cfg.rotate_sheets)},rotateMs=${js((cfg.rotate_sec || 0) * 1000)},refreshMs=${js((cfg.refresh_sec || 0) * 1000)};
var box=document.getElementById("v"),viz=null,timers=[];
function clear(){while(timers.length)clearInterval(timers.pop());}
function make(src,token){clear();var v=document.createElement("tableau-viz");v.setAttribute("src",src);if(token)v.setAttribute("token",token);
v.setAttribute("toolbar","hidden");if(hideTabs)v.setAttribute("hide-tabs","");v.setAttribute("width",String(innerWidth));v.setAttribute("height",String(innerHeight));
v.addEventListener("vizloaderror",function(){st("Tableau did not load \\u2014 retrying");setTimeout(mount,60000);});
v.addEventListener("firstinteractive",function(){st("");
if(refreshMs>0)timers.push(setInterval(function(){try{v.refreshDataAsync()["catch"](function(){});}catch(e){}},refreshMs));
if(rotate&&rotateMs){try{var names=v.workbook.publishedSheetsInfo.map(function(s){return s.name;}),i=0;if(names.length>1)timers.push(setInterval(function(){i=(i+1)%names.length;v.workbook.activateSheetAsync(names[i])["catch"](function(){});},rotateMs));}catch(e){}}});
box.innerHTML="";box.appendChild(v);viz=v;}
function mount(){if(publicSrc)return make(publicSrc,null);getJson(tokenUrl,function(t){make(t.src,t.token);});}
mount();
// A Tableau session does not last for ever; sign in again with a fresh token every six hours.
if(!publicSrc)setInterval(mount,6*3600*1000);
})();</script>`);
    return {
      html,
      csp: `default-src 'none'; style-src 'unsafe-inline' ${src}; script-src 'unsafe-inline' ${src}; connect-src ${origin} ${src}; frame-src ${src}; img-src ${src} data: blob:; font-src ${src} data:; ${SANDBOX}`,
    };
  };
}

/**
 * The page for a widget. Returns { html, csp }. `iframeSandbox` is the org's widget sandbox setting,
 * applied to a framed public page exactly as the web page widget applies it.
 */
function render(db, widget, rawConfig, { origin, iframeSandbox = 'allow-scripts' } = {}) {
  const cfg = rawConfig || {};
  const bg = /^#[0-9a-f]{3,8}$/i.test(String(cfg.background || '')) ? cfg.background : '#000000';
  // Re-checked here, not trusted from the row: `fit` goes into a style attribute as it is.
  const fit = FITS.includes(cfg.fit) ? cfg.fit : 'contain';
  const plain = (text) => ({ html: messagePage(bg, text), csp: "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  if (!PROVIDERS.includes(cfg.provider)) return plain('Choose a dashboard in this widget\'s settings.');
  if (cfg.mode === 'public') {
    let url;
    try { url = publicUrlFor(cfg.provider, cfg.public_url); } catch (e) { return plain(e.message); }
    if (cfg.provider === 'tableau') return tableauPage(widget, { ...cfg, background: bg, fit }, origin, { publicSrc: url })(null);
    return framePage({ ...cfg, background: bg, fit }, url, iframeSandbox);
  }
  const conn = connections.forWidget(db, widget, cfg);
  if (!conn || conn.kind !== cfg.provider) return plain('This dashboard\'s connection has been removed. Choose another in the widget settings.');
  if (cfg.provider === 'grafana') return grafanaImagePage(widget, { ...cfg, background: bg, fit }, origin);
  if (cfg.provider === 'powerbi') return powerBiPage(widget, { ...cfg, background: bg, fit }, origin);
  return tableauPage(widget, { ...cfg, background: bg, fit }, origin)(conn);
}

/** The dashboard editor's Preview: no widget id yet, so no tokens — say what the screen will show. */
function previewHtml(cfg) {
  const name = { grafana: 'Grafana', powerbi: 'Power BI', tableau: 'Tableau' }[cfg && cfg.provider] || 'BI';
  return messagePage('#111', `${name} dashboard — save the widget and it appears on screens. Preview cannot sign in to your dashboard.`);
}

/*
 * What /bi-token hands a screen. Small on purpose: see the header comment.
 */
async function tokenFor(db, widget, cfg, { beforeFetch = null } = {}) {
  if (cfg.mode === 'public') throw Object.assign(new Error('A public dashboard needs no token'), { status: 404 });
  const conn = connections.forWidget(db, widget, cfg);
  if (!conn || conn.kind !== cfg.provider) throw Object.assign(new Error('No connection'), { status: 404 });
  if (cfg.provider === 'powerbi') {
    const e = await powerbi.embedFor(conn, powerbi.normaliseWidgetConfig(cfg), Date.now(), { beforeFetch });
    return { provider: 'powerbi', embedUrl: e.embedUrl, reportId: e.reportId, token: e.token, expiration: e.expiration };
  }
  if (cfg.provider === 'tableau') {
    // Every Tableau JWT is new (no cache can serve one), so every call is counted.
    if (beforeFetch && !beforeFetch()) throw Object.assign(new Error('Too many token requests'), { status: 429 });
    const t = tableau.normaliseWidgetConfig(cfg);
    return { provider: 'tableau', src: tableau.viewUrl(conn, t), token: tableau.mintJwt(conn), expires_in: tableau.JWT_LIFETIME_S };
  }
  throw Object.assign(new Error('Grafana dashboards are images; there is no token'), { status: 404 });
}

module.exports = { PROVIDERS, FITS, normaliseConfig, publicUrlFor, render, previewHtml, tokenFor };
