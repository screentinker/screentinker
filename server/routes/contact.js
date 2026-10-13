// Public (unauthenticated) contact form endpoint. Used by the Enterprise /
// Custom card on the marketing landing page to send a lead to Dan's inbox via
// the existing Microsoft Graph email service.
//
// Honeypot strategy: the form has a hidden 'fax_number' field that real users
// never see (off-screen + aria-hidden + tabindex=-1). If a submission arrives
// with that field populated, we return success to the bot but drop the
// submission silently. Combined with the rate limit applied in server.js
// (5 req/min/IP+path), this is enough friction for a low-traffic public form.

const express = require('express');
const router = express.Router();
const { sendEmail } = require('../services/email');

/*
 * Same rule as /^[^\s@]+@[^\s@]+\.[^\s@]+$/ — no whitespace, exactly one @ with something before
 * it, and a dot in the domain with at least one character either side — done with string ops. The
 * regex is quadratic on a domain of many dots (each split between the two [^\s@]+ is retried).
 */
function isEmail(s) {
  if (typeof s !== 'string' || /\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at < 1 || s.indexOf('@', at + 1) !== -1) return false;
  return s.slice(at + 2, -1).includes('.');
}
function clamp(s, max) {
  return String(s || '').slice(0, max);
}

router.post('/enterprise', async (req, res) => {
  const { name, email, company, screens, multi_tenant, hosting, message, fax_number } = req.body || {};

  // Honeypot. Real users can't see or tab to this field; only bots fill it.
  // Return 200 so the bot's retry logic doesn't kick in, but skip the send.
  if (fax_number && String(fax_number).trim() !== '') {
    console.log(`[contact] honeypot triggered from ${req.ip}; dropping`);
    return res.json({ success: true });
  }

  // Server-side validation. Client validates too but we never trust that.
  if (!name || !email || !company || !screens || !multi_tenant || !hosting) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!isEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  const screensNum = parseInt(screens);
  if (!Number.isFinite(screensNum) || screensNum < 1 || screensNum > 100000) {
    return res.status(400).json({ error: 'Screens must be a positive number' });
  }
  if (!['single', 'multi'].includes(multi_tenant)) {
    return res.status(400).json({ error: 'Invalid multi-tenant selection' });
  }
  if (!['hosted', 'self', 'unsure'].includes(hosting)) {
    return res.status(400).json({ error: 'Invalid hosting selection' });
  }

  // Length caps - keeps a 10MB textarea from filling the mailbox
  const cleanName = clamp(name, 200);
  const cleanEmail = clamp(email, 200);
  const cleanCompany = clamp(company, 200);
  const cleanMessage = clamp(message, 5000);

  const tenantLabel = multi_tenant === 'multi' ? 'Multiple organizations' : 'Single organization';
  const hostingLabel = { hosted: 'Hosted for me', self: 'Self-host', unsure: 'Not sure yet' }[hosting];

  const subject = `Enterprise inquiry: ${cleanCompany}`;
  const text =
`New enterprise inquiry from ${cleanName} (${cleanEmail})

Company: ${cleanCompany}
Estimated screens: ${screensNum}
Multi-tenant: ${tenantLabel}
Hosting preference: ${hostingLabel}

Message:
${cleanMessage || '(none)'}

---
Submitted from screentinker.com pricing page
Source IP: ${req.ip}
`;

  const result = await sendEmail({ to: 'dan@bytetinker.net', subject, text });
  if (!result.sent) {
    console.error(`[contact] email send failed for ${cleanEmail}: reason=${result.reason} error=${result.error || ''}`);
    return res.status(500).json({ error: 'Could not send your message. Please email dan@bytetinker.net directly.' });
  }
  console.log(`[contact] enterprise inquiry from ${cleanEmail} (${cleanCompany}) delivered`);
  res.json({ success: true });
});

module.exports = router;
module.exports.isEmail = isEmail;
