'use strict';

/*
 * A small standalone page with one button, for links that arrive by email (#876).
 *
 * ⚠️ AN EMAILED LINK MUST NEVER ACT ON GET. Corporate mail filters (Microsoft Defender Safe Links,
 * Mimecast, Proofpoint) and link previews open every link in a message before the person does. So
 * the link's GET renders this page and changes nothing, and the button POSTs. Scanners fetch links
 * but do not press buttons. Deliberately NO script that submits the form on load: several scanners
 * run JavaScript, and an auto-submitting page is just a GET with extra steps.
 *
 * Same look as routes/unsubscribe.js, which has followed this rule from the start.
 */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Render { title, body } as a full page. `body` is trusted HTML: callers escape their values.
 * A `form` adds one POST button: { action, button, fields: { name: value } }.
 */
function render({ title, body, form }) {
  const formHtml = form ? `
<form method="post" action="${esc(form.action)}">
${Object.entries(form.fields || {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n')}
<button type="submit">${esc(form.button)}</button>
</form>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | ScreenTinker</title>
<meta name="robots" content="noindex">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111827;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;line-height:1.6;padding:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:32px;max-width:560px;width:100%}
h1{font-size:22px;margin:0 0 12px}
p,td{margin:0 0 14px;color:#cbd5e1;font-size:15px}
table{margin:0 0 14px;border-collapse:collapse}
td{padding:2px 12px 2px 0;vertical-align:top}
button{background:#3b82f6;color:#fff;border:none;border-radius:9px;padding:13px 24px;font-size:15px;font-weight:700;cursor:pointer;min-height:44px;margin:4px 0 14px}
button:hover{background:#2563eb}
.muted{color:#94a3b8;font-size:13px;margin:0}
a{color:#3b82f6}
</style>
</head>
<body><div class="card"><h1>${esc(title)}</h1>${body}${formHtml}</div></body>
</html>`;
}

function send(res, status, opts) {
  res.status(status).type('text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')   // the token is in the URL; keep it out of Referer
    .set('X-Robots-Tag', 'noindex, nofollow')
    .send(render(opts));
}

module.exports = { esc, render, send };
