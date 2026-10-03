'use strict';

/**
 * Public "tell us this works" flow for the Certified Hardware page.
 *
 * Unauthenticated on purpose: the page invites community reports, and requiring an account would
 * mean only existing customers could tell us what runs. The safety is not authentication, it is
 * that nothing here can publish anything a reader would mistake for a support commitment. See
 * lib/hardware-submissions.js — status and validated_by are assigned, never accepted from input.
 *
 * Rate limiting is mounted in server.js, which is where every other public limiter lives.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const submissions = require('../lib/hardware-submissions');
const email = require('../services/email');

const NOTIFY = process.env.HARDWARE_SUBMISSIONS_EMAIL || 'support@screentinker.com';

// APP_URL pins the canonical origin, same as workspace invites and signup emails. Falls back to the
// request's own host so a self-hosted instance still gets working links with nothing configured.
function baseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A plain page, because the submitter arrives from a form post with no JavaScript running. */
function page(res, status, heading, body) {
  res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${esc(heading)} | ScreenTinker</title>
<link rel="stylesheet" href="/css/seo-page.css"></head>
<body><main class="article"><h1>${esc(heading)}</h1>${body}
<p><a href="/certified-hardware">Back to Certified Hardware</a></p></main></body></html>`);
}

router.post('/', async (req, res) => {
  let created;
  try {
    created = submissions.create(db, req.body, req.ip);
  } catch (e) {
    if (e.name === 'SubmissionError') {
      return page(res, 400, 'That did not go through', `<p>${esc(e.message)}</p>
        <p><a href="/certified-hardware/submit">Go back and try again</a></p>`);
    }
    console.error('[hardware-submissions] create:', e && e.message);
    return page(res, 500, 'Something went wrong', '<p>Your report was not saved. Please try again later.</p>');
  }

  const { token, row } = created;
  const base = baseUrl(req);
  const approve = `${base}/hardware-submissions/${token}/approve`;
  const reject = `${base}/hardware-submissions/${token}/reject`;
  const detail = [
    ['Device', row.name], ['Manufacturer', row.manufacturer], ['Model numbers', row.model_numbers],
    ['Category', row.category], ['OS', row.os], ['Player', row.player],
    ['Resolution', row.max_resolution], ['ScreenTinker version', row.player_version],
    ['Notes', row.notes], ['From', `${row.submitter_name || 'anonymous'} ${row.submitter_email || ''}`],
  ].filter(([, v]) => v).map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('');

  // ⚠️ WITHOUT THIS THE FEATURE IS INERT ON ANY INSTANCE WITH NO MAIL CONFIGURED. sendEmail() logs
  // only the subject and the first line of the body when it has nowhere to send, so the approve
  // link would exist solely inside an email that was never sent — the submission sits pending
  // forever and nobody can tell why. Self-hosting is the normal case here, so print the links.
  if (!email.isConfigured()) {
    console.log(`[hardware-submissions] "${row.name}" submitted; email is not configured, so decide here:`);
    console.log(`  approve: ${approve}`);
    console.log(`  reject:  ${reject}`);
  }

  try {
    await email.sendEmail({
      to: NOTIFY,
      subject: `Hardware report: ${row.name}`,
      text: `${row.name}\n\nApprove: ${approve}\nReject: ${reject}\n`,
      html: `<p>A community hardware report was submitted.</p>
        <table cellpadding="4">${detail}</table>
        <p>Approving publishes it on the Certified Hardware page as <b>community-reported</b>.
        It is not certification and carries no support commitment.</p>
        <p><a href="${approve}">Approve and publish</a> &nbsp;|&nbsp; <a href="${reject}">Reject</a></p>
        <p style="color:#666;font-size:12px">These links work once and expire in 30 days.</p>`,
    });
  } catch (e) {
    // The submission is already stored. Losing the notification is recoverable; losing the report
    // because the mail server was down is not, so this never fails the request.
    console.error('[hardware-submissions] notify:', e && e.message);
  }

  return page(res, 200, 'Thanks, that is logged',
    `<p>Your report on <b>${esc(row.name)}</b> has been sent for review.</p>
     <p>If it is published it will appear under Community reported, which means a user says it works.
     It is not certification and carries no support commitment.</p>`);
});

function decision(kind) {
  return (req, res) => {
    let row;
    try {
      row = submissions.decide(db, req.params.token, kind);
    } catch (e) {
      console.error('[hardware-submissions] decide:', e && e.message);
      return page(res, 500, 'Something went wrong', '<p>Please try again.</p>');
    }
    if (!row) {
      return page(res, 410, 'That link is no longer valid',
        '<p>It has already been used, or it expired. Nothing was changed.</p>');
    }
    require('./certified-hardware').invalidate();
    return kind === 'approved'
      ? page(res, 200, 'Published', `<p><b>${esc(row.name)}</b> is now listed under Community reported.</p>`)
      : page(res, 200, 'Rejected', `<p><b>${esc(row.name)}</b> was not published.</p>`);
  };
}

router.get('/:token/approve', decision('approved'));
router.get('/:token/reject', decision('rejected'));

module.exports = router;
