const { db } = require('../server/db/database');
const bcrypt = require('../server/node_modules/bcryptjs');
const { v4: uuidv4 } = require('../server/node_modules/uuid');

const email = 'ivandro.work@gmail.com';
const password = '#whatever';
const name = 'Ivandro Alves';
const hash = bcrypt.hashSync(password, 10);
const userId = uuidv4();

try {
  db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)').run(userId, email, hash, name, 'platform_admin');
  
  // also create an organization and workspace for them
  const orgId = uuidv4();
  const workspaceId = uuidv4();
  
  db.prepare('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)').run(orgId, name + " Org", userId);
  db.prepare('INSERT INTO workspaces (id, name, organization_id) VALUES (?, ?, ?)').run(workspaceId, 'Default Workspace', orgId);
  db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, 'admin');
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(workspaceId, userId, 'admin');
  
  const d = require('../server/db/database').dbOptions;
  if (d.syncUrl) db.sync();

  console.log('Admin created successfully.');
} catch (e) {
  if (e.message.includes('UNIQUE constraint failed')) {
     console.log('User already exists, updating password and role.');
     db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE email = ?').run(hash, 'platform_admin', email);
     const d = require('../server/db/database').dbOptions;
     if (d.syncUrl) db.sync();
  } else {
     console.error(e);
  }
}
