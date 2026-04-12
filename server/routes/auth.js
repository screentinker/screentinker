const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const { db } = require('../db/database');
const { generateToken, requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const config = require('../config');

function logFailedLogin(email, ip, reason) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (NULL, ?, ?, ?)')
      .run('auth:login_failed', `${email} - ${reason}`, ip);
  } catch {}
}

function logSuccessfulLogin(userId, email, ip) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)')
      .run(userId, 'auth:login_success', email, ip);
    db.prepare("UPDATE users SET last_login = strftime('%s','now') WHERE id = ?").run(userId);
  } catch {}
}

// ==================== Local Auth ====================

// Register
router.post('/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  // First user becomes admin with enterprise plan (self-hosted) or free plan with Pro trial
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const role = userCount === 0 ? 'superadmin' : 'user';
  const isFirstUser = userCount === 0;
  const plan = (isFirstUser && config.selfHosted) ? 'enterprise' : 'pro'; // Start on Pro trial
  const trialStarted = isFirstUser && config.selfHosted ? null : Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id, trial_started, trial_plan)
    VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?)
  `).run(id, email.toLowerCase(), name || email.split('@')[0], passwordHash, role, plan, trialStarted, trialStarted ? 'pro' : null);

  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(id);
  const token = generateToken(user);

  res.status(201).json({ token, user });
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND auth_provider = ?').get(email.toLowerCase(), 'local');
  if (!user) {
    logFailedLogin(email, req.ip, 'User not found');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    logFailedLogin(email, req.ip, 'Wrong password');
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  logSuccessfulLogin(user.id, email, req.ip);
  const token = generateToken(user);
  const { password_hash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// ==================== Google OAuth ====================

router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google credential required' });

  try {
    // Verify the Google ID token
    const payload = await verifyGoogleToken(credential);
    if (!payload) return res.status(401).json({ error: 'Invalid Google token' });

    const { email, name, picture, sub: googleId } = payload;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

    if (!user) {
      const id = uuidv4();
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const role = userCount === 0 ? 'superadmin' : 'user';
      const isFirst = userCount === 0;
      const plan = (isFirst && config.selfHosted) ? 'enterprise' : 'pro';
      const trialStarted = isFirst && config.selfHosted ? null : Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO users (id, email, name, auth_provider, provider_id, avatar_url, role, plan_id, trial_started, trial_plan)
        VALUES (?, ?, ?, 'google', ?, ?, ?, ?, ?, ?)
      `).run(id, email.toLowerCase(), name || '', googleId, picture || '', role, plan, trialStarted, trialStarted ? 'pro' : null);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (user.auth_provider !== 'google') {
      // Existing account with different provider — do NOT silently overwrite auth_provider.
      // If they have a local password, require them to log in locally and link from settings.
      if (user.password_hash) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in with your password.' });
      }
      // No password (e.g. Microsoft → Google switch) — allow linking
      db.prepare('UPDATE users SET auth_provider = ?, provider_id = ?, avatar_url = ? WHERE id = ?')
        .run('google', googleId, picture || user.avatar_url, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const token = generateToken(user);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

async function verifyGoogleToken(credential) {
  const client = new OAuth2Client(config.googleClientId);
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: config.googleClientId || undefined,
    });
    return ticket.getPayload();
  } catch (e) {
    // Fallback: if credential is an access token, verify via tokeninfo
    try {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${credential}`);
      if (!res.ok) throw new Error('Invalid token');
      return await res.json();
    } catch {
      throw new Error('Google token verification failed: ' + e.message);
    }
  }
}

// ==================== Microsoft OAuth ====================

router.post('/microsoft', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Microsoft access token required' });

  try {
    // Use the access token to get user profile from Microsoft Graph
    const profile = await getMicrosoftProfile(access_token);
    if (!profile || !profile.mail && !profile.userPrincipalName) {
      return res.status(401).json({ error: 'Could not get Microsoft profile' });
    }

    const email = (profile.mail || profile.userPrincipalName).toLowerCase();
    const name = profile.displayName || '';
    const microsoftId = profile.id;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      const id = uuidv4();
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const role = userCount === 0 ? 'superadmin' : 'user';
      const isFirst = userCount === 0;
      const plan = (isFirst && config.selfHosted) ? 'enterprise' : 'pro';
      const trialStarted = isFirst && config.selfHosted ? null : Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO users (id, email, name, auth_provider, provider_id, role, plan_id, trial_started, trial_plan)
        VALUES (?, ?, ?, 'microsoft', ?, ?, ?, ?, ?)
      `).run(id, email, name, microsoftId, role, plan, trialStarted, trialStarted ? 'pro' : null);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else if (user.auth_provider !== 'microsoft') {
      // Existing account with different provider — do NOT silently overwrite auth_provider.
      if (user.password_hash) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in with your password.' });
      }
      db.prepare('UPDATE users SET auth_provider = ?, provider_id = ? WHERE id = ?')
        .run('microsoft', microsoftId, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const token = generateToken(user);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Microsoft auth error:', err);
    res.status(401).json({ error: 'Microsoft authentication failed' });
  }
});

function getMicrosoftProfile(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.microsoft.com',
      path: '/v1.0/me',
      headers: { Authorization: `Bearer ${accessToken}` }
    };
    https.get(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ==================== User Management ====================

// Get current user
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// Update current user
router.put('/me', requireAuth, (req, res) => {
  const { name, password } = req.body;
  if (name) {
    db.prepare('UPDATE users SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(name, req.user.id);
  }
  if (password && password.length >= 8) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(hash, req.user.id);
  }
  const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// List users - superadmins see all, admins see team members only
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  if (req.user.role === 'superadmin') {
    const users = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id, created_at, last_login FROM users ORDER BY created_at ASC').all();
    res.json(users);
  } else {
    // Admin sees themselves + users in their teams
    const users = db.prepare(`
      SELECT DISTINCT u.id, u.email, u.name, u.role, u.auth_provider, u.avatar_url, u.plan_id, u.created_at
      FROM users u
      LEFT JOIN team_members tm ON u.id = tm.user_id
      WHERE u.id = ? OR tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
      ORDER BY u.created_at ASC
    `).all(req.user.id, req.user.id);
    res.json(users);
  }
});

// Delete user (superadmin only)
router.delete('/users/:id', requireAuth, requireSuperAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Update user role (superadmin only)
router.put('/users/:id/role', requireAuth, requireSuperAdmin, (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin', 'superadmin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (req.params.id === req.user.id && role !== 'superadmin') return res.status(400).json({ error: 'Cannot demote yourself' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ success: true });
});

// Get auth config (public - tells frontend which providers are available)
router.get('/config', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  res.json({
    googleEnabled: !!config.googleClientId,
    googleClientId: config.googleClientId,
    microsoftEnabled: !!config.microsoftClientId,
    microsoftClientId: config.microsoftClientId,
    microsoftTenantId: config.microsoftTenantId,
    localEnabled: true,
    needsSetup: userCount === 0,
  });
});

module.exports = router;
