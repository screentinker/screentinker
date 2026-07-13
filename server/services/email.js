// Email sender with a pluggable transport: Microsoft Graph (default) or SMTP.
//
// Transport is chosen by EMAIL_TRANSPORT ("graph" | "smtp"; default "graph").
// An unknown value falls back to "graph" and is flagged by emailConfigStatus().
//
//   graph  — Microsoft Graph, client-credentials flow (no Graph SDK, plain HTTPS)
//     GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET,
//     GRAPH_SENDER_EMAIL, GRAPH_SENDER_NAME
//   smtp   — any standard mail server via nodemailer
//     SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
//
// When the selected transport is unconfigured, sendEmail() logs an [EMAIL] line
// to stdout and returns { sent:false, reason:'not_configured' } so local dev /
// test environments without mail access keep working.
//
// The heavy deps (@azure/msal-node for Graph, nodemailer for SMTP) are required
// lazily so a deploy that uses only one transport never needs the other, and the
// module loads cleanly when no email is configured at all.

const https = require('https');
const config = require('../config');

const VALID_TRANSPORTS = ['graph', 'smtp'];
const RAW_TRANSPORT = (config.emailTransport || 'graph').toLowerCase();
const TRANSPORT = VALID_TRANSPORTS.includes(RAW_TRANSPORT) ? RAW_TRANSPORT : 'graph';

let _msalClient = null;
let _cachedToken = null;      // { token: string, expiresAtMs: number }
let _smtpTransporter = null;

// ─────────────────────────── configuration ───────────────────────────

function graphMissing() {
  const missing = [];
  if (!config.graphTenantId) missing.push('GRAPH_TENANT_ID');
  if (!config.graphClientId) missing.push('GRAPH_CLIENT_ID');
  if (!config.graphClientSecret) missing.push('GRAPH_CLIENT_SECRET');
  if (!config.graphSenderEmail) missing.push('GRAPH_SENDER_EMAIL');
  return missing;
}

// SMTP needs a server (host+port) and a From identity. Auth is optional so an
// unauthenticated localhost relay works; but a user without a password is a
// misconfiguration, so flag it.
function smtpMissing() {
  const missing = [];
  if (!config.smtpHost) missing.push('SMTP_HOST');
  if (!config.smtpPort) missing.push('SMTP_PORT');
  if (!smtpFromAddress()) missing.push('SMTP_FROM (or SMTP_USER)');
  if (config.smtpUser && !config.smtpPassword) missing.push('SMTP_PASSWORD');
  return missing;
}

function isConfigured() {
  return (TRANSPORT === 'smtp' ? smtpMissing() : graphMissing()).length === 0;
}

// Startup diagnostics. Distinguishes three states so server.js can log the right
// thing: configured, intentionally-unconfigured (nothing set → silent stdout
// fallback), and partially-configured (some fields set but not all → real misconfig).
function emailConfigStatus() {
  const missing = TRANSPORT === 'smtp' ? smtpMissing() : graphMissing();
  const anySet = TRANSPORT === 'smtp'
    ? !!(config.smtpHost || config.smtpPort || config.smtpUser || config.smtpPassword || config.smtpFrom)
    : !!(config.graphTenantId || config.graphClientId || config.graphClientSecret || config.graphSenderEmail);
  return {
    transport: TRANSPORT,
    invalidTransport: !!config.emailTransport && !VALID_TRANSPORTS.includes(RAW_TRANSPORT),
    rawTransport: config.emailTransport || '',
    configured: missing.length === 0,
    partiallyConfigured: anySet && missing.length > 0,
    missing,
  };
}

// ─────────────────────────── Microsoft Graph ───────────────────────────

function getMsalClient() {
  if (_msalClient) return _msalClient;
  const msal = require('@azure/msal-node');
  _msalClient = new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.graphClientId,
      authority: `https://login.microsoftonline.com/${config.graphTenantId}`,
      clientSecret: config.graphClientSecret,
    },
  });
  return _msalClient;
}

// Acquire a Graph access token via client credentials. Cached in memory until
// 60s before reported expiry; on cache miss or near-expiry, refresh.
async function getAccessToken() {
  if (_cachedToken && _cachedToken.expiresAtMs > Date.now() + 60_000) {
    return _cachedToken.token;
  }
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('No accessToken returned from MSAL');
  const expiresAtMs = result.expiresOn ? result.expiresOn.getTime() : (Date.now() + 3_300_000); // 55min fallback
  _cachedToken = { token: result.accessToken, expiresAtMs };
  return _cachedToken.token;
}

