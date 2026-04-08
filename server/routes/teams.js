const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// List user's teams
router.get('/', (req, res) => {
  const teams = db.prepare(`
    SELECT t.*, tm.role as my_role,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t
    JOIN team_members tm ON t.id = tm.team_id AND tm.user_id = ?
    ORDER BY t.created_at ASC
  `).all(req.user.id);
  res.json(teams);
});

// Create team
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO teams (id, name, owner_id) VALUES (?, ?, ?)').run(id, name, req.user.id);
  db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)').run(id, req.user.id, 'owner');

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  res.status(201).json(team);
});

// Get team with members
router.get('/:id', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const membership = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!membership && !['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Not a member' });

  team.members = db.prepare(`
    SELECT tm.*, u.email, u.name as user_name, u.avatar_url
    FROM team_members tm JOIN users u ON tm.user_id = u.id
    WHERE tm.team_id = ?
    ORDER BY tm.role DESC, tm.joined_at ASC
  `).all(req.params.id);

  team.invites = db.prepare('SELECT * FROM team_invites WHERE team_id = ? AND expires_at > ?')
    .all(req.params.id, Math.floor(Date.now() / 1000));

  res.json(team);
});

// Update team
router.put('/:id', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.owner_id !== req.user.id && !['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Owner only' });

  if (req.body.name) {
    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(req.body.name, req.params.id);
  }
  res.json(db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id));
});

// Delete team
router.delete('/:id', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.owner_id !== req.user.id && !['admin','superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Owner only' });

  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Invite user
router.post('/:id/invite', (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  // Check if already a member
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (user) {
    const existing = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(req.params.id, user.id);
    if (existing) return res.status(409).json({ error: 'Already a member' });

    // Direct add if user exists
    db.prepare('INSERT INTO team_members (team_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)')
      .run(req.params.id, user.id, role || 'viewer', req.user.id);
    return res.status(201).json({ success: true, added: true });
  }

  // Create invite for non-existing user
  const id = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400; // 7 days
  db.prepare('INSERT INTO team_invites (id, team_id, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, email.toLowerCase(), role || 'viewer', req.user.id, expiresAt);

  res.status(201).json({ success: true, invite_id: id, invited: true });
});

// Accept invite
router.post('/accept/:inviteId', (req, res) => {
  const invite = db.prepare('SELECT * FROM team_invites WHERE id = ? AND expires_at > ?')
    .get(req.params.inviteId, Math.floor(Date.now() / 1000));
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });

  if (invite.email !== req.user.email) return res.status(403).json({ error: 'Invite is for a different email' });

  db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)')
    .run(invite.team_id, req.user.id, invite.role, invite.invited_by);
  db.prepare('DELETE FROM team_invites WHERE id = ?').run(req.params.inviteId);

  res.json({ success: true });
});

// Change member role (owner only)
router.put('/:id/members/:userId', (req, res) => {
  const { role } = req.body;
  if (!['viewer', 'editor', 'owner'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  // Only team owner or admin can change roles
  const membership = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!['admin','superadmin'].includes(req.user.role) && (!membership || membership.role !== 'owner')) {
    return res.status(403).json({ error: 'Only team owner can change roles' });
  }

  db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?')
    .run(role, req.params.id, req.params.userId);
  res.json({ success: true });
});

// Remove member (owner only)
router.delete('/:id/members/:userId', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.owner_id === req.params.userId) return res.status(400).json({ error: 'Cannot remove owner' });

  const membership = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!['admin','superadmin'].includes(req.user.role) && (!membership || membership.role !== 'owner')) {
    return res.status(403).json({ error: 'Only team owner can remove members' });
  }

  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?')
    .run(req.params.id, req.params.userId);
  res.json({ success: true });
});

// Check team membership or admin role
function checkTeamAccess(req, res) {
  const membership = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!membership && !['admin','superadmin'].includes(req.user.role)) {
    res.status(403).json({ error: 'Not a team member' });
    return false;
  }
  return true;
}

// Assign device to team
router.post('/:id/devices', (req, res) => {
  if (!checkTeamAccess(req, res)) return;
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  db.prepare('UPDATE devices SET team_id = ? WHERE id = ?').run(req.params.id, device_id);
  res.json({ success: true });
});

// Remove device from team
router.delete('/:id/devices/:deviceId', (req, res) => {
  if (!checkTeamAccess(req, res)) return;
  db.prepare('UPDATE devices SET team_id = NULL WHERE id = ? AND team_id = ?').run(req.params.deviceId, req.params.id);
  res.json({ success: true });
});

// Get team's devices
router.get('/:id/devices', (req, res) => {
  if (!checkTeamAccess(req, res)) return;
  const devices = db.prepare('SELECT * FROM devices WHERE team_id = ?').all(req.params.id);
  res.json(devices);
});

module.exports = router;
