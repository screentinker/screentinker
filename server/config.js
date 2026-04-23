const path = require('path');

module.exports = {
  port: process.env.PORT || 3001,
  httpsPort: process.env.HTTPS_PORT || 3443,
  dbPath: path.join(__dirname, 'db', 'remote_display.db'),
  uploadsDir: path.join(__dirname, 'uploads'),
  contentDir: path.join(__dirname, 'uploads', 'content'),
  screenshotsDir: path.join(__dirname, 'uploads', 'screenshots'),
  frontendDir: path.join(__dirname, '..', 'frontend'),
  heartbeatInterval: 10000,    // Check every 10s
  heartbeatTimeout: 45000,     // Offline after 45s (3 missed 15s beats)
  maxFileSize: 500 * 1024 * 1024, // 500MB
  thumbnailWidth: 320,
  screenshotQuality: 70,
  // SSL: drop your Cloudflare Origin cert + key in certs/ folder
  // or set env vars SSL_CERT and SSL_KEY to custom paths
  sslCert: process.env.SSL_CERT || path.join(__dirname, 'certs', 'cert.pem'),
  sslKey: process.env.SSL_KEY || path.join(__dirname, 'certs', 'key.pem'),
  // Auth
  jwtSecret: process.env.JWT_SECRET || (() => {
    const secretFile = path.join(__dirname, 'certs', '.jwt_secret');
    const fs = require('fs');
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
    const secret = require('crypto').randomBytes(64).toString('hex');
    try { fs.mkdirSync(path.dirname(secretFile), { recursive: true }); fs.writeFileSync(secretFile, secret); } catch {}
    return secret;
  })(),
  jwtExpiry: '7d',
  // Google OAuth - set these in env or here
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Microsoft OAuth - set these in env or here
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  microsoftTenantId: process.env.MICROSOFT_TENANT_ID || 'common',
  // Stripe (optional - for paid subscriptions)
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // Email alerts webhook URL (POST endpoint for sending emails)
  emailWebhookUrl: process.env.EMAIL_WEBHOOK_URL || '',
  // Self-hosted mode: if true, first user gets enterprise plan and no billing
  selfHosted: process.env.SELF_HOSTED === 'true',
  // Disable public registration (OAuth auto-signup is also blocked when set).
  // First-user setup is still allowed so a fresh install can be initialized.
  disableRegistration: ['true', '1'].includes(String(process.env.DISABLE_REGISTRATION || '').toLowerCase()),
};
