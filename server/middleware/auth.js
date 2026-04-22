const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.jwtExpiry }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

// Synthetic user record for recovery tokens (scripts/reset-admin.js). Not
// persisted; only exists for the lifetime of the request.
function recoveryUser(decoded) {
  return {
    id: decoded.id,
    email: decoded.email || 'admin@localhost',
    name: 'Recovery Admin',
    role: decoded.role || 'admin',
    auth_provider: 'recovery',
    avatar_url: null,
    plan_id: 'enterprise'
  };
}

// Express middleware - requires valid JWT
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    if (decoded.recovery) {
      req.user = recoveryUser(decoded);
      return next();
    }
    const user = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth - sets req.user if token present, continues either way
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = verifyToken(token);
      req.user = decoded.recovery
        ? recoveryUser(decoded)
        : db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(decoded.id);
    } catch (err) {
      // Token invalid, continue without user
    }
  }
  next();
}

// Require admin role (admin or superadmin)
function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Require superadmin role (platform owner only)
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  next();
}

module.exports = { generateToken, verifyToken, requireAuth, optionalAuth, requireAdmin, requireSuperAdmin };
