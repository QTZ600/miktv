'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const EXPORT_PATH = path.join(__dirname, 'db-export.json');

let _db = null;
let _initPromise = null;
const _deferredInits = [];

function deferInit(fn) {
  _deferredInits.push(fn);
}

async function initDB() {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    await Database.initSQL();
    const db = new Database(DB_PATH);

    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expire_at INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS vehicle_brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS prod_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feishu_record_id TEXT,
      supplier TEXT NOT NULL,
      date TEXT NOT NULL,
      model TEXT,
      batch TEXT,
      plan_qty INTEGER,
      actual_qty INTEGER,
      warehouse_qty INTEGER,
      notes TEXT,
      vehicle_brand TEXT,
      category TEXT,
      order_number TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      updated_by TEXT,
      deleted_at INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS return_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feishu_record_id TEXT,
      supplier TEXT NOT NULL,
      date TEXT NOT NULL,
      model TEXT,
      batch TEXT,
      return_qty INTEGER,
      defect_type TEXT,
      defect_desc TEXT,
      handling_result TEXT,
      warehouse_qty INTEGER,
      vehicle_brand TEXT,
      category TEXT,
      fault_qty INTEGER,
      human_qty INTEGER,
      ntf_qty INTEGER,
      no_issue_qty INTEGER,
      repair_report TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      updated_by TEXT,
      deleted_at INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS mainboard_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id TEXT NOT NULL,
      hardware_version TEXT NOT NULL,
      mac_address TEXT NOT NULL,
      firmware_mode TEXT NOT NULL,
      product_model TEXT,
      batch_no TEXT,
      test_result TEXT NOT NULL,
      tested_at INTEGER NOT NULL,
      raw_payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mainboard_mac_tested ON mainboard_tests(mac_address, tested_at)`);
    db.exec(`CREATE TABLE IF NOT EXISTS supplier_brand_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT NOT NULL,
      brand_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(supplier_name, brand_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS repair_line_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier TEXT NOT NULL,
      vehicle_brand TEXT,
      model TEXT,
      fault_symptom TEXT,
      fault_cause TEXT,
      defective_part TEXT,
      short_term_fix TEXT,
      long_term_fix TEXT,
      sn_whole TEXT,
      sn_part TEXT,
      repair_date TEXT,
      repair_result TEXT,
      repair_person TEXT,
      remarks TEXT,
      batch_no TEXT,
      station TEXT,
      discovery_stage TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      updated_by TEXT,
      deleted_at INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS repair_aftersales_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier TEXT NOT NULL,
      vehicle_brand TEXT,
      model TEXT,
      fault_symptom TEXT,
      fault_cause TEXT,
      defective_part TEXT,
      short_term_fix TEXT,
      long_term_fix TEXT,
      sn_whole TEXT,
      sn_part TEXT,
      repair_date TEXT,
      repair_result TEXT,
      repair_person TEXT,
      remarks TEXT,
      return_order_no TEXT,
      customer_feedback TEXT,
      return_date TEXT,
      repair_complete_date TEXT,
      ship_date TEXT,
      in_warranty TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      updated_by TEXT,
      deleted_at INTEGER
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS repair_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_type TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_att_record ON repair_attachments(record_type, record_id)`);
    db.exec(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name TEXT NOT NULL,
      model_code TEXT,
      category TEXT,
      image_path TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      vehicle_brand TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )`);

    try {
      db.prepare('ALTER TABLE prod_records ADD COLUMN category TEXT').run();
    } catch (e) {}
    try {
      db.prepare('ALTER TABLE return_records ADD COLUMN category TEXT').run();
    } catch (e) {}

    Database.loadExportData(db, EXPORT_PATH);

    const cnt = db.prepare('SELECT COUNT(*) as c FROM vehicle_brands').get();
    if (cnt.c === 0) {
      const ins = db.prepare('INSERT INTO vehicle_brands (name, sort_order, enabled) VALUES (?, ?, 1)');
      ['理想', '小米', '比亚迪', '奇瑞', '长城'].forEach((name, i) => ins.run(name, i));
    }

    _db = db;
    _initPromise = null;

    // Run deferred init functions after _db is set
    for (const fn of _deferredInits) {
      try { fn(); } catch (e) { console.error('[deferred init error]', e.message); }
    }
    _deferredInits.length = 0;

    return db;
  })();

  return _initPromise;
}

function db() {
  if (!_db) {
    throw new Error('Database not initialized. Call initDB() first.');
  }
  return _db;
}

async function kvGet(key) {
  await initDB();
  const row = db().prepare('SELECT value, expire_at FROM kv WHERE key = ?').get(key);
  if (!row) return null;
  if (row.expire_at && row.expire_at < Date.now()) {
    db().prepare('DELETE FROM kv WHERE key = ?').run(key);
    return null;
  }
  const s = row.value;
  let meta;
  try { meta = JSON.parse(s); } catch { return s; }
  if (meta && meta.__wrap === 1) {
    if (meta.expireAt && meta.expireAt < Date.now()) {
      db().prepare('DELETE FROM kv WHERE key = ?').run(key);
      return null;
    }
    return meta.v;
  }
  return s;
}

async function kvPut(key, value, opts = {}) {
  await initDB();
  let payload;
  let expireAt = null;
  if (opts.expirationTtl) {
    expireAt = Date.now() + opts.expirationTtl * 1000;
    payload = JSON.stringify({ __wrap: 1, v: value, expireAt });
  } else {
    payload = typeof value === 'string' ? value : JSON.stringify(value);
  }
  db().prepare('INSERT OR REPLACE INTO kv (key, value, expire_at) VALUES (?, ?, ?)').run(key, payload, expireAt);
}

async function kvDelete(key) {
  await initDB();
  db().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

async function kvList({ prefix }) {
  await initDB();
  const rows = db().prepare("SELECT key FROM kv WHERE key LIKE ? AND key NOT LIKE '%\\%'").all((prefix || '') + '%');
  const now = Date.now();
  const keys = rows
    .filter((r) => {
      const row = db().prepare('SELECT expire_at FROM kv WHERE key = ?').get(r.key);
      return !row || !row.expire_at || row.expire_at >= now;
    })
    .map((r) => ({ name: r.key }));
  return { keys };
}

function getDb() { return db(); }

module.exports = { initDB, deferInit, kvGet, kvPut, kvDelete, kvList, getDb };