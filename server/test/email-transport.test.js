// #173: pluggable email transport (Microsoft Graph default, SMTP alternative).
// These tests drive services/email.js by loading it fresh under different env,
// and mock nodemailer via require.cache so the SMTP path is exercised with no
// network. config.js reads process.env directly (no dotenv), so busting its
// cache re-reads whatever we set here.

const { test } = require('node:test');
const assert = require('node:assert');

const CONFIG = require.resolve('../config.js');
const EMAIL = require.resolve('../services/email.js');
const NODEMAILER = require.resolve('nodemailer');

const EMAIL_ENV_KEYS = [
  'EMAIL_TRANSPORT',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM',
  'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_SENDER_EMAIL',
  'GRAPH_SENDER_NAME', 'GRAPH_DEV_RESTRICT_TO',
];

// Load email.js fresh under a specific env. mockSmtp: 'ok' captures sendMail
// calls; 'throw' makes sendMail reject (transport error path).
function loadEmail(env, { mockSmtp } = {}) {
  for (const k of EMAIL_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[CONFIG];
  delete require.cache[EMAIL];
  const captured = { sendMail: [] };
  if (mockSmtp) {
    const sendMail = mockSmtp === 'throw'
      ? async () => { throw new Error('SMTP connect ECONNREFUSED'); }
      : async (msg) => { captured.sendMail.push(msg); return { messageId: 'test' }; };
    require.cache[NODEMAILER] = {
      id: NODEMAILER, filename: NODEMAILER, loaded: true,
      exports: { createTransport: () => ({ sendMail }) },
    };
  } else {
    delete require.cache[NODEMAILER];
  }
  return { mod: require(EMAIL), captured };
}

const SMTP_OK = { EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_FROM: 'ScreenTinker <noreply@example.com>' };

// ─────────────── transport selection & config validation ───────────────

test('defaults to graph transport when EMAIL_TRANSPORT is unset', () => {
  const { mod } = loadEmail({});
  const es = mod.emailConfigStatus();
  assert.equal(es.transport, 'graph');
  assert.equal(es.configured, false);         // no GRAPH_* set
  assert.equal(mod.isConfigured(), false);
});

test('graph reports configured when all four core vars are set', () => {
  const { mod } = loadEmail({
    GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_SENDER_EMAIL: 'a@b.com',
  });
  assert.equal(mod.isConfigured(), true);
  assert.equal(mod.emailConfigStatus().configured, true);
  assert.deepEqual(mod.emailConfigStatus().missing, []);
});

test('smtp with missing fields is not configured and lists what is missing', () => {
  const { mod } = loadEmail({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.example.com' });
  const es = mod.emailConfigStatus();
  assert.equal(es.transport, 'smtp');
  assert.equal(es.configured, false);
  assert.equal(mod.isConfigured(), false);
  assert.equal(es.partiallyConfigured, true);   // some set, some missing
  assert.ok(es.missing.includes('SMTP_PORT'));
  assert.ok(es.missing.some(m => m.startsWith('SMTP_FROM')));
});

test('smtp fully configured (host+port+from) is configured', () => {
  const { mod } = loadEmail(SMTP_OK);
  assert.equal(mod.isConfigured(), true);
  assert.deepEqual(mod.emailConfigStatus().missing, []);
});

test('smtp with a user but no password is flagged as misconfigured', () => {
  const { mod } = loadEmail({ ...SMTP_OK, SMTP_USER: 'u@example.com' }); // no SMTP_PASSWORD
  const es = mod.emailConfigStatus();
  assert.equal(es.configured, false);
  assert.ok(es.missing.includes('SMTP_PASSWORD'));
});

test('an unset transport is "not configured" but NOT flagged as partial misconfig', () => {
  const { mod } = loadEmail({ EMAIL_TRANSPORT: 'smtp' }); // nothing else
  const es = mod.emailConfigStatus();
  assert.equal(es.configured, false);
  assert.equal(es.partiallyConfigured, false);   // nothing set at all → silent fallback, not an error
});

test('invalid EMAIL_TRANSPORT falls back to graph and is flagged', () => {
  const { mod } = loadEmail({
    EMAIL_TRANSPORT: 'sendgrid',
    GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_SENDER_EMAIL: 'a@b.com',
  });
  const es = mod.emailConfigStatus();
  assert.equal(es.transport, 'graph');
  assert.equal(es.invalidTransport, true);
  assert.equal(es.rawTransport, 'sendgrid');
  assert.equal(mod.isConfigured(), true);        // graph is fully set, so still usable
});

// ─────────────── SMTP message building ───────────────

test('buildSmtpMessage uses SMTP_FROM verbatim and keeps a text alternative', () => {
  const { mod } = loadEmail(SMTP_OK);
  const msg = mod.buildSmtpMessage('to@x.com', '[ScreenTinker] Hi', 'plain body', '<p>plain body</p>');
  assert.equal(msg.from, 'ScreenTinker <noreply@example.com>');
  assert.equal(msg.to, 'to@x.com');
  assert.equal(msg.subject, '[ScreenTinker] Hi');
  assert.equal(msg.html, '<p>plain body</p>');
  assert.equal(msg.text, 'plain body');
});

test('buildSmtpMessage fromName override keeps the configured address, drops empty text', () => {
  const { mod } = loadEmail(SMTP_OK);
  const msg = mod.buildSmtpMessage('to@x.com', 'S', null, '<p>x</p>', 'Alerts');
  assert.deepEqual(msg.from, { name: 'Alerts', address: 'noreply@example.com' });
  assert.equal('text' in msg, false);
});

test('smtpFromAddress parses "Name <addr>", bare addr, and falls back to SMTP_USER', () => {
  assert.equal(loadEmail({ ...SMTP_OK, SMTP_FROM: 'A B <a@b.com>' }).mod.smtpFromAddress(), 'a@b.com');
  assert.equal(loadEmail({ ...SMTP_OK, SMTP_FROM: 'c@d.com' }).mod.smtpFromAddress(), 'c@d.com');
  assert.equal(loadEmail({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_USER: 'u@e.com', SMTP_PASSWORD: 'p' }).mod.smtpFromAddress(), 'u@e.com');
});

// ─────────────── sendEmail routing (SMTP path, mocked) ───────────────

test('sendEmail via smtp routes to nodemailer with the [ScreenTinker] prefix', async () => {
  const { mod, captured } = loadEmail(SMTP_OK, { mockSmtp: 'ok' });
  const r = await mod.sendEmail({ to: 'user@x.com', subject: 'Hello', text: 'hi there' });
  assert.deepEqual(r, { sent: true });
  assert.equal(captured.sendMail.length, 1);
  assert.equal(captured.sendMail[0].subject, '[ScreenTinker] Hello');
  assert.equal(captured.sendMail[0].to, 'user@x.com');
  assert.equal(captured.sendMail[0].from, 'ScreenTinker <noreply@example.com>');
  assert.match(captured.sendMail[0].html, /hi there/);
});

test('sendEmail rawSubject sends the subject without the prefix', async () => {
  const { mod, captured } = loadEmail(SMTP_OK, { mockSmtp: 'ok' });
  await mod.sendEmail({ to: 'user@x.com', subject: 'Welcome to ScreenTinker', html: '<p>hi</p>', rawSubject: true });
  assert.equal(captured.sendMail[0].subject, 'Welcome to ScreenTinker');
});

test('sendEmail via unconfigured smtp is a no-op (not_configured), never sends', async () => {
  const { mod, captured } = loadEmail({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.example.com' }, { mockSmtp: 'ok' });
  const r = await mod.sendEmail({ to: 'u@x.com', subject: 'X', text: 'y' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'not_configured');
  assert.equal(captured.sendMail.length, 0);
});

test('dev restrict allow-list applies to the smtp transport too', async () => {
  const { mod, captured } = loadEmail({ ...SMTP_OK, GRAPH_DEV_RESTRICT_TO: 'ok@x.com' }, { mockSmtp: 'ok' });
  const blocked = await mod.sendEmail({ to: 'stranger@x.com', subject: 'S', text: 't' });
  assert.equal(blocked.reason, 'dev_restricted');
  assert.equal(captured.sendMail.length, 0);
  const allowed = await mod.sendEmail({ to: 'ok@x.com', subject: 'S', text: 't' });
  assert.equal(allowed.sent, true);
  assert.equal(captured.sendMail.length, 1);
});

test('sendEmail returns smtp_error and never throws when the transport fails', async () => {
  const { mod } = loadEmail(SMTP_OK, { mockSmtp: 'throw' });
  const r = await mod.sendEmail({ to: 'user@x.com', subject: 'Hello', text: 'hi' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'smtp_error');
  assert.match(r.error, /ECONNREFUSED/);
});
