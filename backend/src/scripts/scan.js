#!/usr/bin/env node
const db = require('../db');
const { scanAll } = require('../scanner');

(async () => {
  db.init();
  await scanAll();
  db.saveSync();
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
