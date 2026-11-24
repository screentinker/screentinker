'use strict';

/*
 * LEGAL PAGES ON A SELF-HOSTED INSTANCE.
 *
 * frontend/legal/terms.html and privacy.html are the terms and privacy policy of the HOSTED service
 * at screentinker.com, run by Bytetinker LLC: its plans and billing, Wisconsin law, its backups, its
 * support address and its DMCA designated agent. Served unchanged by someone else's server they named
 * Bytetinker as the party responsible for content Bytetinker neither hosts nor can remove, and sent
 * copyright notices and privacy requests to the wrong people (raised by Omniflux, 2026-11-24).
 *
 * So with SELF_HOSTED=true:
 *   - TERMS_URL / PRIVACY_URL set: /legal/terms(.html) and /legal/privacy(.html) redirect to the
 *     operator's own page (and the .md rendition too, so agents land on the same document).
 *   - not set: a short neutral page saying the instance is run independently and its operator sets
 *     the terms and handles notices, with no Bytetinker contact details.
 * The hosted service (SELF_HOSTED unset) is untouched. third-party.html (open-source notices) is the
 * same everywhere and is left alone.
 */

const PAGES = {
  terms: {
    title: 'Terms of use',
    body: [
      'This ScreenTinker server is run independently by its operator. Its operator sets the terms of use for this instance and is responsible for the content stored and shown on it.',
      'ScreenTinker and Bytetinker LLC do not host, control or review content on this server, so copyright notices (including DMCA notices), takedown requests and other complaints about this instance must go to its operator.',
      'If you have an account here, the operator\'s contact details are the ones you were given when your account was set up; ask your administrator.',
    ],
  },
  privacy: {
    title: 'Privacy',
    body: [
      'This ScreenTinker server is run independently by its operator, who decides what is collected, how long it is kept and who it is shared with. Your data on this instance is held by the operator, not by ScreenTinker or Bytetinker LLC.',
      'A self-hosted ScreenTinker server does not send usage data or telemetry to ScreenTinker. Requests to see, correct or delete your data go to the operator of this instance.',
      'If you have an account here, you can delete it yourself in Settings, under Delete my account.',
    ],
  },
};

function kindOf(path) {
  const m = /^\/legal\/(terms|privacy)(\.html|\.md)?$/.exec(String(path || ''));
  return m ? { kind: m[1], markdown: m[2] === '.md' } : null;
}

/** An operator's TERMS_URL / PRIVACY_URL: an absolute http(s) URL, or null (anything else is ignored). */
function cleanUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.toString() : null;
  } catch (e) { return null; }
}

function html(kind) {
  const p = PAGES[kind];
  // security-ok(server-html-interp): t is fixed text from the PAGES constant above, never input
  const paras = p.body.map((t) => `    <p>${t}</p>`).join('\n');
  // security-ok(server-html-interp): p.title and paras are built only from the PAGES constant
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${p.title} - ScreenTinker (self-hosted)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0f172a; color:#e2e8f0; margin:0; line-height:1.7; }
    .container { max-width:720px; margin:0 auto; padding:48px 24px; }
    h1 { font-size:28px; margin-bottom:8px; }
    p { color:#cbd5e1; font-size:15px; }
    a { color:#60a5fa; }
    .note { color:#94a3b8; font-size:13px; margin-top:32px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${p.title}</h1>
${paras}
    <p class="note">ScreenTinker is open-source software under the <a href="https://github.com/screentinker/screentinker/blob/main/LICENSE" rel="noopener">MIT license</a>. Open-source notices: <a href="/legal/third-party.html">third-party software</a>.</p>
  </div>
</body>
</html>
`;
}

/**
 * Express handler for /legal/(terms|privacy)[.html|.md]. Passes through unless the server is
 * self-hosted. `opts` = { selfHosted, termsUrl, privacyUrl, toMarkdown(html, path, req) }.
 */
function handler(opts) {
  return (req, res, next) => {
    if (!opts.selfHosted) return next();
    const k = kindOf(req.path);
    if (!k) return next();
    const target = k.kind === 'terms' ? opts.termsUrl : opts.privacyUrl;
    // security-ok(open-redirect): the target is the operator's own TERMS_URL / PRIVACY_URL from the server environment, never request input
    if (target) return res.redirect(302, target);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex');
    const page = html(k.kind);
    if (k.markdown) return res.type('text/markdown; charset=utf-8').send(opts.toMarkdown(page, `/legal/${k.kind}`, req));
    return res.type('html').send(page);
  };
}

module.exports = { handler, cleanUrl, kindOf, html, PAGES };
