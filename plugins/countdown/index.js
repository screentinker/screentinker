'use strict';

/*
 * Sample widget plugin. Server-side render to HTML, same path as the built-in clock:
 * GET /api/widgets/:id/render is iframed by every player, so this needs no player runtime.
 */

const TARGET_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/;

function render(config, ctx) {
  const c = config || {};
  const { escapeHtml, safeCss } = ctx;
  const color = safeCss(c.color, '#ffffff');
  const background = safeCss(c.background, '#0b1220');
  const label = escapeHtml(String(c.label || 'Countdown'));
  const showSeconds = c.show_seconds !== false;
  const target = typeof c.target === 'string' ? c.target : '';

  if (!TARGET_RE.test(target) || Number.isNaN(Date.parse(target))) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${background};color:${color};
display:flex;align-items:center;justify-content:center;
font-family:-apple-system,sans-serif}
</style></head><body><div>Countdown not configured</div></body></html>`;
  }

  const targetJson = JSON.stringify(target);
  const showJson = JSON.stringify(!!showSeconds);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { overflow:hidden; height:100%; }
body { background:${background}; color:${color}; display:flex; flex-direction:column;
  align-items:center; justify-content:center; height:100vh;
  font-family:-apple-system,sans-serif; }
#label { font-size:clamp(14px, 4vw, 28px); opacity:0.75; margin-bottom:12px; letter-spacing:0.04em; text-transform:uppercase; }
#time { font-size:clamp(28px, 10vw, 96px); font-weight:700; font-variant-numeric:tabular-nums; }
#done { display:none; font-size:clamp(22px, 6vw, 48px); font-weight:700; }
</style></head><body>
<div id="label">${label}</div>
<div id="time"></div>
<div id="done">00:00:00</div>
<script>
(function(){
  var target = Date.parse(${targetJson});
  var showSeconds = ${showJson};
  var timeEl = document.getElementById('time');
  var doneEl = document.getElementById('done');
  function pad(n){ return n < 10 ? '0' + n : String(n); }
  function tick(){
    var ms = target - Date.now();
    if (!(ms > 0)) {
      timeEl.style.display = 'none';
      doneEl.style.display = 'block';
      return;
    }
    var s = Math.floor(ms / 1000);
    var days = Math.floor(s / 86400); s -= days * 86400;
    var hours = Math.floor(s / 3600); s -= hours * 3600;
    var minutes = Math.floor(s / 60); s -= minutes * 60;
    var parts = [];
    if (days > 0) parts.push(days + 'd');
    parts.push(pad(hours));
    parts.push(pad(minutes));
    if (showSeconds) parts.push(pad(s));
    timeEl.textContent = days > 0
      ? (days + 'd ' + pad(hours) + 'h ' + pad(minutes) + 'm' + (showSeconds ? ' ' + pad(s) + 's' : ''))
      : parts.join(':');
  }
  setInterval(tick, 250);
  tick();
})();
</script></body></html>`;
}

function activate(api) {
  api.registerWidget({ type: 'countdown', render });
}

module.exports = { activate, render };
