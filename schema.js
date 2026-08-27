const db = require('better-sqlite3')('quality-board.db');
const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table');
console.log('Tables:', tables.map(t=>t.name).join(', '));
tables.forEach(t => {
  const info = db.prepare('PRAGMA table_info(' + t.name + ')').all();
  console.log('\n[' + t.name + ']');
  info.forEach(c => console.log('  ' + c.name + ' ' + c.type));
});
