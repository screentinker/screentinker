// The rest of the email tests mock nodemailer through require.cache, which proves our code
// calls sendMail correctly but says nothing about whether nodemailer still ACCEPTS what we
// hand it. That gap is exactly where a dependency bump breaks sending: the suite stays green
// while mail stops leaving the building.
//
// This drives the real library against a throwaway SMTP server on a loopback port, using the
// option and message shapes services/email.js actually builds. No network, no credentials.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const nodemailer = require('nodemailer');
const { buildSmtpMessage } = require('../services/email');

// A minimal SMTP server that answers enough of the protocol to accept one message and
// records the conversation, so assertions can be made about what went over the wire.
function startFakeSmtp() {
  const seen = { commands: [], data: '' };
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let inData = false;
      sock.write('220 fake.local ESMTP\r\n');
      sock.on('data', (buf) => {
        const chunk = buf.toString();
        if (inData) {
          seen.data += chunk;
          if (/\r\n\.\r\n/.test(seen.data)) { inData = false; sock.write('250 OK queued\r\n'); }
          return;
        }
        for (const line of chunk.split('\r\n').filter(Boolean)) {
          seen.commands.push(line);
          const cmd = line.split(' ')[0].toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake.local\r\n250 SIZE 10485760\r\n');
          else if (cmd === 'MAIL' || cmd === 'RCPT') sock.write('250 OK\r\n');
          else if (cmd === 'DATA') { inData = true; sock.write('354 send it\r\n'); }
          else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});   // a client hanging up mid-conversation is not a test failure
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

test('the installed nodemailer accepts the options and messages we build', async () => {
  const { srv, port, seen } = await startFakeSmtp();
  try {
    // The shape getSmtpTransporter() constructs.
    const transporter = nodemailer.createTransport({
      host: '127.0.0.1', port, secure: false, tls: { rejectUnauthorized: false },
    });

    // The object `from` form, used when a display name overrides the configured one.
    await transporter.sendMail({
      from: { name: 'ScreenTinker', address: 'noreply@example.com' },
      to: 'user@x.com',
      subject: '[ScreenTinker] Hello',
      html: '<p>hi there</p>',
      text: 'hi there',
    });

    assert.ok(seen.commands.some(c => /^EHLO/i.test(c)), 'greets the server');
    assert.ok(seen.commands.some(c => /^MAIL FROM:<noreply@example\.com>/i.test(c)),
      'envelope sender is the configured address, not the display name');
    assert.ok(seen.commands.some(c => /^RCPT TO:<user@x\.com>/i.test(c)), 'envelope recipient');
    assert.match(seen.data, /Subject: \[ScreenTinker\] Hello/, 'subject and its prefix survive encoding');
    assert.match(seen.data, /From: ScreenTinker <noreply@example\.com>/, 'display-name form still renders');
    assert.match(seen.data, /Content-Type: multipart\/alternative/, 'text and html sent as alternatives');

    // The string `from` form, used when there is no override.
    await transporter.sendMail({
      from: 'ScreenTinker <noreply@example.com>', to: 'user@x.com', subject: 'Welcome', html: '<p>x</p>',
    });
    transporter.close();
  } finally {
    srv.close();
  }
});

test('buildSmtpMessage output is something the installed nodemailer can send', async () => {
  const { srv, port, seen } = await startFakeSmtp();
  try {
    const transporter = nodemailer.createTransport({
      host: '127.0.0.1', port, secure: false, tls: { rejectUnauthorized: false },
    });
    // Built by our own code rather than hand-written here, so the two cannot drift apart.
    await transporter.sendMail(buildSmtpMessage('to@x.com', 'Subj', 'plain', '<p>rich</p>', 'Sender Name'));
    assert.ok(seen.commands.some(c => /^RCPT TO:<to@x\.com>/i.test(c)), 'recipient reached the wire');
    assert.match(seen.data, /Subject: Subj/, 'subject reached the wire');
    transporter.close();
  } finally {
    srv.close();
  }
});