// POST /users/{sender}/sendMail. Plain HTTPS, no Graph SDK. Resolves on 2xx,
// rejects with status + body on anything else so the caller can log.
function postSendMail(token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'graph.microsoft.com',
      port: 443,
      path: `/v1.0/users/${encodeURIComponent(config.graphSenderEmail)}/sendMail`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Graph sendMail ${res.statusCode}: ${chunks.slice(0, 500)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// The From address is always graphSenderEmail (so replies land in that mailbox);
// fromName overrides only the display name. subject/html are already finalized
// by sendEmail (prefix applied, html derived from text) — this builder is pure.
function buildGraphPayload(to, subject, html, fromName) {
  return {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }],
      from: {
        emailAddress: {
          address: config.graphSenderEmail,
          name: fromName || config.graphSenderName || 'ScreenTinker',
        },
      },
    },
    saveToSentItems: false,
  };
}

// ─────────────────────────── SMTP (nodemailer) ───────────────────────────

// Parse the bare address out of SMTP_FROM ("Name <a@b.com>" or "a@b.com");
// fall back to SMTP_USER when SMTP_FROM has no usable address.
function smtpFromAddress() {
  const from = config.smtpFrom || '';
  const m = /<([^>]+)>/.exec(from);
  if (m) return m[1].trim();
  if (from.includes('@')) return from.trim();
  return (config.smtpUser || '').trim();
}

function getSmtpTransporter() {
  if (_smtpTransporter) return _smtpTransporter;
  const nodemailer = require('nodemailer');
  const opts = {
    host: config.smtpHost,
    port: Number(config.smtpPort),
    secure: !!config.smtpSecure,   // true = implicit TLS (465); false = STARTTLS (587)
  };
  if (config.smtpUser) opts.auth = { user: config.smtpUser, pass: config.smtpPassword };
  _smtpTransporter = nodemailer.createTransport(opts);
  return _smtpTransporter;
}

// Pure message builder (exported for tests). fromName overrides the display name
// while keeping the configured From address; otherwise SMTP_FROM is used verbatim.
function buildSmtpMessage(to, subject, text, html, fromName) {
  const from = fromName
    ? { name: fromName, address: smtpFromAddress() }
    : (config.smtpFrom || smtpFromAddress());
  const msg = { from, to, subject, html };
  if (text) msg.text = text;   // keep a plain-text alternative when the caller gave one
  return msg;
}

async function smtpSend(to, subject, text, html, fromName) {
  await getSmtpTransporter().sendMail(buildSmtpMessage(to, subject, text, html, fromName));
}

// ─────────────────────────── public surface ───────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Caller passes { to, subject, text, html } (html optional; derived from text if
// absent). rawSubject:true sends the subject verbatim (no "[ScreenTinker] "
// prefix). fromName overrides the display name. Returns a result object and never
// throws — delivery failures are logged and returned as sent:false so app flow
// (offline alerts, signup mail, etc.) keeps running even when email is broken.
async function sendEmail({ to, subject, text, html, fromName, rawSubject }) {
  if (!isConfigured()) {
    console.log(`[EMAIL] not configured - would send to ${to}: ${subject}`);
    if (text) console.log(`  ${text.split('\n')[0]}`);
    return { sent: false, reason: 'not_configured' };
  }
  // Dev allow-list (applies to every transport). Bypass sending for any recipient
  // not in the list. Skipped when graphDevRestrictTo is empty (i.e. prod).
  if (config.graphDevRestrictTo) {
    const allowed = config.graphDevRestrictTo
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(String(to).toLowerCase())) {
      console.log(`[EMAIL] dev restrict - would send to ${to}: ${subject} (suppressed)`);
      return { sent: false, reason: 'dev_restricted' };
    }
  }
  const finalSubject = rawSubject ? subject : `[ScreenTinker] ${subject}`;
  const finalHtml = html || `<pre style="font-family:sans-serif">${escapeHtml(text || '')}</pre>`;
  try {
    if (TRANSPORT === 'smtp') {
      await smtpSend(to, finalSubject, text, finalHtml, fromName);
    } else {
      const token = await getAccessToken();
      await postSendMail(token, buildGraphPayload(to, finalSubject, finalHtml, fromName));
    }
    console.log(`[EMAIL] sent to ${to}: ${subject}`);
    return { sent: true };
  } catch (e) {
    console.error(`[EMAIL] ${TRANSPORT} send failed for ${to}: ${e.message}`);
    return { sent: false, reason: `${TRANSPORT}_error`, error: e.message };
  }
}

module.exports = {
  sendEmail,
  isConfigured,
  emailConfigStatus,
  // exported for tests
  buildSmtpMessage,
  buildGraphPayload,
  smtpFromAddress,
};
