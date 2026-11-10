'use strict';

/*
 * Broadcast graphics for the vision mixer (routes/mixer.js, frontend views/mixer.js).
 *
 * A graphic is a small self-contained HTML page: text from the query string, drawn and ANIMATED
 * with CSS only. The mixer keys it over a screen with the overlay the players already have
 * (routes/pip.js, a `web` overlay), so it works on every player that can show an overlay and
 * needs nothing new on the screen side.
 *
 *   lower-third   a name and a line under it, sliding in from the left with a colour bar
 *   crawl         a ticker along the bottom, scrolling for as long as it is on
 *   bug           a small corner label (a channel ident, "LIVE", a score)
 *   title         a full-frame title card
 *
 * ⚠️ PUBLIC AND TEXT-ONLY. A player has no session, so the page is served without one; it
 * therefore renders nothing but the text it is handed, escaped, and carries a policy with NO
 * script at all (default-src 'none'): there is nothing here for a crafted link to run.
 */

const KINDS = ['lower-third', 'crawl', 'bug', 'title'];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const colour = (v, dflt) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : dflt);
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

/** What the overlay box should be for each kind, as fractions of the screen (the client turns
 *  them into the pixels routes/pip.js takes). */
const BOX = {
  'lower-third': { position: 'bottom-left', w: 0.62, h: 0.2 },
  crawl: { position: 'bottom-left', w: 1, h: 0.085 },
  bug: { position: 'top-right', w: 0.16, h: 0.1 },
  title: { position: 'center', w: 1, h: 1 },
};

function page(kind, q) {
  if (!KINDS.includes(kind)) return null;
  const accent = colour(q.accent, '#ff2a1f');
  const ink = colour(q.ink, '#ffffff');
  const plate = colour(q.plate, '#0b0c0e');
  const a = esc(clip(q.a, 120));          // the main line
  const b = esc(clip(q.b, 200));          // the second line
  const base = `html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:'Barlow','Helvetica Neue',Arial,sans-serif;color:${ink}}
    *{box-sizing:border-box}
    @font-face{font-family:'Barlow';font-weight:700;src:url('/vendor/fonts/barlow/barlow-latin-700-normal.woff2') format('woff2')}
    @font-face{font-family:'Barlow';font-weight:500;src:url('/vendor/fonts/barlow/barlow-latin-500-normal.woff2') format('woff2')}
    @media (prefers-reduced-motion: reduce){*{animation-duration:1ms !important}}`;
  let css = '', body = '';
  if (kind === 'lower-third') {
    // Sizes are relative to the FRAME the overlay gives it (about 62% x 20% of the screen), not to the screen.
    css = `.w{position:absolute;left:5vw;right:0;bottom:12vh;height:78vh;display:flex;align-items:stretch;animation:in .55s cubic-bezier(.2,.8,.2,1) both}
      .bar{flex:none;width:2.2vw;background:${accent};box-shadow:0 0 5vw ${accent}}
      .t{display:flex;flex-direction:column;justify-content:center;background:${plate};padding:0 5vw 0 3.4vw;min-width:46vw;max-width:92vw;clip-path:inset(0 100% 0 0);animation:wipe .5s .12s cubic-bezier(.2,.8,.2,1) forwards}
      .a{font-size:34vh;font-weight:700;letter-spacing:.01em;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .b{font-size:19vh;font-weight:500;opacity:.85;margin-top:4vh;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      @keyframes in{from{transform:translateX(-8vw);opacity:0}to{transform:none;opacity:1}}
      @keyframes wipe{to{clip-path:inset(0 0 0 0)}}`;
    body = `<div class="w"><div class="bar"></div><div class="t"><div class="a">${a}</div>${b ? `<div class="b">${b}</div>` : ''}</div></div>`;
  } else if (kind === 'crawl') {
    const secs = Math.max(8, Math.min(120, Math.round((a.length + 40) / 6)));
    css = `.w{position:absolute;inset:auto 0 0 0;height:100%;background:${plate};border-top:.6vh solid ${accent};display:flex;align-items:center;overflow:hidden;animation:up .4s ease-out both}
      .tag{flex:none;height:100%;display:flex;align-items:center;padding:0 2vw;background:${accent};color:#fff;font-weight:700;font-size:44vh;letter-spacing:.08em;text-transform:uppercase}
      .run{white-space:nowrap;font-size:50vh;font-weight:500;padding-left:100%;animation:run ${secs}s linear infinite}
      @keyframes run{to{transform:translateX(-100%)}}
      @keyframes up{from{transform:translateY(100%)}to{transform:none}}`;
    body = `<div class="w">${b ? `<div class="tag">${b}</div>` : ''}<div class="run">${a}</div></div>`;
  } else if (kind === 'bug') {
    css = `.w{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:1.2vw;background:${plate};border-left:1vw solid ${accent};font-weight:700;font-size:38vh;letter-spacing:.1em;text-transform:uppercase;animation:pop .35s ease-out both}
      .dot{width:16vh;height:16vh;border-radius:50%;background:${accent};box-shadow:0 0 14vh ${accent};animation:blink 1.6s ease-in-out infinite}
      @keyframes pop{from{transform:scale(.6);opacity:0}to{transform:none;opacity:1}}
      @keyframes blink{50%{opacity:.35}}`;
    body = `<div class="w"><span class="dot"></span><span>${a}</span></div>`;
  } else {
    css = `.w{position:absolute;inset:0;display:grid;place-content:center;text-align:center;background:${plate};padding:6vw;animation:fade .6s ease-out both}
      .rule{width:14vw;height:1vh;background:${accent};margin:0 auto 4vh;box-shadow:0 0 4vh ${accent};transform:scaleX(0);animation:grow .6s .2s ease-out forwards}
      .a{font-size:13vh;font-weight:700;line-height:1.05;letter-spacing:.01em;animation:rise .6s .15s cubic-bezier(.2,.8,.2,1) both}
      .b{font-size:5.5vh;font-weight:500;opacity:.8;margin-top:3vh;animation:rise .6s .3s cubic-bezier(.2,.8,.2,1) both}
      @keyframes fade{from{opacity:0}to{opacity:1}}
      @keyframes grow{to{transform:none}}
      @keyframes rise{from{transform:translateY(4vh);opacity:0}to{transform:none;opacity:1}}`;
    body = `<div class="w"><div><div class="rule"></div><div class="a">${a}</div>${b ? `<div class="b">${b}</div>` : ''}</div></div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${a}</title><style>${base}${css}</style></head><body>${body}</body></html>`;
}

/**
 * The policy the page is served with: no script anywhere.
 * ⚠️ NO frame-ancestors directive, on purpose. `frame-ancestors *` reads as "anyone" but only
 * matches http(s) parents: an Android, Tizen or BrightSign player is a file:// page, and a
 * dashboard preview can be about:blank, and for all of those the frame was refused (a grey box
 * with a sad face where the lower third should be). There is nothing on this page to click, so
 * who frames it does not matter; X-Frame-Options is removed by the route for the same reason.
 */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'";

module.exports = { KINDS, BOX, page, CSP };
