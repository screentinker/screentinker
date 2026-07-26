const fs = require('fs');
let code = fs.readFileSync('server/db/database.js', 'utf8');

// Replace db.exec(schema) with splitting by ';' and running prepare().run()
const replacement = `
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const statements = schema.split(';');
for (let stmt of statements) {
  if (stmt.trim()) {
    try {
      db.prepare(stmt).run();
    } catch (e) {
      console.error('Schema exec error:', e.message, '\\nStatement:', stmt.substring(0, 50));
    }
  }
}
`;

code = code.replace("const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');\\ndb.exec(schema);", replacement);
fs.writeFileSync('server/db/database.js', code);
console.log('Fixed database.js');
