const Database = require('libsql');
const db = new Database(':memory:');
db.exec('CREATE TABLE foo (id INT); CREATE TABLE bar (id INT);');
console.log(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all());
