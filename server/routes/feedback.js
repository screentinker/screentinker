'use strict';

/*
 * The feedback loop (lib/feedback.js).
 *
 *   GET  /api/feedback/prompt        the moment to ask this user about now, or none
 *   POST /api/feedback/shown         the dashboard showed it (it is never shown again)
 *   POST /api/feedback/dismiss       "Not now"
 *   POST /api/feedback               an answer from the dashboard (a prompt or "Send feedback")
 *   GET  /api/feedback/respond       the page a follow-up email's 1-5 links open (PUBLIC, signed token)
 *   POST /api/feedback/respond       that page's Send (PUBLIC, signed token)
 *   GET  /api/feedback/admin         platform admin: totals, averages, reasons, every answer + journey
 *   GET  /api/feedback/admin.csv     the same as a spreadsheet
 *
 * ⚠️ THE EMAIL LINK RECORDS NOTHING BY ITSELF. Mail scanners (Outlook Safe Links, corporate gateways)
 * open every link in a message to check it, so a GET that saved the rating would have recorded all
 * five ratings for anyone behind one. The link opens a page with that rating chosen; only its Send
 * button (a POST) stores the answer.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const feedback = require('../lib/feedback');

function ownUser(req) {
  // Support and recovery sessions authenticate as "<kind>:<id>" and have no account to ask.
  return req.user && !String(req.user.id).includes(':') ? req.user : null;
}

router.get('/prompt', requireAuth, (req, res) => {
  const u = ownUser(req);
  res.json({ enabled: feedback.enabled(), prompt: u ? feedback.promptFor(db, u) : null });
});

router.post('/shown', requireAuth, (req, res) => {
  const u = ownUser(req);
  if (u && feedback.enabled()) feedback.markShown(db, u.id, String((req.body || {}).trigger || ''));
  res.json({ ok: true });
});

router.post('/dismiss', requireAuth, (req, res) => {
  const u = ownUser(req);
  if (u && feedback.enabled()) feedback.markDismissed(db, u.id, String((req.body || {}).trigger || ''));
  res.json({ ok: true });
});

router.post('/', requireAuth, (req, res) => {
  const u = ownUser(req);
  if (!u) return res.status(403).json({ error: 'This session has no account to send feedback from' });
  if (!feedback.enabled()) return res.json({ ok: true, recorded: false });
  try {
    const id = feedback.save(db, { userId: u.id, workspaceId: req.workspaceId || null, ...(req.body || {}) });
    res.status(201).json({ ok: true, recorded: true, id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save your feedback' });
  }
});

router.get('/admin', requireAuth, requireSuperAdmin, (req, res) => {
  res.json(feedback.summary(db, { days: parseInt(req.query.days, 10) || 30 }));
});

router.get('/admin.csv', requireAuth, requireSuperAdmin, (req, res) => {
  const days = parseInt(req.query.days, 10) || 90;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="screentinker-feedback-${days}d.csv"`);
  res.send(feedback.csv(db, { days }));
});

/* ------------------------------------------------------------------ the email page (public) */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const QUESTION = {
  trial_ended: 'Your trial ended. What stopped you from carrying on?',
  cancelled: 'You cancelled. What made you leave?',
  paid: 'What made you choose ScreenTinker?',
  trial_day7: 'How is ScreenTinker working out?',
  first_pair: 'How was setting up your first screen?',
  general: 'How is ScreenTinker working for you?',
};
const REASON_LABEL = {
  price: 'The price', missing_feature: 'A feature I need is missing', hardware: 'It did not work with my screens',
  too_complex: 'Too complicated to set up', didnt_work: 'Something did not work', just_testing: 'I was only trying it out',
  switched: 'I moved to something else', project_ended: 'The project ended', easy_setup: 'Easy to set up',
  hardware_support: 'Works with the screens I have', features: 'The features', open_source: 'It is open source', other: 'Something else',
};

function page(body, status = 200) {
  return [status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScreenTinker feedback</title><style>
body{margin:0;background:#0f172a;color:#e2e8f0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 20px}h1{font-size:22px;margin:0 0 18px}
.stars{display:flex;gap:8px;margin:8px 0 20px}.stars label{flex:1}.stars input{position:absolute;opacity:0}
.stars span{display:block;text-align:center;padding:12px 0;border:1px solid #334155;border-radius:10px;font-weight:700;cursor:pointer}
.stars input:checked+span{background:#3b82f6;border-color:#3b82f6;color:#fff}
.r{display:block;margin:6px 0}textarea{width:100%;box-sizing:border-box;min-height:120px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:10px;padding:10px;font:inherit}
button{margin-top:16px;background:#3b82f6;color:#fff;border:0;border-radius:10px;padding:12px 22px;font:600 16px system-ui;cursor:pointer}
.muted{color:#94a3b8;font-size:14px}</style></head><body><main>${body}</main></body></html>`];
}

router.get('/respond', (req, res) => {
  const tok = feedback.readToken(String(req.query.t || ''));
  if (!tok || !feedback.enabled()) {
    const [s, html] = page('<h1>This link has expired</h1><p class="muted">Thanks for wanting to tell us. You can always reply to the email instead.</p>', 410);
    return res.status(s).type('html').send(html);
  }
  const chosen = Number(req.query.r);
  const stars = [1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="rating" value="${n}" ${n === chosen ? 'checked' : ''}><span>${n}</span></label>`).join('');
  const reasons = feedback.REASONS[tok.trigger].map((r) => `<label class="r"><input type="checkbox" name="reasons" value="${esc(r)}"> ${esc(REASON_LABEL[r] || r)}</label>`).join('');
  const [s, html] = page(`<h1>${esc(QUESTION[tok.trigger])}</h1>
<form method="post" action="respond">
<input type="hidden" name="t" value="${esc(req.query.t)}">
<div class="muted">1 = not at all, 5 = very well</div><div class="stars">${stars}</div>
${reasons ? `<div style="margin-bottom:14px">${reasons}</div>` : ''}
<label class="muted" for="c">Anything else? What would have made the difference?</label>
<textarea id="c" name="comment" maxlength="${feedback.COMMENT_MAX}"></textarea>
<button type="submit">Send</button>
</form>`);
  res.status(s).type('html').send(html);
});

router.post('/respond', (req, res) => {
  const b = req.body || {};
  const tok = feedback.readToken(String(b.t || ''));
  if (!tok || !feedback.enabled()) {
    const [s, html] = page('<h1>This link has expired</h1><p class="muted">You can reply to the email instead.</p>', 410);
    return res.status(s).type('html').send(html);
  }
  try {
    feedback.save(db, { userId: tok.userId, trigger: tok.trigger, source: 'email', rating: b.rating, comment: b.comment,
      reasons: Array.isArray(b.reasons) ? b.reasons : (b.reasons ? [b.reasons] : []) });
  } catch (e) {
    const [s, html] = page(`<h1>Nothing to send yet</h1><p class="muted">${esc(e.message)}. <a style="color:#93c5fd" href="javascript:history.back()">Go back</a></p>`, 400);
    return res.status(s).type('html').send(html);
  }
  const [s, html] = page('<h1>Thank you</h1><p>That goes straight to the people who build ScreenTinker, and it is read.</p>');
  res.status(s).type('html').send(html);
});

module.exports = router;
