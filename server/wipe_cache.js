const { db } = require('./db/database');
db.prepare('DELETE FROM white_labels').run();
console.log('Cache cleared');
