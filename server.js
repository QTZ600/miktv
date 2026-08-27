'use strict';

const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const { kvGet, kvPut, kvDelete, kvList, getDb, initDB, deferInit } = require('./kv');
const XLSX = require('xlsx');
const { handleMes } = require('./mes');
const { handleAiAnalysis, ensureAiTables } = require('./ai-analysis');
const { handleVersionHub, ensureVersionTables } = require("./version-hub");
const sharp = require('sharp');

const UPLOAD_DIR = nodePath.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PUBLIC_DIR = nodePath.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
const PRODUCT_IMAGES_DIR = nodePath.join(PUBLIC_DIR, 'product-images');
if (!fs.existsSync(PRODUCT_IMAGES_DIR)) fs.mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
const LIBS_DIR = nodePath.join(PUBLIC_DIR, 'libs');
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

const WORKFLOW_TYPES = Object.freeze({
  manufacturing: {
    label: '制造执行',
    device: false,
    stages: ['来料检验', 'SMT贴面', 'DIP插件', '功能测试', '老化测试', '出货检验'],
  },
  aftersales: {
    label: '售后返修品',
    device: true,
    stages: ['客户退机', '供应商签收', '供应商初测', '供应商维修', '供应商复测', '供应商发货'],
  },
  line_repair: {
    label: '产线维修品',
    device: true,
    stages: ['登记', '供应商签收', '维修', '复测', '完成'],
  },
});

const REPAIR_RESULTS = ['已修复', '报废', '待料'];
const DISCOVERY_STAGES = ['来料检', '制程', '成品检', '老化测试'];

const BASE_TOKEN = 'U16Bbt0h7aP2UxsJCQgclbzNnib';
const TBL_PROD = 'tblKTBhpEuKy5Y7B';
const TBL_RETURN = 'tbl64JYg1LnsTC4S';

// SUPPLIERS is now dynamic - use getSuppliersList() instead
function getSuppliersList() { return dbGetSupplierNames(); }
const DEFECT_TYPES = ['连接配对', '无声', '啸叫', '异味', '其他'];

// 品类推断函数：根据 model 判断品类（麦克风 / 机顶盒）
function getCategory(model) {
  if (!model) return '其他';
  const m = String(model).toUpperCase();
  // K 开头的产品归为机顶盒（车载中控屏）
  if (m.startsWith('K')) return '机顶盒';
  // 其他产品（X, S, 理想, 威马等）归为麦克风
  return '麦克风';
}

function isSupplierRole(role) {
  return role === 'supplier' || role === 'supplier_repair';
}

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

const SUPPLIER_REPAIR_TABS = new Set([
  'submit-repair-line', 'submit-repair-as', 'history-repair-line', 'history-repair-as',
]);

const SESSION_TTL_SEC = 7 * 24 * 3600;
const OAUTH_STATE_TTL_SEC = 10 * 60; // 10 minutes
const FEISHU_REDIRECT_URI = process.env.FEISHU_REDIRECT_URI || `http://121.89.93.238/auth/feishu/callback`;
const RATELIMIT_WINDOW_SEC = 15 * 60;
const RATELIMIT_MAX_FAIL = 5;
const PORT = parseInt(process.env.PORT || '3000', 10);

const EXT_API_RATE_LIMIT = 20;
const _extApiRateMap = new Map();
function checkExtApiRateLimit(keyId) {
  const now = Date.now();
  let entry = _extApiRateMap.get(keyId);
  if (!entry || now - entry.windowStart >= 1000) {
    entry = { count: 1, windowStart: now };
  } else {
    entry.count++;
  }
  _extApiRateMap.set(keyId, entry);
  return entry.count <= EXT_API_RATE_LIMIT;
}

function toISO8Shanghai(ts) {
  const offset = 8 * 60 * 60 * 1000;
  const d = new Date(ts + offset);
  return d.toISOString().slice(0, 19) + '+08:00';
}

// ---------------- utils ----------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function b64urlEncodeBytes(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - s.length % 4) % 4);
  return Buffer.from(b64, 'base64');
}

const crypto = require('crypto');

function randomToken(bytes = 32) {
  return b64urlEncodeBytes(crypto.randomBytes(bytes));
}

// ---------------- password (PBKDF2) ----------------

function hashPassword(password, salt) {
  const saltBuf = salt || crypto.randomBytes(16);
  const bits = crypto.pbkdf2Sync(password, saltBuf, 100000, 32, 'sha256');
  return `pbkdf2$100000$${b64urlEncodeBytes(saltBuf)}$${b64urlEncodeBytes(bits)}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const salt = b64urlDecode(parts[2]);
  const check = hashPassword(password, salt);
  if (check.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < check.length; i++) diff |= check.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

// ---------------- cookies ----------------

function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader) return map;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try { map[k] = decodeURIComponent(v); } catch { map[k] = v; }
    }
  }
  return map;
}

function buildCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return parts.join('; ');
}

// ---------------- session ----------------

async function getSession(cookies) {
  const token = cookies.sess;
  if (!token) return null;
  const raw = await kvGet(`sess:${token}`);
  if (!raw) return null;
  try {
    const sess = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (sess.expireAt && sess.expireAt < Date.now()) {
      await kvDelete(`sess:${token}`);
      return null;
    }
    return { ...sess, token };
  } catch {
    return null;
  }
}

async function createSession(user) {
  const token = randomToken(32);
  const expireAt = Date.now() + SESSION_TTL_SEC * 1000;
  const payload = {
    username: user.username,
    display_name: user.display_name || null,
    role: user.role,
    supplier: user.supplier || null,
    mes_station: user.mes_station || null,
    company_name: user.company_name || null,
    expireAt,
  };
  await kvPut(`sess:${token}`, JSON.stringify(payload), {
    expirationTtl: SESSION_TTL_SEC,
  });
  return token;
}

async function destroySession(token) {
  if (token) await kvDelete(`sess:${token}`);
}

// ---------------- OAuth state helpers ----------------

async function createOAuthState() {
  const state = randomToken(24);
  await kvPut(`oauth:state:${state}`, JSON.stringify({ createdAt: Date.now() }), {
    expirationTtl: OAUTH_STATE_TTL_SEC,
  });
  return state;
}

async function verifyAndConsumeOAuthState(state) {
  if (!state || !/^[A-Za-z0-9_-]{20,}$/.test(state)) return false;
  const raw = await kvGet(`oauth:state:${state}`);
  if (!raw) return false;
  await kvDelete(`oauth:state:${state}`);
  return true;
}

// ---------------- rate limit ----------------

async function checkRateLimit(ip) {
  const raw = await kvGet(`ratelimit:login:${ip}`);
  if (!raw) return { ok: true };
  try {
    const { count, firstFailAt } = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const elapsed = (Date.now() - firstFailAt) / 1000;
    if (elapsed > RATELIMIT_WINDOW_SEC) return { ok: true };
    if (count >= RATELIMIT_MAX_FAIL) {
      return { ok: false, retryAfter: Math.ceil(RATELIMIT_WINDOW_SEC - elapsed) };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

async function recordLoginFailure(ip) {
  const key = `ratelimit:login:${ip}`;
  const raw = await kvGet(key);
  let data;
  if (raw) {
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { data = null; }
  }
  if (!data || (Date.now() - data.firstFailAt) / 1000 > RATELIMIT_WINDOW_SEC) {
    data = { count: 1, firstFailAt: Date.now() };
  } else {
    data.count += 1;
  }
  await kvPut(key, JSON.stringify(data), { expirationTtl: RATELIMIT_WINDOW_SEC });
}

async function clearLoginFailure(ip) {
  await kvDelete(`ratelimit:login:${ip}`);
}

// ---------------- users ----------------

async function getUser(username) {
  if (!username) return null;
  const raw = await kvGet(`user:${username}`);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

async function putUser(user) {
  await kvPut(`user:${user.username}`, JSON.stringify(user));
}

async function listUsers() {
  const list = await kvList({ prefix: 'user:' });
  const users = [];
  for (const key of list.keys) {
    const raw = await kvGet(key.name);
    if (!raw) continue;
    try {
      const u = typeof raw === 'string' ? JSON.parse(raw) : raw;
      users.push({
        username: u.username,
        display_name: u.display_name || null,
        role: u.role,
        supplier: u.supplier || null,
        mes_station: u.mes_station || null,
        company_name: u.company_name || null,
        disabled: !!u.disabled,
        createdAt: u.createdAt,
        feishu_open_id: u.feishu_open_id || null,
      });
    } catch { /* skip */ }
  }
  users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return users;
}

let _seedChecked = false;
async function seedAdminIfNeeded() {
  if (_seedChecked) return;
  const seeded = await kvGet('_seeded');
  if (seeded) { _seedChecked = true; return; }
  const u = process.env.ADMIN_INITIAL_USERNAME;
  const p = process.env.ADMIN_INITIAL_PASSWORD;
  if (!u || !p) return;
  const existing = await getUser(u);
  if (!existing) {
    const user = {
      username: u,
      display_name: '初始管理员',
      passwordHash: hashPassword(p),
      role: 'admin',
      supplier: null,
      disabled: false,
      createdAt: Date.now(),
    };
    await putUser(user);
  }
  await kvPut('_seeded', '1');
  _seedChecked = true;
}

// ---------------- SQLite record helpers ----------------

function dbGetBrands(enabledOnly = true) {
  const sql = enabledOnly
    ? 'SELECT * FROM vehicle_brands WHERE enabled=1 ORDER BY sort_order, id'
    : 'SELECT * FROM vehicle_brands ORDER BY sort_order, id';
  return getDb().prepare(sql).all();
}

function dbInsertProd(r) {
  const stmt = getDb().prepare(`INSERT INTO prod_records
    (feishu_record_id, supplier, date, model, batch, plan_qty, actual_qty, warehouse_qty, notes, vehicle_brand, order_number, category, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(
    r.feishu_record_id || null, r.supplier, r.date, r.model || null,
    r.batch || null, r.plan_qty || null, r.actual_qty || null,
    r.warehouse_qty || null, r.notes || null, r.vehicle_brand || null,
    r.order_number || null, r.category || getCategory(r.model),
    r.created_at || Date.now()
  );
  return info.lastInsertRowid;
}

function dbInsertReturn(r) {
  const stmt = getDb().prepare(`INSERT INTO return_records
    (feishu_record_id, supplier, date, model, batch, return_qty, defect_type, defect_desc, handling_result, warehouse_qty, vehicle_brand, fault_qty, human_qty, ntf_qty, no_issue_qty, repair_report, category, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(
    r.feishu_record_id || null, r.supplier, r.date, r.model || null,
    r.batch || null, r.return_qty || null, r.defect_type || null,
    r.defect_desc || null, r.handling_result || null, r.warehouse_qty || null,
    r.vehicle_brand || null, r.fault_qty || null, r.human_qty || null,
    r.ntf_qty || null, r.no_issue_qty || null, r.repair_report || null,
    r.category || getCategory(r.model), r.created_at || Date.now()
  );
  return info.lastInsertRowid;
}

function dbListProdBySupplier(supplier) {
  return getDb().prepare(
    `SELECT * FROM prod_records WHERE supplier=? AND deleted_at IS NULL ORDER BY date DESC, id DESC LIMIT 200`
  ).all(supplier);
}

function dbListReturnBySupplier(supplier) {
  return getDb().prepare(
    `SELECT * FROM return_records WHERE supplier=? AND deleted_at IS NULL ORDER BY date DESC, id DESC LIMIT 200`
  ).all(supplier);
}

function buildFilters(q, { forKind = null, likeModel = false } = {}) {
  const wheres = ['deleted_at IS NULL'];
  const params = [];
  if (q.date_from) { wheres.push('date >= ?'); params.push(q.date_from); }
  if (q.date_to) { wheres.push('date <= ?'); params.push(q.date_to); }
  if (q.supplier) { wheres.push('supplier = ?'); params.push(q.supplier); }
  if (q.vehicle_brand) { wheres.push('vehicle_brand = ?'); params.push(q.vehicle_brand); }
  if (q.model) {
    if (likeModel) { wheres.push('model LIKE ?'); params.push('%' + q.model + '%'); }
    else { wheres.push('model = ?'); params.push(q.model); }
  }
  if (q.defect_type && forKind !== 'prod') { wheres.push('defect_type = ?'); params.push(q.defect_type); }
  return { wheres, params };
}

function dbAdminRecords(kind, q) {
  const tbl = kind === 'return' ? 'return_records' : 'prod_records';
  const { wheres, params } = buildFilters(q, { forKind: kind, likeModel: true });
  if (q.id) { wheres.push('id = ?'); params.push(Number(q.id)); }
  return getDb().prepare(
    `SELECT * FROM ${tbl} WHERE ${wheres.join(' AND ')} ORDER BY date DESC, id DESC LIMIT 2000`
  ).all(...params);
}

function dbDashboard(q) {
  const { wheres: pw, params: pp } = buildFilters(q, { forKind: 'prod' });
  const { wheres: rw, params: rp } = buildFilters(q, { forKind: 'return' });

  const prodRow = getDb().prepare(
    `SELECT SUM(COALESCE(actual_qty,0)) as total FROM prod_records WHERE ${pw.join(' AND ')}`
  ).get(...pp);
  const retRow = getDb().prepare(
    `SELECT SUM(COALESCE(return_qty,0)) as total FROM return_records WHERE ${rw.join(' AND ')}`
  ).get(...rp);
  const totalProd = prodRow.total || 0;
  const totalRet = retRow.total || 0;
  const ffr = totalProd > 0 ? Math.round(totalRet * 10000 / totalProd) / 100 : 0;

  function dimQuery(dim, extraProdWhere = '', extraRetWhere = '') {
    const pW = [...pw, ...(extraProdWhere ? [extraProdWhere] : [])].join(' AND ');
    const rW = [...rw, ...(extraRetWhere ? [extraRetWhere] : [])].join(' AND ');
    return getDb().prepare(`
      WITH p AS (SELECT ${dim} n, SUM(COALESCE(actual_qty,0)) q FROM prod_records WHERE ${pW} GROUP BY ${dim}),
           r AS (SELECT ${dim} n, SUM(COALESCE(return_qty,0)) q FROM return_records WHERE ${rW} GROUP BY ${dim})
      SELECT p.n as name, p.q as prod_qty, COALESCE(r.q,0) as ret_qty,
        ROUND(CAST(COALESCE(r.q,0) AS REAL)*100.0/NULLIF(p.q,0),2) as ffr
      FROM p LEFT JOIN r ON p.n=r.n ORDER BY ffr DESC
    `).all(...pp, ...rp);
  }

  const byMonth = getDb().prepare(`
    WITH p AS (SELECT strftime('%Y-%m', date) n, SUM(COALESCE(actual_qty,0)) q FROM prod_records WHERE ${pw.join(' AND ')} GROUP BY n),
         r AS (SELECT strftime('%Y-%m', date) n, SUM(COALESCE(return_qty,0)) q FROM return_records WHERE ${rw.join(' AND ')} GROUP BY n)
    SELECT p.n as name, p.q as prod_qty, COALESCE(r.q,0) as ret_qty,
      ROUND(CAST(COALESCE(r.q,0) AS REAL)*100.0/NULLIF(p.q,0),2) as ffr
    FROM p LEFT JOIN r ON p.n=r.n ORDER BY p.n ASC
  `).all(...pp, ...rp);

  const bySupplier = dimQuery('supplier');
  const byModel = dimQuery('model', 'model IS NOT NULL', 'model IS NOT NULL');
  const byBrand = dimQuery('vehicle_brand', 'vehicle_brand IS NOT NULL', 'vehicle_brand IS NOT NULL');

  // 按品类和供应商聚合数据（用于两个饼图）
  // 优先使用产品表的category字段，没有则fallback到自动推断
  // JOIN 查询需要给 WHERE 条件加 pr. 前缀，避免与 products 表的同名列歧义
  const pwForJoin = pw.map(w => w.replace(/\b(deleted_at|date|supplier|vehicle_brand|model|category|created_at)\b/g, 'pr.$1'));
  const bySupplierByCategory = getDb().prepare(`
    SELECT COALESCE(p.category,
      CASE WHEN pr.model LIKE 'K%' THEN '机顶盒' ELSE '麦克风' END
    ) as category, pr.supplier as name, SUM(COALESCE(pr.actual_qty,0)) as prod_qty
    FROM prod_records pr
    LEFT JOIN products p ON pr.model = p.model_code
    WHERE ${pwForJoin.join(' AND ')}
    GROUP BY COALESCE(p.category,
      CASE WHEN pr.model LIKE 'K%' THEN '机顶盒' ELSE '麦克风' END
    ), pr.supplier
    ORDER BY category, prod_qty DESC
  `).all(...pp);

  // Repair stats
  const repairLineCount = getDb().prepare(
    `SELECT COUNT(*) as c FROM repair_line_records WHERE deleted_at IS NULL`
  ).get().c;
  const repairAsCount = getDb().prepare(
    `SELECT COUNT(*) as c FROM repair_aftersales_records WHERE deleted_at IS NULL`
  ).get().c;

  return { totalProd, totalRet, ffr, byMonth, bySupplier, byModel, byBrand, bySupplierByCategory, repairLineCount, repairAsCount };
}

const TOP_FFR_MIN_PROD = 10;

function dbTopFFR(q, dim = 'model_brand') {
  const { wheres: pw, params: pp } = buildFilters(q, { forKind: 'prod' });
  const { wheres: rw, params: rp } = buildFilters(q, { forKind: 'return' });

  if (dim === 'model_brand') {
    const pW = [...pw, 'model IS NOT NULL', 'vehicle_brand IS NOT NULL'].join(' AND ');
    const rW = [...rw, 'model IS NOT NULL', 'vehicle_brand IS NOT NULL'].join(' AND ');
    return getDb().prepare(`
      WITH p AS (SELECT model as m, vehicle_brand as b, SUM(COALESCE(actual_qty,0)) as q
                 FROM prod_records WHERE ${pW} GROUP BY model, vehicle_brand),
           r AS (SELECT model as m, vehicle_brand as b, SUM(COALESCE(return_qty,0)) as q
                 FROM return_records WHERE ${rW} GROUP BY model, vehicle_brand)
      SELECT p.m as model, p.b as vehicle_brand, p.m || ' · ' || p.b as name,
             p.q as prod_qty, COALESCE(r.q,0) as ret_qty,
             ROUND(CAST(COALESCE(r.q,0) AS REAL)*100.0/NULLIF(p.q,0),2) as ffr
      FROM p LEFT JOIN r ON p.m=r.m AND p.b=r.b
      WHERE p.q >= ${TOP_FFR_MIN_PROD}
      ORDER BY ffr DESC LIMIT 6
    `).all(...pp, ...rp);
  }

  if (dim === 'model_version') {
    const pW = [...pw, 'model IS NOT NULL'].join(' AND ');
    const rW = [...rw, 'model IS NOT NULL'].join(' AND ');
    return getDb().prepare(`
      WITH p AS (SELECT model as m, SUM(COALESCE(actual_qty,0)) as q
                 FROM prod_records WHERE ${pW} GROUP BY model),
           r AS (SELECT model as m, SUM(COALESCE(return_qty,0)) as q
                 FROM return_records WHERE ${rW} GROUP BY model)
      SELECT p.m as model, p.m as name, p.q as prod_qty, COALESCE(r.q,0) as ret_qty,
             ROUND(CAST(COALESCE(r.q,0) AS REAL)*100.0/NULLIF(p.q,0),2) as ffr
      FROM p LEFT JOIN r ON p.m=r.m
      WHERE p.q >= ${TOP_FFR_MIN_PROD}
      ORDER BY p.m
    `).all(...pp, ...rp);
  }

  const col = dim === 'model' ? 'model' : dim === 'vehicle_brand' ? 'vehicle_brand' : 'supplier';
  const pW = [...pw, `${col} IS NOT NULL`].join(' AND ');
  const rW = [...rw, `${col} IS NOT NULL`].join(' AND ');
  return getDb().prepare(`
    WITH p AS (SELECT ${col} as n, SUM(COALESCE(actual_qty,0)) as q
               FROM prod_records WHERE ${pW} GROUP BY ${col}),
         r AS (SELECT ${col} as n, SUM(COALESCE(return_qty,0)) as q
               FROM return_records WHERE ${rW} GROUP BY ${col})
    SELECT p.n as name, p.q as prod_qty, COALESCE(r.q,0) as ret_qty,
           ROUND(CAST(COALESCE(r.q,0) AS REAL)*100.0/NULLIF(p.q,0),2) as ffr
    FROM p LEFT JOIN r ON p.n=r.n
    WHERE p.q >= ${TOP_FFR_MIN_PROD}
    ORDER BY ffr DESC LIMIT 6
  `).all(...pp, ...rp);
}

function dbUpdateRecord(kind, id, fields, username) {
  const tbl = kind === 'return' ? 'return_records' : 'prod_records';
  const now = Date.now();
  const sets = [];
  const vals = [];
  const allowed = kind === 'prod'
    ? ['date', 'model', 'batch', 'plan_qty', 'actual_qty', 'warehouse_qty', 'notes', 'vehicle_brand']
    : ['date', 'model', 'batch', 'return_qty', 'defect_type', 'defect_desc', 'handling_result', 'warehouse_qty', 'vehicle_brand'];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k] === '' ? null : fields[k]); }
  }
  if (sets.length === 0) return;
  sets.push('updated_at=?', 'updated_by=?');
  vals.push(now, username, id);
  getDb().prepare(`UPDATE ${tbl} SET ${sets.join(',')} WHERE id=? AND deleted_at IS NULL`).run(...vals);
}

function dbSoftDelete(kind, id, username) {
  const tbl = kind === 'return' ? 'return_records' : 'prod_records';
  getDb().prepare(
    `UPDATE ${tbl} SET deleted_at=?, updated_at=?, updated_by=? WHERE id=? AND deleted_at IS NULL`
  ).run(Date.now(), Date.now(), username, id);
}

function dbGetRecord(kind, id) {
  const tbl = kind === 'return' ? 'return_records' : 'prod_records';
  return getDb().prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(id);
}

// ---------------- mainboard tests DB helpers ----------------

function dbGetApiKeyByHash(hash) {
  return getDb().prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hash);
}

function dbListApiKeys() {
  return getDb().prepare('SELECT id, supplier_id, prefix, name, status, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all();
}

function dbInsertApiKey(supplierId, name, keyHash, prefix) {
  const stmt = getDb().prepare('INSERT INTO api_keys (supplier_id, name, key_hash, prefix, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  return stmt.run(supplierId, name, keyHash, prefix, 'active', Date.now()).lastInsertRowid;
}

function dbUpdateApiKeyLastUsed(id) {
  getDb().prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(Date.now(), id);
}

function dbRevokeApiKey(id) {
  getDb().prepare("UPDATE api_keys SET status='revoked' WHERE id=?").run(id);
}

function dbInsertMainboardTest(data) {
  const stmt = getDb().prepare(`INSERT INTO mainboard_tests
    (supplier_id, hardware_version, mac_address, firmware_mode, product_model, batch_no, test_result, tested_at, raw_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return stmt.run(
    data.supplier_id, data.hardware_version, data.mac_address,
    data.firmware_mode, data.product_model || null, data.batch_no || null,
    data.test_result, data.tested_at, data.raw_payload || null, Date.now()
  ).lastInsertRowid;
}

function dbListMainboardTests(q, supplierFilter = null) {
  const wheres = [];
  const params = [];
  if (supplierFilter) { wheres.push('supplier_id=?'); params.push(supplierFilter); }
  else if (q.supplier_id) { wheres.push('supplier_id=?'); params.push(q.supplier_id); }
  if (q.mac) { wheres.push('mac_address LIKE ?'); params.push('%' + q.mac + '%'); }
  if (q.date_from) {
    wheres.push('tested_at >= ?');
    params.push(new Date(q.date_from + 'T00:00:00+08:00').getTime());
  }
  if (q.date_to) {
    wheres.push('tested_at <= ?');
    params.push(new Date(q.date_to + 'T23:59:59+08:00').getTime());
  }
  if (q.test_result) { wheres.push('test_result=?'); params.push(q.test_result.toUpperCase()); }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  return getDb().prepare(
    `SELECT * FROM mainboard_tests ${where} ORDER BY tested_at DESC LIMIT 5000`
  ).all(...params);
}

// ---------------- supplier-brand bindings ----------------

function dbGetBindingsForSupplier(supplierName) {
  return getDb().prepare(
    `SELECT b.brand_id, v.name FROM supplier_brand_bindings b
     JOIN vehicle_brands v ON v.id = b.brand_id
     WHERE b.supplier_name = ? AND v.enabled = 1
     ORDER BY v.sort_order, v.id`
  ).all(supplierName);
}

function dbGetAllBindings() {
  return getDb().prepare(
    `SELECT b.id, b.supplier_name, b.brand_id, v.name as brand_name
     FROM supplier_brand_bindings b
     JOIN vehicle_brands v ON v.id = b.brand_id
     ORDER BY b.supplier_name, v.sort_order, v.id`
  ).all();
}

function dbSetBindingsForSupplier(supplierName, brandIds) {
  const db = getDb();
  const del = db.prepare('DELETE FROM supplier_brand_bindings WHERE supplier_name = ?');
  const ins = db.prepare('INSERT INTO supplier_brand_bindings (supplier_name, brand_id, created_at) VALUES (?, ?, ?)');
  const now = Date.now();
  const txn = db.transaction(() => {
    del.run(supplierName);
    for (const bid of brandIds) {
      ins.run(supplierName, bid, now);
    }
  });
  txn();
}

function dbGetBoundBrandNames(supplierName) {
  return getDb().prepare(
    `SELECT v.name FROM supplier_brand_bindings b
     JOIN vehicle_brands v ON v.id = b.brand_id
     WHERE b.supplier_name = ? AND v.enabled = 1
     ORDER BY v.sort_order, v.id`
  ).all(supplierName).map(r => r.name);
}

// ---------------- supplier-product bindings ----------------

function ensureSupplierProductsTable() {
  getDb().prepare(`CREATE TABLE IF NOT EXISTS supplier_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_name TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(supplier_name, product_id)
  )`).run();
}
deferInit(() => { try { ensureSupplierProductsTable(); } catch(e) { console.error('[supplier_products init error]', e); } });

function dbGetProductIdsForSupplier(supplierName) {
  ensureSupplierProductsTable();
  return getDb().prepare(
    `SELECT product_id FROM supplier_products WHERE supplier_name = ?`
  ).all(supplierName).map(r => r.product_id);
}

function dbGetProductsForSupplier(supplierName) {
  ensureSupplierProductsTable();
  const ids = dbGetProductIdsForSupplier(supplierName);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT id, model_name, model_code, image_path, status, vehicle_brand FROM products WHERE id IN (${placeholders}) ORDER BY sort_order, id`
  ).all(...ids);
}

function dbGetAllProductBindings() {
  ensureSupplierProductsTable();
  return getDb().prepare(
    `SELECT sp.supplier_name, sp.product_id, p.model_name
     FROM supplier_products sp
     JOIN products p ON p.id = sp.product_id
     ORDER BY sp.supplier_name, p.sort_order, p.id`
  ).all();
}

function dbSetProductBindingsForSupplier(supplierName, productIds) {
  ensureSupplierProductsTable();
  const db = getDb();
  const del = db.prepare('DELETE FROM supplier_products WHERE supplier_name = ?');
  const ins = db.prepare('INSERT INTO supplier_products (supplier_name, product_id, created_at) VALUES (?, ?, ?)');
  const now = Date.now();
  const txn = db.transaction(() => {
    del.run(supplierName);
    for (const pid of productIds) {
      ins.run(supplierName, pid, now);
    }
  });
  txn();
}

// ---------------- repair records DB helpers ----------------

function dbInsertRepairLine(r) {
  const stmt = getDb().prepare(`INSERT INTO repair_line_records
    (supplier, vehicle_brand, model, fault_symptom, fault_cause, defective_part,
     short_term_fix, long_term_fix, sn_whole, sn_part, repair_date, repair_result,
     repair_person, remarks, batch_no, station, discovery_stage, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return stmt.run(
    r.supplier, r.vehicle_brand || null, r.model || null,
    r.fault_symptom || null, r.fault_cause || null, r.defective_part || null,
    r.short_term_fix || null, r.long_term_fix || null,
    r.sn_whole || null, r.sn_part || null,
    r.repair_date || null, r.repair_result || null,
    r.repair_person || null, r.remarks || null,
    r.batch_no || null, r.station || null, r.discovery_stage || null,
    r.created_at || Date.now()
  ).lastInsertRowid;
}

function dbInsertRepairAftersales(r) {
  const stmt = getDb().prepare(`INSERT INTO repair_aftersales_records
    (supplier, vehicle_brand, model, fault_symptom, fault_cause, defective_part,
     short_term_fix, long_term_fix, sn_whole, sn_part, repair_date, repair_result,
     repair_person, remarks, return_order_no, customer_feedback,
     return_date, repair_complete_date, ship_date, in_warranty, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return stmt.run(
    r.supplier, r.vehicle_brand || null, r.model || null,
    r.fault_symptom || null, r.fault_cause || null, r.defective_part || null,
    r.short_term_fix || null, r.long_term_fix || null,
    r.sn_whole || null, r.sn_part || null,
    r.repair_date || null, r.repair_result || null,
    r.repair_person || null, r.remarks || null,
    r.return_order_no || null, r.customer_feedback || null,
    r.return_date || null, r.repair_complete_date || null,
    r.ship_date || null, r.in_warranty || null,
    r.created_at || Date.now()
  ).lastInsertRowid;
}

function dbListRepairLineBySupplier(supplier) {
  return getDb().prepare(
    `SELECT * FROM repair_line_records WHERE supplier=? AND deleted_at IS NULL ORDER BY repair_date DESC, id DESC LIMIT 500`
  ).all(supplier);
}

function dbListRepairAftersalesBySupplier(supplier) {
  return getDb().prepare(
    `SELECT * FROM repair_aftersales_records WHERE supplier=? AND deleted_at IS NULL ORDER BY repair_date DESC, id DESC LIMIT 500`
  ).all(supplier);
}

function dbAdminRepairRecords(kind, q) {
  const tbl = kind === 'repair_aftersales' ? 'repair_aftersales_records' : 'repair_line_records';
  const wheres = ['deleted_at IS NULL'];
  const params = [];
  if (q.supplier) { wheres.push('supplier = ?'); params.push(q.supplier); }
  if (q.vehicle_brand) { wheres.push('vehicle_brand = ?'); params.push(q.vehicle_brand); }
  if (q.model) { wheres.push('model LIKE ?'); params.push('%' + q.model + '%'); }
  if (q.date_from) { wheres.push('repair_date >= ?'); params.push(q.date_from); }
  if (q.date_to) { wheres.push('repair_date <= ?'); params.push(q.date_to); }
  if (q.repair_result) { wheres.push('repair_result = ?'); params.push(q.repair_result); }
  if (q.sn) { wheres.push('(sn_whole LIKE ? OR sn_part LIKE ?)'); params.push('%' + q.sn + '%', '%' + q.sn + '%'); }
  if (q.id) { wheres.push('id = ?'); params.push(Number(q.id)); }
  return getDb().prepare(
    `SELECT * FROM ${tbl} WHERE ${wheres.join(' AND ')} ORDER BY repair_date DESC, id DESC LIMIT 2000`
  ).all(...params);
}

function dbUpdateRepairRecord(kind, id, fields, username) {
  const tbl = kind === 'repair_aftersales' ? 'repair_aftersales_records' : 'repair_line_records';
  const now = Date.now();
  const sets = [];
  const vals = [];
  const commonAllowed = ['vehicle_brand', 'model', 'fault_symptom', 'fault_cause', 'defective_part',
    'short_term_fix', 'long_term_fix', 'sn_whole', 'sn_part', 'repair_date', 'repair_result',
    'repair_person', 'remarks'];
  const lineExtra = ['batch_no', 'station', 'discovery_stage'];
  const asExtra = ['return_order_no', 'customer_feedback', 'return_date', 'repair_complete_date', 'ship_date', 'in_warranty'];
  const allowed = kind === 'repair_aftersales'
    ? [...commonAllowed, ...asExtra]
    : [...commonAllowed, ...lineExtra];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k] === '' ? null : fields[k]); }
  }
  if (sets.length === 0) return;
  sets.push('updated_at=?', 'updated_by=?');
  vals.push(now, username, id);
  getDb().prepare(`UPDATE ${tbl} SET ${sets.join(',')} WHERE id=? AND deleted_at IS NULL`).run(...vals);
}

function dbSoftDeleteRepair(kind, id, username) {
  const tbl = kind === 'repair_aftersales' ? 'repair_aftersales_records' : 'repair_line_records';
  getDb().prepare(
    `UPDATE ${tbl} SET deleted_at=?, updated_at=?, updated_by=? WHERE id=? AND deleted_at IS NULL`
  ).run(Date.now(), Date.now(), username, id);
}

function dbGetRepairRecord(kind, id) {
  const tbl = kind === 'repair_aftersales' ? 'repair_aftersales_records' : 'repair_line_records';
  return getDb().prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(id);
}

function dbInsertAttachment(recordType, recordId, filename, originalName, mimeType, size) {
  return getDb().prepare(
    `INSERT INTO repair_attachments (record_type, record_id, filename, original_name, mime_type, size, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(recordType, recordId, filename, originalName, mimeType || 'application/octet-stream', size, Date.now()).lastInsertRowid;
}

function dbGetAttachments(recordType, recordId) {
  return getDb().prepare(
    `SELECT * FROM repair_attachments WHERE record_type=? AND record_id=? ORDER BY id`
  ).all(recordType, recordId);
}

function dbDeleteAttachment(id) {
  const row = getDb().prepare('SELECT * FROM repair_attachments WHERE id=?').get(id);
  if (row) {
    const filePath = nodePath.join(UPLOAD_DIR, row.filename);
    try { fs.unlinkSync(filePath); } catch { /* file may not exist */ }
    getDb().prepare('DELETE FROM repair_attachments WHERE id=?').run(id);
  }
  return row;
}

// Count repair records for FFR integration
function dbRepairCountForFFR(q) {
  const { wheres: rw, params: rp } = buildFilters(q, { forKind: 'return' });
  // Count distinct SN matches between repair records and return records
  // Repair records that match existing return records by model+sn
  const lineCount = getDb().prepare(
    `SELECT COUNT(*) as c FROM repair_line_records WHERE deleted_at IS NULL`
  ).get().c;
  const asCount = getDb().prepare(
    `SELECT COUNT(*) as c FROM repair_aftersales_records WHERE deleted_at IS NULL`
  ).get().c;
  return { lineCount, asCount };
}

// ---------------- multipart parser ----------------

function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const endBuf = Buffer.from('--' + boundary + '--');

  let start = 0;
  while (start < body.length) {
    const bStart = body.indexOf(boundaryBuf, start);
    if (bStart < 0) break;
    const afterBoundary = bStart + boundaryBuf.length;
    if (body.slice(bStart, bStart + endBuf.length).equals(endBuf)) break;

    const headerEnd = body.indexOf('\r\n\r\n', afterBoundary);
    if (headerEnd < 0) break;
    const headerStr = body.slice(afterBoundary, headerEnd).toString('utf8');

    const nextBoundary = body.indexOf(boundaryBuf, headerEnd + 4);
    const partEnd = nextBoundary >= 0 ? nextBoundary - 2 : body.length;
    const partBody = body.slice(headerEnd + 4, partEnd);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: ctMatch ? ctMatch[1].trim() : null,
      data: partBody,
      text: !filenameMatch ? partBody.toString('utf8') : null,
    });
    start = nextBoundary >= 0 ? nextBoundary : body.length;
  }
  return parts;
}

// ---------------- feishu ----------------

let _tokenCache = { token: null, expireAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache.token && _tokenCache.expireAt > now + 60_000) return _tokenCache.token;
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('token 获取失败: ' + JSON.stringify(data));
  _tokenCache = { token: data.tenant_access_token, expireAt: now + data.expire * 1000 };
  return data.tenant_access_token;
}

async function feishu(path, init = {}) {
  const token = await getAccessToken();
  const resp = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`飞书 API 错误 ${data.code}: ${data.msg}`);
  return data;
}

// ---------------- feishu OAuth login ----------------

async function feishuExchangeCode(code) {
  // Exchange authorization_code for user_access_token
  // Feishu OIDC requires app_access_token (tenant_access_token) in Authorization header
  const appToken = await getAccessToken();
  const resp = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${appToken}`,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('飞书 token 换取失败: ' + JSON.stringify(data));
  return data.data; // { access_token, token_type, expires_in, ... }
}

async function feishuGetUserInfo(userAccessToken) {
  const resp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { 'Authorization': `Bearer ${userAccessToken}` },
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('飞书用户信息获取失败: ' + JSON.stringify(data));
  return data.data; // { open_id, name, avatar_url, ... }
}

async function getOrCreateFeishuUser(openId, name, avatarUrl) {
  // Find existing user by feishu_open_id index
  const indexRaw = await kvGet(`feishu_user:${openId}`);
  if (indexRaw) {
    const { username } = typeof indexRaw === 'string' ? JSON.parse(indexRaw) : indexRaw;
    const user = await getUser(username);
    if (user && !user.disabled) {
      // Update display name and avatar if changed
      if (user.display_name !== name || user.feishu_avatar !== avatarUrl) {
        user.display_name = name || user.display_name;
        if (avatarUrl) user.feishu_avatar = avatarUrl;
        await putUser(user);
      }
      return user;
    }
    if (user && user.disabled) return null; // disabled
  }
  // Create new user
  const username = `feishu_${openId}`;
  const user = {
    username,
    display_name: name || openId,
    passwordHash: null, // Feishu-only, no local password
    role: 'user',
    supplier: null,
    mes_station: null,
    company_name: null,
    disabled: false,
    feishu_open_id: openId,
    feishu_avatar: avatarUrl || null,
    createdAt: Date.now(),
  };
  await putUser(user);
  await kvPut(`feishu_user:${openId}`, JSON.stringify({ username }));
  return user;
}

async function feishuFetchAll(tableId) {
  const records = [];
  let pageToken = null;
  do {
    const body = { page_size: 500, sort: [{ field_name: '日期', desc: false }] };
    if (pageToken) body.page_token = pageToken;
    const data = await feishu(
      `/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records/search`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    records.push(...(data.data.items || []));
    pageToken = data.data.has_more ? data.data.page_token : null;
  } while (pageToken);
  return records;
}

function tsToDate(ts) {
  if (!ts) return null;
  const d = new Date(typeof ts === 'number' ? ts : Number(ts));
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getFieldText(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? x.text || x.name || '' : x)).join(',');
  if (typeof v === 'object') return v.text || v.name || null;
  return String(v) || null;
}

async function migrateFromFeishu() {
  const flag = await kvGet('_migrated_sqlite_v1');
  if (flag) return;
  console.log('[migration] Starting Feishu → SQLite migration...');
  try {
    // Clear existing migrated data for clean re-import
    getDb().prepare('DELETE FROM prod_records').run();
    getDb().prepare('DELETE FROM return_records').run();

    const prodItems = await feishuFetchAll(TBL_PROD);
    let prodCount = 0;
    for (const it of prodItems) {
      const f = it.fields;
      const rid = it.record_id;
      // 数量 is the main production qty in old records; 实际产出 for new app records
      const qty = (f['数量'] != null ? Number(f['数量']) : null) || (f['实际产出'] != null ? Number(f['实际产出']) : null);
      dbInsertProd({
        feishu_record_id: rid,
        supplier: getFieldText(f['供应商']) || '',
        date: tsToDate(f['日期']) || '',
        model: getFieldText(f['型号']) || getFieldText(f['机型']) || null,
        batch: getFieldText(f['生产批次']) || null,
        plan_qty: f['计划数量'] != null ? Number(f['计划数量']) : null,
        actual_qty: qty,
        warehouse_qty: f['入库数量'] != null ? Number(f['入库数量']) : null,
        notes: getFieldText(f['备注']) || null,
        vehicle_brand: getFieldText(f['车企']) || null,
        created_at: Date.now(),
      });
      prodCount++;
    }

    const retItems = await feishuFetchAll(TBL_RETURN);
    let retCount = 0;
    for (const it of retItems) {
      const f = it.fields;
      const rid = it.record_id;
      dbInsertReturn({
        feishu_record_id: rid,
        supplier: getFieldText(f['供应商']) || '',
        date: tsToDate(f['日期']) || '',
        model: getFieldText(f['型号']) || null,
        batch: getFieldText(f['批次']) || null,
        return_qty: f['退机数量'] != null ? Number(f['退机数量']) : null,
        defect_type: getFieldText(f['不良类型']) || null,
        defect_desc: getFieldText(f['不良描述']) || null,
        handling_result: getFieldText(f['处理结果']) || null,
        warehouse_qty: f['入库数量'] != null ? Number(f['入库数量']) : null,
        vehicle_brand: getFieldText(f['车企']) || null,
        created_at: Date.now(),
      });
      retCount++;
    }

    // Import unique vehicle brands from Feishu data
    const allBrands = new Set();
    [...prodItems, ...retItems].forEach(it => {
      const b = getFieldText(it.fields['车企']);
      if (b && b.trim() && b !== '车企') allBrands.add(b.trim());
    });
    const insBrand = getDb().prepare('INSERT OR IGNORE INTO vehicle_brands (name, sort_order, enabled) VALUES (?, ?, 1)');
    let brandIdx = 10;
    for (const name of [...allBrands].sort()) {
      insBrand.run(name, brandIdx++);
    }

    await kvPut('_migrated_sqlite_v1', '1');
    console.log(`[migration] Done: ${prodCount} prod, ${retCount} return records, ${allBrands.size} brands imported.`);
  } catch (e) {
    console.error('[migration] Failed (will retry next start):', e.message);
  }
}

// ---------------- vendor fill-in data tables migration ----------------

function ensureVendorTables() {
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS vendor_prod_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    customer_name TEXT,
    batch TEXT,
    plan_qty INTEGER,
    actual_qty INTEGER,
    warehouse_qty INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    updated_by TEXT,
    deleted_at INTEGER
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS vendor_return_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    customer_name TEXT,
    batch TEXT,
    return_qty INTEGER,
    defect_type TEXT,
    warehouse_qty INTEGER,
    defect_desc TEXT,
    handling_result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    updated_by TEXT,
    deleted_at INTEGER
  )`).run();
  // Unique indexes for non-null batch (DB-level guard for non-null cases)
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_prod_date_model_batch
    ON vendor_prod_records(date, model, batch) WHERE batch IS NOT NULL AND deleted_at IS NULL`).run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_return_date_model_batch
    ON vendor_return_records(date, model, batch) WHERE batch IS NOT NULL AND deleted_at IS NULL`).run();
  // Add supplier column if not already present (idempotent migration)
  try { db.prepare(`ALTER TABLE vendor_prod_records ADD COLUMN supplier TEXT`).run(); } catch(e) {}
  try { db.prepare(`ALTER TABLE vendor_return_records ADD COLUMN supplier TEXT`).run(); } catch(e) {}
}

// Run migration once at startup
deferInit(() => { try { ensureVendorTables(); } catch (e) { console.error('[vendor-tables init error]', e); } });

// Idempotent migration: add order_number to prod_records
deferInit(() => { try { getDb().prepare('ALTER TABLE prod_records ADD COLUMN order_number TEXT').run(); } catch(e) {} });

// ---------------- supplier data fill-in APIs ----------------

function apiSupplierDataFFR(query) {
  try {
    ensureVendorTables();
    const rows = getDb().prepare(`
      WITH p AS (
        SELECT model, SUM(COALESCE(actual_qty,0)) AS total_prod
        FROM (
          SELECT model, actual_qty FROM vendor_prod_records WHERE deleted_at IS NULL
          UNION ALL
          SELECT model, actual_qty FROM prod_records WHERE deleted_at IS NULL
        ) GROUP BY model
      ),
      r AS (
        SELECT model, SUM(COALESCE(return_qty,0)) AS total_return
        FROM (
          SELECT model, return_qty FROM vendor_return_records WHERE deleted_at IS NULL
          UNION ALL
          SELECT model, return_qty FROM return_records WHERE deleted_at IS NULL
        ) GROUP BY model
      )
      SELECT p.model, p.total_prod, COALESCE(r.total_return,0) AS total_return,
        ROUND(CAST(COALESCE(r.total_return,0) AS REAL)*100.0/NULLIF(p.total_prod,0),2) AS ffr
      FROM p LEFT JOIN r ON p.model=r.model
      ORDER BY ffr DESC, p.model
    `).all();
    return json({ ok: true, rows });
  } catch (e) {
    console.error('[supplier-data ffr error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiSupplierDataProdCreate(body, sess) {
  try {
    ensureVendorTables();
    const { date, model, supplier, customer_name, batch, plan_qty, actual_qty, warehouse_qty, notes } = body || {};
    if (!date || !model) return json({ ok: false, msg: '日期和型号为必填' }, 400);
    if (!customer_name || !String(customer_name).trim()) return json({ ok: false, msg: '客户为必填' }, 400);
    if (plan_qty == null || plan_qty === '') return json({ ok: false, msg: '订单数量为必填' }, 400);
    if (actual_qty == null || actual_qty === '') return json({ ok: false, msg: '交付数量为必填' }, 400);
    if (!batch || !String(batch).trim()) return json({ ok: false, msg: '内部型号为必填' }, 400);
    // 防重：日期 + 机型 + 订单数量 完全一致时拒绝
    const dupByQty = getDb().prepare(
      `SELECT id FROM vendor_prod_records WHERE date=? AND model=? AND plan_qty=? AND deleted_at IS NULL LIMIT 1`
    ).get(date, model.trim(), Number(plan_qty));
    if (dupByQty) return json({ ok: false, msg: '该日期/型号/订单数量的记录已存在，请勿重复提交', duplicate: true }, 400);
    const batchVal = batch || null;
    const dup = getDb().prepare(
      `SELECT id FROM vendor_prod_records WHERE date=? AND model=? AND batch IS ? AND deleted_at IS NULL LIMIT 1`
    ).get(date, model.trim(), batchVal);
    if (dup) return json({ ok: false, msg: '该记录已提交（日期 + 型号 + 生产批次 重复）', duplicate: true }, 409);
    const now = Date.now();
    const info = getDb().prepare(`
      INSERT INTO vendor_prod_records (date, model, supplier, customer_name, batch, plan_qty, actual_qty, warehouse_qty, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(date, model.trim(), supplier || null, customer_name || null, batchVal,
      plan_qty != null ? Number(plan_qty) : null, actual_qty != null ? Number(actual_qty) : null,
      warehouse_qty != null ? Number(warehouse_qty) : null, notes || null, now);
    return json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error('[supplier-data prod create error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}


function apiSupplierDataProdUpload(parts, sess) {
  let recordId = null;
  for (const part of parts) {
    if (part.name === 'record_id' && !part.filename) {
      recordId = Number(part.data.toString('utf8').trim());
    }
  }
  if (!recordId) return json({ ok: false, msg: '缺少 record_id' }, 400);
  const rec = getDb().prepare('SELECT id FROM vendor_prod_records WHERE id=? AND deleted_at IS NULL').get(recordId);
  if (!rec) return json({ ok: false, msg: '记录不存在' }, 404);
  const uploaded = [];
  for (const part of parts) {
    if (!part.filename) continue;
    if (part.data.length > MAX_UPLOAD_SIZE) return json({ ok: false, msg: '文件过大(最大10MB)' }, 400);
    const ext = nodePath.extname(part.filename).toLowerCase() || '.bin';
    const safeName = `vendor_prod_${recordId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const filePath = nodePath.join(UPLOAD_DIR, safeName);
    fs.writeFileSync(filePath, part.data);
    const attId = dbInsertAttachment('vendor_prod', recordId, safeName, part.filename, part.contentType, part.data.length);
    uploaded.push({ id: Number(attId), name: part.filename });
  }
  return json({ ok: true, uploaded });
}

function apiSupplierDataReturnCreate(body, sess) {
  try {
    ensureVendorTables();
    const { date, model, supplier, customer_name, batch, return_qty, defect_type, warehouse_qty, defect_desc, handling_result } = body || {};
    if (!date || !model) return json({ ok: false, msg: '日期和型号为必填' }, 400);
    const batchVal = batch || null;
    const dup = getDb().prepare(
      `SELECT id FROM vendor_return_records WHERE date=? AND model=? AND batch IS ? AND deleted_at IS NULL LIMIT 1`
    ).get(date, model.trim(), batchVal);
    if (dup) return json({ ok: false, msg: '该记录已提交（日期 + 型号 + 批次 重复）', duplicate: true }, 409);
    const now = Date.now();
    const info = getDb().prepare(`
      INSERT INTO vendor_return_records (date, model, supplier, customer_name, batch, return_qty, defect_type, warehouse_qty, defect_desc, handling_result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(date, model.trim(), supplier || null, customer_name || null, batchVal,
      return_qty != null ? Number(return_qty) : null, defect_type || null,
      warehouse_qty != null ? Number(warehouse_qty) : null, defect_desc || null, handling_result || null, now);
    return json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error('[supplier-data return create error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiSupplierDataProdHistory(query) {
  try {
    ensureVendorTables();
    const { model, supplier, customer, date_from, date_to } = query;
    const db = getDb();
    const p1 = [], p2 = [];

    let w1 = `deleted_at IS NULL`;
    if (model && model.trim()) { w1 += ` AND model LIKE ?`; p1.push(`%${model.trim()}%`); }
    if (supplier && supplier.trim()) { w1 += ` AND supplier LIKE ?`; p1.push(`%${supplier.trim()}%`); }
    if (customer && customer.trim()) { w1 += ` AND customer_name LIKE ?`; p1.push(`%${customer.trim()}%`); }
    if (date_from) { w1 += ` AND date >= ?`; p1.push(date_from); }
    if (date_to) { w1 += ` AND date <= ?`; p1.push(date_to); }

    let w2 = `deleted_at IS NULL`;
    if (model && model.trim()) { w2 += ` AND model LIKE ?`; p2.push(`%${model.trim()}%`); }
    if (supplier && supplier.trim()) { w2 += ` AND supplier LIKE ?`; p2.push(`%${supplier.trim()}%`); }
    if (customer && customer.trim()) { w2 += ` AND vehicle_brand LIKE ?`; p2.push(`%${customer.trim()}%`); }
    if (date_from) { w2 += ` AND date >= ?`; p2.push(date_from); }
    if (date_to) { w2 += ` AND date <= ?`; p2.push(date_to); }

    const newRows = db.prepare(`SELECT id, date, model, supplier, customer_name, batch, plan_qty, actual_qty, warehouse_qty, notes, 'new' AS _source FROM vendor_prod_records WHERE ${w1} ORDER BY date DESC, id DESC LIMIT 500`).all(...p1);
    const origRows = db.prepare(`SELECT id, date, model, supplier, vehicle_brand AS customer_name, batch, plan_qty, actual_qty, warehouse_qty, notes, 'original' AS _source FROM prod_records WHERE ${w2} ORDER BY date DESC, id DESC LIMIT 500`).all(...p2);
    const rowsRaw = [...newRows, ...origRows].sort((a, b) => b.date < a.date ? -1 : b.date > a.date ? 1 : 0).slice(0, 1000);
    const rows = rowsRaw.map(r => {
      const recordType = r._source === 'new' ? 'vendor_prod' : 'supplier_prod';
      const atts = dbGetAttachments(recordType, r.id);
      return { ...r, attachments: atts.map(a => ({ id: a.id, name: a.original_name, size: a.size })) };
    });
    return json({ ok: true, rows });
  } catch (e) {
    console.error('[supplier-data prod history error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiSupplierDataReturnHistory(query) {
  try {
    ensureVendorTables();
    const { model, supplier, customer, date_from, date_to } = query;
    const db = getDb();
    const p1 = [], p2 = [];

    let w1 = `deleted_at IS NULL`;
    if (model && model.trim()) { w1 += ` AND model LIKE ?`; p1.push(`%${model.trim()}%`); }
    if (supplier && supplier.trim()) { w1 += ` AND supplier LIKE ?`; p1.push(`%${supplier.trim()}%`); }
    if (customer && customer.trim()) { w1 += ` AND customer_name LIKE ?`; p1.push(`%${customer.trim()}%`); }
    if (date_from) { w1 += ` AND date >= ?`; p1.push(date_from); }
    if (date_to) { w1 += ` AND date <= ?`; p1.push(date_to); }

    let w2 = `deleted_at IS NULL`;
    if (model && model.trim()) { w2 += ` AND model LIKE ?`; p2.push(`%${model.trim()}%`); }
    if (supplier && supplier.trim()) { w2 += ` AND supplier LIKE ?`; p2.push(`%${supplier.trim()}%`); }
    if (customer && customer.trim()) { w2 += ` AND vehicle_brand LIKE ?`; p2.push(`%${customer.trim()}%`); }
    if (date_from) { w2 += ` AND date >= ?`; p2.push(date_from); }
    if (date_to) { w2 += ` AND date <= ?`; p2.push(date_to); }

    const newRows = db.prepare(`SELECT id, date, model, supplier, customer_name, batch, return_qty, defect_type, warehouse_qty, defect_desc, handling_result, 'new' AS _source FROM vendor_return_records WHERE ${w1} ORDER BY date DESC, id DESC LIMIT 500`).all(...p1);
    const origRows = db.prepare(`SELECT id, date, model, supplier, vehicle_brand AS customer_name, batch, return_qty, defect_type, warehouse_qty, defect_desc, handling_result, 'original' AS _source FROM return_records WHERE ${w2} ORDER BY date DESC, id DESC LIMIT 500`).all(...p2);
    const rowsRaw = [...newRows, ...origRows].sort((a, b) => b.date < a.date ? -1 : b.date > a.date ? 1 : 0).slice(0, 1000);
    const rows = rowsRaw.map(r => {
      const recordType = r._source === 'new' ? 'vendor_return' : 'vendor_return';
      const atts = dbGetAttachments(recordType, r.id);
      return { ...r, attachments: atts.map(a => ({ id: a.id, name: a.original_name, size: a.size })) };
    });
    return json({ ok: true, rows });
  } catch (e) {
    console.error('[supplier-data return history error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiSupplierDataProdEdit(body, sess) {
  try {
    ensureVendorTables();
    const { id, date, model, supplier, customer_name, batch, plan_qty, actual_qty, warehouse_qty, notes } = body || {};
    if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
    if (!date || !model) return json({ ok: false, msg: '日期和型号为必填' }, 400);
    const now = Date.now();
    const info = getDb().prepare(`
      UPDATE vendor_prod_records SET date=?, model=?, supplier=?, customer_name=?, batch=?, plan_qty=?, actual_qty=?, warehouse_qty=?, notes=?, updated_at=?, updated_by=?
      WHERE id=? AND deleted_at IS NULL
    `).run(date, model.trim(), supplier || null, customer_name || null, batch || null,
      plan_qty != null ? Number(plan_qty) : null, actual_qty != null ? Number(actual_qty) : null,
      warehouse_qty != null ? Number(warehouse_qty) : null, notes || null, now, sess.username, Number(id));
    if (info.changes === 0) return json({ ok: false, msg: '记录不存在或已删除' }, 404);
    return json({ ok: true });
  } catch (e) {
    console.error('[supplier-data prod edit error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiSupplierDataReturnEdit(body, sess) {
  try {
    ensureVendorTables();
    const { id, date, model, supplier, customer_name, batch, return_qty, defect_type, warehouse_qty, defect_desc, handling_result } = body || {};
    if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
    if (!date || !model) return json({ ok: false, msg: '日期和型号为必填' }, 400);
    const now = Date.now();
    const info = getDb().prepare(`
      UPDATE vendor_return_records SET date=?, model=?, supplier=?, customer_name=?, batch=?, return_qty=?, defect_type=?, warehouse_qty=?, defect_desc=?, handling_result=?, updated_at=?, updated_by=?
      WHERE id=? AND deleted_at IS NULL
    `).run(date, model.trim(), supplier || null, customer_name || null, batch || null,
      return_qty != null ? Number(return_qty) : null, defect_type || null,
      warehouse_qty != null ? Number(warehouse_qty) : null, defect_desc || null, handling_result || null, now, sess.username, Number(id));
    if (info.changes === 0) return json({ ok: false, msg: '记录不存在或已删除' }, 404);
    return json({ ok: true });
  } catch (e) {
    console.error('[supplier-data return edit error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

// ---------------- business APIs ----------------

async function apiHistory(query, sess) {
  if (!isSupplierRole(sess.role) || !sess.supplier) {
    return json({ ok: false, msg: '当前账号无供应商数据视图' }, 403);
  }
  const kind = query.kind || 'prod';
  const modelFilter = query.model || '';
  let rows = kind === 'return'
    ? dbListReturnBySupplier(sess.supplier)
    : dbListProdBySupplier(sess.supplier);
  if (modelFilter) {
    rows = rows.filter(r => r.model === modelFilter);
  }
  if (kind === 'return') {
    rows = rows.map(r => {
      const atts = dbGetAttachments('vendor_return', r.id);
      return { ...r, attachments: atts.map(a => ({ id: a.id, name: a.original_name, size: a.size })) };
    });
  } else {
    rows = rows.map(r => {
      const atts = dbGetAttachments('supplier_prod', r.id);
      return { ...r, attachments: atts.map(a => ({ id: a.id, name: a.original_name, size: a.size })) };
    });
  }
  return json({ ok: true, items: rows });
}

async function apiSubmit(body, sess) {
  if (!isSupplierRole(sess.role) || !sess.supplier) {
    return json({ ok: false, msg: '当前账号不能填报' }, 403);
  }
  const { kind, fields } = body || {};
  if (!fields || typeof fields !== 'object') return json({ ok: false, msg: '缺少 fields' }, 400);

  const record = { ...fields };
  record['供应商'] = sess.supplier;

  const dateStr = record['日期'];
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return json({ ok: false, msg: '日期格式错误' }, 400);
  }

  const vehicleBrand = record['车企'] || null;
  if (vehicleBrand) {
    const brands = (isSupplierRole(sess.role) && sess.supplier)
      ? dbGetBoundBrandNames(sess.supplier)
      : dbGetBrands(true).map(b => b.name);
    if (!brands.includes(vehicleBrand)) {
      return json({ ok: false, msg: '客户不在可选列表中' }, 400);
    }
  }

  if (kind === 'return' && record['不良类型']) {
    if (!DEFECT_TYPES.includes(record['不良类型'])) {
      return json({ ok: false, msg: '不良类型非法' }, 400);
    }
  }

  // 生产填报必填字段校验
  if (kind === 'prod') {
    if (!vehicleBrand) return json({ ok: false, msg: '客户不能为空' }, 400);
    if (!(record['机型'] || '').trim()) return json({ ok: false, msg: '型号不能为空' }, 400);
    if (!(record['订单号'] || '').trim()) return json({ ok: false, msg: '订单号不能为空' }, 400);
    if (!(record['生产批次'] || '').trim()) return json({ ok: false, msg: '内部型号不能为空' }, 400);
    if (record['计划数量'] === undefined || record['计划数量'] === '') return json({ ok: false, msg: '订单数量不能为空' }, 400);
    if (record['实际产出'] === undefined || record['实际产出'] === '') return json({ ok: false, msg: '交付数量不能为空' }, 400);
  }

  // 防重：生产记录按「供应商 + 日期 + 机型 + 订单号 + 内部型号」判重（允许同日同型号多个订单）
  if (kind === 'prod') {
    const model = (record['机型'] || '').trim();
    const orderNum = (record['订单号'] || '').trim();
    const batchVal = (record['生产批次'] || '').trim() || null;
    const existing = getDb().prepare(
      'SELECT id FROM prod_records WHERE supplier=? AND date=? AND model=? AND order_number=? AND batch IS ? AND deleted_at IS NULL LIMIT 1'
    ).get(sess.supplier, dateStr, model, orderNum, batchVal);
    if (existing) {
      return json({ ok: false, msg: '该记录已存在（相同订单号和内部型号）', duplicate: true }, 400);
    }
  }

  let localId;
  if (kind === 'return') {
    localId = dbInsertReturn({
      supplier: sess.supplier,
      date: dateStr,
      model: record['型号'] || null,
      batch: record['批次'] || null,
      return_qty: Number(record['退机数量']) || null,
      defect_type: record['不良类型'] || null,
      fault_qty: record['故障数量'] ? Number(record['故障数量']) : null,
      human_qty: record['人为数量'] ? Number(record['人为数量']) : null,
      ntf_qty: record['NTF数量'] ? Number(record['NTF数量']) : null,
      no_issue_qty: record['七无数量'] ? Number(record['七无数量']) : null,
      repair_report: record['上传维修记录'] || null,
      defect_desc: record['不良描述'] || null,
      handling_result: record['处理结果'] || null,
      warehouse_qty: Number(record['入库数量']) || null,
      vehicle_brand: vehicleBrand,
      created_at: Date.now(),
    });
  } else {
    localId = dbInsertProd({
      supplier: sess.supplier,
      date: dateStr,
      model: record['机型'] || null,
      batch: record['生产批次'] || null,
      plan_qty: Number(record['计划数量']) || null,
      actual_qty: Number(record['实际产出']) || null,
      warehouse_qty: Number(record['入库数量']) || null,
      notes: record['备注'] || null,
      vehicle_brand: vehicleBrand,
      order_number: record['订单号'] || null,
      created_at: Date.now(),
    });
  }

  // Also write to Feishu (best-effort)
  try {
    const feishuRecord = { ...record };
    const d = new Date(dateStr + 'T00:00:00+08:00');
    feishuRecord['日期'] = d.getTime();
    const numberFields = kind === 'return'
      ? ['退机数量', '入库数量']
      : ['计划数量', '实际产出', '入库数量', '数量'];
    for (const k of numberFields) {
      if (feishuRecord[k] !== undefined && feishuRecord[k] !== '' && feishuRecord[k] !== null) {
        feishuRecord[k] = Number(feishuRecord[k]);
      } else {
        delete feishuRecord[k];
      }
    }
    // Keep 车企 for Feishu (it already has this field)
    const tableId = kind === 'return' ? TBL_RETURN : TBL_PROD;
    const resp = await feishu(`/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records`, {
      method: 'POST',
      body: JSON.stringify({ fields: feishuRecord }),
    });
    // Update local record with feishu_record_id and updated_by
    const tbl = kind === 'return' ? 'return_records' : 'prod_records';
    getDb().prepare(`UPDATE ${tbl} SET feishu_record_id=?, updated_by=? WHERE id=?`)
      .run(resp.data.record.record_id, sess.username, localId);
    return json({ ok: true, id: localId, record_id: resp.data.record.record_id });
  } catch (e) {
    console.error('[feishu write failed]', e.message);
    return json({ ok: true, id: localId, record_id: null });
  }
}

function apiOptions(sess) {
  let brands;
  if (sess && isSupplierRole(sess.role) && sess.supplier) {
    brands = dbGetBoundBrandNames(sess.supplier);
  } else {
    brands = dbGetBrands(true).map(b => b.name);
  }
  return json({ ok: true, defectTypes: DEFECT_TYPES, suppliers: getSuppliersList(), vehicleBrands: brands });
}

function apiSupplierFFR(sess) {
  if (!isSupplierRole(sess.role) || !sess.supplier) {
    return json({ ok: false, msg: '当前账号无供应商数据视图' }, 403);
  }
  const boundBrands = dbGetBoundBrandNames(sess.supplier);
  if (boundBrands.length === 0) {
    const repairLineCount = getDb().prepare(
      'SELECT COUNT(*) as c FROM repair_line_records WHERE supplier=? AND deleted_at IS NULL'
    ).get(sess.supplier).c;
    const repairAsCount = getDb().prepare(
      'SELECT COUNT(*) as c FROM repair_aftersales_records WHERE supplier=? AND deleted_at IS NULL'
    ).get(sess.supplier).c;
    return json({ ok: true, items: [], repairLineCount, repairAsCount });
  }
  const placeholders = boundBrands.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT
      p.model,
      COALESCE(p.prod_qty, 0) as prod_qty,
      COALESCE(r.return_qty, 0) as return_qty,
      CASE WHEN COALESCE(p.prod_qty, 0) > 0
        THEN ROUND(CAST(COALESCE(r.return_qty, 0) AS REAL) / p.prod_qty * 100, 2)
        ELSE 0
      END as ffr
    FROM (
      SELECT model, SUM(COALESCE(actual_qty, 0)) as prod_qty
      FROM prod_records
      WHERE supplier = ? AND deleted_at IS NULL
        AND vehicle_brand IN (${placeholders})
        AND model IS NOT NULL
      GROUP BY model
    ) p
    LEFT JOIN (
      SELECT model, SUM(COALESCE(return_qty, 0)) as return_qty
      FROM return_records
      WHERE supplier = ? AND deleted_at IS NULL
        AND vehicle_brand IN (${placeholders})
        AND model IS NOT NULL
      GROUP BY model
    ) r ON p.model = r.model
    ORDER BY ffr DESC, p.model
  `).all(sess.supplier, ...boundBrands, sess.supplier, ...boundBrands);
  // Include repair counts for this supplier
  const repairLineCount = getDb().prepare(
    'SELECT COUNT(*) as c FROM repair_line_records WHERE supplier=? AND deleted_at IS NULL'
  ).get(sess.supplier).c;
  const repairAsCount = getDb().prepare(
    'SELECT COUNT(*) as c FROM repair_aftersales_records WHERE supplier=? AND deleted_at IS NULL'
  ).get(sess.supplier).c;
  return json({ ok: true, items: rows, repairLineCount, repairAsCount });
}

// ---------------- admin APIs ----------------

function originOk(reqHeaders, host) {
  const origin = reqHeaders.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === host;
  } catch { return false; }
}

async function apiAdminList() {
  return json({ ok: true, users: await listUsers() });
}

async function apiAdminCreate(body) {
  const { username, password, display_name, role, supplier, mes_station, company_name } = body || {};
  if (!username || !password || !display_name || !role) {
    return json({ ok: false, msg: '缺少 username/password/display_name/role' }, 400);
  }
  if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username)) {
    return json({ ok: false, msg: 'username 只能含字母数字和 _.- 长度 2-40' }, 400);
  }
  if (password.length < 6 || password.length > 128) {
    return json({ ok: false, msg: 'password 长度需 6-128' }, 400);
  }
  if (display_name.trim().length === 0 || display_name.length > 100) {
    return json({ ok: false, msg: '姓名长度需 1-100' }, 400);
  }
  if (role !== 'admin' && role !== 'super_admin' && role !== 'supplier' && role !== 'supplier_repair' && role !== 'factory' && role !== 'dev') {
    return json({ ok: false, msg: 'role 必须是 admin、super_admin、supplier、supplier_repair、factory 或 dev' }, 400);
  }
  if (isSupplierRole(role)) {
    if (!supplier || !getSuppliersList().includes(supplier)) {
      return json({ ok: false, msg: 'supplier 必须是预设白名单之一' }, 400);
    }
  }
  const { MES_STATIONS } = require('./mes');
  const MES_STATION_KEYS = MES_STATIONS.map(s => s.key);
  if (role === 'factory' && mes_station) {
    if (!MES_STATION_KEYS.includes(mes_station)) {
      return json({ ok: false, msg: '无效的工站选择' }, 400);
    }
  }
  if (await getUser(username)) {
    return json({ ok: false, msg: '用户名已存在' }, 409);
  }
  const user = {
    username,
    display_name: display_name.trim(),
    passwordHash: hashPassword(password),
    role,
    supplier: isSupplierRole(role) ? supplier : null,
    mes_station: role === 'factory' ? (mes_station || null) : null,
    company_name: company_name || null,
    disabled: false,
    createdAt: Date.now(),
  };
  await putUser(user);
  return json({ ok: true });
}

async function apiAdminChangePassword(body) {
  const { username, password } = body || {};
  if (!username || !password) return json({ ok: false, msg: '缺少 username/password' }, 400);
  if (password.length < 6 || password.length > 128) {
    return json({ ok: false, msg: 'password 长度需 6-128' }, 400);
  }
  const user = await getUser(username);
  if (!user) return json({ ok: false, msg: '用户不存在' }, 404);
  user.passwordHash = hashPassword(password);
  await putUser(user);
  return json({ ok: true });
}

async function apiAdminToggle(body, sess) {
  const { username, disabled } = body || {};
  if (!username || typeof disabled !== 'boolean') return json({ ok: false, msg: '参数错误' }, 400);
  if (username === sess.username && disabled) {
    return json({ ok: false, msg: '不能禁用自己' }, 400);
  }
  const user = await getUser(username);
  if (!user) return json({ ok: false, msg: '用户不存在' }, 404);
  user.disabled = disabled;
  await putUser(user);
  return json({ ok: true });
}

async function apiAdminDelete(body, sess) {
  const { username } = body || {};
  if (!username) return json({ ok: false, msg: '缺少 username' }, 400);
  if (username === sess.username) {
    return json({ ok: false, msg: '不能删除自己' }, 400);
  }
  if (!(await getUser(username))) return json({ ok: false, msg: '用户不存在' }, 404);
  await kvDelete(`user:${username}`);
  return json({ ok: true });
}

async function apiAdminSetRole(body, sess) {
  if (sess.role !== 'super_admin') return json({ ok: false, msg: '仅超管可修改角色' }, 403);
  const { username, role } = body || {};
  if (!username || !role) return json({ ok: false, msg: '缺少 username/role' }, 400);
  const ALLOWED_ROLES = ['user', 'admin', 'super_admin', 'supplier', 'supplier_repair', 'factory', 'dev'];
  if (!ALLOWED_ROLES.includes(role)) return json({ ok: false, msg: '无效角色' }, 400);
  const user = await getUser(username);
  if (!user) return json({ ok: false, msg: '用户不存在' }, 404);
  user.role = role;
  await putUser(user);
  return json({ ok: true });
}

// Top FFR
function extractModelVersion(modelName) {
  if (!modelName) return { name: modelName, major: 0, minor: 0, hasSuffix: false, suffix: '' };
  const match = modelName.match(/(\d+)\.(\d+)/);
  if (!match) return { name: modelName, major: 0, minor: 0, hasSuffix: false, suffix: '' };
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const fullVersion = match[0];
  const suffix = modelName.substring(match.index + fullVersion.length).trim();
  return { name: modelName, major, minor, hasSuffix: suffix.length > 0, suffix };
}

function sortByModelVersion(items) {
  return items.sort((a, b) => {
    const aV = extractModelVersion(a.model || a.name);
    const bV = extractModelVersion(b.model || b.name);
    if (aV.major !== bV.major) return aV.major - bV.major;
    if (aV.minor !== bV.minor) return aV.minor - bV.minor;
    if (aV.hasSuffix !== bV.hasSuffix) return aV.hasSuffix ? 1 : -1;
    return (aV.suffix || '').localeCompare(bV.suffix || '');
  });
}


// ---- 每日录入走势 ----
function dbDailyTrend(days) {
  days = Math.max(1, Math.min(365, parseInt(days) || 30));
  const since = Date.now() - days * 24 * 3600 * 1000;
  const rows = getDb().prepare(`
    SELECT date(datetime(created_at/1000, 'unixepoch', '+8 hours')) as day, COUNT(*) as cnt
    FROM (
      SELECT created_at FROM prod_records WHERE deleted_at IS NULL AND created_at >= ?
      UNION ALL
      SELECT created_at FROM return_records WHERE deleted_at IS NULL AND created_at >= ?
    )
    GROUP BY day ORDER BY day ASC
  `).all(since, since);
  // 补全近 days 天的空日期
  const result = [];
  const now = new Date(Date.now() + 8 * 3600 * 1000); // UTC+8
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    const found = rows.find(r => r.day === dayStr);
    result.push({ day: dayStr, cnt: found ? found.cnt : 0 });
  }
  return result;
}

// ---- 用户录入明细 ----
function dbUserStats(days) {
  days = Math.max(1, Math.min(365, parseInt(days) || 7));
  const since = Date.now() - days * 24 * 3600 * 1000;
  const rows = getDb().prepare(`
    SELECT
      COALESCE(updated_by, '未知') as username,
      COUNT(*) as cnt,
      MAX(COALESCE(updated_at, created_at)) as last_at
    FROM (
      SELECT updated_by, updated_at, created_at FROM prod_records WHERE deleted_at IS NULL AND created_at >= ?
      UNION ALL
      SELECT updated_by, updated_at, created_at FROM return_records WHERE deleted_at IS NULL AND created_at >= ?
    )
    GROUP BY COALESCE(updated_by, '未知')
    ORDER BY cnt DESC
  `).all(since, since);
  return rows;
}

function apiDailyTrend(query) {
  try {
    const data = dbDailyTrend(query.days);
    return json({ ok: true, data });
  } catch (e) {
    console.error('[daily-trend error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiUserStats(query) {
  try {
    const items = dbUserStats(query.days);
    return json({ ok: true, items });
  } catch (e) {
    console.error('[user-stats error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}


// ---- 录入记录明细（每条展开）----
function dbRecordDetails(query) {
  const days = Math.max(1, Math.min(365, parseInt(query.days) || 7));
  const page = Math.max(1, parseInt(query.page) || 1);
  const pageSize = 20;
  const since = Date.now() - days * 24 * 3600 * 1000;
  const offset = (page - 1) * pageSize;
  const db = getDb();
  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM (
      SELECT id FROM prod_records WHERE deleted_at IS NULL AND created_at >= ?
      UNION ALL
      SELECT id FROM return_records WHERE deleted_at IS NULL AND created_at >= ?
    )
  `).get(since, since);
  const total = countRow ? countRow.total : 0;
  const rows = db.prepare(`
    SELECT 'prod' as type, supplier, model, category, actual_qty as qty, vehicle_brand, date, created_at,
           COALESCE(updated_by, supplier) as operator
    FROM prod_records WHERE deleted_at IS NULL AND created_at >= ?
    UNION ALL
    SELECT 'return' as type, supplier, model, category, return_qty as qty, vehicle_brand, date, created_at,
           COALESCE(updated_by, supplier) as operator
    FROM return_records WHERE deleted_at IS NULL AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(since, since, pageSize, offset);
  return { items: rows, total, page, pageSize };
}

function apiRecordDetails(query) {
  try {
    const data = dbRecordDetails(query);
    return json({ ok: true, ...data });
  } catch (e) {
    console.error('[record-details error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiTopFFR(query) {
  try {
    const dim = ['model_brand', 'model', 'vehicle_brand', 'supplier', 'model_version'].includes(query.dim) ? query.dim : 'model_brand';
    const items = dbTopFFR(query, dim);
    if (dim === 'model_version') {
      return json({ ok: true, items: sortByModelVersion(items), minProd: TOP_FFR_MIN_PROD });
    }
    return json({ ok: true, items, minProd: TOP_FFR_MIN_PROD });
  } catch (e) {
    console.error('[top-ffr error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

// Dashboard
function apiDashboard(query) {
  try {
    const stats = dbDashboard(query);
    return json({ ok: true, ...stats });
  } catch (e) {
    console.error('[dashboard error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

// Records list
function apiAdminRecords(query) {
  const kind = query.kind === 'return' ? 'return' : 'prod';
  try {
    const rows = dbAdminRecords(kind, query);
    return json({ ok: true, items: rows });
  } catch (e) {
    console.error('[records error]', e);
    return json({ ok: false, msg: e.message }, 500);
  }
}

// Edit record
function apiAdminEdit(body, sess) {
  const { kind, id, fields } = body || {};
  if (!kind || !id || !fields) return json({ ok: false, msg: '缺少参数' }, 400);
  const rec = dbGetRecord(kind, id);
  if (!rec) return json({ ok: false, msg: '记录不存在' }, 404);
  if (rec.deleted_at) return json({ ok: false, msg: '记录已删除' }, 400);
  dbUpdateRecord(kind, id, fields, sess.username);
  return json({ ok: true });
}

// Delete record
function apiAdminDeleteRecord(body, sess) {
  const { kind, id } = body || {};
  if (!kind || !id) return json({ ok: false, msg: '缺少参数' }, 400);
  const rec = dbGetRecord(kind, id);
  if (!rec) return json({ ok: false, msg: '记录不存在' }, 404);
  if (rec.deleted_at) return json({ ok: false, msg: '记录已删除' }, 400);
  dbSoftDelete(kind, id, sess.username);
  return json({ ok: true });
}

// Export Excel
function apiAdminExport(query) {
  const kind = query.kind === 'return' ? 'return' : 'prod';
  const rows = dbAdminRecords(kind, query);

  const wb = XLSX.utils.book_new();
  let sheetData;

  if (kind === 'prod') {
    sheetData = [
      ['ID', '供应商', '日期', '型号', '生产批次', '计划数量', '实际产出', '入库数量', '备注', '客户', '创建时间', '更新时间', '更新人'],
      ...rows.map(r => [
        r.id, r.supplier, r.date, r.model, r.batch,
        r.plan_qty, r.actual_qty, r.warehouse_qty, r.notes, r.vehicle_brand,
        r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_by || '',
      ]),
    ];
  } else {
    sheetData = [
      ['ID', '供应商', '日期', '型号', '批次', '退机数量', '不良类型', '不良描述', '处理结果', '入库数量', '客户', '创建时间', '更新时间', '更新人'],
      ...rows.map(r => [
        r.id, r.supplier, r.date, r.model, r.batch,
        r.return_qty, r.defect_type, r.defect_desc, r.handling_result, r.warehouse_qty, r.vehicle_brand,
        r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_by || '',
      ]),
    ];
  }

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, kind === 'prod' ? '生产记录' : '退机记录');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const kindLabel = kind === 'prod' ? '生产' : '退机';
  const fname = `雷石质量管理系统_${kindLabel}_${ts}.xlsx`;

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    },
    body: buf,
  };
}

// Dashboard multi-module export (single sheet)
function apiAdminExportDashboard(query) {
  const rawModules = (query.modules || 'dashboard,prod,return,ffr').split(',').map(m => m.trim()).filter(Boolean);
  const validModules = ['dashboard', 'prod', 'return', 'ffr'];
  const modules = rawModules.filter(m => validModules.includes(m));
  if (modules.length === 0) {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: false, msg: '未选择任何模块' })) };
  }

  const allRows = [];

  if (modules.includes('dashboard')) {
    const stats = dbDashboard(query);
    allRows.push(['【仪表盘汇总】']);
    allRows.push(['指标', '数值']);
    allRows.push(['总生产台数（实际产出）', stats.totalProd]);
    allRows.push(['总退机台数', stats.totalRet]);
    allRows.push(['总 FFR%', stats.ffr]);
    allRows.push(['产线维修品数', stats.repairLineCount]);
    allRows.push(['售后返修品数', stats.repairAsCount]);
    allRows.push([]);

    // FFR TOP6 (model_brand dimension by default)
    const topItems = dbTopFFR(query, 'model_brand');
    allRows.push(['FFR TOP 6（机型-客户，生产≥10台）']);
    allRows.push(['名称', '生产台数', '退机台数', 'FFR%']);
    for (const item of topItems) {
      allRows.push([item.name, item.prod_qty, item.ret_qty, item.ffr]);
    }
    allRows.push([]);
  }

  if (modules.includes('prod')) {
    const rows = dbAdminRecords('prod', query);
    allRows.push(['【生产数据】']);
    allRows.push(['ID', '供应商', '日期', '型号', '生产批次', '计划数量', '实际产出', '入库数量', '备注', '客户', '创建时间', '更新时间', '更新人']);
    for (const r of rows) {
      allRows.push([
        r.id, r.supplier, r.date, r.model, r.batch,
        r.plan_qty, r.actual_qty, r.warehouse_qty, r.notes, r.vehicle_brand,
        r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_by || '',
      ]);
    }
    allRows.push([]);
  }

  if (modules.includes('return')) {
    const rows = dbAdminRecords('return', query);
    allRows.push(['【退机数量】']);
    allRows.push(['ID', '供应商', '日期', '型号', '批次', '退机数量', '不良类型', '不良描述', '处理结果', '入库数量', '客户', '创建时间', '更新时间', '更新人']);
    for (const r of rows) {
      allRows.push([
        r.id, r.supplier, r.date, r.model, r.batch,
        r.return_qty, r.defect_type, r.defect_desc, r.handling_result, r.warehouse_qty, r.vehicle_brand,
        r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 19).replace('T', ' ') : '',
        r.updated_by || '',
      ]);
    }
    allRows.push([]);
  }

  if (modules.includes('ffr')) {
    const stats = dbDashboard(query);
    allRows.push(['【FFR 分析】']);

    allRows.push(['按供应商 FFR']);
    allRows.push(['供应商', '生产台数', '退机台数', 'FFR%']);
    for (const r of stats.bySupplier) allRows.push([r.name, r.prod_qty, r.ret_qty, r.ffr]);
    allRows.push([]);

    allRows.push(['按型号 FFR']);
    allRows.push(['型号', '生产台数', '退机台数', 'FFR%']);
    for (const r of stats.byModel) allRows.push([r.name, r.prod_qty, r.ret_qty, r.ffr]);
    allRows.push([]);

    allRows.push(['按客户 FFR']);
    allRows.push(['客户', '生产台数', '退机台数', 'FFR%']);
    for (const r of stats.byBrand) allRows.push([r.name, r.prod_qty, r.ret_qty, r.ffr]);
    allRows.push([]);

    allRows.push(['按月 FFR 趋势']);
    allRows.push(['月份', '生产台数', '退机台数', 'FFR%']);
    for (const r of stats.byMonth) allRows.push([r.name, r.prod_qty, r.ret_qty, r.ffr]);
    allRows.push([]);
  }

  const ws = XLSX.utils.aoa_to_sheet(allRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '质量看板');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fname = `质量看板_${ts}.xlsx`;

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    },
    body: buf,
  };
}

// Vehicle brands APIs
function apiAdminBrandsList() {
  return json({ ok: true, brands: dbGetBrands(false) });
}

function apiAdminBrandsCreate(body) {
  const { name, sort_order } = body || {};
  if (!name || !name.trim()) return json({ ok: false, msg: '缺少 name' }, 400);
  try {
    getDb().prepare('INSERT INTO vehicle_brands (name, sort_order, enabled) VALUES (?, ?, 1)')
      .run(name.trim(), sort_order || 0);
    return json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return json({ ok: false, msg: '客户已存在' }, 409);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiAdminBrandsUpdate(body) {
  const { id, name, sort_order, enabled } = body || {};
  if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name.trim()); }
  if (sort_order !== undefined) { sets.push('sort_order=?'); vals.push(sort_order); }
  if (enabled !== undefined) { sets.push('enabled=?'); vals.push(enabled ? 1 : 0); }
  if (sets.length === 0) return json({ ok: false, msg: '没有可更新的字段' }, 400);
  vals.push(id);
  try {
    getDb().prepare(`UPDATE vehicle_brands SET ${sets.join(',')} WHERE id=?`).run(...vals);
    return json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return json({ ok: false, msg: '客户已存在' }, 409);
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiAdminBrandsDelete(body) {
  const { id } = body || {};
  if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
  getDb().prepare('DELETE FROM vehicle_brands WHERE id=?').run(id);
  return json({ ok: true });
}

// ---------------- admin supplier-brand bindings ----------------

function apiAdminBindingsList() {
  const bindings = dbGetAllBindings();
  const grouped = {};
  for (const b of bindings) {
    if (!grouped[b.supplier_name]) grouped[b.supplier_name] = [];
    grouped[b.supplier_name].push({ brand_id: b.brand_id, brand_name: b.brand_name });
  }
  const brands = dbGetBrands(false);
  const supplierList = dbGetSupplierNames();
  return json({ ok: true, bindings: grouped, suppliers: supplierList, brands });
}

function apiAdminBindingsUpdate(body) {
  const { supplier_name, brand_ids } = body || {};
  const validSuppliers = dbGetSupplierNames();
  if (!supplier_name || !validSuppliers.includes(supplier_name)) {
    return json({ ok: false, msg: '供应商无效' }, 400);
  }
  if (!Array.isArray(brand_ids)) {
    return json({ ok: false, msg: 'brand_ids 必须是数组' }, 400);
  }
  const validIds = brand_ids.filter(id => typeof id === 'number' && Number.isInteger(id));
  dbSetBindingsForSupplier(supplier_name, validIds);
  return json({ ok: true });
}

// ---------------- suppliers table (dynamic) ----------------
function dbGetSuppliers() {
  return getDb().prepare('SELECT id, name FROM suppliers ORDER BY sort_order, name').all();
}
function dbGetSupplierNames() {
  return dbGetSuppliers().map(s => s.name);
}
function dbCreateSupplier(name) {
  const maxSort = getDb().prepare('SELECT MAX(sort_order) as m FROM suppliers').get();
  getDb().prepare('INSERT INTO suppliers (name, sort_order, created_at) VALUES (?, ?, ?)').run(name.trim(), (maxSort.m || 0) + 1, Date.now());
}
function dbDeleteSupplier(id) {
  getDb().prepare('DELETE FROM suppliers WHERE id=?').run(id);
}

// ---------------- supplier-product bindings API ----------------

function apiAdminProductBindingsList() {
  const bindings = dbGetAllProductBindings();
  const grouped = {};
  for (const b of bindings) {
    if (!grouped[b.supplier_name]) grouped[b.supplier_name] = [];
    grouped[b.supplier_name].push({ product_id: b.product_id, model_name: b.model_name });
  }
  const products = getDb().prepare('SELECT id, model_name FROM products ORDER BY sort_order, id').all();
  return json({ ok: true, bindings: grouped, suppliers: getSuppliersList(), products });
}

function apiAdminProductBindingsUpdate(body) {
  const { supplier_name, product_ids } = body || {};
  if (!supplier_name || !getSuppliersList().includes(supplier_name)) {
    return json({ ok: false, msg: '供应商无效' }, 400);
  }
  if (!Array.isArray(product_ids)) {
    return json({ ok: false, msg: 'product_ids 必须是数组' }, 400);
  }
  const validIds = product_ids.filter(id => typeof id === 'number' && Number.isInteger(id));
  dbSetProductBindingsForSupplier(supplier_name, validIds);
  return json({ ok: true });
}

// ---------------- ext API: mainboard upload ----------------

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  const rand = randomToken(32);
  const full = 'qbk_' + rand;
  return { full, hash: hashApiKey(full), prefix: full.slice(0, 8) };
}

async function apiExtMainboardUpload(body, headers) {
  const rawKey = (headers['x-api-key'] || '').trim();
  if (!rawKey) return json({ ok: false, error: '缺少 X-API-Key 请求头，请联系管理员获取 API Key' }, 401);

  const keyHash = hashApiKey(rawKey);
  const keyRow = dbGetApiKeyByHash(keyHash);
  if (!keyRow || keyRow.status !== 'active') {
    return json({ ok: false, error: 'invalid api key' }, 401);
  }

  if (!checkExtApiRateLimit(keyRow.id)) {
    return json({ ok: false, error: '请求过于频繁，每 API Key 限速 20次/秒，请检查脚本是否有重复上传逻辑' }, 429);
  }

  let parsed;
  if (Buffer.isBuffer(body)) {
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { return json({ ok: false, error: '请求体必须为 JSON 格式，请检查 Content-Type: application/json 是否已设置' }, 400); }
  } else {
    parsed = body || {};
  }

  const required = ['hardware_version', 'mac_address', 'firmware_mode', 'test_result'];
  for (const f of required) {
    if (!parsed[f] || String(parsed[f]).trim() === '') {
      return json({ ok: false, error: `missing field: ${f}` }, 400);
    }
  }

  const testResult = String(parsed.test_result).toUpperCase();
  if (testResult !== 'PASS' && testResult !== 'FAIL') {
    return json({ ok: false, error: 'test_result 字段只允许填 PASS 或 FAIL' }, 400);
  }

  const testedAt = Date.now();
  const id = dbInsertMainboardTest({
    supplier_id: keyRow.supplier_id,
    hardware_version: String(parsed.hardware_version).trim(),
    mac_address: String(parsed.mac_address).trim().toUpperCase(),
    firmware_mode: String(parsed.firmware_mode).trim(),
    product_model: parsed.product_model ? String(parsed.product_model).trim() : null,
    batch_no: parsed.batch_no ? String(parsed.batch_no).trim() : null,
    test_result: testResult,
    tested_at: testedAt,
    raw_payload: JSON.stringify(parsed),
  });

  dbUpdateApiKeyLastUsed(keyRow.id);
  return json({ ok: true, id: Number(id), tested_at: toISO8Shanghai(testedAt) });
}

// ---------------- admin API keys management ----------------

function apiAdminApiKeysList() {
  return json({ ok: true, keys: dbListApiKeys() });
}

function apiAdminApiKeysCreate(body) {
  const { supplier_id, name } = body || {};
  if (!supplier_id || !getSuppliersList().includes(supplier_id)) {
    return json({ ok: false, msg: '供应商无效，必须是预设供应商之一' }, 400);
  }
  if (!name || !name.trim()) return json({ ok: false, msg: '请填写 Key 名称' }, 400);
  const { full, hash, prefix } = generateApiKey();
  const id = dbInsertApiKey(supplier_id, name.trim(), hash, prefix);
  return json({ ok: true, id: Number(id), key: full });
}

function apiAdminApiKeysRevoke(body) {
  const { id } = body || {};
  if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
  const row = getDb().prepare('SELECT * FROM api_keys WHERE id=?').get(id);
  if (!row) return json({ ok: false, msg: 'Key 不存在' }, 404);
  dbRevokeApiKey(id);
  return json({ ok: true });
}

// ---------------- admin mainboard tests ----------------

function apiAdminMainboardTests(query) {
  try {
    return json({ ok: true, items: dbListMainboardTests(query) });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiAdminMainboardTestsExport(query) {
  const items = dbListMainboardTests(query);
  const wb = XLSX.utils.book_new();
  const sheetData = [
    ['ID', '测试时间', '供应商', 'MAC地址', '硬件版本', '固件Mode', '产品型号', '批次号', '测试结果'],
    ...items.map(r => [
      r.id,
      r.tested_at ? new Date(r.tested_at).toLocaleString('sv', { timeZone: 'Asia/Shanghai' }) : '',
      r.supplier_id, r.mac_address, r.hardware_version, r.firmware_mode,
      r.product_model || '', r.batch_no || '', r.test_result,
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, '主板测试记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fname = `雷石质量管理系统_主板测试_${ts}.xlsx`;
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    },
    body: buf,
  };
}

// ---------------- supplier mainboard tests ----------------

function apiSupplierMainboardTests(query, sess) {
  if (!sess.supplier) return json({ ok: false, msg: '账号未绑定供应商' }, 403);
  try {
    return json({ ok: true, items: dbListMainboardTests(query, sess.supplier) });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}

// ---------------- repair record APIs ----------------

function apiRepairSubmit(body, sess, kind) {
  if (sess.role !== 'supplier_repair' || !sess.supplier) {
    return json({ ok: false, msg: '当前账号不能填报' }, 403);
  }
  const f = body || {};

  if (f.vehicle_brand) {
    const brands = dbGetBoundBrandNames(sess.supplier);
    if (!brands.includes(f.vehicle_brand)) {
      return json({ ok: false, msg: '客户不在可选列表中' }, 400);
    }
  }
  if (f.repair_result && !REPAIR_RESULTS.includes(f.repair_result)) {
    return json({ ok: false, msg: '维修结果非法' }, 400);
  }

  let recordId;
  if (kind === 'repair_line') {
    if (f.discovery_stage && !DISCOVERY_STAGES.includes(f.discovery_stage)) {
      return json({ ok: false, msg: '不良发现环节非法' }, 400);
    }
    recordId = dbInsertRepairLine({
      supplier: sess.supplier,
      vehicle_brand: f.vehicle_brand || null,
      model: f.model || null,
      fault_symptom: f.fault_symptom || null,
      fault_cause: f.fault_cause || null,
      defective_part: f.defective_part || null,
      short_term_fix: f.short_term_fix || null,
      long_term_fix: f.long_term_fix || null,
      sn_whole: f.sn_whole || null,
      sn_part: f.sn_part || null,
      repair_date: f.repair_date || null,
      repair_result: f.repair_result || null,
      repair_person: f.repair_person || null,
      remarks: f.remarks || null,
      batch_no: f.batch_no || null,
      station: f.station || null,
      discovery_stage: f.discovery_stage || null,
    });
  } else {
    recordId = dbInsertRepairAftersales({
      supplier: sess.supplier,
      vehicle_brand: f.vehicle_brand || null,
      model: f.model || null,
      fault_symptom: f.fault_symptom || null,
      fault_cause: f.fault_cause || null,
      defective_part: f.defective_part || null,
      short_term_fix: f.short_term_fix || null,
      long_term_fix: f.long_term_fix || null,
      sn_whole: f.sn_whole || null,
      sn_part: f.sn_part || null,
      repair_date: f.repair_date || null,
      repair_result: f.repair_result || null,
      repair_person: f.repair_person || null,
      remarks: f.remarks || null,
      return_order_no: f.return_order_no || null,
      customer_feedback: f.customer_feedback || null,
      return_date: f.return_date || null,
      repair_complete_date: f.repair_complete_date || null,
      ship_date: f.ship_date || null,
      in_warranty: f.in_warranty || null,
    });
  }
  return json({ ok: true, id: Number(recordId) });
}

function apiRepairHistory(query, sess, kind) {
  if (sess.role !== 'supplier_repair' || !sess.supplier) {
    return json({ ok: false, msg: '当前账号无供应商数据视图' }, 403);
  }
  const rows = kind === 'repair_aftersales'
    ? dbListRepairAftersalesBySupplier(sess.supplier)
    : dbListRepairLineBySupplier(sess.supplier);
  // Attach file info
  const items = rows.map(r => {
    const atts = dbGetAttachments(kind, r.id);
    return { ...r, attachments: atts.map(a => ({ id: a.id, name: a.original_name, size: a.size })) };
  });
  return json({ ok: true, items });
}

function apiRepairUpload(parts, sess, kind) {
  if (sess.role !== 'supplier_repair' || !sess.supplier) {
    return json({ ok: false, msg: '当前账号不能上传' }, 403);
  }
  let recordId = null;
  const uploaded = [];

  for (const part of parts) {
    if (part.name === 'record_id' && !part.filename) {
      recordId = Number(part.data.toString('utf8').trim());
    }
  }
  if (!recordId) return json({ ok: false, msg: '缺少 record_id' }, 400);

  const rec = dbGetRepairRecord(kind, recordId);
  if (!rec || rec.deleted_at) return json({ ok: false, msg: '记录不存在' }, 404);
  if (rec.supplier !== sess.supplier) return json({ ok: false, msg: '无权操作' }, 403);

  for (const part of parts) {
    if (!part.filename) continue;
    if (part.data.length > MAX_UPLOAD_SIZE) {
      return json({ ok: false, msg: '文件过大(最大10MB)' }, 400);
    }
    const ext = nodePath.extname(part.filename).toLowerCase() || '.bin';
    const safeName = `${kind}_${recordId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const filePath = nodePath.join(UPLOAD_DIR, safeName);
    fs.writeFileSync(filePath, part.data);
    const attId = dbInsertAttachment(kind, recordId, safeName, part.filename, part.contentType, part.data.length);
    uploaded.push({ id: Number(attId), name: part.filename });
  }
  return json({ ok: true, uploaded });
}

function apiRepairAttachments(query) {
  const { record_type, record_id } = query;
  if (!record_type || !record_id) return json({ ok: false, msg: '缺少参数' }, 400);
  // 工作流附件必须走工作流专用接口，避免绕过工单归属校验。
  if (record_type === 'workflow_stage') return json({ ok: false, msg: '请使用工作流附件接口' }, 403);
  const atts = dbGetAttachments(record_type, Number(record_id));
  return json({ ok: true, attachments: atts.map(a => ({ id: a.id, name: a.original_name, size: a.size, mime: a.mime_type })) });
}

function apiRepairAttachmentDownload(query) {
  const { id } = query;
  if (!id) return { status: 400, headers: { 'Content-Type': 'text/plain' }, body: 'missing id' };
  const att = getDb().prepare('SELECT * FROM repair_attachments WHERE id=?').get(Number(id));
  if (!att) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found' };
  // 工作流附件有独立的供应商归属鉴权，禁止从旧下载接口旁路访问。
  if (att.record_type === 'workflow_stage') return json({ ok: false, msg: '请使用工作流附件接口' }, 403);
  const filePath = nodePath.join(UPLOAD_DIR, att.filename);
  if (!fs.existsSync(filePath)) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'file not found' };
  const data = fs.readFileSync(filePath);
  return {
    status: 200,
    headers: {
      'Content-Type': att.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.original_name)}`,
    },
    body: data,
  };
}

function apiAdminRepairRecords(query) {
  const kind = query.kind === 'repair_aftersales' ? 'repair_aftersales' : 'repair_line';
  try {
    const rows = dbAdminRepairRecords(kind, query);
    const items = rows.map(r => {
      const atts = dbGetAttachments(kind, r.id);
      return { ...r, attachments: atts.map(a => ({ id: a.id, name: a.original_name, size: a.size })) };
    });
    return json({ ok: true, items });
  } catch (e) {
    return json({ ok: false, msg: e.message }, 500);
  }
}

function apiAdminRepairEdit(body, sess) {
  const { kind, id, fields } = body || {};
  if (!kind || !id || !fields) return json({ ok: false, msg: '缺少参数' }, 400);
  const rec = dbGetRepairRecord(kind, id);
  if (!rec) return json({ ok: false, msg: '记录不存在' }, 404);
  if (rec.deleted_at) return json({ ok: false, msg: '记录已删除' }, 400);
  dbUpdateRepairRecord(kind, id, fields, sess.username);
  return json({ ok: true });
}

function apiAdminRepairDelete(body, sess) {
  const { kind, id } = body || {};
  if (!kind || !id) return json({ ok: false, msg: '缺少参数' }, 400);
  const rec = dbGetRepairRecord(kind, id);
  if (!rec) return json({ ok: false, msg: '记录不存在' }, 404);
  if (rec.deleted_at) return json({ ok: false, msg: '记录已删除' }, 400);
  dbSoftDeleteRepair(kind, id, sess.username);
  return json({ ok: true });
}

function apiAdminRepairExport(query) {
  const kind = query.kind === 'repair_aftersales' ? 'repair_aftersales' : 'repair_line';
  const rows = dbAdminRepairRecords(kind, query);

  const wb = XLSX.utils.book_new();
  let sheetData;

  const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : '';

  if (kind === 'repair_line') {
    sheetData = [
      ['ID', '供应商', '客户', '型号', '故障现象', '故障原因', '不良零部件', '短期解决办法',
       '长期解决办法', '整机SN码', '配件SN码', '维修日期', '维修结果', '维修人员', '备注',
       '生产批次号', '产线工位', '不良发现环节', '创建时间'],
      ...rows.map(r => [
        r.id, r.supplier, r.vehicle_brand, r.model, r.fault_symptom, r.fault_cause,
        r.defective_part, r.short_term_fix, r.long_term_fix, r.sn_whole, r.sn_part,
        r.repair_date, r.repair_result, r.repair_person, r.remarks,
        r.batch_no, r.station, r.discovery_stage, fmtTs(r.created_at),
      ]),
    ];
  } else {
    sheetData = [
      ['ID', '供应商', '客户', '型号', '故障现象', '故障原因', '不良零部件', '短期解决办法',
       '长期解决办法', '整机SN码', '配件SN码', '维修日期', '维修结果', '维修人员', '备注',
       '返修单号', '客户反馈描述', '寄回日期', '维修完成日期', '寄出日期', '是否在保', '创建时间'],
      ...rows.map(r => [
        r.id, r.supplier, r.vehicle_brand, r.model, r.fault_symptom, r.fault_cause,
        r.defective_part, r.short_term_fix, r.long_term_fix, r.sn_whole, r.sn_part,
        r.repair_date, r.repair_result, r.repair_person, r.remarks,
        r.return_order_no, r.customer_feedback, r.return_date,
        r.repair_complete_date, r.ship_date, r.in_warranty, fmtTs(r.created_at),
      ]),
    ];
  }

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const sheetName = kind === 'repair_line' ? '产线维修品' : '售后返修品';
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fname = `雷石质量管理系统_${sheetName}_${ts}.xlsx`;
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    },
    body: buf,
  };
}

// ---------------- login ----------------

async function apiLogin(body, ip) {
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    return json({ ok: false, msg: `登录失败次数过多,请 ${rl.retryAfter}s 后再试` }, 429);
  }
  const { username, password } = body || {};
  if (!username || !password) return json({ ok: false, msg: '缺少用户名或密码' }, 400);
  const user = await getUser(username);
  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
    await recordLoginFailure(ip);
    return json({ ok: false, msg: '用户名或密码错误' }, 401);
  }
  await clearLoginFailure(ip);
  const token = await createSession(user);
  const setCookie = buildCookie('sess', token, { maxAge: SESSION_TTL_SEC, sameSite: 'Lax' });
  return json(
    { ok: true, role: user.role, supplier: user.supplier, username: user.username, display_name: user.display_name },
    200,
    { 'Set-Cookie': setCookie },
  );
}

async function handleLogout(cookies, method) {
  const sess = cookies.sess;
  if (sess) await destroySession(sess);
  const clearCookie = buildCookie('sess', '', { maxAge: 0 });
  if (method === 'GET') {
    return htmlRedirect('/login', { 'Set-Cookie': clearCookie });
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie });
}

function htmlRedirect(location, extra = {}) {
  const safe = String(location).replace(/"/g, '&quot;');
  const body = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><script>location.replace(${JSON.stringify(location)})</script>`;
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra },
    body,
  };
}

// ---------------- response helpers ----------------

function json(obj, status = 200, extra = {}) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
    body: JSON.stringify(obj),
  };
}

function html(body, status = 200, extra = {}) {
  return {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra },
    body,
  };
}

// ---------------- pages ----------------

const ADMIN_NAV = (active, sessionOrRole) => {
  const role = typeof sessionOrRole === 'object' && sessionOrRole
    ? sessionOrRole.role
    : sessionOrRole;
  const username = typeof sessionOrRole === 'object' && sessionOrRole
    ? escapeHtml(sessionOrRole.display_name || sessionOrRole.username || '')
    : '';
  const roleLabel = role === 'super_admin' ? '超级管理员' : role === 'admin' ? '管理员' : role === 'dev' ? '开发人员' : '';
  const inProduction = ['workflow-manufacturing','mainboard-tests','ai','proto-boards','workflow-line-repair'].includes(active);
  const inSupplier = ['suppliers','bindings','supplier-data','supplier-modules'].includes(active);
  const inAfterSales = active === 'workflow-aftersales';
  const itemStyle = (selected, level) => `padding:${level === 1 ? '11px 20px' : level === 2 ? '7px 20px 7px 32px' : '6px 20px 6px 46px'};font-size:${level === 1 ? '14px' : '13px'};font-weight:${level === 1 ? '600' : '400'};text-decoration:none;display:block;${selected ? 'color:#2563eb;background:#eff6ff;border-left:3px solid #2563eb;' : 'color:#6b7280;border-left:3px solid transparent;'}`;
  const header = `<style>
  body > .admin-content, body > div > .admin-content { padding-top:112px !important; width:calc(100% - 220px) !important; box-sizing:border-box !important; }
  @media (max-width:720px) {
    .admin-shell-header h1 { font-size:20px !important; }
    .admin-shell-header > div:first-child { padding:0 16px !important; }
  }
  </style>
  <header class="admin-shell-header" style="position:fixed;top:0;left:0;right:0;height:96px;z-index:300;background:#fff;border-bottom:1px solid #e5e7eb;box-sizing:border-box;">
  <div style="height:56px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;">
    <h1 style="font-size:24px;line-height:1.25;font-weight:700;color:#111827;margin:0;">雷石质量管理系统 | 后台管理</h1>
    <div style="font-size:14px;color:#6b7280;">${roleLabel}${username ? ' ' + username : ''}${roleLabel || username ? ' · ' : ''}<a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a></div>
  </div>
  <div style="height:40px;" aria-hidden="true"></div>
</header>`;
  const workflowLinks = (type, stages, selected) => stages.map((name, i) =>
    `<a href="/admin/workflows?type=${type}&stage=${i}" style="${itemStyle(selected, 3)}">${name}</a>`).join('');
  const mainNav = `<nav style="position:fixed;top:96px;left:0;width:220px;height:calc(100vh - 96px);z-index:200;background:#fff;border-right:1px solid #e5e7eb;overflow-y:auto;box-sizing:border-box;"><div style="display:flex;flex-direction:column;padding:12px 0 16px;">
  <a href="/admin/dashboard" style="${itemStyle(active==='dashboard',1)}">首页</a>
  <a href="/admin/brands" style="${itemStyle(active==='brands',1)}">客户管理</a>
  <a href="/admin/suppliers" style="${itemStyle(inSupplier,1)}">供应商管理</a>
  ${inSupplier ? `<a href="/admin/suppliers" style="${itemStyle(active==='suppliers',2)}">新增供应商</a><a href="/admin/bindings" style="${itemStyle(active==='bindings',2)}">供应商绑定</a><a href="/admin/supplier-data" style="${itemStyle(active==='supplier-data',2)}">供应商数据</a>${active==='supplier-data' ? ['ffr:FFR数据','prod-form:生产填报','return-form:退机填报','prod-history:生产历史','return-history:退机历史'].map(x=>{const p=x.split(':');return `<a href="/admin/supplier-data#${p[0]}" style="${itemStyle(false,3)}">${p[1]}</a>`}).join('') : ''}<a href="/admin/supplier-modules" style="${itemStyle(active==='supplier-modules',2)}">模块配置</a>` : ''}
  <a href="/admin/workflows?type=manufacturing" style="${itemStyle(inProduction,1)}">生产管理</a>
  ${inProduction ? `<a href="/admin/workflows?type=manufacturing" style="${itemStyle(active==='workflow-manufacturing',2)}">制造执行</a>${active==='workflow-manufacturing' ? workflowLinks('manufacturing',WORKFLOW_TYPES.manufacturing.stages,true) : ''}<a href="/admin/mainboard-tests" style="${itemStyle(active==='mainboard-tests',2)}">测试记录</a><a href="/ai" style="${itemStyle(active==='ai',2)}">AI数据分析</a><a href="/admin/proto-boards" style="${itemStyle(active==='proto-boards',2)}">实验板管理</a><a href="/admin/workflows?type=line_repair" style="${itemStyle(active==='workflow-line-repair',2)}">产线维修品</a>` : ''}
  <a href="/admin/workflows?type=aftersales" style="${itemStyle(inAfterSales,1)}">售后管理</a>
  ${inAfterSales ? `<a href="/admin/workflows?type=aftersales" style="${itemStyle(true,2)}">售后返修品</a>${workflowLinks('aftersales',WORKFLOW_TYPES.aftersales.stages,true)}` : ''}
  <a href="/admin" style="${itemStyle(active==='users',1)}">用户管理</a>
  </div></nav>`;
  return header + mainNav + "\n<script>\n(function(){var IDLE_MS=30*60*1000,t;function reset(){clearTimeout(t);t=setTimeout(function(){alert('长时间未操作，请重新登录');location.href='/logout';},IDLE_MS)}['click','keydown','mousemove','scroll','touchstart'].forEach(function(e){document.addEventListener(e,reset,true)});reset()})();\n</script>";
};

function loginPage(msg = '') {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>登录 - 雷石质量管理系统</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
.login-btn-disabled {
  background-color: #cbd5e1;
  color: white;
  cursor: not-allowed;
  opacity: 0.6;
}
.login-btn-enabled {
  background-color: #3b82f6;
  color: white;
  cursor: pointer;
  transition: background-color 0.2s;
}
.login-btn-enabled:hover {
  background-color: #2563eb;
}
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body style="margin:0;padding:0;overflow:hidden;background:#1565c0;">
<canvas id="plexus" style="position:fixed;top:0;left:0;z-index:0;display:block;"></canvas>
<div style="position:relative;z-index:10;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;">
<div style="background:rgba(255,255,255,0.08);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.18);border-radius:1rem;padding:2rem;width:100%;max-width:360px;box-shadow:0 8px 40px rgba(0,0,0,0.4);">
  <h1 style="font-size:1.25rem;font-weight:600;margin-bottom:1.5rem;text-align:center;color:#fff;">雷石质量管理系统</h1>
  ${msg ? `<div class="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">${escapeHtml(msg)}</div>` : ''}
  <form id="f" class="space-y-3">
    <label class="block"><span style="font-size:0.875rem;color:#bfdbfe;">用户名</span>
      <input id="username" name="username" style="margin-top:0.25rem;width:100%;box-sizing:border-box;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);border-radius:0.75rem;padding:0.625rem 1rem;color:#fff;font-size:0.875rem;outline:none;" autofocus></label>
    <label class="block"><span style="font-size:0.875rem;color:#bfdbfe;">密码</span>
      <input id="password" name="password" type="password" style="margin-top:0.25rem;width:100%;box-sizing:border-box;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);border-radius:0.75rem;padding:0.625rem 1rem;color:#fff;font-size:0.875rem;outline:none;"></label>
    <div id="pwdHint" class="text-sm text-amber-600 min-h-[1em]"></div>
    <div id="msg" class="text-sm text-red-600 min-h-[1em]"></div>
    <button id="loginBtn" class="w-full login-btn-disabled py-2 rounded font-medium" type="submit" disabled>账号登录</button>
  </form>
  <a href="/auth/feishu" class="flex items-center justify-center w-full py-2.5 mb-4 hover:opacity-80 transition-opacity" title="飞书登录">
    <img src="/feishu-logo.jpg" alt="飞书登录" style="height:24px;width:auto;">
  </a>
</div>
<script>
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const pwdHint = document.getElementById('pwdHint');
const form = document.getElementById('f');

function validatePassword(pwd) {
  if (!pwd) return null;
  if (pwd.length < 8) return '密码至少8位';
  if (!/^[0-9]/.test(pwd) && !/[a-zA-Z]/.test(pwd)) {
    return '密码需包含数字或字母';
  }
  return null;
}

function updateButtonState() {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const pwdError = validatePassword(password);

  if (pwdError) {
    pwdHint.textContent = pwdError;
    pwdHint.style.color = '#b45309';
  } else if (password) {
    pwdHint.textContent = '';
  } else {
    pwdHint.textContent = '';
  }

  const canSubmit = username && password && !pwdError;
  loginBtn.disabled = !canSubmit;
  if (canSubmit) {
    loginBtn.classList.remove('login-btn-disabled');
    loginBtn.classList.add('login-btn-enabled');
  } else {
    loginBtn.classList.remove('login-btn-enabled');
    loginBtn.classList.add('login-btn-disabled');
  }
}

usernameInput.addEventListener('input', updateButtonState);
passwordInput.addEventListener('input', updateButtonState);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const body = { username: fd.get('username'), password: fd.get('password') };
  const msg = document.getElementById('msg');
  msg.textContent = '';

  const pwdErr = validatePassword(body.password);
  if (pwdErr) { msg.textContent = pwdErr; return; }
  if (!body.username || !body.password) { msg.textContent = '请输入用户名和密码'; return; }

  try {
    const r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) {
      location.href = (d.role === 'admin' || d.role === 'super_admin') ? '/admin/dashboard' : d.role === 'dev' ? '/admin/product-versions' : '/';
    } else {
      msg.textContent = d.msg || '登录失败';
    }
  } catch (err) { msg.textContent = '网络错误: ' + err.message; }
});
</script><script>
document.addEventListener('DOMContentLoaded', function() {
  // 为所有可能的日期输入初始化 flatpickr
  const allInputs = document.querySelectorAll('input[type="text"]');
  allInputs.forEach(input => {
    const id = input.id || '';
    const name = input.name || '';
    // 识别日期字段：包含 'date' 或 '日期' 的 id/name
    if (id.includes('日期') || id.includes('date') ||
        name.includes('date') || name.includes('日期') ||
        name === 'repair_date' || name === 'return_date' ||
        name === 'repair_complete_date' || name === 'ship_date') {
      try {
        flatpickr(input, window.fp_config);
      } catch(e) {
        console.error('Failed to init flatpickr for', id || name, e);
      }
    }
  });
});

</script>
</div>
<script>
(function(){
  function init(){
    var cv=document.getElementById('plexus');
    if(!cv){setTimeout(init,50);return;}
    var ctx=cv.getContext('2d');
    var W=window.innerWidth||1280;
    var H=window.innerHeight||720;
    cv.width=W;cv.height=H;
    var dpr=window.devicePixelRatio||1;
    if(dpr>1){cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+'px';cv.style.height=H+'px';ctx.scale(dpr,dpr);}

    // === Node definitions ===
    var centerNode={x:W/2,y:H/2,r:18,glow:30,pulse:0,label:'雷石'};
    var midNodes=[];
    var smallNodes=[];
    var connections=[];
    var flowParticles=[];
    var pulseWaves=[];
    var activePulses=[];
    var time=0;

    var midLabels=['供应商A','供应商B','供应商C','客户A','客户B','客户C','供应商D','客户D'];
    var midCount=8;
    var smallCount=18;

    function initNodes(){
      midNodes=[];smallNodes=[];connections=[];flowParticles=[];
      // Distribute mid nodes across full screen instead of just center circle
      var minMarginX=100, minMarginY=80;
      for(var i=0;i<midCount;i++){
        var randomX=minMarginX+Math.random()*(W-2*minMarginX);
        var randomY=minMarginY+Math.random()*(H-2*minMarginY);
        midNodes.push({
          x:randomX,
          y:randomY,
          baseX:randomX,
          baseY:randomY,
          r:7,glow:12,
          angle:0,dist:0,
          drift:Math.random()*Math.PI*2,
          driftSpeed:0.003+Math.random()*0.004,
          driftAmp:8+Math.random()*6,
          label:midLabels[i]||'节点'
        });
      }
      // Distribute small nodes across entire canvas
      for(var i=0;i<smallCount;i++){
        smallNodes.push({
          x:Math.random()*W,
          y:Math.random()*H,
          vx:(Math.random()-0.5)*0.3,
          vy:(Math.random()-0.5)*0.3,
          r:3,glow:6
        });
      }
      // connections: center<->mid, mid<->some small
      for(var i=0;i<midCount;i++){
        connections.push({from:'mid',fi:i,to:'center',ti:0});
      }
      for(var i=0;i<smallCount;i++){
        var nearest=0,minD=1e9;
        for(var j=0;j<midCount;j++){
          var dx=smallNodes[i].x-midNodes[j].baseX;
          var dy=smallNodes[i].y-midNodes[j].baseY;
          var d=dx*dx+dy*dy;
          if(d<minD){minD=d;nearest=j;}
        }
        connections.push({from:'small',fi:i,to:'mid',ti:nearest});
      }
      // init flow particles on each connection
      for(var i=0;i<connections.length;i++){
        var count=connections[i].from==='mid'?3:2;
        for(var j=0;j<count;j++){
          flowParticles.push({
            connIdx:i,
            t:Math.random(),
            speed:0.003+Math.random()*0.004,
            size:connections[i].from==='mid'?2.5:1.8,
            brightness:0.7+Math.random()*0.3
          });
        }
      }
    }

    function getConnEndpoints(c){
      var sx,sy,ex,ey;
      if(c.from==='mid'){sx=midNodes[c.fi].x;sy=midNodes[c.fi].y;}
      else{sx=smallNodes[c.fi].x;sy=smallNodes[c.fi].y;}
      if(c.to==='center'){ex=centerNode.x;ey=centerNode.y;}
      else{ex=midNodes[c.ti].x;ey=midNodes[c.ti].y;}
      return{sx:sx,sy:sy,ex:ex,ey:ey};
    }

    function drawBackground(){
      var gr=ctx.createRadialGradient(W/2,H/2,0,W/2,H/2,Math.max(W,H)*0.75);
      gr.addColorStop(0,'#0a2463');
      gr.addColorStop(0.5,'#0d3b8e');
      gr.addColorStop(1,'#061539');
      ctx.fillStyle=gr;ctx.fillRect(0,0,W,H);
    }

    function drawConnections(){
      for(var i=0;i<connections.length;i++){
        var c=connections[i];
        var ep=getConnEndpoints(c);
        var isMidConn=c.from==='mid';
        ctx.beginPath();
        ctx.moveTo(ep.sx,ep.sy);
        ctx.lineTo(ep.ex,ep.ey);
        ctx.strokeStyle=isMidConn?'rgba(100,180,255,0.25)':'rgba(100,180,255,0.12)';
        ctx.lineWidth=isMidConn?1.5:0.8;
        ctx.stroke();
      }
    }

    function drawFlowParticles(){
      for(var i=0;i<flowParticles.length;i++){
        var fp=flowParticles[i];
        var c=connections[fp.connIdx];
        var ep=getConnEndpoints(c);
        // flow direction: from source toward target (toward center)
        var t=fp.t;
        var px=ep.sx+(ep.ex-ep.sx)*t;
        var py=ep.sy+(ep.ey-ep.sy)*t;
        ctx.beginPath();
        ctx.arc(px,py,fp.size,0,Math.PI*2);
        var alpha=fp.brightness*(0.5+0.5*Math.sin(time*3+i));
        ctx.fillStyle='rgba(200,230,255,'+Math.min(1,alpha).toFixed(2)+')';
        ctx.shadowColor='rgba(150,210,255,0.8)';
        ctx.shadowBlur=8;
        ctx.fill();
        ctx.shadowBlur=0;
        fp.t+=fp.speed;
        if(fp.t>1)fp.t=0;
      }
    }

    function drawNode(x,y,r,glowR,color,glowColor){
      // outer glow
      ctx.beginPath();
      ctx.arc(x,y,glowR,0,Math.PI*2);
      var gr=ctx.createRadialGradient(x,y,r*0.5,x,y,glowR);
      gr.addColorStop(0,glowColor||'rgba(100,180,255,0.4)');
      gr.addColorStop(1,'rgba(100,180,255,0)');
      ctx.fillStyle=gr;ctx.fill();
      // core
      ctx.beginPath();
      ctx.arc(x,y,r,0,Math.PI*2);
      ctx.fillStyle=color||'rgba(200,230,255,0.95)';
      ctx.shadowColor='rgba(120,200,255,0.9)';
      ctx.shadowBlur=r*2;
      ctx.fill();
      ctx.shadowBlur=0;
    }

    function drawCenterNode(){
      var pulseFactor=1+0.08*Math.sin(time*1.5);
      var r=centerNode.r*pulseFactor;
      var glowR=centerNode.glow*pulseFactor;
      // large outer halo
      ctx.beginPath();
      ctx.arc(centerNode.x,centerNode.y,glowR*2,0,Math.PI*2);
      var gr2=ctx.createRadialGradient(centerNode.x,centerNode.y,r,centerNode.x,centerNode.y,glowR*2);
      gr2.addColorStop(0,'rgba(80,160,255,0.15)');
      gr2.addColorStop(1,'rgba(80,160,255,0)');
      ctx.fillStyle=gr2;ctx.fill();
      drawNode(centerNode.x,centerNode.y,r,glowR,'rgba(220,240,255,1)','rgba(80,170,255,0.5)');
    }

    function drawMidNodes(){
      for(var i=0;i<midCount;i++){
        var n=midNodes[i];
        // drift animation
        n.drift+=n.driftSpeed;
        n.x=n.baseX+Math.cos(n.drift)*n.driftAmp;
        n.y=n.baseY+Math.sin(n.drift*0.7)*n.driftAmp*0.6;
        var pf=1+0.05*Math.sin(time*2+i);
        drawNode(n.x,n.y,n.r*pf,n.glow*pf,'rgba(180,220,255,0.9)','rgba(80,160,255,0.3)');
      }
    }

    function drawSmallNodes(){
      for(var i=0;i<smallCount;i++){
        var n=smallNodes[i];
        n.x+=n.vx;n.y+=n.vy;
        // soft boundary bounce
        var margin=50;
        if(n.x<margin){n.x=margin;n.vx*=-1;}
        if(n.x>W-margin){n.x=W-margin;n.vx*=-1;}
        if(n.y<margin){n.y=margin;n.vy*=-1;}
        if(n.y>H-margin){n.y=H-margin;n.vy*=-1;}
        // gentle pull toward assigned mid node
        var c=connections.find(function(cc){return cc.from==='small'&&cc.fi===i;});
        if(c){
          var mid=midNodes[c.ti];
          var dx=mid.x-n.x,dy=mid.y-n.y;
          var dist=Math.sqrt(dx*dx+dy*dy);
          var maxDist=Math.min(W,H)*0.3;
          if(dist>maxDist){n.vx+=dx*0.0002;n.vy+=dy*0.0002;}
        }
        drawNode(n.x,n.y,n.r,n.glow,'rgba(160,210,255,0.8)','rgba(80,160,255,0.2)');
      }
    }

    function drawPulseWaves(){
      // center radiation pulse
      for(var i=pulseWaves.length-1;i>=0;i--){
        var pw=pulseWaves[i];
        pw.r+=1.5;
        pw.alpha-=0.008;
        if(pw.alpha<=0){pulseWaves.splice(i,1);continue;}
        ctx.beginPath();
        ctx.arc(centerNode.x,centerNode.y,pw.r,0,Math.PI*2);
        ctx.strokeStyle='rgba(120,200,255,'+pw.alpha.toFixed(3)+')';
        ctx.lineWidth=2;
        ctx.stroke();
      }
    }

    function drawActivePulse(){
      for(var i=activePulses.length-1;i>=0;i--){
        var ap=activePulses[i];
        ap.t+=0.015;
        if(ap.t>1){activePulses.splice(i,1);continue;}
        var c=connections[ap.connIdx];
        var ep=getConnEndpoints(c);
        // bright sweep along connection
        var px=ep.sx+(ep.ex-ep.sx)*ap.t;
        var py=ep.sy+(ep.ey-ep.sy)*ap.t;
        ctx.beginPath();
        ctx.arc(px,py,5,0,Math.PI*2);
        var alpha=0.9*(1-ap.t);
        ctx.fillStyle='rgba(200,240,255,'+alpha.toFixed(2)+')';
        ctx.shadowColor='rgba(150,220,255,1)';
        ctx.shadowBlur=20;
        ctx.fill();
        ctx.shadowBlur=0;
        // trail
        var trail=0.08;
        for(var j=1;j<=3;j++){
          var tt=ap.t-trail*j;
          if(tt<0)continue;
          var tx=ep.sx+(ep.ex-ep.sx)*tt;
          var ty=ep.sy+(ep.ey-ep.sy)*tt;
          ctx.beginPath();
          ctx.arc(tx,ty,3,0,Math.PI*2);
          ctx.fillStyle='rgba(180,230,255,'+(alpha*0.4/j).toFixed(2)+')';
          ctx.fill();
        }
      }
    }

    var lastPulseTime=0;
    var lastWaveTime=0;

    function draw(){
      try{
        time+=0.016;
        drawBackground();
        drawConnections();
        drawFlowParticles();
        drawSmallNodes();
        drawMidNodes();
        drawCenterNode();
        drawPulseWaves();
        drawActivePulse();

        // periodic active pulse on random connection (every 3-5s)
        if(time-lastPulseTime>3+Math.random()*2){
          lastPulseTime=time;
          var idx=Math.floor(Math.random()*connections.length);
          activePulses.push({connIdx:idx,t:0});
        }
        // center radiation wave (every 4-6s)
        if(time-lastWaveTime>4+Math.random()*2){
          lastWaveTime=time;
          pulseWaves.push({r:centerNode.r,alpha:0.35});
        }
      }catch(e){}
      requestAnimationFrame(draw);
    }

    initNodes();draw();
    window.addEventListener('resize',function(){
      W=window.innerWidth||1280;
      H=window.innerHeight||720;
      cv.width=W*(dpr>1?dpr:1);cv.height=H*(dpr>1?dpr:1);
      cv.style.width=W+'px';cv.style.height=H+'px';
      if(dpr>1){ctx.scale(dpr,dpr);}
      centerNode.x=W/2;centerNode.y=H/2;
      initNodes();
    });
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  }else{
    init();
  }
})();

</script></body></html>`;
}

function appPage(sess) {
  const safe = escapeHtml(sess.supplier || '');
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>雷石质量管理系统 - ${safe}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background-color:#f0f0f0}
.prod-card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,0.07);overflow:hidden;transition:box-shadow 0.2s;}
.prod-card:hover{box-shadow:0 4px 16px rgba(0,0,0,0.12);}
.filter-tab{color:#9ca3af;font-size:15px;cursor:pointer;padding:4px 0;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;font-family:inherit;}
.filter-tab.active{color:#111827;border-bottom-color:#111827;}
</style>
</head><body class="min-h-screen">
<div style="max-width:1100px;margin:0 auto;padding:24px 24px 40px;">
  <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:32px;">
    <h1 style="font-size:20px;font-weight:700;color:#111827;margin:0;">雷石质量管理系统</h1>
    <div style="display:flex;align-items:center;gap:16px;font-size:14px;color:#6b7280;">
      <span>账号: <b style="color:#111827;">${uname}</b> / 供应商: <b style="color:#111827;">${safe}</b></span>
      <a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a>
    </div>
  </header>
  ${supplierWorkflowNav(sess, '')}
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:20px;">
      <button class="filter-tab active" onclick="setFilter(this,'all')">全部</button>
      <span style="color:#e5e7eb;">|</span>
      <button class="filter-tab" onclick="setFilter(this,'active')">在产</button>
      <span style="color:#e5e7eb;">|</span>
      <button class="filter-tab" onclick="setFilter(this,'inactive')">停产</button>
    </div>
    <div style="position:relative;">
      <input id="search-input" type="text" placeholder="" oninput="filterCards()" style="border:1px solid #e5e7eb;border-radius:6px;padding:6px 32px 6px 12px;font-size:14px;outline:none;width:180px;background:#fff;">
      <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#9ca3af;">&#128269;</span>
    </div>
  </div>
  <div id="products-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
    <div style="color:#9ca3af;text-align:center;padding:48px;grid-column:1/-1;">加载中...</div>
  </div>
</div>
<script>
async function loadProducts() {
  const grid = document.getElementById('products-grid');
  try {
    const prodResp = await fetch('/api/products');
    if (prodResp.status === 401) { location.href = '/login'; return; }
    const data = await prodResp.json();
    if (!data.ok) { grid.innerHTML = '<div style="color:#ef4444;text-align:center;padding:48px;grid-column:1/-1">\u52a0\u8f7d\u5931\u8d25</div>'; return; }
    const products = data.products;
    if (!products.length) {
      grid.innerHTML = '<div style="color:#94a3b8;text-align:center;padding:48px;grid-column:1/-1">\u6682\u65e0\u4ea7\u54c1\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458</div>';
      return;
    }
    let ffrMap = {};
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(function(){ ctrl.abort(); }, 5000);
      const ffrResp = await fetch('/api/supplier/ffr', { signal: ctrl.signal });
      clearTimeout(tid);
      if (ffrResp.ok) {
        const ffrData = await ffrResp.json();
        if (ffrData.ok && ffrData.items) {
          ffrData.items.forEach(function(item){ ffrMap[item.model] = item; });
        }
      }
    } catch(ffrErr) {}
    grid.innerHTML = products.map(function(p) {
      var imgHtml = p.image_path
        ? '<img src="' + p.image_path.replace(/"/g,'&quot;') + '" alt="' + (p.model_name||'').replace(/"/g,'&quot;') + '" style="width:100%;height:200px;object-fit:contain;background:#ffffff;">'
        : '<div style="width:100%;height:200px;background:#ffffff;display:flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:2rem;">&#128247;</div>';
      var stats = ffrMap[p.model_code || p.model_name] || ffrMap[p.model_name];
      var prodQty = stats ? stats.prod_qty : '-';
      var retQty = stats ? stats.return_qty : '-';
      var ffrVal = (stats && stats.prod_qty > 0) ? stats.ffr : null;
      var ffrStr = ffrVal !== null ? ffrVal.toFixed(2) + '%' : '-';
      var ffrValStyle = (ffrVal !== null && ffrVal > 0.2) ? 'color:#dc2626;font-weight:600' : '';
      return '<div class="prod-card" data-name="' + (p.model_name||'').replace(/"/g,'&quot;') + '" data-status="' + (p.status||'active') + '">'
        + '<div style="padding:20px 20px 12px;">'
        + '<h3 style="font-size:17px;font-weight:700;color:#111827;margin:0 0 4px 0;line-height:1.3;">' + (p.model_name||'').replace(/</g,'&lt;') + '</h3>'
        + ((p.model_code && p.model_code !== p.model_name) ? '<div style="font-size:12px;color:#9ca3af;margin-bottom:8px;">\u578b\u53f7: ' + (p.model_code||'').replace(/</g,'&lt;') + '</div>' : '<div style="margin-bottom:8px;"></div>')
        + '</div>'
        + imgHtml
        + '<div style="padding:14px 20px 18px;">'
        + '<div style="font-size:12px;color:#9ca3af;margin-bottom:10px;white-space:nowrap;">'
        + '\u751f\u4ea7: ' + prodQty + '&nbsp;&nbsp;&nbsp;\u9000\u673a: ' + retQty + '&nbsp;&nbsp;&nbsp;FFR: <span style="' + ffrValStyle + '">' + ffrStr + '</span>'
        + '</div>'
        + '<div style="display:flex;gap:12px;margin-top:2px;">'
        + '<a href="/supplier/prod?model=' + encodeURIComponent(p.model_code || p.model_name) + '&brand=' + encodeURIComponent(p.vehicle_brand||'') + '" style="color:#2563eb;font-size:13px;text-decoration:none;font-weight:500;">\u751f\u4ea7\u586b\u62a5 &rarr;</a>'
        + '<a href="/supplier/return?model=' + encodeURIComponent(p.model_code || p.model_name) + '&brand=' + encodeURIComponent(p.vehicle_brand||'') + '" style="color:#2563eb;font-size:13px;text-decoration:none;font-weight:500;">\u9000\u673a\u586b\u62a5 &rarr;</a>'
        + '</div>'
        + '</div>'
        + '</div>';
    }).join('');
  } catch(e) { grid.innerHTML = '<div style="color:#ef4444;text-align:center;padding:48px;grid-column:1/-1">\u7f51\u7edc\u9519\u8bef: ' + e.message + '</div>'; }
}
loadProducts();

var _currentFilter = 'all';
function setFilter(btn, f) {
  _currentFilter = f;
  document.querySelectorAll('.filter-tab').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  filterCards();
}
function filterCards() {
  var q = (document.getElementById('search-input').value || '').toLowerCase();
  document.querySelectorAll('.prod-card').forEach(function(card) {
    var name = (card.dataset.name || '').toLowerCase();
    var status = card.dataset.status || 'active';
    var matchSearch = !q || name.indexOf(q) >= 0;
    var matchFilter = _currentFilter === 'all' || _currentFilter === status;
    card.style.display = (matchSearch && matchFilter) ? '' : 'none';
  });
}
</script></body></html>`;
}

// Supplier sub-page: Production
function supplierProdPage(sess, query) {
  const safe = escapeHtml(sess.supplier || '');
  const uname = escapeHtml(sess.display_name || sess.username);
  const modelParam = escapeHtml(query.model || '');
  const brandParam = escapeHtml(query.brand || '');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>生产填报 | ${modelParam} - 雷石质量管理系统</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#fff}
.form-label{display:block;font-size:14px;font-weight:500;color:#111;margin-bottom:6px;}
.form-label .req{color:#111;}
.form-input{display:block;width:100%;box-sizing:border-box;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;font-size:14px;font-family:inherit;outline:none;}
.form-input:focus{border-color:#2563eb;}
.form-input[readonly]{background:#ffffff;cursor:not-allowed;}
.form-input.err{border-color:#ef4444;}
.tab-btn{padding:10px 16px;font-size:14px;font-weight:500;border:none;background:none;cursor:pointer;color:#6b7280;border-bottom:2px solid transparent;}
.tab-btn.active{color:#2563eb;border-bottom-color:#2563eb;}
.err-msg{display:none;font-size:12px;color:#ef4444;margin-top:4px;}
</style>
<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>window.fp_config={enableTime:false,dateFormat:'Y-m-d',locale:'zh',monthSelectorType:'static',allowInput:true,disableMobile:true};</script>
</head><body class="min-h-screen">
<div style="max-width:900px;margin:0 auto;padding:24px;">
  <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
    <h1 style="font-size:20px;font-weight:700;color:#111;margin:0;">生产填报 | ${modelParam}</h1>
    <div style="display:flex;align-items:center;gap:16px;font-size:14px;color:#6b7280;">
      <a href="/" style="color:#2563eb;text-decoration:none;">&larr; 返回</a>
      <span>账号: <b style="color:#111;">${uname}</b> / 供应商: <b style="color:#111;">${safe}</b></span>
      <a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a>
    </div>
  </header>
  <div id="msg" style="display:none;padding:10px 16px;border-radius:6px;margin-bottom:16px;"></div>
  <div style="border-bottom:1px solid #e5e7eb;margin-bottom:24px;display:flex;gap:0;">
    <button class="tab-btn active" data-tab="submit">填报</button>
    <button class="tab-btn" data-tab="history">历史记录</button>
  </div>
  <div id="tab-submit">
    <form id="form-prod">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px 24px;margin-bottom:16px;">
        <!-- Row 1: 日期 | 订单号 -->
        <div>
          <label class="form-label"><span class="req">*</span>日期</label>
          <input id="prod-日期" name="日期" type="text" placeholder="YYYY-MM-DD" autocomplete="off" class="form-input">
          <div class="err-msg" id="err-日期">请选择日期</div>
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>订单号</label>
          <input id="prod-订单号" name="订单号" type="text" class="form-input" placeholder="请输入订单号">
          <div class="err-msg" id="err-订单号">订单号不能为空</div>
        </div>
        <!-- Row 2: 客户（只读）| 型号（只读）-->
        <div>
          <label class="form-label"><span class="req">*</span>客户</label>
          <input id="prod-车企-input" name="车企" value="${brandParam}" class="form-input" style="background:#ffffff;cursor:not-allowed;" readonly>
          <div class="err-msg" id="err-车企">请填写客户</div>
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>型号</label>
          <input id="prod-机型" name="机型" value="${modelParam}" readonly class="form-input" style="background:#ffffff;cursor:not-allowed;">
        </div>
        <!-- Row 3: 内部型号 | 订单数量 -->
        <div>
          <label class="form-label"><span class="req">*</span>内部型号</label>
          <input id="prod-生产批次" name="生产批次" class="form-input" placeholder="请输入内部型号">
          <div class="err-msg" id="err-生产批次">内部型号不能为空</div>
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>订单数量</label>
          <input id="prod-计划数量" name="计划数量" type="number" min="0" class="form-input" placeholder="请输入订单数量">
          <div class="err-msg" id="err-计划数量">订单数量不能为空</div>
        </div>
        <!-- Row 4: 交付数量 | 验货报告 -->
        <div>
          <label class="form-label"><span class="req">*</span>交付数量</label>
          <input id="prod-实际产出" name="实际产出" type="number" min="0" class="form-input" placeholder="请输入交付数量">
          <div class="err-msg" id="err-实际产出">交付数量不能为空</div>
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>验货报告</label>
          <input id="prod-report" name="验货报告" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg" multiple class="form-input" style="padding:8px 12px;">
          <div class="err-msg" id="err-report">请上传验货报告</div>
        </div>
      </div>
      <!-- Row 5: 备注（全宽）-->
      <div style="margin-bottom:24px;">
        <label class="form-label">备注</label>
        <textarea id="prod-备注" name="备注" class="form-input" rows="3" style="resize:vertical;" placeholder="选填，如有补充说明请填写"></textarea>
      </div>
      <div style="display:flex;align-items:center;gap:16px;">
        <button type="submit" id="prod-submit-btn" style="background:#f97316;color:#fff;border:none;border-radius:6px;padding:10px 32px;font-size:15px;font-weight:600;cursor:pointer;">提交</button>
        <span id="prod-dup-err" style="display:none;color:#ef4444;font-size:13px;"></span>
      </div>
    </form>
  </div>
  <div id="tab-history" style="display:none;">
    <div style="overflow:auto;"><div id="table-prod">加载中...</div></div>
  </div>
</div>
<script>
let fpRetries = 0;
(function initFP() {
  fpRetries++;
  if (!window.flatpickr || !window.fp_config) { if (fpRetries < 50) setTimeout(initFP, 100); return; }
  try { flatpickr(document.getElementById('prod-日期'), window.fp_config); } catch(e) {}
})();

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.style.display = 'block';
  el.style.background = ok ? '#dcfce7' : '#fee2e2';
  el.style.color = ok ? '#166534' : '#991b1b';
  el.textContent = text;
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('tab-submit').style.display = name === 'submit' ? '' : 'none';
  document.getElementById('tab-history').style.display = name === 'history' ? '' : 'none';
  if (name === 'history') loadHistory();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function clearErrors() {
  document.querySelectorAll('.form-input').forEach(el => el.classList.remove('err'));
  document.querySelectorAll('.err-msg').forEach(el => el.style.display = 'none');
  var dup = document.getElementById('prod-dup-err'); if(dup) dup.style.display = 'none';
}
function showFieldErr(fieldId, errId) {
  var el = document.getElementById(fieldId); if(el) el.classList.add('err');
  var ee = document.getElementById(errId); if(ee) ee.style.display = 'block';
}

document.getElementById('form-prod').addEventListener('submit', async function(e) {
  e.preventDefault();
  clearErrors();
  var hasErr = false;
  function chk(id, errId) {
    var el = document.getElementById(id);
    if (!el || !(el.value||'').trim()) { showFieldErr(id, errId); hasErr = true; }
  }
  chk('prod-日期', 'err-日期');
  chk('prod-订单号', 'err-订单号');
  var brandInp = document.getElementById('prod-车企-input');
  if (!brandInp || !(brandInp.value||'').trim()) { showFieldErr('prod-车企-input','err-车企'); hasErr = true; }
  chk('prod-生产批次', 'err-生产批次');
  chk('prod-计划数量', 'err-计划数量');
  chk('prod-实际产出', 'err-实际产出');
  var repInp = document.getElementById('prod-report');
  if (!repInp || !repInp.files || repInp.files.length === 0) { showFieldErr('prod-report','err-report'); hasErr = true; }
  if (hasErr) return;

  var submitBtn = document.getElementById('prod-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '提交中...'; }

  var fields = {};
  fields['日期'] = (document.getElementById('prod-日期').value || '').trim();
  fields['订单号'] = (document.getElementById('prod-订单号').value || '').trim();
  fields['车企'] = (brandInp.value || '').trim();
  fields['机型'] = (document.getElementById('prod-机型').value || '').trim();
  fields['生产批次'] = (document.getElementById('prod-生产批次').value || '').trim();
  fields['计划数量'] = document.getElementById('prod-计划数量').value;
  fields['实际产出'] = document.getElementById('prod-实际产出').value;
  var notesEl = document.getElementById('prod-备注');
  if (notesEl && notesEl.value.trim()) fields['备注'] = notesEl.value.trim();

  try {
    var resp = await fetch('/api/submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: 'prod', fields }) });
    if (resp.status === 401) { location.href = '/login'; return; }
    var data = await resp.json();
    if (data.ok) {
      if (repInp && repInp.files && repInp.files.length > 0) {
        var ufd = new FormData();
        ufd.append('record_id', String(data.id));
        for (var f of repInp.files) ufd.append('file', f);
        try { await fetch('/api/supplier/prod-upload', { method: 'POST', body: ufd }); } catch(ue) {}
      }
      showMsg('提交成功 ID: ' + data.id, true);
      this.reset();
      document.getElementById('prod-机型').value = ${JSON.stringify(query.model || '')};
      document.getElementById('prod-车企-input').value = ${JSON.stringify(brandParam)};
    } else if (data.duplicate) {
      var dup = document.getElementById('prod-dup-err');
      if(dup) { dup.textContent = data.msg || '该记录已存在'; dup.style.display = 'inline'; }
    } else { showMsg('提交失败: ' + data.msg, false); }
  } catch(err) { showMsg('网络错误: ' + err.message, false); }
  finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '提交'; } }
});

async function loadHistory() {
  var mount = document.getElementById('table-prod');
  mount.textContent = '加载中...';
  try {
    var modelFilter = document.getElementById('prod-机型') ? document.getElementById('prod-机型').value : '';
    var resp = await fetch('/api/history?kind=prod' + (modelFilter ? '&model=' + encodeURIComponent(modelFilter) : ''));
    if (resp.status === 401) { location.href = '/login'; return; }
    var data = await resp.json();
    if (!data.ok) { mount.textContent = '加载失败: ' + data.msg; return; }
    var items = data.items;
    if (!items.length) { mount.textContent = '暂无数据'; return; }
    var cols = ['date','order_number','vehicle_brand','model','batch','plan_qty','actual_qty','notes'];
    var labels = ['日期','订单号','客户','型号','内部型号','订单数量','交付数量','备注'];
    var html = '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f9fafb;">';
    html += labels.map(function(c){ return '<th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">'+c+'</th>'; }).join('');
    html += '<th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">验货报告</th>';
    html += '</tr></thead><tbody>';
    for (var it of items) {
      html += '<tr style="border-bottom:1px solid #f3f4f6;">';
      for (var c of cols) {
        var v = it[c];
        html += '<td style="padding:8px 12px;vertical-align:top;">' + (v == null ? '' : String(v).replace(/</g,'&lt;')) + '</td>';
      }
      var atts = it.attachments || [];
      if (atts.length) {
        html += '<td style="padding:8px 12px;vertical-align:top;">' + atts.map(function(a){ return '<a href="/api/repair/attachment/download?id=' + a.id + '" target="_blank" style="display:inline-block;margin-right:4px;margin-bottom:2px;color:#2563eb;text-decoration:underline;font-size:12px;">' + String(a.name).replace(/</g,'&lt;') + '</a>'; }).join('') + '</td>';
      } else {
        html += '<td style="padding:8px 12px;vertical-align:top;color:#9ca3af;">无</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    mount.innerHTML = html;
  } catch(e) { mount.textContent = '网络错误: ' + e.message; }
}
</script></body></html>`;
}
// Supplier sub-page: Return
function supplierReturnPage(sess, query) {
  const safe = escapeHtml(sess.supplier || '');
  const uname = escapeHtml(sess.display_name || sess.username);
  const modelParam = escapeHtml(query.model || '');
  const brandParam = escapeHtml(query.brand || '');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>售后退机 - ${modelParam} - 雷石质量管理系统</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#fff}
.form-label{display:block;font-size:14px;font-weight:500;color:#111;margin-bottom:6px;}
.form-label .req{color:#111;}
.form-input{display:block;width:100%;box-sizing:border-box;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;font-size:14px;font-family:inherit;outline:none;}
.form-input:focus{border-color:#2563eb;}
.form-input[readonly]{background:#ffffff;cursor:not-allowed;}
.tab-btn{padding:10px 16px;font-size:14px;font-weight:500;border:none;background:none;cursor:pointer;color:#6b7280;border-bottom:2px solid transparent;}
.tab-btn.active{color:#2563eb;border-bottom-color:#2563eb;}
</style>
<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>window.fp_config={enableTime:false,dateFormat:'Y-m-d',locale:'zh',monthSelectorType:'static',allowInput:true,disableMobile:true};</script>
</head><body class="min-h-screen">
<div style="max-width:900px;margin:0 auto;padding:24px;">
  <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
    <h1 style="font-size:20px;font-weight:700;color:#111;margin:0;">售后退机 | ${modelParam}</h1>
    <div style="display:flex;align-items:center;gap:16px;font-size:14px;color:#6b7280;">
      <a href="/" style="color:#2563eb;text-decoration:none;">&larr; 返回</a>
      <span>账号: <b style="color:#111;">${uname}</b> / 供应商: <b style="color:#111;">${safe}</b></span>
      <a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a>
    </div>
  </header>
  <div id="msg" style="display:none;padding:10px 16px;border-radius:6px;margin-bottom:16px;"></div>
  <div style="border-bottom:1px solid #e5e7eb;margin-bottom:24px;display:flex;gap:0;">
    <button class="tab-btn active" data-tab="submit">填报</button>
    <button class="tab-btn" data-tab="history">历史记录</button>
  </div>
  <div id="tab-submit">
    <form id="form-return">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px 24px;margin-bottom:16px;">
        <div>
          <label class="form-label"><span class="req">*</span>日期</label>
          <input name="日期" type="text" autocomplete="off" required class="form-input" placeholder="YYYY-MM-DD">
        </div>
        <div>
          <label class="form-label"><span class="req">*</span> 型号</label>
          <input name="型号" value="${modelParam}" readonly class="form-input">
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>客户</label>
          <input name="车企" value="${brandParam}" readonly class="form-input" style="background:#ffffff;">
        </div>
        <div>
          <label class="form-label"><span class="req">*</span> 批次</label>
          <input name="批次" class="form-input" required>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:12px 16px;margin-bottom:16px;">
        <div>
          <label class="form-label"><span class="req">*</span> 退机数量</label>
          <input name="退机数量" type="number" min="0" required class="form-input">
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>故障数量</label>
          <input name="故障数量" type="number" min="0" class="form-input">
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>人为数量</label>
          <input name="人为数量" type="number" min="0" class="form-input">
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>NTF数量</label>
          <input name="NTF数量" type="number" min="0" class="form-input">
        </div>
        <div>
          <label class="form-label"><span class="req">*</span>七无数量</label>
          <input name="七无数量" type="number" min="0" class="form-input">
        </div>
      </div>
      <div style="margin-bottom:24px;">
        <label class="form-label">上传维修记录/报告 <span style="font-weight:400;color:#6b7280;font-size:12px;">（可选，支持 PDF/Word/Excel/JPG，可多选）</span></label>
        <input id="return-file-input" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg" multiple class="form-input" style="padding:8px 12px;">
        <div id="return-file-list" style="margin-top:6px;font-size:13px;color:#374151;"></div>
      </div>
      <button type="submit" style="background:#f97316;color:#fff;border:none;border-radius:6px;padding:10px 32px;font-size:15px;font-weight:500;cursor:pointer;">提交</button>
    </form>
  </div>
  <div id="tab-history" style="display:none;">
    <div style="overflow:auto;"><div id="table-return">加载中...</div></div>
  </div>
</div>
<script>
let fpRetries = 0;
(function initFP() {
  fpRetries++;
  if (!window.flatpickr || !window.fp_config) { if (fpRetries < 50) setTimeout(initFP, 100); return; }
  document.querySelectorAll('input[name="日期"]').forEach(input => {
    try { flatpickr(input, window.fp_config); } catch(e) {}
  });
})();

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.style.display = 'block';
  el.style.background = ok ? '#dcfce7' : '#fee2e2';
  el.style.color = ok ? '#166534' : '#991b1b';
  el.textContent = text;
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// file list preview
(function(){
  const fi = document.getElementById('return-file-input');
  const fl = document.getElementById('return-file-list');
  if (fi && fl) fi.addEventListener('change', function() {
    fl.innerHTML = Array.from(this.files).map(f => '<span style="display:inline-block;margin-right:8px;padding:2px 8px;background:#ffffff;border-radius:4px;">' + f.name.replace(/</g,'&lt;') + '</span>').join('');
  });
})();

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('tab-submit').style.display = name === 'submit' ? '' : 'none';
  document.getElementById('tab-history').style.display = name === 'history' ? '' : 'none';
  if (name === 'history') loadHistory();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

document.getElementById('form-return').addEventListener('submit', async function(e) {
  e.preventDefault();
  const fd = new FormData(this);
  const fields = {};
  for (const [k, v] of fd.entries()) {
    if (k !== 'return-file-input' && v !== '') fields[k] = v;
  }
  let submitBtn = this.querySelector('button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '提交中...'; }
  try {
    const resp = await fetch('/api/submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: 'return', fields }) });
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (data.ok) {
      const fileInput = document.getElementById('return-file-input');
      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        const ufd = new FormData();
        ufd.append('record_id', String(data.id));
        for (const f of fileInput.files) ufd.append('file', f);
        try { await fetch('/api/supplier/return-upload', { method: 'POST', body: ufd }); } catch(ue) {}
      }
      showMsg('提交成功 ID: ' + data.id, true);
      this.reset();
      document.getElementById('return-file-list').innerHTML = '';
      this.querySelector('[name="型号"]').value = ${JSON.stringify(query.model || '')};
    } else if (data.duplicate) {
      showMsg(data.msg || '该记录已存在', false);
    } else {
      showMsg('提交失败: ' + data.msg, false);
    }
  } catch(err) { showMsg('网络错误: ' + err.message, false); }
  finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '提交'; } }
});

async function loadHistory() {
  const mount = document.getElementById('table-return');
  mount.textContent = '加载中...';
  try {
    const modelFilter = document.querySelector('input[name="型号"]') ? document.querySelector('input[name="型号"]').value : '';
    const resp = await fetch('/api/history?kind=return' + (modelFilter ? '&model=' + encodeURIComponent(modelFilter) : ''));
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (!data.ok) { mount.textContent = '加载失败: ' + data.msg; return; }
    const items = data.items;
    if (!items.length) { mount.textContent = '暂无数据'; return; }
    const cols = ['date','model','batch','return_qty','fault_qty','human_qty','ntf_qty','no_issue_qty','vehicle_brand'];
    const labels = ['日期','型号','批次','退机数量','故障数量','人为数量','NTF数量','七无数量','客户'];
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#f9fafb;">';
    html += labels.map(c => '<th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">' + c + '</th>').join('');
    html += '<th style="padding:8px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">维修记录</th>';
    html += '</tr></thead><tbody>';
    for (const it of items) {
      html += '<tr style="border-bottom:1px solid #f3f4f6;">';
      for (const c of cols) {
        const v = it[c];
        html += '<td style="padding:8px 12px;vertical-align:top;">' + (v == null ? '' : String(v).replace(/</g,'&lt;')) + '</td>';
      }
      // attachments column
      const atts = it.attachments || [];
      if (atts.length) {
        html += '<td style="padding:8px 12px;vertical-align:top;">' + atts.map(a => '<a href="/api/repair/attachment/download?id=' + a.id + '" target="_blank" style="display:inline-block;margin-right:4px;margin-bottom:2px;color:#2563eb;text-decoration:underline;font-size:12px;">' + String(a.name).replace(/</g,'&lt;') + '</a>').join('') + '</td>';
      } else {
        html += '<td style="padding:8px 12px;vertical-align:top;color:#9ca3af;">无</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    mount.innerHTML = html;
  } catch(e) { mount.textContent = '网络错误: ' + e.message; }
}
</script></body></html>`;
}
// Admin: Products management page
function adminProductsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>产品管理 - 管理后台</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue','Microsoft YaHei',sans-serif;background:#f5f5f7;}
.prod-admin-card{background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);transition:box-shadow 0.25s,transform 0.25s;cursor:default;}
.prod-admin-card:hover{box-shadow:0 8px 32px rgba(0,0,0,0.13);transform:translateY(-2px);}
.prod-admin-card .card-img-wrap{background:#ffffff;display:flex;align-items:center;justify-content:center;padding:24px;aspect-ratio:4/3;}
.prod-admin-card .card-img-wrap img{width:100%;height:100%;object-fit:contain;}
.prod-admin-card .card-img-placeholder{color:#cbd5e1;font-size:3rem;text-align:center;}
.prod-admin-card .card-body{padding:16px 20px 20px;}
.prod-admin-card .card-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;}
.prod-admin-card .badge{font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;display:inline-block;}
.prod-admin-card .badge-cat{background:#e8edff;color:#4338ca;}
.prod-admin-card .badge-active{background:#dcfce7;color:#15803d;}
.prod-admin-card .badge-inactive{background:#ffffff;color:#6b7280;}
.prod-admin-card h3{font-size:17px;font-weight:600;color:#1d1d1f;margin:0 0 3px;line-height:1.35;}
.prod-admin-card .card-meta{font-size:12px;color:#6e6e73;margin-bottom:0;}
.prod-admin-card .card-actions{display:flex;gap:18px;margin-top:13px;padding-top:12px;border-top:1px solid #f0f0f0;}
.prod-admin-card .btn-edit{color:#0071e3;font-size:13px;font-weight:500;background:none;border:none;cursor:pointer;padding:0;font-family:inherit;}
.prod-admin-card .btn-edit:hover{text-decoration:underline;}
.prod-admin-card .btn-del{color:#ff3b30;font-size:13px;font-weight:500;background:none;border:none;cursor:pointer;padding:0;font-family:inherit;}
.prod-admin-card .btn-del:hover{text-decoration:underline;}
@media(min-width:640px){.prod-grid{grid-template-columns:repeat(2,1fr)!important;}}
@media(min-width:1024px){.prod-grid{grid-template-columns:repeat(3,1fr)!important;}}
@media(min-width:1280px){.prod-grid{grid-template-columns:repeat(4,1fr)!important;}}
</style>
</head><body class="min-h-screen" style="background:#f5f5f7;">
${ADMIN_NAV('products', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div id="msg" class="mb-3 hidden"></div>
  <section class="bg-white rounded shadow p-4 mb-6">
    <h2 class="font-medium mb-3">新增产品</h2>
    <form id="create-form" class="flex gap-3 items-end flex-wrap">
      <div>
        <label class="text-sm text-slate-600 block mb-1">型号 * <span class="text-xs text-slate-400">（与历史数据关联）</span></label>
        <input name="model_code" id="model-code-input" placeholder="如: 理想3.1" class="border rounded p-2 w-48" list="model-codes-list" autocomplete="off">
        <datalist id="model-codes-list"></datalist>
      </div>
      <div>
        <label class="text-sm text-slate-600 block mb-1">名称 * <span class="text-xs text-slate-400">（卡片显示）</span></label>
        <input name="model_name" id="model-name-input" placeholder="如: 理想3.1标准版" class="border rounded p-2 w-48" required>
      </div>
      <div>
        <label class="text-sm text-slate-600 block mb-1">产品图片</label>
        <input name="image" type="file" accept="image/*" class="border rounded p-2 file:mr-2 file:py-1 file:px-3 file:border-0 file:rounded file:bg-blue-50 file:text-blue-700 file:cursor-pointer">
      </div>
      <div>
        <label class="text-sm text-slate-600 block mb-1">状态</label>
        <select name="status" class="border rounded p-2 h-10">
          <option value="active">在产</option>
          <option value="inactive">停产</option>
        </select>
      </div>
      <div>
        <label class="text-sm text-slate-600 block mb-1">品类 *</label>
        <select name="category" class="border rounded p-2 h-10" required>
          <option value="">-- 请选择 --</option>
          <option value="机顶盒">机顶盒</option>
          <option value="服务器">服务器</option>
          <option value="麦克风">麦克风</option>
          <option value="音箱">音箱</option>
        </select>
      </div>
      <div>
        <label class="text-sm text-slate-600 block mb-1">客户</label>
        <input name="vehicle_brand" placeholder="如: 理想" class="border rounded p-2 w-32" list="create-brand-list" autocomplete="off">
        <datalist id="create-brand-list"></datalist>
      </div>
      <button class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 h-10" type="submit">新增</button>
    </form>
  </section>
  <section style="margin-top:0;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h2 style="font-size:22px;font-weight:600;color:#1d1d1f;margin:0;">产品列表</h2>
    </div>
    <div id="list"><div style="text-align:center;padding:48px;color:#6e6e73;">加载中...</div></div>
  </section>
</div>
<!-- Edit Modal -->
<div id="edit-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:12px;padding:24px;width:360px;max-width:90vw;">
    <h3 style="font-size:16px;font-weight:600;margin:0 0 16px;">编辑产品</h3>
    <form id="edit-form">
      <input type="hidden" id="edit-id">
      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px;">型号（与历史数据关联）</label>
        <input id="edit-code" type="text" list="edit-model-codes-list" style="border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;width:100%;box-sizing:border-box;font-size:14px;" autocomplete="off">
        <datalist id="edit-model-codes-list"></datalist>
      </div>
      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px;">名称 *（卡片显示）</label>
        <input id="edit-name" type="text" required style="border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;width:100%;box-sizing:border-box;font-size:14px;">
      </div>
      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px;">品类</label>
        <select id="edit-category" style="border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;width:100%;font-size:14px;">
          <option value="">-- 请选择 --</option>
          <option value="机顶盒">机顶盒</option>
          <option value="服务器">服务器</option>
          <option value="麦克风">麦克风</option>
          <option value="音箱">音箱</option>
        </select>
      </div>
      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px;">客户</label>
        <input id="edit-brand" type="text" list="edit-brand-list" style="border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;width:100%;box-sizing:border-box;font-size:14px;" placeholder="如: 理想" autocomplete="off">
        <datalist id="edit-brand-list"></datalist>
      </div>
      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px;">状态</label>
        <select id="edit-status" style="border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;width:100%;font-size:14px;">
          <option value="active">在产</option>
          <option value="inactive">停产</option>
        </select>
      </div>
      <div style="margin-bottom:16px;">
        <label style="font-size:13px;color:#6b7280;display:block;margin-bottom:4px;">更换图片（可选）</label>
        <img id="edit-img-preview" style="width:100%;height:120px;object-fit:contain;background:#f8fafc;border-radius:6px;margin-bottom:8px;">
        <input id="edit-img-file" type="file" accept="image/*" style="font-size:13px;">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" onclick="closeEditModal()" style="padding:8px 16px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;font-size:14px;cursor:pointer;">取消</button>
        <button type="submit" style="padding:8px 16px;border-radius:6px;background:#2563eb;color:#fff;border:none;font-size:14px;cursor:pointer;">保存</button>
      </div>
    </form>
  </div>
</div>
<script>
function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
  if (r.status === 401) { location.href = '/login'; return; }
  return r.json();
}

async function uploadImage(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/admin/products/upload-image', { method: 'POST', body: fd });
  if (r.status === 401) { location.href = '/login'; return null; }
  return r.json();
}

async function refresh() {
  const r = await fetch('/api/admin/products/list');
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  if (!d.ok) { document.getElementById('list').textContent = '加载失败'; return; }
  if (!d.products.length) { document.getElementById('list').textContent = '暂无产品'; return; }
  let html = '<div style="display:grid;grid-template-columns:repeat(1,1fr);gap:20px;" class="prod-grid">';
  for (const p of d.products) {
    var esc = function(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); };
    var imgHtml = p.image_path
      ? '<div class="card-img-wrap"><img src="' + esc(p.image_path) + '" alt="' + esc(p.model_name) + '"></div>'
      : '<div class="card-img-wrap"><div class="card-img-placeholder">&#128247;</div></div>';
    var catBadge = '<span class="badge badge-cat">' + esc(p.category||'未设置') + '</span>';
    var statusBadge = p.status==='inactive'
      ? '<span class="badge badge-inactive">停产</span>'
      : '<span class="badge badge-active">在产</span>';
    var brandBadge = p.vehicle_brand ? '<span style="font-size:11px;color:#6e6e73;">' + esc(p.vehicle_brand) + '</span>' : '';
    var codeLine = (p.model_code && p.model_code !== p.model_name)
      ? '<p class="card-meta">型号：' + esc(p.model_code) + '</p>'
      : '';
    html += '<div class="prod-admin-card">'
      + imgHtml
      + '<div class="card-body">'
      + '<div class="card-badges">' + catBadge + statusBadge + brandBadge + '</div>'
      + '<h3>' + esc(p.model_name) + '</h3>'
      + codeLine
      + '<div class="card-actions">'
      + '<button class="btn-edit" data-id="' + p.id + '" data-name="' + esc(p.model_name) + '" data-img="' + esc(p.image_path||'') + '" data-code="' + esc(p.model_code||'') + '" data-status="' + (p.status||'active') + '" data-brand="' + esc(p.vehicle_brand||'') + '" data-category="' + esc(p.category||'') + '" onclick="editProductFromEl(this)">编辑</button>'
      + '<button class="btn-del" onclick="deleteProduct(' + p.id + ')">删除</button>'
      + '</div>'
      + '</div></div>';
  }
  html += '</div>';
  document.getElementById('list').innerHTML = html;
}

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const modelName = fd.get('model_name');
  const modelCode = (fd.get('model_code')||'').trim() || modelName;
  const imageFile = fd.get('image');
  const categoryVal = (fd.get('category')||'').trim();
  if (!modelCode) { showMsg('型号不能为空', false); return; }
  if (!categoryVal) { showMsg('品类不能为空', false); return; }
  let imagePath = null;
  if (imageFile && imageFile.size > 0) {
    const up = await uploadImage(imageFile);
    if (up && up.ok) imagePath = up.image_path;
    else if (up) { showMsg('图片上传失败: ' + up.msg, false); return; }
  }
  const statusVal = fd.get('status') || 'active';
  const brandVal = (fd.get('vehicle_brand')||'').trim();
  const d = await api('/api/admin/products/create', { model_name: modelName, model_code: modelCode, image_path: imagePath, status: statusVal, vehicle_brand: brandVal, category: categoryVal });
  if (d && d.ok) { showMsg('创建成功'); e.target.reset(); refresh(); }
  else showMsg('创建失败: ' + (d && d.msg), false);
});

function editProductFromEl(btn) {
  var id = btn.dataset.id;
  var currentName = btn.dataset.name;
  var currentImgPath = btn.dataset.img;
  var currentCode = btn.dataset.code;
  var currentStatus = btn.dataset.status;
  var currentCategory = btn.dataset.category;
  var modal = document.getElementById('edit-modal');
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-name').value = currentName;
  document.getElementById('edit-code').value = currentCode || currentName;
  if(document.getElementById('edit-brand')) document.getElementById('edit-brand').value = btn.dataset.brand || '';
  document.getElementById('edit-category').value = currentCategory || '';
  document.getElementById('edit-status').value = currentStatus || 'active';
  document.getElementById('edit-img-preview').src = currentImgPath || '';
  document.getElementById('edit-img-preview').style.display = currentImgPath ? 'block' : 'none';
  modal.style.display = 'flex';
}
function closeEditModal() {
  document.getElementById('edit-modal').style.display = 'none';
  document.getElementById('edit-img-file').value = '';
}
document.getElementById('edit-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const id = parseInt(document.getElementById('edit-id').value);
  const newName = document.getElementById('edit-name').value.trim();
  if (!newName) { showMsg('型号名称不能为空', false); return; }
  const imageFile = document.getElementById('edit-img-file').files[0];
  let imagePath = undefined;
  if (imageFile && imageFile.size > 0) {
    const up = await uploadImage(imageFile);
    if (up && up.ok) imagePath = up.image_path;
    else { showMsg('图片上传失败', false); return; }
  }
  const newCode = (document.getElementById('edit-code').value||'').trim() || newName;
  const editStatus = document.getElementById('edit-status').value || 'active';
  const editBrandEl = document.getElementById('edit-brand');
  const editBrand = editBrandEl ? editBrandEl.value.trim() : '';
  const editCategory = (document.getElementById('edit-category').value||'').trim();
  const body = { id, model_name: newName, model_code: newCode, status: editStatus, vehicle_brand: editBrand, category: editCategory };
  if (imagePath !== undefined) body.image_path = imagePath;
  const d = await api('/api/admin/products/update', body);
  if (d && d.ok) { showMsg('已更新'); closeEditModal(); refresh(); }
  else showMsg('更新失败: ' + (d && d.msg), false);
});

async function deleteProduct(id) {
  if (!confirm('确定删除此产品？')) return;
  const d = await api('/api/admin/products/delete', { id });
  if (d && d.ok) { showMsg('已删除'); refresh(); }
  else showMsg('删除失败: ' + (d && d.msg), false);
}

refresh();
// Load model codes for autocomplete
fetch('/api/options').then(r=>r.json()).then(d=>{
  if(!d.vehicleBrands) return;
  var bo = d.vehicleBrands.map(b=>'<option value="'+b.replace(/"/g,'&quot;')+'">').join('');
  ['create-brand-list','edit-brand-list'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.innerHTML=bo;
  });
}).catch(function(){});
fetch('/api/admin/products/model-codes').then(r=>r.json()).then(d=>{
  if(!d.ok) return;
  var opts = d.codes.map(c=>'<option value="'+c.replace(/"/g,'&quot;')+'">').join('');
  var dl = document.getElementById('model-codes-list');
  if(dl) dl.innerHTML = opts;
  var dl2 = document.getElementById('edit-model-codes-list');
  if(dl2) dl2.innerHTML = opts;
});
</script></body></html>`;
}

function adminProductBindingsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>产品绑定供应商 - 管理后台</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style>
</head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('product-bindings', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div id="msg" class="mb-3 hidden"></div>
  <section class="bg-white rounded shadow p-4">
    <h2 class="font-medium mb-1">供应商-产品绑定管理</h2>
    <p class="text-sm text-slate-500 mb-4">为每个供应商配置可见的产品，供应商登录后只能看到已绑定的产品</p>
    <div id="bindings-list">加载中...</div>
  </section>
</div>
<script>
function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
let _data = null;
async function refresh() {
  const r = await fetch('/api/admin/product-bindings/list');
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  if (!d.ok) { document.getElementById('bindings-list').textContent = '加载失败'; return; }
  _data = d;
  render();
}
function render() {
  const { suppliers, products, bindings } = _data;
  const container = document.getElementById('bindings-list');
  let h = '';
  for (const sup of suppliers) {
    const bound = bindings[sup] || [];
    const boundIds = new Set(bound.map(b => b.product_id));
    h += '<div class="mb-6 border rounded p-4">';
    h += '<h3 class="font-medium text-lg mb-2">' + sup + '</h3>';
    if (!products.length) {
      h += '<p class="text-slate-400 text-sm mb-3">暂无产品，请先在产品管理中添加产品</p>';
    } else {
      h += '<div class="flex flex-wrap gap-3 mb-3">';
      for (const p of products) {
        const checked = boundIds.has(p.id) ? 'checked' : '';
        h += '<label class="inline-flex items-center gap-1 text-sm">'
          + '<input type="checkbox" data-sup="' + sup + '" data-pid="' + p.id + '" ' + checked + '>'
          + escapeHtml(p.model_name) + '</label>';
      }
      h += '</div>';
    }
    h += '<button class="save-btn bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700" data-sup="' + sup + '">保存</button>';
    h += '</div>';
  }
  container.innerHTML = h;
}
function escapeHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
document.getElementById('bindings-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.save-btn');
  if (!btn) return;
  const sup = btn.dataset.sup;
  const checks = document.querySelectorAll('input[data-sup="' + sup + '"]');
  const productIds = [];
  checks.forEach(c => { if (c.checked) productIds.push(Number(c.dataset.pid)); });
  btn.disabled = true; btn.textContent = '保存中...';
  try {
    const r = await fetch('/api/admin/product-bindings/update', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ supplier_name: sup, product_ids: productIds })
    });
    const d = await r.json();
    if (d.ok) { showMsg(sup + ' 产品绑定已更新'); await refresh(); }
    else showMsg('失败: ' + d.msg, false);
  } catch(e) { showMsg('网络错误', false); }
  btn.disabled = false; btn.textContent = '保存';
});
refresh();
</script></body></html>`;
}

function supplierRepairPage(sess) {
  const safe = escapeHtml(sess.supplier || '');
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>雷石质量管理系统 - ${safe}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script>

<style>
label { display: block; }
select, input[type="text"], input[type="number"], input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  display: block !important;
}
.flatpickr-wrapper {
  display: block !important;
  width: 100% !important;
}
/* 确保 flatpickr 日期选择器显示年份 */
.flatpickr-current-month {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 100% !important;
  flex-wrap: nowrap !important;
}

.flatpickr-current-month span.cur-month {
  display: inline-block !important;
  margin: 0 0.3ch !important;
}

.flatpickr-current-month .numInputWrapper {
  display: inline-block !important;
  width: 7ch !important;
}

.flatpickr-current-month input.cur-year {
  width: 6ch !important;

  display: inline-block !important;
  margin-left: 0.3ch !important;
}

.flatpickr-current-month input.cur-year:disabled {
  color: rgba(0,0,0,0.5) !important;
}

.numInputWrapper span {
  opacity: 1 !important;
  visibility: visible !important;
}

.flatpickr-current-month:hover .numInputWrapper span {
  opacity: 1 !important;
  visibility: visible !important;
}

.flatpickr-calendar { min-width: 320px; }
</style>

</head><body class="bg-slate-50 min-h-screen">
<div class="max-w-5xl mx-auto p-4">
  <header class="mb-4 flex justify-between items-center">
    <div>
      <h1 class="text-2xl font-semibold">雷石质量管理系统</h1>
      <div class="text-sm text-slate-500">账号: <span class="font-medium text-slate-800">${uname}</span> / 供应商: <span class="font-medium text-slate-800">${safe}</span></div>
    </div>
    <a href="/logout" class="text-sm text-blue-600 hover:underline">退出</a>
  </header>
  ${supplierWorkflowNav(sess, '')}
  <nav class="flex gap-2 mb-4 border-b flex-wrap">
    ${sess.role !== 'supplier_repair' ? `
    ${dbGetSupplierModuleConfig('ffr') ? '<button class="tab-btn px-4 py-2 font-medium" data-tab="ffr">FFR 数据</button>' : ''}
    ${dbGetSupplierModuleConfig('prod_submit') ? '<button class="tab-btn px-4 py-2 font-medium" data-tab="submit-prod">生产填报</button>' : ''}
    ${dbGetSupplierModuleConfig('return_submit') ? '<button class="tab-btn px-4 py-2 font-medium" data-tab="submit-return">退机填报</button>' : ''}
    ${dbGetSupplierModuleConfig('prod_history') ? '<button class="tab-btn px-4 py-2 font-medium" data-tab="history-prod">生产历史</button>' : ''}
    ${dbGetSupplierModuleConfig('return_history') ? '<button class="tab-btn px-4 py-2 font-medium" data-tab="history-return">退机历史</button>' : ''}
    ${dbGetSupplierModuleConfig('proto_board') ? '<button class="tab-btn px-4 py-2 font-medium" data-tab="proto-board">实验板</button>' : ''}
    ` : ''}
  
  ${sess.role === 'supplier_repair' ? `
    <button class="tab-btn px-4 py-2 font-medium" data-tab="submit-repair-line">产线维修品</button>
    <button class="tab-btn px-4 py-2 font-medium" data-tab="submit-repair-as">售后返修品</button>
    <button class="tab-btn px-4 py-2 font-medium" data-tab="history-repair-line">产线维修历史</button>
    <button class="tab-btn px-4 py-2 font-medium" data-tab="history-repair-as">售后返修历史</button>
    ` : ''}
  </nav>
  <div id="msg" class="mb-3 hidden"></div>
  ${sess.role !== 'supplier_repair' ? `
  <section id="tab-ffr" class="panel">
    <div class="bg-white rounded shadow p-4">
      <h2 class="font-medium mb-3">FFR 数据（按型号）</h2>
      <p class="text-sm text-slate-500 mb-3">FFR = 退机数量 ÷ 生产数量</p>
      <div id="ffr-table">加载中...</div>
    </div>
  </section>
  <section id="tab-submit-prod" class="panel hidden">
    <form id="form-prod" class="bg-white rounded shadow p-4 grid grid-cols-2 gap-4">
      <label class="col-span-1">日期 *<input id="prod-日期" name="日期" type="text" placeholder="YYYY-MM-DD" class="w-full border rounded p-2 mt-1" autocomplete="off">
        <span id="prod-日期-err" class="hidden text-red-500 text-xs mt-1 block">请选择日期</span></label>
      <label class="col-span-1">型号 *<input id="prod-机型" name="机型" class="w-full border rounded p-2 mt-1">
        <span id="prod-机型-err" class="hidden text-red-500 text-xs mt-1 block">机型不能为空</span></label>
      <label class="col-span-1">客户 *
        <select id="brand-prod" name="车企" class="w-full border rounded p-2 mt-1">
          <option value="">--请选择--</option>
        </select>
        <span id="prod-车企-err" class="hidden text-red-500 text-xs mt-1 block">请选择客户</span>
      </label>
      <label class="col-span-1">内部型号 *<input id="prod-生产批次" name="生产批次" class="w-full border rounded p-2 mt-1">
        <span id="prod-生产批次-err" class="hidden text-red-500 text-xs mt-1 block">内部型号不能为空</span></label>
      <label class="col-span-1">订单数量 *<input id="prod-计划数量" name="计划数量" type="number" min="0" class="w-full border rounded p-2 mt-1">
        <span id="prod-计划数量-err" class="hidden text-red-500 text-xs mt-1 block">订单数量不能为空</span></label>
      <label class="col-span-1">交付数量 *<input id="prod-实际产出" name="实际产出" type="number" min="0" class="w-full border rounded p-2 mt-1">
        <span id="prod-实际产出-err" class="hidden text-red-500 text-xs mt-1 block">交付数量不能为空</span></label>
      <label class="col-span-2">验货报告 *
        <input id="prod-report" name="验货报告" type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx" class="mt-1 w-full border rounded p-2 file:mr-3 file:py-1 file:px-3 file:border-0 file:rounded file:bg-blue-50 file:text-blue-700 file:cursor-pointer">
        <span id="prod-report-err" class="hidden text-red-500 text-xs mt-1 block">请上传验货报告</span></label>
      <label class="col-span-2">备注<textarea name="备注" class="w-full border rounded p-2 mt-1"></textarea></label>
      <div class="col-span-2 flex items-center gap-4">
        <button class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700" type="submit">提交</button>
        <span id="prod-dup-err" class="hidden text-red-600 text-sm font-medium"></span>
      </div>
    </form>
  </section>
  <section id="tab-submit-return" class="panel hidden">
    <form id="form-return" class="bg-white rounded shadow p-4 grid grid-cols-2 gap-4">
      <label class="col-span-1">日期<input name="日期" type="text" autocomplete="off" required class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-1">型号<input name="型号" required class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-1">客户
        <select name="车企" class="w-full border rounded p-2 mt-1" id="brand-return">
          <option value="">--请选择(可选)--</option>
        </select>
      </label>
      <label class="col-span-1">批次<input name="批次" class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-1">退机数量<input name="退机数量" type="number" min="0" required class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-1">不良类型
        <select name="不良类型" required class="w-full border rounded p-2 mt-1">
          <option value="">--请选择--</option>
          ${DEFECT_TYPES.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}
        </select>
      </label>
      <label class="col-span-2">不良描述<textarea name="不良描述" class="w-full border rounded p-2 mt-1"></textarea></label>
      <label class="col-span-2">处理结果<textarea name="处理结果" class="w-full border rounded p-2 mt-1"></textarea></label>
      <div class="col-span-2"><button class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700" type="submit">提交</button></div>
    </form>
  </section>
  <section id="tab-history-prod" class="panel hidden">
    <div class="bg-white rounded shadow p-4 overflow-auto"><div id="table-prod">加载中...</div></div>
  </section>
  <section id="tab-history-return" class="panel hidden">
    <div class="bg-white rounded shadow p-4 overflow-auto"><div id="table-return">加载中...</div></div>
  </section>
  <section id="tab-proto-board" class="panel hidden">
    <div class="bg-white rounded shadow p-4">
      <h2 class="font-medium mb-3">实验板</h2>
      <div id="proto-board-list">加载中...</div>
    </div>
  </section>
  ` : ''}

  ${sess.role === 'supplier_repair' ? `
  <!-- 产线维修品录入 -->
  <section id="tab-submit-repair-line" class="panel hidden">
    <form id="form-repair-line" class="bg-white rounded shadow p-4 grid grid-cols-2 gap-4">
      <h2 class="col-span-2 font-medium text-lg border-b pb-2 mb-2">产线维修品记录</h2>
      <label>客户<select name="vehicle_brand" class="w-full border rounded p-2 mt-1 brand-sel"><option value="">--请选择--</option></select></label>
      <label>型号<input name="model" class="w-full border rounded p-2 mt-1"></label>
      <label>整机SN码<input name="sn_whole" class="w-full border rounded p-2 mt-1"></label>
      <label>配件SN码<input name="sn_part" class="w-full border rounded p-2 mt-1"></label>
      <label>故障现象<input name="fault_symptom" class="w-full border rounded p-2 mt-1"></label>
      <label>故障原因<input name="fault_cause" class="w-full border rounded p-2 mt-1"></label>
      <label>不良零部件<input name="defective_part" class="w-full border rounded p-2 mt-1"></label>
      <label>短期解决办法<input name="short_term_fix" class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-2">长期解决办法<input name="long_term_fix" class="w-full border rounded p-2 mt-1"></label>
      <label>生产批次号<input name="batch_no" class="w-full border rounded p-2 mt-1"></label>
      <label>产线工位<input name="station" class="w-full border rounded p-2 mt-1"></label>
      <label>不良发现环节<select name="discovery_stage" class="w-full border rounded p-2 mt-1">
        <option value="">--请选择--</option>
        ${DISCOVERY_STAGES.map(s => `<option>${escapeHtml(s)}</option>`).join('')}
      </select></label>
      <label>维修日期<input name="repair_date" type="text" autocomplete="off" class="w-full border rounded p-2 mt-1"></label>
      <label>维修结果<select name="repair_result" class="w-full border rounded p-2 mt-1">
        <option value="">--请选择--</option>
        ${REPAIR_RESULTS.map(s => `<option>${escapeHtml(s)}</option>`).join('')}
      </select></label>
      <label>维修人员<input name="repair_person" class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-2">备注<textarea name="remarks" class="w-full border rounded p-2 mt-1"></textarea></label>
      <div class="col-span-2"><button class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700" type="submit">提交</button></div>
    </form>
    <div id="repair-line-upload-area" class="bg-white rounded shadow p-4 mt-4 hidden">
      <h3 class="font-medium mb-2">上传不良品图片/附件</h3>
      <p class="text-sm text-slate-500 mb-2">记录ID: <span id="rl-record-id"></span></p>
      <input type="file" id="rl-file-input" multiple accept="image/*,.pdf,.xlsx,.xls" class="mb-2">
      <button id="rl-upload-btn" class="bg-green-600 text-white px-3 py-1 rounded text-sm">上传</button>
      <div id="rl-upload-msg" class="text-sm mt-2"></div>
    </div>
  </section>

  <!-- 售后返修品录入 -->
  <section id="tab-submit-repair-as" class="panel hidden">
    <form id="form-repair-as" class="bg-white rounded shadow p-4 grid grid-cols-2 gap-4">
      <h2 class="col-span-2 font-medium text-lg border-b pb-2 mb-2">售后返修品记录</h2>
      <label>客户<select name="vehicle_brand" class="w-full border rounded p-2 mt-1 brand-sel"><option value="">--请选择--</option></select></label>
      <label>型号<input name="model" class="w-full border rounded p-2 mt-1"></label>
      <label>整机SN码<input name="sn_whole" class="w-full border rounded p-2 mt-1"></label>
      <label>配件SN码<input name="sn_part" class="w-full border rounded p-2 mt-1"></label>
      <label>故障现象<input name="fault_symptom" class="w-full border rounded p-2 mt-1"></label>
      <label>故障原因<input name="fault_cause" class="w-full border rounded p-2 mt-1"></label>
      <label>不良零部件<input name="defective_part" class="w-full border rounded p-2 mt-1"></label>
      <label>短期解决办法<input name="short_term_fix" class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-2">长期解决办法<input name="long_term_fix" class="w-full border rounded p-2 mt-1"></label>
      <label>返修单号<input name="return_order_no" class="w-full border rounded p-2 mt-1"></label>
      <label>客户反馈描述<input name="customer_feedback" class="w-full border rounded p-2 mt-1"></label>
      <label>寄回日期<input name="return_date" type="text" autocomplete="off" class="w-full border rounded p-2 mt-1"></label>
      <label>维修日期<input name="repair_date" type="text" autocomplete="off" class="w-full border rounded p-2 mt-1"></label>
      <label>维修完成日期<input name="repair_complete_date" type="text" autocomplete="off" class="w-full border rounded p-2 mt-1"></label>
      <label>寄出日期<input name="ship_date" type="text" autocomplete="off" class="w-full border rounded p-2 mt-1"></label>
      <label>维修结果<select name="repair_result" class="w-full border rounded p-2 mt-1">
        <option value="">--请选择--</option>
        ${REPAIR_RESULTS.map(s => `<option>${escapeHtml(s)}</option>`).join('')}
      </select></label>
      <label>是否在保<select name="in_warranty" class="w-full border rounded p-2 mt-1">
        <option value="">--请选择--</option>
        <option value="是">是</option>
        <option value="否">否</option>
      </select></label>
      <label>维修人员<input name="repair_person" class="w-full border rounded p-2 mt-1"></label>
      <label class="col-span-2">备注<textarea name="remarks" class="w-full border rounded p-2 mt-1"></textarea></label>
      <div class="col-span-2"><button class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700" type="submit">提交</button></div>
    </form>
    <div id="repair-as-upload-area" class="bg-white rounded shadow p-4 mt-4 hidden">
      <h3 class="font-medium mb-2">上传不良品图片/附件</h3>
      <p class="text-sm text-slate-500 mb-2">记录ID: <span id="ras-record-id"></span></p>
      <input type="file" id="ras-file-input" multiple accept="image/*,.pdf,.xlsx,.xls" class="mb-2">
      <button id="ras-upload-btn" class="bg-green-600 text-white px-3 py-1 rounded text-sm">上传</button>
      <div id="ras-upload-msg" class="text-sm mt-2"></div>
    </div>
  </section>

  <!-- 产线维修历史 -->
  <section id="tab-history-repair-line" class="panel hidden">
    <div class="bg-white rounded shadow p-4 overflow-auto"><div id="table-repair-line">加载中...</div></div>
  </section>

  <!-- 售后返修历史 -->
  <section id="tab-history-repair-as" class="panel hidden">
    <div class="bg-white rounded shadow p-4 overflow-auto"><div id="table-repair-as">加载中...</div></div>
  </section>
  ` : ''}
</div>
<script>
// Load vehicle brands
async function loadBrands() {
  try {
    const r = await fetch('/api/options');
    const d = await r.json();
    if (d.ok && d.vehicleBrands) {
      document.querySelectorAll('#brand-prod,#brand-return,.brand-sel').forEach(sel => {
        d.vehicleBrands.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b; opt.textContent = b;
          sel.appendChild(opt);
        });
      });
    }
  } catch(e) { console.warn('brand load failed', e); }
}
loadBrands();

// 初始化所有日期输入框
let flatpickrRetries = 0;
(function initFlatpickr() {
  flatpickrRetries++;
  // 延迟执行以确保 DOM 和 flatpickr 库都已加载
  if (!window.flatpickr || !window.fp_config) {
    if (flatpickrRetries < 50) {  // 增加重试次数，最多 5 秒
      setTimeout(initFlatpickr, 100);
    } else {
      console.error('Failed to load flatpickr library after retries');
    }
    return;
  }
  const dateInputs = document.querySelectorAll('input[type="text"]');
  let initialized = 0;
  dateInputs.forEach(input => {
    const name = input.name || '';
    const id = input.id || '';
    // 检查是否为日期字段
    if (name.includes('date') || name === '日期' || name === 'repair_date' ||
        name === 'return_date' || name === 'repair_complete_date' || name === 'ship_date' ||
        id.includes('date') || id.includes('日期')) {
      try {
        flatpickr(input, window.fp_config);
        initialized++;
      } catch(e) {
        console.warn('Failed to init flatpickr for ' + (id || name) + ':', e);
      }
    }
  });
  if (initialized > 0) {
    console.log('Initialized ' + initialized + ' flatpickr date pickers');
  }
})();

function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === name;
    b.className = 'tab-btn px-4 py-2 font-medium ' + (active ? 'border-b-2 border-blue-600 text-blue-600' : 'text-slate-600');
  });
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  var tabEl = document.getElementById('tab-' + name);
  if (tabEl) tabEl.classList.remove('hidden');
  if (name === 'ffr' && document.getElementById('tab-ffr')) loadFFR();
  if (name === 'history-prod' && document.getElementById('tab-history-prod')) loadHistory('prod');
  if (name === 'history-return' && document.getElementById('tab-history-return')) loadHistory('return');
  if (name === 'history-repair-line') loadRepairHistory('repair_line');
  if (name === 'history-repair-as') loadRepairHistory('repair_aftersales');
  if (name === 'proto-board') loadProtoBoards();
}
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
async function submitForm(form, kind) {
  const fd = new FormData(form);
  const fields = {};
  for (const [k, v] of fd.entries()) { if (v !== '') fields[k] = v; }
  try {
    const resp = await fetch('/api/submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind, fields }) });
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (data.ok) { showMsg('提交成功 ID: ' + data.id); form.reset(); }
    else if (resp.status === 409 || data.msg === '该订单已提交') { alert('该订单已提交'); }
    else { showMsg('提交失败: ' + data.msg, false); }
  } catch (e) { showMsg('网络错误: ' + e.message, false); }
}
var _fprod = document.getElementById('form-prod');
var _fret = document.getElementById('form-return');
if (_fprod) _fprod.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 清除上次错误状态
  ['日期','型号','生产批次','计划数量','实际产出'].forEach(f => {
    const inp = document.getElementById('prod-' + f);
    if (inp) inp.classList.remove('border-red-400');
    const err = document.getElementById('prod-' + f + '-err');
    if (err) err.classList.add('hidden');
  });
  const brandSel = document.getElementById('brand-prod');
  if (brandSel) brandSel.classList.remove('border-red-400');
  const brandErr = document.getElementById('prod-车企-err');
  if (brandErr) brandErr.classList.add('hidden');
  const reportInp = document.getElementById('prod-report');
  if (reportInp) reportInp.classList.remove('border-red-400');
  const reportErr = document.getElementById('prod-report-err');
  if (reportErr) reportErr.classList.add('hidden');
  const dupErr = document.getElementById('prod-dup-err');
  if (dupErr) dupErr.classList.add('hidden');

  // 必填校验
  let hasErr = false;
  function checkField(id, errId) {
    const el = document.getElementById(id);
    if (!el) return;
    const v = (el.value || '').trim();
    if (!v) {
      el.classList.add('border-red-400');
      const ee = document.getElementById(errId);
      if (ee) ee.classList.remove('hidden');
      hasErr = true;
    }
  }
  checkField('prod-日期', 'prod-日期-err');
  checkField('prod-机型', 'prod-机型-err');
  checkField('prod-生产批次', 'prod-生产批次-err');
  checkField('prod-计划数量', 'prod-计划数量-err');
  checkField('prod-实际产出', 'prod-实际产出-err');
  // 客户（select）
  if (brandSel && !brandSel.value) {
    brandSel.classList.add('border-red-400');
    if (brandErr) brandErr.classList.remove('hidden');
    hasErr = true;
  }
  // 验货报告文件
  if (reportInp && (!reportInp.files || reportInp.files.length === 0)) {
    reportInp.classList.add('border-red-400');
    if (reportErr) reportErr.classList.remove('hidden');
    hasErr = true;
  }
  if (hasErr) return;

  // 发送 JSON 数据
  const fd = new FormData(e.target);
  const fields = {};
  for (const [k, v] of fd.entries()) {
    if (k !== '验货报告' && v !== '') fields[k] = v;
  }
  try {
    const resp = await fetch('/api/submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ kind: 'prod', fields }) });
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (data.ok) {
      // 上传验货报告
      const repFile = reportInp && reportInp.files && reportInp.files[0];
      if (repFile) {
        const ufd = new FormData();
        ufd.append('record_id', String(data.id));
        ufd.append('file', repFile);
        try {
          await fetch('/api/supplier/prod-upload', { method: 'POST', body: ufd });
        } catch (ue) { console.warn('验货报告上传失败', ue); }
      }
      showMsg('提交成功 ID: ' + data.id);
      e.target.reset();
    } else if (data.duplicate) {
      if (dupErr) { dupErr.textContent = data.msg || '该记录已存在'; dupErr.classList.remove('hidden'); }
    } else {
      showMsg('提交失败: ' + data.msg, false);
    }
  } catch (err) { showMsg('网络错误: ' + err.message, false); }
});
if (_fret) _fret.addEventListener('submit', (e) => { e.preventDefault(); submitForm(e.target, 'return'); });
async function loadHistory(kind) {
  const mount = document.getElementById('table-' + kind);
  mount.textContent = '加载中...';
  try {
    const resp = await fetch('/api/history?kind=' + kind);
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (!data.ok) { mount.textContent = '加载失败: ' + data.msg; return; }
    const items = data.items;
    if (items.length === 0) { mount.textContent = '暂无数据'; return; }
    const cols = kind === 'return'
      ? ['date','model','batch','return_qty','defect_type','defect_desc','handling_result','warehouse_qty','vehicle_brand']
      : ['date','model','batch','plan_qty','actual_qty','warehouse_qty','notes','vehicle_brand'];
    const labels = kind === 'return'
      ? ['日期','型号','批次','退机数量','不良类型','不良描述','处理结果','入库数量','客户']
      : ['日期','型号','生产批次','计划数量','实际产出','入库数量','备注','客户'];
    let html = '<table class="min-w-full text-sm"><thead><tr class="bg-slate-100">';
    html += labels.map((c) => '<th class="p-2 text-left">' + c + '</th>').join('');
    html += '</tr></thead><tbody>';
    for (const it of items) {
      html += '<tr class="border-b">';
      for (const c of cols) {
        const v = it[c];
        html += '<td class="p-2 align-top">' + (v == null ? '' : String(v).replace(/</g,'&lt;')) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    mount.innerHTML = html;
  } catch (e) { mount.textContent = '网络错误: ' + e.message; }
}
async function loadFFR() {
  const mount = document.getElementById('ffr-table');
  mount.textContent = '加载中...';
  try {
    const resp = await fetch('/api/supplier/ffr');
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (!data.ok) { mount.textContent = '加载失败: ' + data.msg; return; }
    const items = data.items;
    if (items.length === 0) { mount.textContent = '暂无数据（请联系管理员绑定客户）'; return; }
    let h = '';
    if (data.repairLineCount || data.repairAsCount) {
      h += '<div class="flex gap-4 mb-3 text-sm"><span class="bg-orange-50 text-orange-700 px-3 py-1 rounded">产线维修品: ' + (data.repairLineCount||0) + '</span>';
      h += '<span class="bg-blue-50 text-blue-700 px-3 py-1 rounded">售后返修品: ' + (data.repairAsCount||0) + '</span></div>';
    }
    h += '<table class="min-w-full text-sm"><thead><tr class="bg-slate-100">';
    h += '<th class="p-2 text-left">型号</th><th class="p-2 text-right">生产数量</th><th class="p-2 text-right">退机数量</th><th class="p-2 text-right">FFR</th>';
    h += '</tr></thead><tbody>';
    for (const it of items) {
      const ffrColor = it.ffr > 5 ? 'text-red-600 font-medium' : it.ffr > 2 ? 'text-yellow-600' : 'text-green-600';
      h += '<tr class="border-b">';
      h += '<td class="p-2">' + (it.model || '-') + '</td>';
      h += '<td class="p-2 text-right">' + it.prod_qty + '</td>';
      h += '<td class="p-2 text-right">' + it.return_qty + '</td>';
      h += '<td class="p-2 text-right ' + ffrColor + '">' + it.ffr + '%</td>';
      h += '</tr>';
    }
    h += '</tbody></table>';
    mount.innerHTML = h;
  } catch (e) { mount.textContent = '网络错误: ' + e.message; }
}
// Repair form submit
async function submitRepairForm(form, kind) {
  const fd = new FormData(form);
  const fields = {};
  for (const [k, v] of fd.entries()) { if (v !== '') fields[k] = v; }
  try {
    const resp = await fetch('/api/repair/submit?kind=' + kind, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(fields)
    });
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (data.ok) {
      showMsg('提交成功 ID: ' + data.id);
      form.reset();
      // Show upload area
      const prefix = kind === 'repair_line' ? 'rl' : 'ras';
      document.getElementById(prefix + '-record-id').textContent = data.id;
      document.getElementById(kind === 'repair_line' ? 'repair-line-upload-area' : 'repair-as-upload-area').classList.remove('hidden');
      window._lastRepairId = data.id;
      window._lastRepairKind = kind;
    } else { showMsg('提交失败: ' + data.msg, false); }
  } catch (e) { showMsg('网络错误: ' + e.message, false); }
}
document.getElementById('form-repair-line')?.addEventListener('submit', (e) => { e.preventDefault(); submitRepairForm(e.target, 'repair_line'); });
document.getElementById('form-repair-as')?.addEventListener('submit', (e) => { e.preventDefault(); submitRepairForm(e.target, 'repair_aftersales'); });

// File upload
async function uploadRepairFiles(kind, prefix) {
  const fileInput = document.getElementById(prefix + '-file-input');
  const msgEl = document.getElementById(prefix + '-upload-msg');
  const recordId = window._lastRepairId;
  if (!recordId) { msgEl.textContent = '请先提交记录'; return; }
  if (!fileInput.files.length) { msgEl.textContent = '请选择文件'; return; }
  const fd = new FormData();
  fd.append('record_id', recordId);
  for (const f of fileInput.files) fd.append('files', f);
  try {
    const resp = await fetch('/api/repair/upload?kind=' + kind, { method: 'POST', body: fd });
    const data = await resp.json();
    if (data.ok) {
      msgEl.innerHTML = '<span class="text-green-600">上传成功: ' + data.uploaded.map(u => u.name).join(', ') + '</span>';
      fileInput.value = '';
    } else { msgEl.innerHTML = '<span class="text-red-600">上传失败: ' + data.msg + '</span>'; }
  } catch (e) { msgEl.innerHTML = '<span class="text-red-600">网络错误</span>'; }
}
document.getElementById('rl-upload-btn')?.addEventListener('click', () => uploadRepairFiles('repair_line', 'rl'));
document.getElementById('ras-upload-btn')?.addEventListener('click', () => uploadRepairFiles('repair_aftersales', 'ras'));

// Load repair history
async function loadProtoBoards() {
  var el = document.getElementById('proto-board-list');
  if (!el) return;
  try {
    var r = await fetch('/api/proto-boards/list');
    var d = await r.json();
    if (!d.ok || !d.boards || !d.boards.length) { el.innerHTML = '<p style="color:#9ca3af;">暂无实验板记录</p>'; return; }
    var h = '<div style="display:grid;gap:12px;">';
    d.boards.forEach(function(b){
      var stages = (b.stages||[]).map(function(s){
        var icon = s.status==='done'?'✅':s.status==='in_progress'?'🔄':'⬜';
        return icon + ' ' + s.stage_name;
      }).join(' → ');
      h += '<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;">'
        + '<div style="font-weight:600;margin-bottom:4px;">' + (b.name||'') + '</div>'
        + '<div style="font-size:13px;color:#6b7280;margin-bottom:4px;">型号: ' + (b.model||'-') + ' | PCB版本: ' + (b.pcb_version||'-') + '</div>'
        + '<div style="font-size:13px;">' + stages + '</div>'
        + '</div>';
    });
    h += '</div>';
    el.innerHTML = h;
  } catch(e) { el.innerHTML = '<p style="color:#ef4444;">加载失败</p>'; }
}

async function loadRepairHistory(kind) {
  const tabId = kind === 'repair_line' ? 'repair-line' : 'repair-as';
  const mount = document.getElementById('table-' + tabId);
  mount.textContent = '加载中...';
  try {
    const resp = await fetch('/api/repair/history?kind=' + kind);
    if (resp.status === 401) { location.href = '/login'; return; }
    const data = await resp.json();
    if (!data.ok) { mount.textContent = '加载失败: ' + data.msg; return; }
    const items = data.items;
    if (items.length === 0) { mount.textContent = '暂无数据'; return; }
    const commonCols = [
      {k:'repair_date',l:'维修日期'},{k:'vehicle_brand',l:'客户'},{k:'model',l:'型号'},
      {k:'sn_whole',l:'整机SN'},{k:'fault_symptom',l:'故障现象'},{k:'fault_cause',l:'故障原因'},
      {k:'defective_part',l:'不良零部件'},{k:'repair_result',l:'维修结果'},{k:'repair_person',l:'维修人员'}
    ];
    const extraCols = kind === 'repair_line'
      ? [{k:'batch_no',l:'批次号'},{k:'station',l:'工位'},{k:'discovery_stage',l:'发现环节'}]
      : [{k:'return_order_no',l:'返修单号'},{k:'in_warranty',l:'在保'},{k:'return_date',l:'寄回'},{k:'ship_date',l:'寄出'}];
    const cols = [...commonCols, ...extraCols];
    let h = '<table class="min-w-full text-sm"><thead><tr class="bg-slate-100">';
    h += cols.map(c => '<th class="p-2 text-left whitespace-nowrap">' + c.l + '</th>').join('');
    h += '<th class="p-2 text-left">附件</th></tr></thead><tbody>';
    for (const it of items) {
      h += '<tr class="border-b">';
      for (const c of cols) {
        const v = it[c.k];
        h += '<td class="p-2 align-top max-w-xs truncate">' + (v == null ? '' : String(v).replace(/</g,'&lt;')) + '</td>';
      }
      const attHtml = (it.attachments || []).map(a =>
        '<a href="/api/repair/attachment/download?id=' + a.id + '" class="text-blue-600 underline text-xs mr-1">' + String(a.name).replace(/</g,'&lt;') + '</a>'
      ).join('');
      h += '<td class="p-2 align-top">' + (attHtml || '-') + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table>';
    mount.innerHTML = h;
  } catch (e) { mount.textContent = '网络错误: ' + e.message; }
}

switchTab('${sess.role === 'supplier_repair' ? 'submit-repair-line' : 'ffr'}');
</script></body></html>`;
}


function adminPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>管理后台</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('users', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div id="msg" class="mb-3 hidden"></div>
  <section class="bg-white rounded shadow p-4 mb-6">
    <h2 class="font-medium mb-3">新建账号</h2>
    <form id="create-form" class="grid grid-cols-4 gap-3">
      <input name="username" placeholder="用户名" class="border rounded p-2" required>
      <input name="password" placeholder="密码 (≥6位)" type="text" class="border rounded p-2" required minlength="6">
      <input name="display_name" placeholder="姓名 (必填)" class="border rounded p-2" required>
      <select name="role" class="border rounded p-2" id="role-sel" required>
        <option value="supplier">供应商</option>
        <option value="supplier_repair">供应商维修组</option>
        <option value="admin">管理员</option>
        <option value="factory">工厂操作员</option>
        <option value="dev">研发组</option>
        ${sess.role === 'super_admin' ? '<option value="super_admin">超级管理员</option>' : ''}
      </select>
      <select name="supplier" class="border rounded p-2" id="sup-sel">
        ${getSuppliersList().map((s) => `<option>${escapeHtml(s)}</option>`).join('')}
      </select>
      <select name="mes_station" class="border rounded p-2" id="station-sel" style="display:none">
        <option value="">不绑定工站</option>
        ${require('./mes').MES_STATIONS.map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('')}
      </select>
      <input name="company_name" placeholder="供应商公司名称 (可选)" class="border rounded p-2">
      <div class="col-span-4"><button class="bg-blue-600 text-white px-4 py-2 rounded" type="submit">创建</button></div>
    </form>
  </section>
  <section class="bg-white rounded shadow p-4">
    <h2 class="font-medium mb-3">账号列表</h2>
    <div id="list">加载中...</div>
  </section>
</div>
<script>
const ME = ${JSON.stringify(sess.username)};
const IS_SUPER = ${sess.role === "super_admin"};
const STATION_LABEL_MAP = ${JSON.stringify(Object.fromEntries(require('./mes').MES_STATIONS.map(s => [s.key, s.label])))};
function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
document.getElementById('role-sel').addEventListener('change', (e) => {
  const v = e.target.value;
  document.getElementById('sup-sel').style.display = (v === 'supplier' || v === 'supplier_repair') ? '' : 'none';
  document.getElementById('station-sel').style.display = v === 'factory' ? '' : 'none';
});
document.getElementById('role-sel').dispatchEvent(new Event('change'));
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
  if (r.status === 401) { location.href = '/login'; return; }
  return r.json();
}
async function refresh() {
  try {
    const r = await fetch('/api/admin/list');
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json();
    if (!d.ok) { document.getElementById('list').innerHTML = '<div class="text-red-600 p-4">加载失败: ' + (d.msg || '未知错误') + '</div>'; return; }
    
    const he = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    
    const rows = d.users.map((u) => {
      const self = u.username === ME;
      const isFeishu = !!u.feishu_open_id;
      const un = he(u.username);
      const dn = he(u.display_name || u.username);
      const sup = he(u.supplier || '-');
      const cn = he(u.company_name || '-');
      const actions = [
        isFeishu ? '' : '<button data-act="chpwd" data-u="' + un + '" class="text-blue-600 mr-2">改密</button>',
        self ? '' : '<button data-act="toggle" data-u="' + un + '" data-d="' + (!u.disabled) + '" class="text-yellow-600 mr-2">' + (u.disabled ? '启用' : '禁用') + '</button>',
        (IS_SUPER && !self) ? '<button data-act="setrole" data-u="' + un + '" class="text-blue-600 mr-2">改角色</button>' : '',
        self ? '' : '<button data-act="delete" data-u="' + un + '" class="text-red-600">删除</button>',
      ].join('');
      const rl = u.role === 'supplier_repair' ? '供应商维修组' : u.role === 'supplier' ? '供应商' : u.role === 'admin' ? '管理员' : u.role === 'super_admin' ? '超级管理员' : u.role === 'factory' ? '工厂操作员' : u.role === 'dev' ? '研发组' : u.role === 'user' ? '普通用户' : u.role;
      const sl = u.mes_station ? (STATION_LABEL_MAP[u.mes_station] || u.mes_station) : '-';
      const fb = isFeishu ? ' <span class="text-xs bg-blue-100 text-blue-700 rounded px-1">飞书</span>' : '';
      return '<tr class="border-b"><td class="p-2">' + un + fb + (self ? ' <span class="text-xs text-slate-400">(你)</span>' : '') + '</td><td class="p-2">' + dn + '</td><td class="p-2">' + he(rl) + '</td><td class="p-2">' + sup + '</td><td class="p-2">' + cn + '</td><td class="p-2">' + he(sl) + '</td><td class="p-2">' + he(u.disabled ? '已禁用' : '正常') + '</td><td class="p-2">' + actions + '</td></tr>';
    }).join('');
    
    document.getElementById('list').innerHTML = '<table class="min-w-full text-sm"><thead><tr class="bg-slate-100 text-left"><th class="p-2">用户名</th><th class="p-2">姓名</th><th class="p-2">角色</th><th class="p-2">供应商</th><th class="p-2">公司名称</th><th class="p-2">绑定工站</th><th class="p-2">状态</th><th class="p-2">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (err) {
    console.error('[refresh error]', err);
    document.getElementById('list').innerHTML = '<div class="text-red-600 p-4">加载失败: ' + err.message + '</div>';
  }
}
document.getElementById('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const u = btn.dataset.u;
  const act = btn.dataset.act;
  if (act === 'chpwd') {
    const p = prompt('给 ' + u + ' 设置新密码 (≥6位):');
    if (!p) return;
    const d = await api('/api/admin/chpwd', { username: u, password: p });
    showMsg(d.ok ? '已改密' : ('失败: ' + d.msg), d.ok);
  } else if (act === 'toggle') {
    const disabled = btn.dataset.d === 'true';
    const d = await api('/api/admin/toggle', { username: u, disabled });
    if (d.ok) { showMsg('已更新'); refresh(); } else showMsg('失败: ' + d.msg, false);
  } else if (act === 'setrole') {
    const roles = ['user', 'admin', 'super_admin', 'supplier', 'supplier_repair', 'factory', 'dev'];
    const labels = ['普通用户', '管理员', '超级管理员', '供应商', '供应商维修组', '工厂操作员', '研发组'];
    const choice = prompt('给 ' + u + ' 设置角色:\\n' + roles.map((r,i) => i+': '+labels[i]).join('\\n'));
    if (choice === null) return;
    const idx = parseInt(choice, 10);
    if (isNaN(idx) || idx < 0 || idx >= roles.length) { showMsg('无效选择', false); return; }
    const d = await api('/api/admin/setrole', { username: u, role: roles[idx] });
    if (d.ok) { showMsg('角色已更新为: ' + labels[idx]); refresh(); } else showMsg('失败: ' + d.msg, false);
  } else if (act === 'delete') {
    if (!confirm('确认删除 ' + u + ' ?')) return;
    const d = await api('/api/admin/delete', { username: u });
    if (d.ok) { showMsg('已删除'); refresh(); } else showMsg('失败: ' + d.msg, false);
  }
});
document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = { username: fd.get('username'), password: fd.get('password'), display_name: fd.get('display_name'), role: fd.get('role') };
  if (body.role === 'supplier' || body.role === 'supplier_repair') body.supplier = fd.get('supplier');
  if (body.role === 'factory' && fd.get('mes_station')) body.mes_station = fd.get('mes_station');
  if (fd.get('company_name')) body.company_name = fd.get('company_name');
  const d = await api('/api/admin/create', body);
  if (d.ok) { showMsg('已创建'); e.target.reset(); refresh(); } else showMsg('失败: ' + d.msg, false);
});
refresh();
</script></body></html>`;
}

function adminBrandsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>客户管理</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('brands', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div id="msg" class="mb-3 hidden"></div>
  <section class="bg-white rounded shadow p-4 mb-6">
    <h2 class="font-medium mb-3">新增客户</h2>
    <form id="create-form" class="flex gap-3">
      <input name="name" placeholder="客户" class="border rounded p-2 flex-1" required>
      <input name="sort_order" placeholder="排序(数字)" type="number" class="border rounded p-2 w-32">
      <button class="bg-blue-600 text-white px-4 py-2 rounded" type="submit">添加</button>
    </form>
  </section>
  <section class="bg-white rounded shadow p-4">
    <h2 class="font-medium mb-3">客户列表</h2>
    <div id="list">加载中...</div>
  </section>
</div>
<script>
function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
  if (r.status === 401) { location.href = '/login'; return; }
  return r.json();
}
async function refresh() {
  const r = await fetch('/api/admin/brands/list');
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  if (!d.ok) { document.getElementById('list').textContent = '加载失败'; return; }
  if (d.brands.length === 0) { document.getElementById('list').textContent = '暂无客户'; return; }
  const rows = d.brands.map(b => {
    return \`<tr class="border-b">
      <td class="p-2">\${b.id}</td>
      <td class="p-2">\${b.name}</td>
      <td class="p-2">\${b.sort_order}</td>
      <td class="p-2">\${b.enabled ? '<span class="text-green-700">启用</span>' : '<span class="text-slate-400">禁用</span>'}</td>
      <td class="p-2 space-x-2">
        <button data-act="edit" data-id="\${b.id}" data-name="\${b.name}" data-sort="\${b.sort_order}" class="text-blue-600">编辑</button>
        <button data-act="toggle" data-id="\${b.id}" data-enabled="\${b.enabled}" class="text-yellow-600">\${b.enabled ? '禁用' : '启用'}</button>
        <button data-act="delete" data-id="\${b.id}" data-name="\${b.name}" class="text-red-600">删除</button>
      </td>
    </tr>\`;
  }).join('');
  document.getElementById('list').innerHTML = \`<table class="min-w-full text-sm"><thead><tr class="bg-slate-100 text-left"><th class="p-2">ID</th><th class="p-2">名称</th><th class="p-2">排序</th><th class="p-2">状态</th><th class="p-2">操作</th></tr></thead><tbody>\${rows}</tbody></table>\`;
}
document.getElementById('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  if (act === 'edit') {
    const name = prompt('修改名称:', btn.dataset.name);
    if (name === null) return;
    const sortStr = prompt('修改排序(数字):', btn.dataset.sort);
    if (sortStr === null) return;
    const d = await api('/api/admin/brands/update', { id, name, sort_order: Number(sortStr) });
    if (d.ok) { showMsg('已更新'); refresh(); } else showMsg('失败: ' + d.msg, false);
  } else if (act === 'toggle') {
    const enabled = btn.dataset.enabled !== '1' && btn.dataset.enabled !== 'true' ? 1 : 0;
    const d = await api('/api/admin/brands/update', { id, enabled });
    if (d.ok) { showMsg('已更新'); refresh(); } else showMsg('失败: ' + d.msg, false);
  } else if (act === 'delete') {
    if (!confirm('确认删除「' + btn.dataset.name + '」?')) return;
    const d = await api('/api/admin/brands/delete', { id });
    if (d.ok) { showMsg('已删除'); refresh(); } else showMsg('失败: ' + d.msg, false);
  }
});
document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const d = await api('/api/admin/brands/create', { name: fd.get('name'), sort_order: Number(fd.get('sort_order') || 0) });
  if (d.ok) { showMsg('已添加'); e.target.reset(); refresh(); } else showMsg('失败: ' + d.msg, false);
});
refresh();
</script></body></html>`;
}

function adminSuppliersPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>供应商管理</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style>
</head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('suppliers', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div id="msg" class="mb-3 hidden"></div>
  <section class="bg-white rounded shadow p-6 mb-4">
    <h2 class="font-medium mb-4 text-lg">新增供应商</h2>
    <div class="flex gap-3 items-center mb-6">
      <input id="new-supplier-name" placeholder="输入供应商名称" class="border rounded p-2 w-64 text-sm" autocomplete="off">
      <button id="add-supplier-btn" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">新增供应商</button>
    </div>
    <h3 class="font-medium mb-3 text-sm text-slate-600">已有供应商</h3>
    <div id="supplier-list" class="flex flex-wrap gap-2">加载中...</div>
  </section>
</div>
<script>
function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
async function loadSuppliers() {
  const r = await fetch('/api/admin/suppliers/list');
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  if (!d.ok) return;
  const container = document.getElementById('supplier-list');
  if (!d.suppliers.length) { container.innerHTML = '<span class="text-sm text-slate-400">暂无供应商</span>'; return; }
  container.innerHTML = d.suppliers.map(s =>
    '<span class="inline-flex items-center gap-2 bg-slate-100 rounded-full px-4 py-1.5 text-sm font-medium">'
    + s.name
    + ' <button data-id="' + s.id + '" data-name="' + (s.name||'').replace(/"/g,'&quot;') + '" onclick="deleteSupplierBtn(this)" class="text-red-400 hover:text-red-600 text-xs font-bold">&times;</button>'
    + '</span>'
  ).join('');

}
function deleteSupplierBtn(btn) {
  const id = parseInt(btn.dataset.id);
  const name = btn.dataset.name;
  deleteSupplier(id, name);
}
async function deleteSupplier(id, name) {
  if (!confirm('确认删除供应商「' + name + '」？此操作不可撤销。')) return;
  const r = await fetch('/api/admin/suppliers/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
  const d = await r.json();
  if (d.ok) { showMsg('已删除: ' + name); loadSuppliers(); }
  else showMsg('删除失败: ' + d.msg, false);
}
document.getElementById('add-supplier-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-supplier-name').value.trim();
  if (!name) { showMsg('请输入供应商名称', false); return; }
  const r = await fetch('/api/admin/suppliers/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
  const d = await r.json();
  if (d.ok) { showMsg('已添加: ' + name); document.getElementById('new-supplier-name').value = ''; loadSuppliers(); }
  else showMsg('失败: ' + d.msg, false);
});
document.getElementById('new-supplier-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-supplier-btn').click();
});
loadSuppliers();
</script></body></html>`;
}

function adminBindingsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>供应商-客户绑定</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('bindings', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div id="msg" class="mb-3 hidden"></div>

  <section class="bg-white rounded shadow p-4">
    <h2 class="font-medium mb-3">供应商-客户绑定管理</h2>
    <p class="text-sm text-slate-500 mb-4">为每个供应商配置可见的客户，供应商只能看到已绑定客户的数据</p>
    <div id="bindings-list">加载中...</div>
  </section>
</div>
<script>
function showMsg(text, ok = true) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
let _data = null;
async function refresh() {
  const r = await fetch('/api/admin/bindings/list');
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  if (!d.ok) { document.getElementById('bindings-list').textContent = '加载失败'; return; }
  _data = d;
  render();
}
function render() {
  const { suppliers, brands, bindings } = _data;
  const container = document.getElementById('bindings-list');
  let h = '';
  for (const sup of suppliers) {
    const bound = bindings[sup] || [];
    const boundIds = new Set(bound.map(b => b.brand_id));
    h += '<div class="mb-6 border rounded p-4">';
    h += '<h3 class="font-medium text-lg mb-2">' + sup + '</h3>';
    h += '<div class="flex flex-wrap gap-2 mb-3">';
    for (const br of brands) {
      const checked = boundIds.has(br.id) ? 'checked' : '';
      const disabledStyle = br.enabled ? '' : 'opacity-50';
      h += '<label class="inline-flex items-center gap-1 text-sm ' + disabledStyle + '">'
        + '<input type="checkbox" data-sup="' + sup + '" data-bid="' + br.id + '" ' + checked + '>'
        + br.name + (br.enabled ? '' : ' (已禁用)') + '</label>';
    }
    h += '</div>';
    h += '<button class="save-btn bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700" data-sup="' + sup + '">保存</button>';
    h += '</div>';
  }
  container.innerHTML = h;
}
document.getElementById('bindings-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.save-btn');
  if (!btn) return;
  const sup = btn.dataset.sup;
  const checks = document.querySelectorAll('input[data-sup="' + sup + '"]');
  const brandIds = [];
  checks.forEach(c => { if (c.checked) brandIds.push(Number(c.dataset.bid)); });
  btn.disabled = true; btn.textContent = '保存中...';
  try {
    const r = await fetch('/api/admin/bindings/update', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ supplier_name: sup, brand_ids: brandIds })
    });
    const d = await r.json();
    if (d.ok) { showMsg(sup + ' 绑定已更新'); await refresh(); }
    else showMsg('失败: ' + d.msg, false);
  } catch(e) { showMsg('网络错误', false); }
  btn.disabled = false; btn.textContent = '保存';
});
refresh();
</script></body></html>`;
}

function adminApiKeysPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const suppliersOpts = getSuppliersList().map(s => `<option>${escapeHtml(s)}</option>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>API Key 管理</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('api-keys', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div id="msg" class="mb-3 hidden"></div>

  <!-- 生成新 Key -->
  <section class="bg-white rounded shadow p-4 mb-6">
    <h2 class="font-medium mb-3">生成新 API Key</h2>
    <form id="create-form" class="flex flex-wrap gap-3 items-end">
      <label class="flex flex-col text-sm">供应商
        <select name="supplier_id" required class="border rounded p-2 mt-1">${suppliersOpts}</select>
      </label>
      <label class="flex flex-col text-sm">Key 名称（如：东原产线A）
        <input name="name" required placeholder="产线名称" class="border rounded p-2 mt-1 w-48">
      </label>
      <button class="bg-blue-600 text-white px-4 py-2 rounded self-end" type="submit">生成</button>
    </form>
  </section>

  <!-- Key 列表 -->
  <section class="bg-white rounded shadow p-4">
    <h2 class="font-medium mb-3">API Key 列表</h2>
    <div id="list">加载中...</div>
  </section>
</div>

<!-- 一次性展示弹窗 -->
<div id="key-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg">
    <h2 class="text-lg font-semibold mb-2 text-green-700">API Key 已生成（仅显示一次）</h2>
    <p class="text-sm text-slate-500 mb-3">请立即复制此 Key，关闭后无法再查看完整内容。</p>
    <div class="bg-slate-100 rounded p-3 font-mono text-sm break-all" id="key-display"></div>
    <div class="flex gap-3 mt-4">
      <button id="btn-copy-key" class="bg-blue-600 text-white px-4 py-2 rounded text-sm">复制</button>
      <button id="btn-close-modal" class="border px-4 py-2 rounded text-sm">已复制，关闭</button>
    </div>
    <div id="copy-hint" class="text-xs text-green-600 mt-2 hidden">已复制到剪贴板</div>
  </div>
</div>

<script>
function showMsg(text, ok=true) {
  const el=document.getElementById('msg');
  el.className='mb-3 px-4 py-2 rounded '+(ok?'bg-green-100 text-green-800':'bg-red-100 text-red-800');
  el.textContent=text; el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'),5000);
}
async function api(path,body) {
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  if(r.status===401){location.href='/login';return;}
  return r.json();
}
function fmtDate(ts) {
  if(!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
}
async function refresh() {
  const r=await fetch('/api/admin/api-keys/list');
  if(r.status===401){location.href='/login';return;}
  const d=await r.json();
  if(!d.ok){document.getElementById('list').textContent='加载失败';return;}
  if(!d.keys.length){document.getElementById('list').textContent='暂无 API Key';return;}
  const rows=d.keys.map(k=>{
    const status=k.status==='active'?'<span class="text-green-700">有效</span>':'<span class="text-red-500">已吊销</span>';
    const revoke=k.status==='active'?'<button data-act="revoke" data-id="'+k.id+'" class="text-red-600 text-xs">吊销</button>':'<span class="text-slate-300 text-xs">-</span>';
    return '<tr class="border-b"><td class="p-2">'+escapeHtml(k.supplier_id)+'</td><td class="p-2">'+escapeHtml(k.name)+'</td><td class="p-2 font-mono text-xs">'+escapeHtml(k.prefix)+'****</td><td class="p-2">'+status+'</td><td class="p-2 text-xs">'+fmtDate(k.created_at)+'</td><td class="p-2 text-xs">'+fmtDate(k.last_used_at)+'</td><td class="p-2">'+revoke+'</td></tr>';
  }).join('');
  document.getElementById('list').innerHTML='<div class="overflow-x-auto"><table class="min-w-full text-sm"><thead><tr class="bg-slate-100"><th class="p-2 text-left">供应商</th><th class="p-2 text-left">名称</th><th class="p-2 text-left">前缀</th><th class="p-2 text-left">状态</th><th class="p-2 text-left">创建时间</th><th class="p-2 text-left">上次使用</th><th class="p-2 text-left">操作</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
document.getElementById('list').addEventListener('click',async e=>{
  const btn=e.target.closest('button[data-act]');
  if(!btn)return;
  if(btn.dataset.act==='revoke'){
    if(!confirm('确认吊销此 API Key？吊销后产线无法继续上传数据。'))return;
    const d=await api('/api/admin/api-keys/revoke',{id:Number(btn.dataset.id)});
    if(d.ok){showMsg('已吊销');refresh();}else showMsg('失败: '+d.msg,false);
  }
});
document.getElementById('create-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const fd=new FormData(e.target);
  const d=await api('/api/admin/api-keys/create',{supplier_id:fd.get('supplier_id'),name:fd.get('name')});
  if(d.ok){
    e.target.reset();
    document.getElementById('key-display').textContent=d.key;
    document.getElementById('key-modal').classList.remove('hidden');
    refresh();
  }else{showMsg('失败: '+d.msg,false);}
});
document.getElementById('btn-copy-key').addEventListener('click',()=>{
  navigator.clipboard.writeText(document.getElementById('key-display').textContent).then(()=>{
    document.getElementById('copy-hint').classList.remove('hidden');
  });
});
document.getElementById('btn-close-modal').addEventListener('click',()=>{
  document.getElementById('key-modal').classList.add('hidden');
  document.getElementById('copy-hint').classList.add('hidden');
});
refresh();
</script></body></html>`;
}

function adminMainboardTestsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const suppliersOpts = getSuppliersList().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>测试记录</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('mainboard-tests', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">

  <!-- 筛选 -->
  <div class="bg-white rounded shadow p-4 mb-4 flex flex-wrap gap-3 items-end">
    <label class="flex flex-col text-sm">MAC 搜索
      <input id="f-mac" class="border rounded p-1 mt-1 w-44" placeholder="模糊匹配"></label>
    <label class="flex flex-col text-sm">时间从
      <input type="text" autocomplete="off" id="f-date-from" class="border rounded p-1 mt-1"></label>
    <label class="flex flex-col text-sm">时间至
      <input type="text" autocomplete="off" id="f-date-to" class="border rounded p-1 mt-1"></label>
    <label class="flex flex-col text-sm">测试结果
      <select id="f-result" class="border rounded p-1 mt-1">
        <option value="">全部</option>
        <option value="PASS">PASS</option>
        <option value="FAIL">FAIL</option>
      </select></label>
    <label class="flex flex-col text-sm">供应商
      <select id="f-supplier" class="border rounded p-1 mt-1">
        <option value="">全部</option>
        ${suppliersOpts}
      </select></label>
    <button id="btn-query" class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm self-end">查询</button>
    <button id="btn-export" class="px-3 py-1.5 bg-green-600 text-white rounded text-sm self-end">导出 Excel</button>
  </div>

  <div class="bg-white rounded shadow p-4">
    <div id="list-info" class="text-sm text-slate-500 mb-2"></div>
    <div id="list" class="overflow-x-auto">加载中...</div>
  </div>
</div>
<script>
function fmtDate(ts){if(!ts)return'-';return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function buildQuery(){
  const p=[];
  const mac=document.getElementById('f-mac').value.trim();
  const df=document.getElementById('f-date-from').value;
  const dt=document.getElementById('f-date-to').value;
  const res=document.getElementById('f-result').value;
  const sup=document.getElementById('f-supplier').value;
  if(mac)p.push('mac='+encodeURIComponent(mac));
  if(df)p.push('date_from='+df);
  if(dt)p.push('date_to='+dt);
  if(res)p.push('test_result='+res);
  if(sup)p.push('supplier_id='+encodeURIComponent(sup));
  return p.join('&');
}
async function load(){
  document.getElementById('list').textContent='加载中...';
  const r=await fetch('/api/admin/mainboard-tests?'+buildQuery());
  if(r.status===401){location.href='/login';return;}
  const d=await r.json();
  if(!d.ok){document.getElementById('list').textContent='加载失败: '+d.msg;return;}
  const items=d.items;
  document.getElementById('list-info').textContent='共 '+items.length+' 条记录';
  if(!items.length){document.getElementById('list').innerHTML='<p class="text-slate-400 py-4 text-sm">暂无数据</p>';return;}
  let h='<table class="min-w-full text-xs"><thead><tr class="bg-slate-100">';
  ['测试时间','供应商','MAC地址','硬件版本','固件Mode','产品型号','批次号','结果'].forEach(c=>{
    h+='<th class="p-2 text-left whitespace-nowrap">'+c+'</th>';
  });
  h+='</tr></thead><tbody>';
  for(const it of items){
    const rc=it.test_result==='PASS'?'text-green-700 font-medium':'text-red-600 font-medium';
    h+='<tr class="border-b hover:bg-slate-50">';
    h+='<td class="p-2 whitespace-nowrap">'+fmtDate(it.tested_at)+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.supplier_id)+'</td>';
    h+='<td class="p-2 font-mono">'+escapeHtml(it.mac_address)+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.hardware_version)+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.firmware_mode)+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.product_model||'')+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.batch_no||'')+'</td>';
    h+='<td class="p-2 '+rc+'">'+escapeHtml(it.test_result)+'</td>';
    h+='</tr>';
  }
  h+='</tbody></table>';
  document.getElementById('list').innerHTML=h;
}
document.getElementById('btn-query').addEventListener('click',load);
document.getElementById('btn-export').addEventListener('click',()=>{
  window.location.href='/api/admin/mainboard-tests/export?'+buildQuery();
});
['f-mac'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')load();});
});
load();
</script></body></html>`;
}

function supplierMainboardTestsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const supplier = escapeHtml(sess.supplier || '');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>主板测试记录 - ${supplier}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
<div class="max-w-5xl mx-auto p-4">
  <header class="mb-4 flex justify-between items-center">
    <div>
      <h1 class="text-2xl font-semibold">雷石质量管理系统</h1>
      <div class="text-sm text-slate-500">账号: <span class="font-medium text-slate-800">${uname}</span> / 供应商: <span class="font-medium text-slate-800">${supplier}</span></div>
    </div>
    <div class="text-sm space-x-3"><a href="/" class="text-blue-600 hover:underline">返回填报</a> <a href="/logout" class="text-blue-600 hover:underline">退出</a></div>
  </header>
  <div class="mb-4 bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-700">
    主板测试记录（仅显示本供应商数据）
  </div>

  <!-- 筛选 -->
  <div class="bg-white rounded shadow p-4 mb-4 flex flex-wrap gap-3 items-end">
    <label class="flex flex-col text-sm">MAC 搜索
      <input id="f-mac" class="border rounded p-1 mt-1 w-40" placeholder="模糊匹配"></label>
    <label class="flex flex-col text-sm">时间从
      <input type="text" autocomplete="off" id="f-date-from" class="border rounded p-1 mt-1"></label>
    <label class="flex flex-col text-sm">时间至
      <input type="text" autocomplete="off" id="f-date-to" class="border rounded p-1 mt-1"></label>
    <label class="flex flex-col text-sm">测试结果
      <select id="f-result" class="border rounded p-1 mt-1">
        <option value="">全部</option>
        <option value="PASS">PASS</option>
        <option value="FAIL">FAIL</option>
      </select></label>
    <button id="btn-query" class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm self-end">查询</button>
  </div>

  <div class="bg-white rounded shadow p-4">
    <div id="list-info" class="text-sm text-slate-500 mb-2"></div>
    <div id="list" class="overflow-x-auto">加载中...</div>
  </div>
</div>
<script>
function fmtDate(ts){if(!ts)return'-';return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function buildQuery(){
  const p=[];
  const mac=document.getElementById('f-mac').value.trim();
  const df=document.getElementById('f-date-from').value;
  const dt=document.getElementById('f-date-to').value;
  const res=document.getElementById('f-result').value;
  if(mac)p.push('mac='+encodeURIComponent(mac));
  if(df)p.push('date_from='+df);
  if(dt)p.push('date_to='+dt);
  if(res)p.push('test_result='+res);
  return p.join('&');
}
async function load(){
  document.getElementById('list').textContent='加载中...';
  const r=await fetch('/api/supplier/mainboard-tests?'+buildQuery());
  if(r.status===401){location.href='/login';return;}
  const d=await r.json();
  if(!d.ok){document.getElementById('list').textContent='加载失败: '+d.msg;return;}
  const items=d.items;
  document.getElementById('list-info').textContent='共 '+items.length+' 条记录';
  if(!items.length){document.getElementById('list').innerHTML='<p class="text-slate-400 py-4 text-sm">暂无数据</p>';return;}
  let h='<table class="min-w-full text-xs"><thead><tr class="bg-slate-100">';
  ['测试时间','MAC地址','硬件版本','固件Mode','产品型号','批次号','结果'].forEach(c=>{
    h+='<th class="p-2 text-left whitespace-nowrap">'+c+'</th>';
  });
  h+='</tr></thead><tbody>';
  for(const it of items){
    const rc=it.test_result==='PASS'?'text-green-700 font-medium':'text-red-600 font-medium';
    h+='<tr class="border-b hover:bg-slate-50">';
    h+='<td class="p-2 whitespace-nowrap">'+fmtDate(it.tested_at)+'</td>';
    h+='<td class="p-2 font-mono">'+escapeHtml(it.mac_address)+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.hardware_version)+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.firmware_mode)+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.product_model||'')+'</td>';
    h+='<td class="p-2">'+escapeHtml(it.batch_no||'')+'</td>';
    h+='<td class="p-2 '+rc+'">'+escapeHtml(it.test_result)+'</td>';
    h+='</tr>';
  }
  h+='</tbody></table>';
  document.getElementById('list').innerHTML=h;
}
document.getElementById('btn-query').addEventListener('click',load);
document.getElementById('f-mac').addEventListener('keydown',e=>{if(e.key==='Enter')load();});
load();
</script></body></html>`;
}

function adminDashboardPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const suppliersJson = JSON.stringify(getSuppliersList());
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>数据看板</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}
.chart-wrap{position:relative;height:260px}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('dashboard', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">

  <!-- Filters -->
  <div style="background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.07);padding:16px 20px;margin-bottom:20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
    <span style="font-size:14px;color:#6b7280;white-space:nowrap;">日期:
      <input type="text" autocomplete="off" id="f-date-from" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;width:90px;margin:0 4px;" placeholder="开始">
      至
      <input type="text" autocomplete="off" id="f-date-to" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;width:90px;margin-left:4px;" placeholder="结束">
    </span>
    <span style="font-size:14px;color:#6b7280;white-space:nowrap;">客户:
      <select id="f-brand" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;margin-left:4px;">
        <option value="">全部</option>
      </select>
    </span>
    <span style="font-size:14px;color:#6b7280;white-space:nowrap;">供应商:
      <select id="f-supplier" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;margin-left:4px;">
        <option value="">全部</option>
        ${getSuppliersList().map(s => '<option>' + escapeHtml(s) + '</option>').join('')}
      </select>
    </span>
    <span style="font-size:14px;color:#6b7280;white-space:nowrap;">产品型号:
      <input id="f-model" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;width:100px;margin-left:4px;" placeholder="">
    </span>
    <span style="font-size:14px;color:#6b7280;white-space:nowrap;">故障类型:
      <select id="f-defect" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;margin-left:4px;">
        <option value="">全部</option>
        ${DEFECT_TYPES.map(t => '<option>' + escapeHtml(t) + '</option>').join('')}
      </select>
    </span>
    <button id="btn-export" style="margin-left:auto;background:#16a34a;color:#fff;border:none;border-radius:6px;padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;">导出Excel</button>
  </div>

  <!-- KPI Cards -->
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px;">
    <div style="background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.07);padding:24px;text-align:center;">
      <div style="font-size:36px;font-weight:700;color:#2563eb;" id="kpi-ffr">-</div>
      <div style="font-size:13px;color:#9ca3af;margin-top:6px;">总 FFR%</div>
    </div>
    <div style="background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.07);padding:24px;text-align:center;">
      <div style="font-size:36px;font-weight:700;color:#111827;" id="kpi-prod">-</div>
      <div style="font-size:13px;color:#9ca3af;margin-top:6px;">总生产数(实际产出)</div>
    </div>
    <div style="background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.07);padding:24px;text-align:center;">
      <div style="font-size:36px;font-weight:700;color:#dc2626;" id="kpi-ret">-</div>
      <div style="font-size:13px;color:#9ca3af;margin-top:6px;">总退机数</div>
    </div>
  </div>

  <!-- Top FFR Cards -->
  <div class="bg-white rounded-lg shadow p-4 mb-4">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium text-gray-800">FFR TOP 6</span>
        <span class="text-xs text-gray-500" id="top-ffr-min-hint">仅统计生产 ≥ 10 台的项目</span>
      </div>
      <div class="flex gap-1" id="top-ffr-dims">
        <button class="top-ffr-dim-btn px-3 py-1 rounded text-xs font-medium bg-blue-600 text-white" data-dim="model_brand">机型-客户</button>
        <button class="top-ffr-dim-btn px-3 py-1 rounded text-xs font-medium text-gray-600 hover:bg-gray-200" data-dim="model">机型</button>
        <button class="top-ffr-dim-btn px-3 py-1 rounded text-xs font-medium text-gray-600 hover:bg-gray-200" data-dim="vehicle_brand">客户</button>
        <button class="top-ffr-dim-btn px-3 py-1 rounded text-xs font-medium text-gray-600 hover:bg-gray-200" data-dim="supplier">供应商</button>
        <button class="top-ffr-dim-btn px-3 py-1 rounded text-xs font-medium text-gray-600 hover:bg-gray-200" data-dim="model_version">按型号</button>
      </div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" id="top-ffr-cards">
      <div class="text-slate-400 text-sm col-span-full text-center py-4">加载中...</div>
    </div>
  </div>

  <!-- Charts -->
  <div class="grid grid-cols-2 gap-4 mb-4">
    <div class="bg-white rounded shadow p-4">
      <h3 class="font-medium mb-2 text-sm text-slate-600">按月 FFR 趋势</h3>
      <div class="chart-wrap"><canvas id="chart-month"></canvas></div>
    </div>
    <div class="bg-white rounded shadow p-4">
      <h3 class="font-medium mb-2 text-sm text-slate-600">按供应商 FFR（高→低）</h3>
      <div class="chart-wrap"><canvas id="chart-supplier"></canvas></div>
    </div>
    <div class="bg-white rounded shadow p-4">
      <h3 class="font-medium mb-2 text-sm text-slate-600">按机型 FFR（高→低）</h3>
      <div class="chart-wrap"><canvas id="chart-model"></canvas></div>
    </div>
    <div class="bg-white rounded shadow p-4">
      <h3 class="font-medium mb-2 text-sm text-slate-600">按客户 FFR（高→低）</h3>
      <div class="chart-wrap"><canvas id="chart-brand"></canvas></div>
    </div>
  </div>

  <!-- Supplier Production Charts -->
  <div class="grid grid-cols-2 gap-4 mb-4">
    <div class="bg-white rounded shadow p-4" style="display:flex;flex-direction:column;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h3 class="font-medium text-sm text-slate-600" style="margin:0;">按供应商生产数量</h3>
        <button id="btn-supplier-prod-detail" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:3px 12px;font-size:12px;font-weight:500;cursor:pointer;">明细</button>
      </div>
      <div class="chart-wrap" style="flex:1;min-height:300px"><canvas id="chart-supplier-prod"></canvas></div>
    </div>
    <div class="bg-white rounded shadow p-4" style="display:flex;flex-direction:column;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 class="font-medium text-sm text-slate-600" style="margin:0;">供应商生产数量占比</h3>
        <div style="display:flex;gap:12px;align-items:center;">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;">品类: <select id="pie-filter-category" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;"><option value="">全部</option></select></label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;">供应商: <select id="pie-filter-supplier" style="border:1px solid #e5e7eb;border-radius:4px;padding:4px 8px;font-size:13px;"><option value="">全部</option></select></label>
        </div>
      </div>
      <div style="display:flex;justify-content:center;flex:1;min-height:350px;position:relative;">
        <div class="chart-wrap" style="width:100%;height:350px;position:relative;"><canvas id="chart-supplier-ratio-pie"></canvas></div>
      </div>
    </div>
  </div>


  <!-- Daily Trend Chart -->
  <div class="bg-white rounded shadow p-4 mb-4">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <h3 class="font-medium text-sm text-slate-600" style="margin:0;">每日录入数量走势</h3>
      <div style="display:flex;gap:8px;align-items:center;">
        <div id="trend-range-btns" style="display:flex;gap:4px;">
          <button class="trend-range-btn px-3 py-1 rounded text-xs font-medium text-gray-600 hover:bg-gray-200" data-days="7">近7天</button>
          <button class="trend-range-btn px-3 py-1 rounded text-xs font-medium bg-blue-600 text-white" data-days="30">近30天</button>
        </div>
        <button id="btn-user-stats" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:4px 14px;font-size:13px;font-weight:500;cursor:pointer;">明细</button>
      </div>
    </div>
    <div style="position:relative;height:220px;"><canvas id="chart-daily-trend"></canvas></div>
  </div>
  <!-- Detail Tabs -->
  <div class="bg-white rounded shadow p-4">
    <div class="flex gap-2 mb-4 border-b pb-2">
      <button class="dtab-btn px-3 py-1 text-sm font-medium" data-kind="prod">生产明细</button>
      <button class="dtab-btn px-3 py-1 text-sm font-medium" data-kind="return">退机明细</button>
    </div>

    <!-- Detail Filters -->
    <div class="bg-slate-50 rounded p-3 mb-4 flex flex-wrap gap-3 items-end">
      <label class="flex flex-col text-sm">日期从<input type="text" autocomplete="off" id="detail-f-date-from" class="border rounded p-1 mt-1"></label>
      <label class="flex flex-col text-sm">日期至<input type="text" autocomplete="off" id="detail-f-date-to" class="border rounded p-1 mt-1"></label>
      <label class="flex flex-col text-sm">供应商
        <select id="detail-f-supplier" class="border rounded p-1 mt-1">
          <option value="">全部</option>
          ${getSuppliersList().map(s => `<option>${escapeHtml(s)}</option>`).join('')}
        </select>
      </label>
      <label class="flex flex-col text-sm">客户
        <select id="detail-f-brand" class="border rounded p-1 mt-1">
          <option value="">全部</option>
        </select>
      </label>
      <label class="flex flex-col text-sm">机型/型号
        <input id="detail-f-model" class="border rounded p-1 mt-1 w-28" placeholder="模糊匹配">
      </label>
      <button id="btn-detail-query" class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm mt-auto">查询</button>
      <button id="btn-detail-reset" class="px-3 py-1.5 bg-slate-400 text-white rounded text-sm mt-auto">重置</button>
    </div>

    <div id="detail-table">加载中...</div>
  </div>
</div>

<!-- Edit Modal -->
<div id="edit-modal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg max-h-screen overflow-y-auto">
    <h2 class="text-lg font-semibold mb-4">编辑记录</h2>
    <form id="edit-form" class="grid grid-cols-2 gap-3">
      <input type="hidden" name="_kind" id="ef-kind">
      <input type="hidden" name="_id" id="ef-id">
    </form>
    <div id="edit-msg" class="text-sm text-red-600 mt-2 min-h-[1em]"></div>
    <div class="flex gap-3 mt-4">
      <button id="btn-edit-save" class="bg-blue-600 text-white px-4 py-2 rounded">保存</button>
      <button id="btn-edit-cancel" class="border px-4 py-2 rounded">取消</button>
    </div>
  </div>
</div>

<!-- User Stats Modal (录入明细 - 每条记录展开) -->
<div id="user-stats-modal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-xl p-6 w-full max-h-screen overflow-y-auto" style="max-width:820px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 class="text-lg font-semibold">录入明细</h2>
      <button id="btn-user-stats-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#6b7280;">&times;</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;">
      <span style="font-size:13px;color:#6b7280;">时间范围:</span>
      <div id="user-stats-range-btns" style="display:flex;gap:4px;">
        <button class="us-range-btn px-3 py-1 rounded text-xs font-medium text-gray-600 hover:bg-gray-200" data-days="1">今日</button>
        <button class="us-range-btn px-3 py-1 rounded text-xs font-medium bg-blue-600 text-white" data-days="7">近7天</button>
        <button class="us-range-btn px-3 py-1 rounded text-xs font-medium text-gray-600 hover:bg-gray-200" data-days="30">近30天</button>
      </div>
    </div>
    <div id="user-stats-table">加载中...</div>
    <div id="user-stats-pagination" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:13px;color:#6b7280;"></div>
  </div>
</div>
<!-- Export module selection modal -->
<div id="export-modal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-xl p-6 w-80">
    <h3 class="text-base font-semibold mb-4">选择导出模块</h3>
    <div class="space-y-3 mb-5">
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" class="export-mod-cb w-4 h-4" value="dashboard" checked>
        <span class="text-sm">仪表盘（汇总指标 + FFR TOP6）</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" class="export-mod-cb w-4 h-4" value="prod" checked>
        <span class="text-sm">生产数据</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" class="export-mod-cb w-4 h-4" value="return" checked>
        <span class="text-sm">退机数量</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" class="export-mod-cb w-4 h-4" value="ffr" checked>
        <span class="text-sm">FFR（按供应商/机型/客户/月份）</span>
      </label>
    </div>
    <div class="flex gap-3 justify-end">
      <button id="export-cancel" class="border px-4 py-2 rounded text-sm text-slate-600 hover:bg-slate-50">取消</button>
      <button id="export-confirm" class="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700">确认导出</button>
    </div>
  </div>
</div>

<script>
const SUPPLIERS = ${suppliersJson};
let _charts = {};
let _currentKind = 'prod';
let _filters = {};
let _brands = [];
let _topFfrDim = 'model_brand';

// Load brands for filter
async function loadBrandsFilter() {
  const r = await fetch('/api/admin/brands/list');
  const d = await r.json();
  if (d.ok) {
    _brands = d.brands.filter(b => b.enabled);
    // Main filters
    const sel = document.getElementById('f-brand');
    d.brands.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.name; opt.textContent = b.name;
      sel.appendChild(opt);
    });
    // Detail filters
    const detailSel = document.getElementById('detail-f-brand');
    if (detailSel) {
      d.brands.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.name; opt.textContent = b.name;
        detailSel.appendChild(opt);
      });
    }
  }
}

function getFilters() {
  return {
    date_from: document.getElementById('f-date-from').value,
    date_to: document.getElementById('f-date-to').value,
    supplier: document.getElementById('f-supplier').value,
    vehicle_brand: document.getElementById('f-brand').value,
    model: document.getElementById('f-model').value,
    defect_type: document.getElementById('f-defect').value,
  };
}

function getDetailFilters() {
  return {
    date_from: document.getElementById('detail-f-date-from').value,
    date_to: document.getElementById('detail-f-date-to').value,
    supplier: document.getElementById('detail-f-supplier').value,
    vehicle_brand: document.getElementById('detail-f-brand').value,
    model: document.getElementById('detail-f-model').value,
  };
}

function buildQuery(extra = {}) {
  const f = { ...getFilters(), ...extra };
  return Object.entries(f).filter(([,v]) => v).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
}

function buildDetailQuery(extra = {}) {
  const f = { ...getDetailFilters(), ...extra };
  return Object.entries(f).filter(([,v]) => v).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
}

// Charts
function makeBarChart(id, labels, data, color) {
  if (_charts[id]) { _charts[id].destroy(); }
  _charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'FFR%', data, backgroundColor: color || 'rgba(59,130,246,0.7)', borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' } } }
    }
  });
}

function makeLineChart(id, labels, data) {
  if (_charts[id]) { _charts[id].destroy(); }
  _charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: {
      labels,
      datasets: [{ label: 'FFR%', data, borderColor: 'rgb(59,130,246)', backgroundColor: 'rgba(59,130,246,0.1)', tension: 0.3, fill: true, pointRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' } } }
    }
  });
}

function makePieChart(id, labels, data) {
  if (_charts[id]) { _charts[id].destroy(); }
  const total = data.reduce((s, v) => s + v, 0);
  const COLORS = [
    'rgba(99,102,241,0.8)','rgba(16,185,129,0.8)','rgba(245,158,11,0.8)',
    'rgba(239,68,68,0.8)','rgba(59,130,246,0.8)','rgba(168,85,247,0.8)',
    'rgba(236,72,153,0.8)','rgba(20,184,166,0.8)'
  ];
  _charts[id] = new Chart(document.getElementById(id), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: COLORS.slice(0, labels.length), borderWidth: 1 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = total > 0 ? (ctx.parsed * 100 / total).toFixed(1) : '0.0';
              return ' ' + ctx.label + ': ' + ctx.parsed.toLocaleString() + ' 台 (' + pct + '%)';
            }
          }
        }
      }
    }
  });
}

let _supplierRatioData = [];

function initSupplierRatioPie(bySupplierByCategory) {
  // 保存原始数据
  _supplierRatioData = bySupplierByCategory || [];

  // 提取唯一的品类
  const categories = new Set();
  for (const item of _supplierRatioData) {
    if (item.category) categories.add(item.category);
  }
  const categoryList = Array.from(categories).sort();

  // 填充品类筛选器
  const catSelect = document.getElementById('pie-filter-category');
  for (const cat of categoryList) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    catSelect.appendChild(opt);
  }

  // 填充供应商筛选器（从全局 SUPPLIERS）
  const suppSelect = document.getElementById('pie-filter-supplier');
  for (const supp of SUPPLIERS) {
    const opt = document.createElement('option');
    opt.value = supp;
    opt.textContent = supp;
    suppSelect.appendChild(opt);
  }

  // 绑定筛选器的 change 事件
  catSelect.addEventListener('change', loadSupplierRatioPie);
  suppSelect.addEventListener('change', loadSupplierRatioPie);

  // 初始加载
  loadSupplierRatioPie();
}

function loadSupplierRatioPie() {
  const catVal = document.getElementById('pie-filter-category').value;
  const suppVal = document.getElementById('pie-filter-supplier').value;

  // 筛选数据
  let filtered = _supplierRatioData;
  if (catVal) {
    filtered = filtered.filter(x => x.category === catVal);
  }

  // 按供应商聚合数据
  let pieData = {};
  for (const item of filtered) {
    pieData[item.name] = (pieData[item.name] || 0) + (item.prod_qty || 0);
  }

  // 如果选择了供应商，只显示该供应商
  if (suppVal) {
    pieData = { [suppVal]: pieData[suppVal] || 0 };
  }

  const labels = Object.keys(pieData);
  const values = Object.values(pieData);

  makePieChart('chart-supplier-ratio-pie', labels, values);
}

function makeBarChartQty(id, labels, data, color) {
  if (_charts[id]) { _charts[id].destroy(); }
  _charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '生产数量', data, backgroundColor: color || 'rgba(99,102,241,0.7)', borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => v.toLocaleString() } } }
    }
  });
}

async function loadDashboard() {
  const qs = buildQuery();
  try {
    const r = await fetch('/api/admin/dashboard?' + qs);
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json();
    if (!d.ok) { console.error(d.msg); return; }

    document.getElementById('kpi-ffr').textContent = (d.ffr || 0).toFixed(2) + '%';
    document.getElementById('kpi-prod').textContent = (d.totalProd || 0).toLocaleString();
    document.getElementById('kpi-ret').textContent = (d.totalRet || 0).toLocaleString();
    // repair cards removed

    makeLineChart('chart-month', d.byMonth.map(x=>x.name), d.byMonth.map(x=>x.ffr||0));
    makeBarChart('chart-supplier', d.bySupplier.map(x=>x.name), d.bySupplier.map(x=>x.ffr||0), 'rgba(99,102,241,0.7)');
    makeBarChart('chart-model', d.byModel.map(x=>x.name), d.byModel.map(x=>x.ffr||0), 'rgba(16,185,129,0.7)');
    makeBarChart('chart-brand', d.byBrand.map(x=>x.name), d.byBrand.map(x=>x.ffr||0), 'rgba(245,158,11,0.7)');
    makeBarChartQty('chart-supplier-prod', d.bySupplier.map(x=>x.name), d.bySupplier.map(x=>x.prod_qty||0), 'rgba(16,185,129,0.7)');

    // 初始化单饼图筛选器
    if (d.bySupplierByCategory && d.bySupplierByCategory.length > 0) {
      initSupplierRatioPie(d.bySupplierByCategory);
    }
  } catch(e) { console.error('dashboard load error', e); }
}

async function loadTopFFR(dim) {
  if (dim) _topFfrDim = dim;
  document.querySelectorAll('.top-ffr-dim-btn').forEach(b => {
    const active = b.dataset.dim === _topFfrDim;
    b.className = 'top-ffr-dim-btn px-3 py-1 rounded text-xs font-medium ' + (active ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-200');
  });
  const qs = buildQuery({ dim: _topFfrDim });
  const container = document.getElementById('top-ffr-cards');
  try {
    const r = await fetch('/api/admin/dashboard/top-ffr?' + qs);
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json();
    if (!d.ok) { container.innerHTML = '<div class="text-red-400 text-sm col-span-full">加载失败</div>'; return; }
    document.getElementById('top-ffr-min-hint').textContent = '仅统计生产 ≥ ' + d.minProd + ' 台的项目';
    if (!d.items || d.items.length === 0) {
      container.innerHTML = '<div class="text-slate-400 text-sm col-span-full text-center py-4">暂无数据</div>';
      return;
    }
    const cards = d.items.map((item, i) => {
      const ffrStr = (item.ffr || 0).toFixed(2) + '%';
      const rankColors = ['text-red-600', 'text-orange-500', 'text-yellow-600', 'text-gray-700', 'text-gray-700', 'text-gray-700'];
      const dimData = JSON.stringify({ model: item.model || null, vehicle_brand: item.vehicle_brand || null, name: item.name });
      return \`<div class="bg-gray-100 hover:bg-gray-200 rounded-lg p-3 cursor-pointer select-none transition-colors" data-top-item='\${dimData.replace(/'/g,"&#39;")}' title="生产 \${item.prod_qty} 台 / 退机 \${item.ret_qty} 台\\n点击筛选">
        <div class="text-xs text-gray-600 mb-1 truncate" title="\${item.name}">\${item.name}</div>
        <div class="text-2xl font-bold \${rankColors[i]}">\${ffrStr}</div>
        <div class="text-xs text-gray-500 mt-1">生产 \${item.prod_qty}</div>
      </div>\`;
    }).join('');
    container.innerHTML = cards;
  } catch(e) {
    container.innerHTML = '<div class="text-red-400 text-sm col-span-full">网络错误: ' + e.message + '</div>';
  }
}

document.getElementById('top-ffr-dims').addEventListener('click', (e) => {
  const btn = e.target.closest('.top-ffr-dim-btn');
  if (btn) loadTopFFR(btn.dataset.dim);
});

document.getElementById('top-ffr-cards').addEventListener('click', (e) => {
  const card = e.target.closest('[data-top-item]');
  if (!card) return;
  let item;
  try { item = JSON.parse(card.dataset.topItem); } catch { return; }
  if (_topFfrDim === 'model_brand') {
    if (item.model) { document.getElementById('f-model').value = item.model; }
    if (item.vehicle_brand) { document.getElementById('f-brand').value = item.vehicle_brand; }
  } else if (_topFfrDim === 'model') {
    document.getElementById('f-model').value = item.name;
  } else if (_topFfrDim === 'vehicle_brand') {
    document.getElementById('f-brand').value = item.name;
  } else if (_topFfrDim === 'supplier') {
    document.getElementById('f-supplier').value = item.name;
  } else if (_topFfrDim === 'model_version') {
    document.getElementById('f-model').value = item.name;
  }
  onFilterChange();
  setTimeout(() => { document.querySelector('.dtab-btn[data-kind="' + _currentKind + '"]') && document.getElementById('detail-table').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 350);
});

async function loadDetail(kind) {
  _currentKind = kind;
  document.querySelectorAll('.dtab-btn').forEach(b => {
    b.className = 'dtab-btn px-3 py-1 text-sm font-medium ' + (b.dataset.kind === kind ? 'border-b-2 border-blue-600 text-blue-600' : 'text-slate-500');
  });
  const qs = buildDetailQuery({ kind });
  document.getElementById('detail-table').textContent = '加载中...';
  try {
    const r = await fetch('/api/admin/records?' + qs);
    if (r.status === 401) { location.href = '/login'; return; }
    const d = await r.json();
    if (!d.ok) { document.getElementById('detail-table').textContent = '加载失败: '+d.msg; return; }
    renderDetail(d.items, kind);
  } catch(e) { document.getElementById('detail-table').textContent = '网络错误: '+e.message; }
}

function renderDetail(items, kind) {
  if (items.length === 0) { document.getElementById('detail-table').innerHTML = '<p class="text-slate-400 text-sm py-4">暂无数据</p>'; return; }
  const cols = kind === 'return'
    ? [{k:'date',l:'日期'},{k:'supplier',l:'供应商'},{k:'model',l:'型号'},{k:'batch',l:'批次'},{k:'return_qty',l:'退机数'},{k:'defect_type',l:'不良类型'},{k:'defect_desc',l:'不良描述'},{k:'handling_result',l:'处理结果'},{k:'warehouse_qty',l:'入库数'},{k:'vehicle_brand',l:'客户'},{k:'updated_by',l:'更新人'}]
    : [{k:'date',l:'日期'},{k:'supplier',l:'供应商'},{k:'model',l:'型号'},{k:'batch',l:'批次'},{k:'plan_qty',l:'计划'},{k:'actual_qty',l:'实际'},{k:'warehouse_qty',l:'入库'},{k:'notes',l:'备注'},{k:'vehicle_brand',l:'客户'},{k:'updated_by',l:'更新人'}];
  let h = '<div class="text-sm text-slate-600 mb-2">共 '+items.length+' 条记录</div>';
  h += '<div class="overflow-x-auto"><table class="min-w-full text-xs"><thead><tr class="bg-slate-100">';
  h += cols.map(c=>'<th class="p-2 text-left whitespace-nowrap">'+c.l+'</th>').join('');
  h += '<th class="p-2 text-left">操作</th></tr></thead><tbody>';
  for (const it of items) {
    h += '<tr class="border-b hover:bg-slate-50">';
    h += cols.map(c=>'<td class="p-2 whitespace-nowrap max-w-xs truncate">'+(it[c.k]==null?'':String(it[c.k]).replace(/</g,'&lt;'))+'</td>').join('');
    h += \`<td class="p-2 whitespace-nowrap">
      <button data-act="edit" data-id="\${it.id}" data-kind="\${kind}" class="text-blue-600 mr-2 text-xs">编辑</button>
      <button data-act="delete" data-id="\${it.id}" data-kind="\${kind}" class="text-red-600 text-xs">删除</button>
    </td></tr>\`;
  }
  h += '</tbody></table></div>';
  document.getElementById('detail-table').innerHTML = h;
}

document.getElementById('detail-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const kind = btn.dataset.kind;
  const act = btn.dataset.act;
  if (act === 'delete') {
    if (!confirm('确认删除这条记录? (软删,不可恢复)')) return;
    const r = await fetch('/api/admin/record/delete', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({kind,id}) });
    const d = await r.json();
    if (d.ok) { loadDetail(kind); loadDashboard(); loadDailyTrend(); } else alert('删除失败: '+d.msg);
  } else if (act === 'edit') {
    openEditModal(id, kind);
  }
});

// Detail filter buttons
document.getElementById('btn-detail-query').addEventListener('click', () => {
  loadDetail(_currentKind);
});

document.getElementById('btn-detail-reset').addEventListener('click', () => {
  document.getElementById('detail-f-date-from').value = '';
  document.getElementById('detail-f-date-to').value = '';
  document.getElementById('detail-f-supplier').value = '';
  document.getElementById('detail-f-brand').value = '';
  document.getElementById('detail-f-model').value = '';
  loadDetail(_currentKind);
});

async function openEditModal(id, kind) {
  // Fetch record
  const r = await fetch('/api/admin/records?kind='+kind+'&id='+id);
  const d = await r.json();
  const rec = d.items && d.items.find(x => x.id === id);
  if (!rec) { alert('记录不存在'); return; }

  document.getElementById('ef-kind').value = kind;
  document.getElementById('ef-id').value = id;

  const form = document.getElementById('edit-form');
  // Remove old dynamic fields
  form.querySelectorAll('.dfield').forEach(el => el.remove());

  const prodFields = [
    {k:'date',l:'日期',t:'date'},{k:'model',l:'机型',t:'text'},{k:'batch',l:'批次',t:'text'},
    {k:'plan_qty',l:'计划数量',t:'number'},{k:'actual_qty',l:'实际产出',t:'number'},
    {k:'warehouse_qty',l:'入库数量',t:'number'},{k:'notes',l:'备注',t:'text'},
    {k:'vehicle_brand',l:'客户',t:'brand'}
  ];
  const retFields = [
    {k:'date',l:'日期',t:'date'},{k:'model',l:'型号',t:'text'},{k:'batch',l:'批次',t:'text'},
    {k:'return_qty',l:'退机数量',t:'number'},{k:'defect_type',l:'不良类型',t:'defect'},
    {k:'defect_desc',l:'不良描述',t:'text'},{k:'handling_result',l:'处理结果',t:'text'},
    {k:'warehouse_qty',l:'入库数量',t:'number'},{k:'vehicle_brand',l:'客户',t:'brand'}
  ];
  const fields = kind === 'prod' ? prodFields : retFields;
  const defectTypes = ${JSON.stringify(DEFECT_TYPES)};

  fields.forEach(f => {
    const wrap = document.createElement('label');
    wrap.className = 'dfield flex flex-col text-sm';
    let inp;
    if (f.t === 'brand') {
      inp = document.createElement('select');
      inp.innerHTML = '<option value="">--</option>' + _brands.map(b => '<option'+(rec[f.k]===b.name?' selected':'')+'>'+b.name+'</option>').join('');
    } else if (f.t === 'defect') {
      inp = document.createElement('select');
      inp.innerHTML = defectTypes.map(t => '<option'+(rec[f.k]===t?' selected':'')+'>'+t+'</option>').join('');
    } else {
      inp = document.createElement('input');
      inp.type = f.t;
      inp.value = rec[f.k] != null ? rec[f.k] : '';
    }
    inp.name = f.k;
    inp.className = 'border rounded p-1.5 mt-1';
    wrap.textContent = f.l;
    wrap.appendChild(inp);
    form.appendChild(wrap);
  });

  document.getElementById('edit-modal').classList.remove('hidden');
  document.getElementById('edit-msg').textContent = '';
}

document.getElementById('btn-edit-cancel').addEventListener('click', () => {
  document.getElementById('edit-modal').classList.add('hidden');
});

document.getElementById('btn-edit-save').addEventListener('click', async () => {
  const form = document.getElementById('edit-form');
  const kind = document.getElementById('ef-kind').value;
  const id = Number(document.getElementById('ef-id').value);
  const fields = {};
  form.querySelectorAll('input[name], select[name]').forEach(el => {
    if (el.name.startsWith('_')) return;
    fields[el.name] = el.value;
  });
  const r = await fetch('/api/admin/record/edit', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ kind, id, fields })
  });
  const d = await r.json();
  if (d.ok) {
    document.getElementById('edit-modal').classList.add('hidden');
    loadDetail(kind); loadDashboard();
  } else {
    document.getElementById('edit-msg').textContent = '失败: '+d.msg;
  }
});

document.querySelectorAll('.dtab-btn').forEach(b => b.addEventListener('click', () => loadDetail(b.dataset.kind)));

// Export — module selection modal
document.getElementById('btn-export').addEventListener('click', () => {
  document.getElementById('export-modal').classList.remove('hidden');
});
document.getElementById('export-cancel').addEventListener('click', () => {
  document.getElementById('export-modal').classList.add('hidden');
});
document.getElementById('export-confirm').addEventListener('click', () => {
  const checked = Array.from(document.querySelectorAll('.export-mod-cb:checked')).map(cb => cb.value);
  if (checked.length === 0) { alert('请至少选择一个模块'); return; }
  const qs = buildQuery({ modules: checked.join(',') });
  window.location.href = '/api/admin/export-dashboard?' + qs;
  document.getElementById('export-modal').classList.add('hidden');
});

// Filter change handler with debounce
let _debounce;
function onFilterChange() {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => { loadDashboard(); loadTopFFR(); loadDetail(_currentKind); }, 300);
}
['f-date-from','f-date-to','f-supplier','f-brand','f-model','f-defect'].forEach(id => {
  document.getElementById(id).addEventListener('change', onFilterChange);
  if (id === 'f-model') document.getElementById(id).addEventListener('input', onFilterChange);
});

// Init flatpickr for filter dates
(function initFilterFP(){
  if(!window.flatpickr||!window.fp_config){setTimeout(initFilterFP,100);return;}
  try{flatpickr(document.getElementById('f-date-from'),window.fp_config);}catch(e){}
  try{flatpickr(document.getElementById('f-date-to'),window.fp_config);}catch(e){}
  try{flatpickr(document.getElementById('detail-f-date-from'),window.fp_config);}catch(e){}
  try{flatpickr(document.getElementById('detail-f-date-to'),window.fp_config);}catch(e){}
})();
// Init
loadBrandsFilter().then(() => { loadDashboard(); loadTopFFR(); loadDetail('prod'); loadDailyTrend(); });

// ===== 走势图 & 用户明细 =====
var _trendDays = 30;
var _usDays = 7;

async function loadDailyTrend(days) {
  if (days) _trendDays = days;
  document.querySelectorAll('.trend-range-btn').forEach(function(b) {
    var active = parseInt(b.dataset.days) === _trendDays;
    b.className = 'trend-range-btn px-3 py-1 rounded text-xs font-medium ' + (active ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-200');
  });
  try {
    var r = await fetch('/api/admin/dashboard/daily-trend?days=' + _trendDays);
    var d = await r.json();
    if (!d.ok) return;
    var labels = d.data.map(function(x) { return x.day.slice(5); });
    var values = d.data.map(function(x) { return x.cnt; });
    if (_charts['chart-daily-trend']) { _charts['chart-daily-trend'].destroy(); }
    _charts['chart-daily-trend'] = new Chart(document.getElementById('chart-daily-trend'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: '录入条数',
          data: values,
          backgroundColor: 'rgba(37,99,235,0.65)',
          borderRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 } },
          x: { 
            ticks: { maxTicksLimit: _trendDays > 20 ? 30 : 7, maxRotation: 45 },
            barMaxWidth: 12,
            barCategoryGap: '15%'
          }
        }
      }
    });
  } catch(e) { console.error('trend load error', e); }
}

var _usPage = 1;
async function loadUserStats(days, page) {
  if (days !== undefined) _usDays = days;
  if (page !== undefined) _usPage = page; else _usPage = 1;
  document.querySelectorAll('.us-range-btn').forEach(function(b) {
    var active = parseInt(b.dataset.days) === _usDays;
    b.className = 'us-range-btn px-3 py-1 rounded text-xs font-medium ' + (active ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-200');
  });
  document.getElementById('user-stats-table').textContent = '加载中...';
  document.getElementById('user-stats-pagination').innerHTML = '';
  try {
    var r = await fetch('/api/admin/dashboard/record-details?days=' + _usDays + '&page=' + _usPage);
    var d = await r.json();
    if (!d.ok) { document.getElementById('user-stats-table').textContent = '加载失败'; return; }
    if (!d.items || d.items.length === 0) {
      document.getElementById('user-stats-table').innerHTML = '<p class="text-slate-400 text-sm py-4 text-center">暂无数据</p>';
      return;
    }
    var h = '<div style="overflow-x:auto;"><table class="min-w-full text-sm border-collapse"><thead><tr class="bg-slate-100 text-left">' +
      '<th class="p-2 whitespace-nowrap">录入人</th>' +
      '<th class="p-2 whitespace-nowrap">类型</th>' +
      '<th class="p-2 whitespace-nowrap">供应商</th>' +
      '<th class="p-2 whitespace-nowrap">型号</th>' +
      '<th class="p-2 whitespace-nowrap">品类</th>' +
      '<th class="p-2 whitespace-nowrap">数量</th>' +
      '<th class="p-2 whitespace-nowrap">客户</th>' +
      '<th class="p-2 whitespace-nowrap">日期</th>' +
      '<th class="p-2 whitespace-nowrap">录入时间</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < d.items.length; i++) {
      var it = d.items[i];
      var createdAt = it.created_at ? new Date(it.created_at).toLocaleString('zh-CN', {hour12: false}) : '-';
      var typeLabel = it.type === 'prod' ? '<span style="color:#16a34a;font-size:11px;background:#dcfce7;padding:1px 6px;border-radius:4px;">生产</span>' : '<span style="color:#dc2626;font-size:11px;background:#fee2e2;padding:1px 6px;border-radius:4px;">退机</span>';
      h += '<tr class="border-b hover:bg-slate-50">' +
        '<td class="p-2">' + (it.operator || '-') + '</td>' +
        '<td class="p-2">' + typeLabel + '</td>' +
        '<td class="p-2">' + (it.supplier || '-') + '</td>' +
        '<td class="p-2">' + (it.model || '-') + '</td>' +
        '<td class="p-2 text-slate-500">' + (it.category || '-') + '</td>' +
        '<td class="p-2 font-medium">' + (it.qty != null ? it.qty : '-') + '</td>' +
        '<td class="p-2 text-slate-500">' + (it.vehicle_brand || '-') + '</td>' +
        '<td class="p-2 text-slate-500 text-xs">' + (it.date || '-') + '</td>' +
        '<td class="p-2 text-slate-400 text-xs">' + createdAt + '</td>' +
        '</tr>';
    }
    h += '</tbody></table></div>';
    document.getElementById('user-stats-table').innerHTML = h;
    // Pagination
    var totalPages = Math.ceil(d.total / d.pageSize);
    var pg = '<span>共 ' + d.total + ' 条</span><div style="display:flex;gap:6px;align-items:center;">';
    pg += '<button onclick="loadUserStats(undefined,' + (_usPage - 1) + ')" ' + (_usPage <= 1 ? 'disabled style="opacity:0.4;"' : '') + ' style="padding:2px 10px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;">上一页</button>';
    pg += '<span>' + _usPage + ' / ' + totalPages + '</span>';
    pg += '<button onclick="loadUserStats(undefined,' + (_usPage + 1) + ')" ' + (_usPage >= totalPages ? 'disabled style="opacity:0.4;"' : '') + ' style="padding:2px 10px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;">下一页</button>';
    pg += '</div>';
    document.getElementById('user-stats-pagination').innerHTML = pg;
  } catch(e) { document.getElementById('user-stats-table').textContent = '网络错误: ' + e.message; }
}

document.getElementById('trend-range-btns').addEventListener('click', function(e) {
  var btn = e.target.closest('.trend-range-btn');
  if (btn) loadDailyTrend(parseInt(btn.dataset.days));
});

document.getElementById('btn-user-stats').addEventListener('click', function() {
  document.getElementById('user-stats-modal').classList.remove('hidden');
  loadUserStats(_usDays);
});

var _supplierDetailBtn = document.getElementById('btn-supplier-prod-detail');
if (_supplierDetailBtn) {
  _supplierDetailBtn.addEventListener('click', function() {
    document.getElementById('user-stats-modal').classList.remove('hidden');
    loadUserStats(_usDays);
  });
}

document.getElementById('btn-user-stats-close').addEventListener('click', function() {
  document.getElementById('user-stats-modal').classList.add('hidden');
});

document.getElementById('user-stats-modal').addEventListener('click', function(e) {
  if (e.target === document.getElementById('user-stats-modal')) document.getElementById('user-stats-modal').classList.add('hidden');
});

document.getElementById('user-stats-range-btns').addEventListener('click', function(e) {
  var btn = e.target.closest('.us-range-btn');
  if (btn) loadUserStats(parseInt(btn.dataset.days));
});

</script></body></html>`;
}

function adminRepairRecordsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const suppliersOpts = getSuppliersList().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>维修品记录</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}</style><style>
select {
  box-sizing: border-box !important;
  font-family: inherit;
  font-size: 1em;
  padding: 0.5rem !important;
  width: 100% !important;
}
input[type="text"],
input[type="number"],
input[type="date"] {
  box-sizing: border-box !important;
  width: 100% !important;
  padding: 0.5rem !important;
}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('repair-records', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">

  <!-- 类型切换 -->
  <div class="flex gap-2 mb-4">
    <button class="kind-btn px-4 py-2 rounded font-medium bg-blue-600 text-white" data-kind="repair_line">产线维修品</button>
    <button class="kind-btn px-4 py-2 rounded font-medium text-slate-600 hover:bg-slate-100" data-kind="repair_aftersales">售后返修品</button>
  </div>

  <!-- 筛选 -->
  <div class="bg-white rounded shadow p-4 mb-4 flex flex-wrap gap-3 items-end">
    <label class="flex flex-col text-sm">供应商
      <select id="f-supplier" class="border rounded p-1 mt-1">
        <option value="">全部</option>
        ${suppliersOpts}
      </select></label>
    <label class="flex flex-col text-sm">客户
      <select id="f-brand" class="border rounded p-1 mt-1">
        <option value="">全部</option>
      </select></label>
    <label class="flex flex-col text-sm">型号
      <input id="f-model" class="border rounded p-1 mt-1 w-28" placeholder="模糊匹配"></label>
    <label class="flex flex-col text-sm">SN码
      <input id="f-sn" class="border rounded p-1 mt-1 w-32" placeholder="整机/配件SN"></label>
    <label class="flex flex-col text-sm">维修日期从
      <input type="text" autocomplete="off" id="f-date-from" class="border rounded p-1 mt-1"></label>
    <label class="flex flex-col text-sm">维修日期至
      <input type="text" autocomplete="off" id="f-date-to" class="border rounded p-1 mt-1"></label>
    <label class="flex flex-col text-sm">维修结果
      <select id="f-result" class="border rounded p-1 mt-1">
        <option value="">全部</option>
        <option value="已修复">已修复</option>
        <option value="报废">报废</option>
        <option value="待料">待料</option>
      </select></label>
    <button id="btn-query" class="px-3 py-1.5 bg-blue-600 text-white rounded text-sm self-end">查询</button>
    <button id="btn-export" class="px-3 py-1.5 bg-green-600 text-white rounded text-sm self-end">导出 Excel</button>
  </div>

  <div class="bg-white rounded shadow p-4">
    <div id="list-info" class="text-sm text-slate-500 mb-2"></div>
    <div id="list" class="overflow-x-auto">加载中...</div>
  </div>
</div>

<!-- Edit Modal -->
<div id="edit-modal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center z-50">
  <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-screen overflow-y-auto">
    <h2 class="text-lg font-semibold mb-4">编辑维修记录</h2>
    <form id="edit-form" class="grid grid-cols-2 gap-3">
      <input type="hidden" name="_kind" id="ef-kind">
      <input type="hidden" name="_id" id="ef-id">
    </form>
    <div id="edit-msg" class="text-sm text-red-600 mt-2 min-h-[1em]"></div>
    <div class="flex gap-3 mt-4">
      <button id="btn-edit-save" class="bg-blue-600 text-white px-4 py-2 rounded">保存</button>
      <button id="btn-edit-cancel" class="border px-4 py-2 rounded">取消</button>
    </div>
  </div>
</div>

<script>
const SUPPLIERS = ${JSON.stringify(getSuppliersList())};
let _currentKind = 'repair_line';

function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

// Load brands
async function loadBrandsFilter() {
  const r = await fetch('/api/admin/brands/list');
  const d = await r.json();
  if (d.ok) {
    const sel = document.getElementById('f-brand');
    d.brands.filter(b => b.enabled).forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.name; opt.textContent = b.name;
      sel.appendChild(opt);
    });
  }
}

function buildQuery(extra = {}) {
  const f = {
    kind: _currentKind,
    supplier: document.getElementById('f-supplier').value,
    vehicle_brand: document.getElementById('f-brand').value,
    model: document.getElementById('f-model').value,
    sn: document.getElementById('f-sn').value,
    date_from: document.getElementById('f-date-from').value,
    date_to: document.getElementById('f-date-to').value,
    repair_result: document.getElementById('f-result').value,
    ...extra
  };
  return Object.entries(f).filter(([,v]) => v).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
}

// Kind switch
document.querySelectorAll('.kind-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _currentKind = btn.dataset.kind;
    document.querySelectorAll('.kind-btn').forEach(b => {
      b.className = 'kind-btn px-4 py-2 rounded font-medium ' +
        (b.dataset.kind === _currentKind ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100');
    });
    load();
  });
});

async function load() {
  document.getElementById('list').textContent = '加载中...';
  const r = await fetch('/api/admin/repair-records?' + buildQuery());
  if (r.status === 401) { location.href = '/login'; return; }
  const d = await r.json();
  if (!d.ok) { document.getElementById('list').textContent = '加载失败: ' + d.msg; return; }
  const items = d.items;
  document.getElementById('list-info').textContent = '共 ' + items.length + ' 条记录';
  if (!items.length) { document.getElementById('list').innerHTML = '<p class="text-slate-400 py-4 text-sm">暂无数据</p>'; return; }

  const commonCols = [
    {k:'supplier',l:'供应商'},{k:'vehicle_brand',l:'客户'},{k:'model',l:'型号'},
    {k:'sn_whole',l:'整机SN'},{k:'sn_part',l:'配件SN'},{k:'fault_symptom',l:'故障现象'},
    {k:'fault_cause',l:'故障原因'},{k:'defective_part',l:'不良零部件'},
    {k:'short_term_fix',l:'短期措施'},{k:'long_term_fix',l:'长期措施'},
    {k:'repair_date',l:'维修日期'},{k:'repair_result',l:'维修结果'},{k:'repair_person',l:'维修人员'}
  ];
  const extraCols = _currentKind === 'repair_line'
    ? [{k:'batch_no',l:'批次号'},{k:'station',l:'工位'},{k:'discovery_stage',l:'发现环节'}]
    : [{k:'return_order_no',l:'返修单号'},{k:'customer_feedback',l:'客户反馈'},{k:'return_date',l:'寄回日期'},{k:'repair_complete_date',l:'维修完成'},{k:'ship_date',l:'寄出日期'},{k:'in_warranty',l:'在保'}];
  const cols = [...commonCols, ...extraCols];

  let h = '<table class="min-w-full text-xs"><thead><tr class="bg-slate-100">';
  cols.forEach(c => { h += '<th class="p-2 text-left whitespace-nowrap">' + c.l + '</th>'; });
  h += '<th class="p-2 text-left">附件</th><th class="p-2 text-left">操作</th></tr></thead><tbody>';
  for (const it of items) {
    h += '<tr class="border-b hover:bg-slate-50">';
    cols.forEach(c => {
      const v = it[c.k];
      h += '<td class="p-2 whitespace-nowrap max-w-xs truncate" title="' + escapeHtml(v) + '">' + (v == null ? '' : escapeHtml(v)) + '</td>';
    });
    const attHtml = (it.attachments || []).map(a =>
      '<a href="/api/repair/attachment/download?id=' + a.id + '" class="text-blue-600 underline text-xs mr-1" target="_blank">' + escapeHtml(a.name) + '</a>'
    ).join('') || '-';
    h += '<td class="p-2">' + attHtml + '</td>';
    h += '<td class="p-2 whitespace-nowrap"><button data-act="edit" data-id="' + it.id + '" class="text-blue-600 mr-2 text-xs">编辑</button><button data-act="delete" data-id="' + it.id + '" class="text-red-600 text-xs">删除</button></td>';
    h += '</tr>';
  }
  h += '</tbody></table>';
  document.getElementById('list').innerHTML = h;
}

// Edit / Delete
document.getElementById('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'delete') {
    if (!confirm('确认删除？')) return;
    const r = await fetch('/api/admin/repair-record/delete', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ kind: _currentKind, id })
    });
    const d = await r.json();
    if (d.ok) load(); else alert('删除失败: ' + d.msg);
  } else if (btn.dataset.act === 'edit') {
    openEditModal(id);
  }
});

async function openEditModal(id) {
  const r = await fetch('/api/admin/repair-records?' + buildQuery({ id }));
  const d = await r.json();
  const rec = d.items && d.items.find(x => x.id === id);
  if (!rec) { alert('记录不存在'); return; }

  document.getElementById('ef-kind').value = _currentKind;
  document.getElementById('ef-id').value = id;
  const form = document.getElementById('edit-form');
  form.querySelectorAll('.dfield').forEach(el => el.remove());

  const commonFields = [
    {k:'vehicle_brand',l:'客户',t:'text'},{k:'model',l:'型号',t:'text'},
    {k:'sn_whole',l:'整机SN码',t:'text'},{k:'sn_part',l:'配件SN码',t:'text'},
    {k:'fault_symptom',l:'故障现象',t:'text'},{k:'fault_cause',l:'故障原因',t:'text'},
    {k:'defective_part',l:'不良零部件',t:'text'},{k:'short_term_fix',l:'短期措施',t:'text'},
    {k:'long_term_fix',l:'长期措施',t:'text'},{k:'repair_date',l:'维修日期',t:'date'},
    {k:'repair_result',l:'维修结果',t:'select',opts:['已修复','报废','待料']},
    {k:'repair_person',l:'维修人员',t:'text'},{k:'remarks',l:'备注',t:'text'}
  ];
  const lineFields = [{k:'batch_no',l:'批次号',t:'text'},{k:'station',l:'工位',t:'text'},
    {k:'discovery_stage',l:'发现环节',t:'select',opts:['来料检','制程','成品检','老化测试']}];
  const asFields = [{k:'return_order_no',l:'返修单号',t:'text'},{k:'customer_feedback',l:'客户反馈',t:'text'},
    {k:'return_date',l:'寄回日期',t:'date'},{k:'repair_complete_date',l:'维修完成日期',t:'date'},
    {k:'ship_date',l:'寄出日期',t:'date'},{k:'in_warranty',l:'是否在保',t:'select',opts:['是','否']}];
  const fields = [...commonFields, ...(_currentKind === 'repair_line' ? lineFields : asFields)];

  fields.forEach(f => {
    const wrap = document.createElement('label');
    wrap.className = 'dfield flex flex-col text-sm';
    let inp;
    if (f.t === 'select') {
      inp = document.createElement('select');
      inp.innerHTML = '<option value="">--</option>' + (f.opts||[]).map(o => '<option' + (rec[f.k]===o?' selected':'') + '>' + o + '</option>').join('');
    } else {
      inp = document.createElement('input');
      inp.type = f.t; inp.value = rec[f.k] != null ? rec[f.k] : '';
    }
    inp.name = f.k; inp.className = 'border rounded p-1.5 mt-1';
    wrap.textContent = f.l; wrap.appendChild(inp);
    form.appendChild(wrap);
  });

  document.getElementById('edit-modal').classList.remove('hidden');
  document.getElementById('edit-msg').textContent = '';
}

document.getElementById('btn-edit-cancel').addEventListener('click', () => {
  document.getElementById('edit-modal').classList.add('hidden');
});

document.getElementById('btn-edit-save').addEventListener('click', async () => {
  const kind = document.getElementById('ef-kind').value;
  const id = Number(document.getElementById('ef-id').value);
  const fields = {};
  document.getElementById('edit-form').querySelectorAll('input[name], select[name]').forEach(el => {
    if (!el.name.startsWith('_')) fields[el.name] = el.value;
  });
  const r = await fetch('/api/admin/repair-record/edit', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ kind, id, fields })
  });
  const d = await r.json();
  if (d.ok) { document.getElementById('edit-modal').classList.add('hidden'); load(); }
  else { document.getElementById('edit-msg').textContent = '失败: ' + d.msg; }
});

document.getElementById('btn-query').addEventListener('click', load);
document.getElementById('btn-export').addEventListener('click', () => {
  window.location.href = '/api/admin/repair-records/export?' + buildQuery();
});
['f-sn','f-model'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
});

loadBrandsFilter().then(load);
</script></body></html>`;
}

// ---------------- supplier data management page ----------------

function adminSupplierDataPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const defectTypesOpts = DEFECT_TYPES.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>供应商填报数据管理</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}
.tab-btn{border-bottom:3px solid transparent;border-radius:0;background:none;padding:.5rem 1rem;color:#64748b;cursor:pointer}
.tab-btn.active{border-bottom-color:#2563eb;color:#2563eb;font-weight:600}
.panel{display:none}.panel.active{display:block}
.flatpickr-calendar { min-width: 320px; }
</style>

<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
<script src="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/flatpickr/dist/l10n/zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};
</script></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('supplier-data', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div class="bg-white rounded shadow">

    <!-- Tab Buttons -->
    <div class="flex border-b border-slate-200 px-4 pt-2">
      <button class="tab-btn active" data-tab="ffr" onclick="switchVendorTab(this,'ffr')">FFR数据</button>
      <button class="tab-btn" data-tab="prod-form" onclick="switchVendorTab(this,'prod-form')">生产填报</button>
      <button class="tab-btn" data-tab="return-form" onclick="switchVendorTab(this,'return-form')">退机填报</button>
      <button class="tab-btn" data-tab="prod-history" onclick="switchVendorTab(this,'prod-history')">生产历史</button>
      <button class="tab-btn" data-tab="return-history" onclick="switchVendorTab(this,'return-history')">退机历史</button>
    </div>

    <!-- Tab 1: FFR 数据 -->
    <section id="tab-ffr" class="panel active p-4">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold">FFR 数据（按型号汇总）</h2>
        <button onclick="loadFFR()" class="bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700">刷新</button>
      </div>
      <div id="ffr-table">加载中...</div>
    </section>

    <!-- Tab 2: 生产填报 -->
    <section id="tab-prod-form" class="panel p-4">
      <h2 class="text-lg font-semibold mb-4">生产填报</h2>
      <div id="prod-msg" class="mb-3 hidden"></div>
      <form id="prod-form" class="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
        <label class="block"><span class="text-sm font-medium text-slate-700">日期 *</span>
          <input id="pf-date" name="date" type="text" autocomplete="off" required class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300">
          <span id="pf-date-err" class="hidden block text-red-500 text-xs mt-1">请选择日期</span></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">型号 *</span>
          <input id="pf-model" name="model" type="text" required placeholder="请输入机型" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300">
          <span id="pf-model-err" class="hidden block text-red-500 text-xs mt-1">机型不能为空</span></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">供应商</span>
          <input name="supplier" type="text" placeholder="可选" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">客户 *</span>
          <input id="pf-customer" name="customer_name" type="text" list="brands-list" placeholder="请输入或从列表选择" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300">
          <span id="pf-customer-err" class="hidden block text-red-500 text-xs mt-1">客户不能为空</span></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">内部型号 *</span>
          <input id="pf-batch" name="batch" type="text" placeholder="请输入内部型号" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300">
          <span id="pf-batch-err" class="hidden block text-red-500 text-xs mt-1">请填写内部型号</span></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">订单数量 *</span>
          <input id="pf-plan" name="plan_qty" type="number" min="0" placeholder="请输入订单数量" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300">
          <span id="pf-plan-err" class="hidden block text-red-500 text-xs mt-1">订单数量不能为空</span></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">交付数量 *</span>
          <input id="pf-actual" name="actual_qty" type="number" min="0" placeholder="请输入交付数量" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300">
          <span id="pf-actual-err" class="hidden block text-red-500 text-xs mt-1">交付数量不能为空</span></label>
        <label class="block md:col-span-2"><span class="text-sm font-medium text-slate-700">验货报告 *</span>
          <input id="pf-report" name="report_file" type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300 file:mr-3 file:py-1 file:px-3 file:border-0 file:rounded file:bg-blue-100 file:text-blue-700 file:cursor-pointer">
          <span id="pf-report-err" class="hidden block text-red-500 text-xs mt-1">请上传验货报告</span></label>
        <label class="block md:col-span-2"><span class="text-sm font-medium text-slate-700">备注</span>
          <textarea name="notes" rows="3" placeholder="可选" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></textarea></label>
        <div class="md:col-span-2 flex items-center gap-4 flex-wrap">
          <button type="submit" class="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 font-medium">提交</button>
          <span id="pf-dup-err" class="hidden text-red-600 text-sm font-medium"></span>
        </div>
      </form>
    </section>

    <!-- Tab 3: 退机填报 -->
    <section id="tab-return-form" class="panel p-4">
      <h2 class="text-lg font-semibold mb-4">退机填报</h2>
      <div id="return-msg" class="mb-3 hidden"></div>
      <form id="return-form" class="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
        <label class="block"><span class="text-sm font-medium text-slate-700">日期 *</span>
          <input name="date" type="text" autocomplete="off" required class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">型号 *</span>
          <input name="model" type="text" required placeholder="请输入型号" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">供应商</span>
          <input name="supplier" type="text" placeholder="可选" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">客户</span>
          <input name="customer_name" type="text" list="brands-list" placeholder="可选，可输入或从列表选择" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">批次</span>
          <input name="batch" type="text" placeholder="可选" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">退机数量</span>
          <input name="return_qty" type="number" min="0" placeholder="可选" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></label>
        <label class="block"><span class="text-sm font-medium text-slate-700">不良类型</span>
          <select name="defect_type" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300">
            <option value="">请选择</option>
            ${defectTypesOpts}
          </select></label>
        <label class="block md:col-span-2"><span class="text-sm font-medium text-slate-700">不良描述</span>
          <textarea name="defect_desc" rows="2" placeholder="可选" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></textarea></label>
        <label class="block md:col-span-2"><span class="text-sm font-medium text-slate-700">处理结果</span>
          <textarea name="handling_result" rows="2" placeholder="可选" class="mt-1 w-full border rounded p-2 focus:ring-2 focus:ring-blue-300"></textarea></label>
        <div class="md:col-span-2">
          <button type="submit" class="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 font-medium">提交</button>
        </div>
      </form>
    </section>

    <!-- Tab 4: 生产历史 -->
    <section id="tab-prod-history" class="panel p-4">
      <div class="flex flex-wrap gap-3 mb-4 items-end">
        <div><label class="text-sm font-medium text-slate-700 block mb-1">供应商</label>
          <input id="ph-supplier" type="text" placeholder="供应商关键词" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300 w-32"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">车企/客户</label>
          <input id="ph-customer" type="text" placeholder="客户关键词" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300 w-36"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">产品型号</label>
          <input id="ph-model" type="text" placeholder="型号关键词" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300 w-32"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">开始日期</label>
          <input id="ph-date-from" type="text" autocomplete="off" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">结束日期</label>
          <input id="ph-date-to" type="text" autocomplete="off" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300"></div>
        <button id="ph-query" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">查询</button>
        <button id="ph-reset" class="bg-slate-200 text-slate-700 px-4 py-2 rounded text-sm hover:bg-slate-300">重置</button>
      </div>
      <div id="prod-history-list">点击查询加载数据</div>
    </section>

    <!-- Tab 5: 退机历史 -->
    <section id="tab-return-history" class="panel p-4">
      <div class="flex flex-wrap gap-3 mb-4 items-end">
        <div><label class="text-sm font-medium text-slate-700 block mb-1">供应商</label>
          <input id="rh-supplier" type="text" placeholder="供应商关键词" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300 w-32"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">车企/客户</label>
          <input id="rh-customer" type="text" placeholder="客户关键词" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300 w-36"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">产品型号</label>
          <input id="rh-model" type="text" placeholder="型号关键词" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300 w-32"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">开始日期</label>
          <input id="rh-date-from" type="text" autocomplete="off" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300"></div>
        <div><label class="text-sm font-medium text-slate-700 block mb-1">结束日期</label>
          <input id="rh-date-to" type="text" autocomplete="off" class="border rounded p-2 text-sm focus:ring-2 focus:ring-blue-300"></div>
        <button id="rh-query" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">查询</button>
        <button id="rh-reset" class="bg-slate-200 text-slate-700 px-4 py-2 rounded text-sm hover:bg-slate-300">重置</button>
      </div>
      <div id="return-history-list">点击查询加载数据</div>
    </section>
  </div>

  <!-- Edit Modal -->
  <div id="edit-modal" class="fixed inset-0 bg-black/50 z-50 items-center justify-center" style="display:none">
    <div class="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 id="modal-title" class="text-lg font-semibold">编辑记录</h3>
        <button onclick="closeModal()" class="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
      </div>
      <div id="modal-msg" class="mb-3" style="display:none"></div>
      <form id="edit-form" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <input type="hidden" id="ef-type" name="type">
        <input type="hidden" id="ef-id" name="id">
        <div id="ef-prod-fields">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label class="block"><span class="text-sm font-medium text-slate-700">日期 *</span><input id="ef-date" name="date" type="text" autocomplete="off" required class="mt-1 w-full border rounded p-2"></label>
            <label class="block"><span class="text-sm font-medium text-slate-700">型号 *</span><input id="ef-model" name="model" type="text" required class="mt-1 w-full border rounded p-2"></label>
            <label class="block"><span class="text-sm font-medium text-slate-700">供应商</span><input id="ef-supplier" name="supplier" type="text" class="mt-1 w-full border rounded p-2"></label>
            <label class="block"><span class="text-sm font-medium text-slate-700">客户</span><input id="ef-customer" name="customer_name" type="text" list="brands-list" class="mt-1 w-full border rounded p-2"></label>
            <label class="block"><span class="text-sm font-medium text-slate-700">批次</span><input id="ef-batch" name="batch" type="text" class="mt-1 w-full border rounded p-2"></label>
            <label class="block" id="ef-plan-wrap"><span class="text-sm font-medium text-slate-700">计划数量</span><input id="ef-plan" name="plan_qty" type="number" min="0" class="mt-1 w-full border rounded p-2"></label>
            <label class="block" id="ef-actual-wrap"><span class="text-sm font-medium text-slate-700">实际产出</span><input id="ef-actual" name="actual_qty" type="number" min="0" class="mt-1 w-full border rounded p-2"></label>
            <label class="block" id="ef-return-qty-wrap" style="display:none"><span class="text-sm font-medium text-slate-700">退机数量</span><input id="ef-return-qty" name="return_qty" type="number" min="0" class="mt-1 w-full border rounded p-2"></label>
            <label class="block" id="ef-defect-type-wrap" style="display:none"><span class="text-sm font-medium text-slate-700">不良类型</span>
              <select id="ef-defect-type" name="defect_type" class="mt-1 w-full border rounded p-2">
                <option value="">请选择</option>${defectTypesOpts}
              </select></label>
            <label class="block" id="ef-notes-wrap"><span class="text-sm font-medium text-slate-700">备注</span><textarea id="ef-notes" name="notes" rows="2" class="mt-1 w-full border rounded p-2"></textarea></label>
            <label class="block md:col-span-2" id="ef-defect-desc-wrap" style="display:none"><span class="text-sm font-medium text-slate-700">不良描述</span><textarea id="ef-defect-desc" name="defect_desc" rows="2" class="mt-1 w-full border rounded p-2"></textarea></label>
            <label class="block md:col-span-2" id="ef-handling-wrap" style="display:none"><span class="text-sm font-medium text-slate-700">处理结果</span><textarea id="ef-handling" name="handling_result" rows="2" class="mt-1 w-full border rounded p-2"></textarea></label>
          </div>
        </div>
        <div class="md:col-span-2 flex gap-3 justify-end">
          <button type="button" onclick="closeModal()" class="px-4 py-2 border rounded text-slate-600 hover:bg-slate-100">取消</button>
          <button type="submit" class="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium">保存</button>
        </div>
      </form>
    </div>
  </div>
</div>

<script>
function escH(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showMsg(id, text, ok=true){
  const el=document.getElementById(id);
  el.className='mb-3 px-4 py-2 rounded '+(ok?'bg-green-100 text-green-800':'bg-red-100 text-red-800');
  el.textContent=text; el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'),4000);
}
async function api(path,body,method='POST'){
  const opts={method,headers:{'Content-Type':'application/json'}};
  if(body) opts.body=JSON.stringify(body);
  const r=await fetch(path,opts);
  if(r.status===401){location.href='/login';return null;}
  return r.json();
}

// Tab switching
function switchVendorTab(btn, tab) {
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
  if(tab==='ffr') loadFFR();
  if(tab==='prod-history') loadProdHistory();
  if(tab==='return-history') loadReturnHistory();
}

// Tab 1: FFR
async function loadFFR(){
  document.getElementById('ffr-table').innerHTML='加载中...';
  let d;
  try { d=await api('/api/admin/supplier-data/ffr',null,'GET'); }
  catch(e){ document.getElementById('ffr-table').innerHTML='请求失败: '+e.message; return; }
  if(!d||!d.ok){document.getElementById('ffr-table').innerHTML='加载失败: '+(d&&d.msg||'unknown'); return;}
  if(!d.rows.length){document.getElementById('ffr-table').innerHTML='<p class="text-slate-500 py-4">暂无数据（请先填报生产数据）</p>';return;}
  let h='<div class="overflow-x-auto"><table class="min-w-full text-sm border-collapse"><thead><tr class="bg-slate-100"><th class="p-3 text-left border-b">型号</th><th class="p-3 text-right border-b">总生产数量</th><th class="p-3 text-right border-b">总退机数量</th><th class="p-3 text-right border-b">FFR</th></tr></thead><tbody>';
  for(const r of d.rows){
    const ffrVal=r.ffr==null?'—':r.ffr+'%';
    const ffrClass=r.ffr==null?'text-slate-400':r.ffr>5?'text-red-600 font-bold':r.ffr>2?'text-yellow-600 font-medium':'text-green-600';
    h+='<tr class="border-b hover:bg-slate-50"><td class="p-3 font-medium">'+escH(r.model)+'</td><td class="p-3 text-right">'+escH(r.total_prod)+'</td><td class="p-3 text-right">'+escH(r.total_return)+'</td><td class="p-3 text-right '+ffrClass+'">'+ffrVal+'</td></tr>';
  }
  h+='</tbody></table></div>';
  document.getElementById('ffr-table').innerHTML=h;
}

// Tab 2: 生产填报
document.getElementById('prod-form').addEventListener('submit',async e=>{
  e.preventDefault();
  // 清除上次的错误提示
  ['pf-date-err','pf-model-err','pf-customer-err','pf-batch-err','pf-plan-err','pf-actual-err','pf-report-err','pf-dup-err'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.classList.add('hidden');
  });
  ['pf-date','pf-model','pf-customer','pf-batch','pf-plan','pf-actual','pf-report'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.classList.remove('border-red-400');
  });
  // 必填字段校验
  let hasErr=false;
  function checkProdField(inputId,errId){
    const el=document.getElementById(inputId);
    if(!el) return;
    const v=(el.value||'').trim();
    if(!v){
      el.classList.add('border-red-400');
      const errEl=document.getElementById(errId);
      if(errEl) errEl.classList.remove('hidden');
      hasErr=true;
    }
  }
  checkProdField('pf-date','pf-date-err');
  checkProdField('pf-model','pf-model-err');
  checkProdField('pf-customer','pf-customer-err');
  checkProdField('pf-batch','pf-batch-err');
  checkProdField('pf-plan','pf-plan-err');
  checkProdField('pf-actual','pf-actual-err');
  // 验货报告文件校验
  const reportInput=document.getElementById('pf-report');
  if(reportInput&&(!reportInput.files||reportInput.files.length===0)){
    reportInput.classList.add('border-red-400');
    const re=document.getElementById('pf-report-err');
    if(re) re.classList.remove('hidden');
    hasErr=true;
  }
  if(hasErr) return;
  const fd=new FormData(e.target);
  const body={date:fd.get('date'),model:fd.get('model'),supplier:fd.get('supplier')||null,customer_name:fd.get('customer_name')||null,batch:fd.get('batch')||null};
  const pq=fd.get('plan_qty'); if(pq) body.plan_qty=Number(pq);
  const aq=fd.get('actual_qty'); if(aq) body.actual_qty=Number(aq);
  const wq=fd.get('warehouse_qty'); if(wq) body.warehouse_qty=Number(wq);
  const notes=fd.get('notes'); if(notes) body.notes=notes;
  const d=await api('/api/admin/supplier-data/prod',body);
  if(!d) return;
  if(d.ok){
    // 上传验货报告
    const repFile=reportInput&&reportInput.files&&reportInput.files[0];
    if(repFile){
      const fd2=new FormData();
      fd2.append('record_id',String(d.id));
      fd2.append('file',repFile);
      try{
        const ur=await fetch('/api/admin/supplier-data/prod/upload',{method:'POST',body:fd2});
        if(!ur.ok){const uj=await ur.json().catch(()=>({}));console.warn('验货报告上传失败',uj);}
      }catch(ue){console.warn('验货报告上传异常',ue);}
    }
    showMsg('prod-msg','提交成功！');e.target.reset();
  }
  else if(d.duplicate){
    const dupEl=document.getElementById('pf-dup-err');
    if(dupEl){dupEl.textContent=d.msg||'该日期/型号/订单数量的记录已存在，请勿重复提交';dupEl.classList.remove('hidden');}
  } else {
    showMsg('prod-msg','提交失败: '+d.msg,false);
  }
});

// Tab 3: 退机填报
document.getElementById('return-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const fd=new FormData(e.target);
  const body={date:fd.get('date'),model:fd.get('model'),supplier:fd.get('supplier')||null,customer_name:fd.get('customer_name')||null,batch:fd.get('batch')||null,defect_type:fd.get('defect_type')||null};
  const rq=fd.get('return_qty'); if(rq) body.return_qty=Number(rq);
  const wq=fd.get('warehouse_qty'); if(wq) body.warehouse_qty=Number(wq);
  const dd=fd.get('defect_desc'); if(dd) body.defect_desc=dd;
  const hr=fd.get('handling_result'); if(hr) body.handling_result=hr;
  const d=await api('/api/admin/supplier-data/return',body);
  if(!d) return;
  if(d.ok){showMsg('return-msg','提交成功！');e.target.reset();}
  else showMsg('return-msg','提交失败: '+d.msg,false);
});

// Tab 4: 生产历史
async function loadProdHistory(){
  const supplier=document.getElementById('ph-supplier').value.trim();
  const customer=document.getElementById('ph-customer').value.trim();
  const model=document.getElementById('ph-model').value.trim();
  const dateFrom=document.getElementById('ph-date-from').value;
  const dateTo=document.getElementById('ph-date-to').value;
  const qp=new URLSearchParams();
  if(supplier) qp.set('supplier',supplier);
  if(customer) qp.set('customer',customer);
  if(model) qp.set('model',model);
  if(dateFrom) qp.set('date_from',dateFrom);
  if(dateTo) qp.set('date_to',dateTo);
  document.getElementById('prod-history-list').innerHTML='加载中...';
  const d=await api('/api/admin/supplier-data/prod-history?'+qp.toString(),null,'GET');
  if(!d||!d.ok){document.getElementById('prod-history-list').innerHTML='加载失败';return;}
  if(!d.rows.length){document.getElementById('prod-history-list').innerHTML='<p class="text-slate-500 py-4">暂无记录</p>';return;}
  let h='<div class="overflow-x-auto"><table class="min-w-full text-sm border-collapse"><thead><tr class="bg-slate-100"><th class="p-2 text-left border-b">来源</th><th class="p-2 text-left border-b">日期</th><th class="p-2 text-left border-b">机型</th><th class="p-2 text-left border-b">供应商</th><th class="p-2 text-left border-b">客户</th><th class="p-2 text-left border-b">批次</th><th class="p-2 text-right border-b">计划</th><th class="p-2 text-right border-b">实际产出</th><th class="p-2 text-right border-b">入库</th><th class="p-2 text-left border-b">验货报告</th><th class="p-2 text-left border-b">备注</th><th class="p-2 border-b">操作</th></tr></thead><tbody>';
  for(const r of d.rows){
    const srcBadge=r._source==='new'?'<span class="px-1.5 py-0.5 rounded text-xs bg-green-100 text-green-700">新填报</span>':'<span class="px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-600">原有数据</span>';
    const rowData=JSON.stringify({id:r.id,date:r.date,model:r.model,supplier:r.supplier||'',customer_name:r.customer_name||'',batch:r.batch||'',plan_qty:r.plan_qty,actual_qty:r.actual_qty,warehouse_qty:r.warehouse_qty,notes:r.notes||''}).replace(/"/g,'&quot;');
    const editBtn=r._source==='new'?'<button data-act="edit-prod" data-row="'+rowData+'" class="text-blue-600 hover:underline text-xs">编辑</button>':'<span class="text-slate-400 text-xs">只读</span>';
    h+='<tr class="border-b hover:bg-slate-50">';
    h+='<td class="p-2 whitespace-nowrap">'+srcBadge+'</td>';
    h+='<td class="p-2 whitespace-nowrap">'+escH(r.date)+'</td><td class="p-2 whitespace-nowrap">'+escH(r.model)+'</td>';
    h+='<td class="p-2">'+escH(r.supplier||'-')+'</td>';
    h+='<td class="p-2">'+escH(r.customer_name||'-')+'</td><td class="p-2">'+escH(r.batch||'-')+'</td>';
    h+='<td class="p-2 text-right">'+escH(r.plan_qty??'-')+'</td><td class="p-2 text-right">'+escH(r.actual_qty??'-')+'</td><td class="p-2 text-right">'+escH(r.warehouse_qty??'-')+'</td>';
    const prodAttLinks=(r.attachments||[]).map(a=>'<a href="/api/repair/attachment/download?id='+a.id+'" target="_blank" class="text-blue-600 underline text-xs mr-1">'+escH(a.name)+'</a>').join('');
    h+='<td class="p-2">'+(prodAttLinks||'<span class="text-slate-400 text-xs">无</span>')+'</td>';
    h+='<td class="p-2 max-w-xs truncate" title="'+escH(r.notes||'')+'">'+escH(r.notes||'-')+'</td>';
    h+='<td class="p-2 whitespace-nowrap">'+editBtn+'</td>';
    h+='</tr>';
  }
  h+='</tbody></table></div><p class="text-xs text-slate-400 mt-2">共 '+d.rows.length+' 条（新填报 + 原有数据合并）</p>';
  document.getElementById('prod-history-list').innerHTML=h;
}
document.getElementById('ph-query').addEventListener('click',loadProdHistory);
document.getElementById('ph-reset').addEventListener('click',()=>{
  ['ph-supplier','ph-customer','ph-model','ph-date-from','ph-date-to'].forEach(id=>document.getElementById(id).value='');
  loadProdHistory();
});
['ph-supplier','ph-customer','ph-model'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')loadProdHistory();}));
document.getElementById('prod-history-list').addEventListener('click',e=>{
  const btn=e.target.closest('[data-act]');
  if(!btn) return;
  if(btn.dataset.act==='edit-prod'){
    openEditModal('prod',JSON.parse(btn.dataset.row));
  }
});

// Tab 5: 退机历史
async function loadReturnHistory(){
  const supplier=document.getElementById('rh-supplier').value.trim();
  const customer=document.getElementById('rh-customer').value.trim();
  const model=document.getElementById('rh-model').value.trim();
  const dateFrom=document.getElementById('rh-date-from').value;
  const dateTo=document.getElementById('rh-date-to').value;
  const qp=new URLSearchParams();
  if(supplier) qp.set('supplier',supplier);
  if(customer) qp.set('customer',customer);
  if(model) qp.set('model',model);
  if(dateFrom) qp.set('date_from',dateFrom);
  if(dateTo) qp.set('date_to',dateTo);
  document.getElementById('return-history-list').innerHTML='加载中...';
  const d=await api('/api/admin/supplier-data/return-history?'+qp.toString(),null,'GET');
  if(!d||!d.ok){document.getElementById('return-history-list').innerHTML='加载失败';return;}
  if(!d.rows.length){document.getElementById('return-history-list').innerHTML='<p class="text-slate-500 py-4">暂无记录</p>';return;}
  let h='<div class="overflow-x-auto"><table class="min-w-full text-sm border-collapse"><thead><tr class="bg-slate-100"><th class="p-2 text-left border-b">来源</th><th class="p-2 text-left border-b">日期</th><th class="p-2 text-left border-b">型号</th><th class="p-2 text-left border-b">供应商</th><th class="p-2 text-left border-b">客户</th><th class="p-2 text-left border-b">批次</th><th class="p-2 text-right border-b">退机数量</th><th class="p-2 text-left border-b">不良类型</th><th class="p-2 text-right border-b">入库</th><th class="p-2 text-left border-b">验货报告</th><th class="p-2 text-left border-b">不良描述</th><th class="p-2 text-left border-b">处理结果</th><th class="p-2 border-b">操作</th></tr></thead><tbody>';
  for(const r of d.rows){
    const srcBadge=r._source==='new'?'<span class="px-1.5 py-0.5 rounded text-xs bg-green-100 text-green-700">新填报</span>':'<span class="px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-600">原有数据</span>';
    const rowData=JSON.stringify({id:r.id,date:r.date,model:r.model,supplier:r.supplier||'',customer_name:r.customer_name||'',batch:r.batch||'',return_qty:r.return_qty,defect_type:r.defect_type||'',warehouse_qty:r.warehouse_qty,defect_desc:r.defect_desc||'',handling_result:r.handling_result||''}).replace(/"/g,'&quot;');
    const editBtn=r._source==='new'?'<button data-act="edit-return" data-row="'+rowData+'" class="text-blue-600 hover:underline text-xs">编辑</button>':'<span class="text-slate-400 text-xs">只读</span>';
    h+='<tr class="border-b hover:bg-slate-50">';
    h+='<td class="p-2 whitespace-nowrap">'+srcBadge+'</td>';
    h+='<td class="p-2 whitespace-nowrap">'+escH(r.date)+'</td><td class="p-2 whitespace-nowrap">'+escH(r.model)+'</td>';
    h+='<td class="p-2">'+escH(r.supplier||'-')+'</td>';
    h+='<td class="p-2">'+escH(r.customer_name||'-')+'</td><td class="p-2">'+escH(r.batch||'-')+'</td>';
    h+='<td class="p-2 text-right">'+escH(r.return_qty??'-')+'</td><td class="p-2">'+escH(r.defect_type||'-')+'</td><td class="p-2 text-right">'+escH(r.warehouse_qty??'-')+'</td>';
    const retAttLinks=(r.attachments||[]).map(a=>'<a href="/api/repair/attachment/download?id='+a.id+'" target="_blank" class="text-blue-600 underline text-xs mr-1">'+escH(a.name)+'</a>').join('');
    h+='<td class="p-2">'+(retAttLinks||'<span class="text-slate-400 text-xs">无</span>')+'</td>';
    h+='<td class="p-2 max-w-xs truncate" title="'+escH(r.defect_desc||'')+'">'+escH(r.defect_desc||'-')+'</td>';
    h+='<td class="p-2 max-w-xs truncate" title="'+escH(r.handling_result||'')+'">'+escH(r.handling_result||'-')+'</td>';
    h+='<td class="p-2 whitespace-nowrap">'+editBtn+'</td>';
    h+='</tr>';
  }
  h+='</tbody></table></div><p class="text-xs text-slate-400 mt-2">共 '+d.rows.length+' 条（新填报 + 原有数据合并）</p>';
  document.getElementById('return-history-list').innerHTML=h;
}
document.getElementById('rh-query').addEventListener('click',loadReturnHistory);
document.getElementById('rh-reset').addEventListener('click',()=>{
  ['rh-supplier','rh-customer','rh-model','rh-date-from','rh-date-to'].forEach(id=>document.getElementById(id).value='');
  loadReturnHistory();
});
['rh-supplier','rh-customer','rh-model'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')loadReturnHistory();}));
document.getElementById('return-history-list').addEventListener('click',e=>{
  const btn=e.target.closest('[data-act]');
  if(!btn) return;
  if(btn.dataset.act==='edit-return'){
    const row=JSON.parse(btn.dataset.row);
    openEditModal('return',row);
  }
});

// Edit Modal
let _editType=null;
function openEditModal(type,data){
  _editType=type;
  const isProd=type==='prod';
  document.getElementById('modal-title').textContent=isProd?'编辑生产记录':'编辑退机记录';
  document.getElementById('ef-type').value=type;
  document.getElementById('ef-id').value=data.id;
  document.getElementById('ef-date').value=data.date||'';
  document.getElementById('ef-model').value=data.model||'';
  document.getElementById('ef-customer').value=data.customer_name||'';
  document.getElementById('ef-supplier').value=data.supplier||'';
  document.getElementById('ef-batch').value=data.batch||'';
  document.getElementById('ef-warehouse').value=data.warehouse_qty??'';
  // prod-specific
  document.getElementById('ef-plan-wrap').style.display=isProd?'':'none';
  document.getElementById('ef-actual-wrap').style.display=isProd?'':'none';
  document.getElementById('ef-notes-wrap').style.display=isProd?'':'none';
  if(isProd){
    document.getElementById('ef-plan').value=data.plan_qty??'';
    document.getElementById('ef-actual').value=data.actual_qty??'';
    document.getElementById('ef-notes').value=data.notes||'';
  }
  // return-specific
  document.getElementById('ef-return-qty-wrap').style.display=isProd?'none':'';
  document.getElementById('ef-defect-type-wrap').style.display=isProd?'none':'';
  document.getElementById('ef-defect-desc-wrap').style.display=isProd?'none':'';
  document.getElementById('ef-handling-wrap').style.display=isProd?'none':'';
  if(!isProd){
    document.getElementById('ef-return-qty').value=data.return_qty??'';
    document.getElementById('ef-defect-type').value=data.defect_type||'';
    document.getElementById('ef-defect-desc').value=data.defect_desc||'';
    document.getElementById('ef-handling').value=data.handling_result||'';
  }
  const modal=document.getElementById('edit-modal');
  modal.style.display='flex';
  modal.classList.add('flex');
}
function closeModal(){
  const modal=document.getElementById('edit-modal');
  modal.style.display='none';
  modal.classList.remove('flex');
}
document.getElementById('edit-modal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});
document.getElementById('edit-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const type=document.getElementById('ef-type').value;
  const id=Number(document.getElementById('ef-id').value);
  const body={id,date:document.getElementById('ef-date').value,model:document.getElementById('ef-model').value,supplier:document.getElementById('ef-supplier').value||null,customer_name:document.getElementById('ef-customer').value||null,batch:document.getElementById('ef-batch').value||null};
  const wq=document.getElementById('ef-warehouse').value; if(wq!=='')body.warehouse_qty=Number(wq);
  if(type==='prod'){
    const pq=document.getElementById('ef-plan').value; if(pq!=='')body.plan_qty=Number(pq);
    const aq=document.getElementById('ef-actual').value; if(aq!=='')body.actual_qty=Number(aq);
    const n=document.getElementById('ef-notes').value; if(n)body.notes=n;
  } else {
    const rq=document.getElementById('ef-return-qty').value; if(rq!=='')body.return_qty=Number(rq);
    body.defect_type=document.getElementById('ef-defect-type').value||null;
    body.defect_desc=document.getElementById('ef-defect-desc').value||null;
    body.handling_result=document.getElementById('ef-handling').value||null;
  }
  const endpoint=type==='prod'?'/api/admin/supplier-data/prod/edit':'/api/admin/supplier-data/return/edit';
  const d=await api(endpoint,body);
  if(!d) return;
  if(d.ok){
    showMsg('modal-msg','保存成功');
    setTimeout(()=>{closeModal();if(type==='prod')loadProdHistory();else loadReturnHistory();},800);
  } else showMsg('modal-msg','保存失败: '+d.msg,false);
});

// Load vehicle brands into datalist
async function loadBrands(){
  try{
    const d=await api('/api/admin/brands/list',null,'GET');
    if(!d||!d.ok) return;
    const dl=document.getElementById('brands-list');
    dl.innerHTML='';
    for(const b of d.brands.filter(x=>x.enabled)){
      const opt=document.createElement('option');
      opt.value=b.name;
      dl.appendChild(opt);
    }
  }catch(e){}
}

// Init: load FFR and brands on page open
loadFFR();
loadBrands();
const validVendorTabs = ['ffr','prod-form','return-form','prod-history','return-history'];
function handleVendorHash(){
  const tab = location.hash.slice(1);
  if (validVendorTabs.includes(tab)) {
    const btn = document.querySelector('[data-tab="' + tab + '"]');
    if (btn) switchVendorTab(btn, tab);
  }
}
handleVendorHash();
window.addEventListener('hashchange', handleVendorHash);
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="/admin/supplier-data#"]');
  if (a) {
    e.preventDefault();
    const tab = a.getAttribute('href').split('#')[1];
    if (validVendorTabs.includes(tab)) {
      history.replaceState(null, '', '#' + tab);
      handleVendorHash();
    }
  }
});
</script>
<datalist id="brands-list"></datalist>
</body></html>`;
}

// ============================================================
// 通用工单工作流
// ============================================================

function ensureWorkflowTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      order_no TEXT NOT NULL UNIQUE,
      product_model TEXT,
      batch_no TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      supplier TEXT NOT NULL,
      sn TEXT,
      mac TEXT,
      customer TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      current_stage INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      stage_index INTEGER NOT NULL,
      stage_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      quantity INTEGER,
      qualified_count INTEGER,
      defective_count INTEGER,
      problem_description TEXT,
      responsible TEXT,
      happened_at INTEGER,
      submitted_by TEXT,
      submitted_at INTEGER,
      updated_at INTEGER,
      UNIQUE(order_id, stage_index),
      FOREIGN KEY(order_id) REFERENCES workflow_orders(id)
    );
    CREATE TABLE IF NOT EXISTS workflow_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      from_stage INTEGER,
      to_stage INTEGER,
      detail TEXT,
      operator TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(order_id) REFERENCES workflow_orders(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_orders_type_stage ON workflow_orders(type, current_stage, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_orders_supplier ON workflow_orders(supplier, type, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_stages_order ON workflow_stages(order_id, stage_index);
    CREATE INDEX IF NOT EXISTS idx_workflow_logs_order ON workflow_logs(order_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_device_sn ON workflow_orders(sn) WHERE type IN ('aftersales','line_repair') AND sn IS NOT NULL AND sn <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_device_mac ON workflow_orders(mac) WHERE type IN ('aftersales','line_repair') AND mac IS NOT NULL AND mac <> '';
  `);
}

function workflowConfig(type) {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_TYPES, type) ? WORKFLOW_TYPES[type] : null;
}

function workflowCanAccess(order, sess) {
  return isAdminRole(sess.role) || (isSupplierRole(sess.role) && !!sess.supplier && order.supplier === sess.supplier);
}

function workflowActor(sess) {
  return sess.display_name || sess.username;
}

function workflowStageRequiresAdmin(order, stageIndex) {
  return workflowConfig(order.type).device && stageIndex === 0;
}

function workflowCanSubmitStage(order, stageIndex, sess) {
  if (workflowStageRequiresAdmin(order, stageIndex)) return sess.role === 'super_admin';
  return isSupplierRole(sess.role) && !!sess.supplier && order.supplier === sess.supplier;
}

function workflowGetOrder(id, sess) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM workflow_orders WHERE id=?').get(Number(id));
  if (!order || !workflowCanAccess(order, sess)) return null;
  order.stages = db.prepare('SELECT * FROM workflow_stages WHERE order_id=? ORDER BY stage_index').all(order.id);
  order.logs = db.prepare('SELECT * FROM workflow_logs WHERE order_id=? ORDER BY id DESC LIMIT 100').all(order.id);
  for (const stage of order.stages) {
    stage.attachments = dbGetAttachments('workflow_stage', stage.id);
  }
  return order;
}

function apiWorkflowList(query, sess) {
  const cfg = workflowConfig(query.type);
  if (!cfg) return json({ ok: false, msg: '无效工作流类型' }, 400);
  const wheres = ['type=?'];
  const params = [query.type];
  if (isSupplierRole(sess.role)) {
    if (!sess.supplier) return json({ ok: false, msg: '账号未绑定供应商' }, 403);
    wheres.push('supplier=?');
    params.push(sess.supplier);
  } else if (!isAdminRole(sess.role)) {
    return json({ ok: false, msg: '无权访问' }, 403);
  }
  if (query.stage !== undefined && query.stage !== '') {
    const stage = Number(query.stage);
    if (!Number.isInteger(stage) || stage < 0 || stage >= cfg.stages.length) return json({ ok: false, msg: '无效阶段' }, 400);
    wheres.push('current_stage=?');
    params.push(stage);
  }
  if (query.status && ['active', 'completed'].includes(query.status)) {
    wheres.push('status=?');
    params.push(query.status);
  }
  if (query.q) {
    wheres.push('(order_no LIKE ? OR product_model LIKE ? OR batch_no LIKE ? OR sn LIKE ? OR mac LIKE ?)');
    const term = `%${query.q}%`;
    params.push(term, term, term, term, term);
  }
  const rows = getDb().prepare(`SELECT * FROM workflow_orders WHERE ${wheres.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT 500`).all(...params);
  return json({ ok: true, config: cfg, orders: rows });
}

function apiWorkflowGet(query, sess) {
  const order = workflowGetOrder(query.id, sess);
  return order ? json({ ok: true, order, config: workflowConfig(order.type) }) : json({ ok: false, msg: '工单不存在或无权访问' }, 404);
}

function apiWorkflowCreate(parsed, sess) {
  if (sess.role !== 'super_admin') return json({ ok: false, msg: '仅超级管理员可创建工单' }, 403);
  const cfg = workflowConfig(parsed.type);
  if (!cfg) return json({ ok: false, msg: '无效工作流类型' }, 400);
  const supplier = String(parsed.supplier || '').trim();
  const productModel = String(parsed.product_model || '').trim();
  const batchNo = String(parsed.batch_no || '').trim();
  const customer = String(parsed.customer || '').trim();
  const sn = String(parsed.sn || '').trim().toUpperCase();
  const mac = String(parsed.mac || '').trim().toUpperCase();
  const quantity = cfg.device ? 1 : Number(parsed.quantity);
  if (!supplier || !productModel) return json({ ok: false, msg: '产品/型号和供应商不能为空' }, 400);
  if (!dbGetSupplierNames().includes(supplier)) return json({ ok: false, msg: '供应商不存在' }, 400);
  if (!Number.isInteger(quantity) || quantity < 1) return json({ ok: false, msg: '数量必须为正整数' }, 400);
  if (cfg.device && !sn && !mac) return json({ ok: false, msg: 'SN 或 MAC 至少填写一个' }, 400);
  if (cfg.device && !customer) return json({ ok: false, msg: '客户不能为空' }, 400);
  const db = getDb();
  const now = Date.now();
  try {
    const id = db.transaction(() => {
      const orderNo = `${parsed.type === 'manufacturing' ? 'MO' : parsed.type === 'aftersales' ? 'AS' : 'LR'}-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const result = db.prepare(`INSERT INTO workflow_orders
        (type,order_no,product_model,batch_no,quantity,supplier,sn,mac,customer,status,current_stage,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'active',0,?,?,?)`).run(parsed.type, orderNo, productModel, batchNo || null, quantity, supplier, sn || null, mac || null, customer || null, workflowActor(sess), now, now);
      const orderId = Number(result.lastInsertRowid);
      const insertStage = db.prepare('INSERT INTO workflow_stages (order_id,stage_index,stage_name,status,quantity,updated_at) VALUES (?,?,?,?,?,?)');
      cfg.stages.forEach((name, index) => insertStage.run(orderId, index, name, index === 0 ? 'in_progress' : 'pending', quantity, now));
      db.prepare('INSERT INTO workflow_logs (order_id,action,from_stage,to_stage,detail,operator,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(orderId, 'create', null, 0, `创建并绑定供应商 ${supplier}`, workflowActor(sess), now);
      return orderId;
    })();
    return json({ ok: true, id });
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) return json({ ok: false, msg: 'SN、MAC 或工单号已存在' }, 409);
    throw e;
  }
}

function validateWorkflowStageData(parsed, order) {
  const quantity = Number(parsed.quantity);
  const qualified = Number(parsed.qualified_count);
  const defective = Number(parsed.defective_count);
  if (![quantity, qualified, defective].every(Number.isInteger) || quantity < 0 || qualified < 0 || defective < 0) return '数量、合格数、不良数必须为非负整数';
  if (quantity !== qualified + defective) return '合格数与不良数之和必须等于数量';
  if (!String(parsed.responsible || '').trim()) return '负责人不能为空';
  if (defective > 0 && !String(parsed.problem_description || '').trim()) return '存在不良时必须填写问题描述';
  if (order.type !== 'manufacturing' && quantity !== 1) return '设备类工单数量必须为 1';
  return null;
}

function apiWorkflowSubmit(parsed, sess) {
  const db = getDb();
  try {
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM workflow_orders WHERE id=?').get(Number(parsed.order_id));
      if (!order || !workflowCanAccess(order, sess)) throw Object.assign(new Error('工单不存在或无权访问'), { status: 404 });
      if (order.status !== 'active') throw Object.assign(new Error('已完成工单只读'), { status: 409 });
      const stageIndex = Number(parsed.stage_index);
      if (stageIndex !== order.current_stage) throw Object.assign(new Error('只能提交当前阶段'), { status: 409 });
      if (!workflowCanSubmitStage(order, stageIndex, sess)) throw Object.assign(new Error(workflowStageRequiresAdmin(order, stageIndex) ? '设备登记阶段仅超级管理员可提交' : '当前阶段仅绑定供应商可提交'), { status: 403 });
      const stage = db.prepare('SELECT * FROM workflow_stages WHERE order_id=? AND stage_index=?').get(order.id, stageIndex);
      if (!stage || stage.status !== 'in_progress') throw Object.assign(new Error('当前阶段状态已变化，请刷新'), { status: 409 });
      const validation = validateWorkflowStageData(parsed, order);
      if (validation) throw Object.assign(new Error(validation), { status: 400 });
      const now = Date.now();
      const cfg = workflowConfig(order.type);
      const next = stageIndex + 1;
      db.prepare(`UPDATE workflow_stages SET status='done',quantity=?,qualified_count=?,defective_count=?,problem_description=?,responsible=?,happened_at=?,submitted_by=?,submitted_at=?,updated_at=? WHERE id=? AND status='in_progress'`)
        .run(Number(parsed.quantity), Number(parsed.qualified_count), Number(parsed.defective_count), String(parsed.problem_description || '').trim() || null, String(parsed.responsible).trim(), Number(parsed.happened_at) || now, workflowActor(sess), now, now, stage.id);
      if (next < cfg.stages.length) {
        db.prepare("UPDATE workflow_stages SET status='in_progress',updated_at=? WHERE order_id=? AND stage_index=? AND status='pending'").run(now, order.id, next);
        db.prepare('UPDATE workflow_orders SET current_stage=?,updated_at=? WHERE id=?').run(next, now, order.id);
      } else {
        db.prepare("UPDATE workflow_orders SET status='completed',updated_at=? WHERE id=?").run(now, order.id);
      }
      db.prepare('INSERT INTO workflow_logs (order_id,action,from_stage,to_stage,detail,operator,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(order.id, 'submit', stageIndex, next < cfg.stages.length ? next : null, `${stage.stage_name}提交：合格${parsed.qualified_count}，不良${parsed.defective_count}`, workflowActor(sess), now);
      return { completed: next >= cfg.stages.length };
    })();
    return json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return json({ ok: false, msg: e.message }, e.status);
    throw e;
  }
}

function apiWorkflowAdminAction(parsed, sess) {
  if (sess.role !== 'super_admin') return json({ ok: false, msg: '仅超级管理员可执行此操作' }, 403);
  const action = parsed.action;
  if (!['return', 'advance', 'correct'].includes(action)) return json({ ok: false, msg: '无效操作' }, 400);
  const reason = String(parsed.reason || '').trim();
  if (!reason) return json({ ok: false, msg: '必须填写操作原因' }, 400);
  const db = getDb();
  try {
    db.transaction(() => {
      const order = db.prepare('SELECT * FROM workflow_orders WHERE id=?').get(Number(parsed.order_id));
      if (!order) throw Object.assign(new Error('工单不存在'), { status: 404 });
      if (action !== 'correct' && Number(parsed.expected_stage) !== order.current_stage) throw Object.assign(new Error('工单阶段已变化，请刷新后重试'), { status: 409 });
      const cfg = workflowConfig(order.type);
      const now = Date.now();
      if (action === 'correct') {
        const stageIndex = Number(parsed.stage_index);
        const stage = db.prepare('SELECT * FROM workflow_stages WHERE order_id=? AND stage_index=?').get(order.id, stageIndex);
        if (!stage) throw Object.assign(new Error('阶段不存在'), { status: 404 });
        const validation = validateWorkflowStageData(parsed, order);
        if (validation) throw Object.assign(new Error(validation), { status: 400 });
        db.prepare('UPDATE workflow_stages SET quantity=?,qualified_count=?,defective_count=?,problem_description=?,responsible=?,happened_at=?,updated_at=? WHERE id=?')
          .run(Number(parsed.quantity), Number(parsed.qualified_count), Number(parsed.defective_count), String(parsed.problem_description || '').trim() || null, String(parsed.responsible).trim(), Number(parsed.happened_at) || now, now, stage.id);
        db.prepare('INSERT INTO workflow_logs (order_id,action,from_stage,to_stage,detail,operator,created_at) VALUES (?,?,?,?,?,?,?)').run(order.id, 'correct', stageIndex, stageIndex, reason, workflowActor(sess), now);
        db.prepare('UPDATE workflow_orders SET updated_at=? WHERE id=?').run(now, order.id);
        return;
      }
      if (order.status !== 'active') throw Object.assign(new Error('已完成工单不能推进或退回'), { status: 409 });
      const current = order.current_stage;
      if (action === 'return') {
        if (current < 1) throw Object.assign(new Error('首阶段不能退回'), { status: 409 });
        const resetCurrent = db.prepare("UPDATE workflow_stages SET status='pending',updated_at=? WHERE order_id=? AND stage_index=? AND status='in_progress'").run(now, order.id, current);
        const reopenPrevious = db.prepare("UPDATE workflow_stages SET status='in_progress',submitted_by=NULL,submitted_at=NULL,updated_at=? WHERE order_id=? AND stage_index=? AND status='done'").run(now, order.id, current - 1);
        const moveOrder = db.prepare('UPDATE workflow_orders SET current_stage=?,updated_at=? WHERE id=? AND current_stage=?').run(current - 1, now, order.id, current);
        if (resetCurrent.changes !== 1 || reopenPrevious.changes !== 1 || moveOrder.changes !== 1) throw Object.assign(new Error('工单阶段已变化，请刷新后重试'), { status: 409 });
        db.prepare('INSERT INTO workflow_logs (order_id,action,from_stage,to_stage,detail,operator,created_at) VALUES (?,?,?,?,?,?,?)').run(order.id, 'admin_return', current, current - 1, reason, workflowActor(sess), now);
      } else {
        const next = current + 1;
        const finishCurrent = db.prepare("UPDATE workflow_stages SET status='done',submitted_by=?,submitted_at=?,updated_at=? WHERE order_id=? AND stage_index=? AND status='in_progress'").run(workflowActor(sess), now, now, order.id, current);
        if (finishCurrent.changes !== 1) throw Object.assign(new Error('工单阶段已变化，请刷新后重试'), { status: 409 });
        if (next < cfg.stages.length) {
          const startNext = db.prepare("UPDATE workflow_stages SET status='in_progress',updated_at=? WHERE order_id=? AND stage_index=? AND status='pending'").run(now, order.id, next);
          const moveOrder = db.prepare('UPDATE workflow_orders SET current_stage=?,updated_at=? WHERE id=? AND current_stage=?').run(next, now, order.id, current);
          if (startNext.changes !== 1 || moveOrder.changes !== 1) throw Object.assign(new Error('工单阶段已变化，请刷新后重试'), { status: 409 });
        } else {
          const finishOrder = db.prepare("UPDATE workflow_orders SET status='completed',updated_at=? WHERE id=? AND current_stage=?").run(now, order.id, current);
          if (finishOrder.changes !== 1) throw Object.assign(new Error('工单阶段已变化，请刷新后重试'), { status: 409 });
        }
        db.prepare('INSERT INTO workflow_logs (order_id,action,from_stage,to_stage,detail,operator,created_at) VALUES (?,?,?,?,?,?,?)').run(order.id, 'admin_advance', current, next < cfg.stages.length ? next : null, reason, workflowActor(sess), now);
      }
    })();
    return json({ ok: true });
  } catch (e) {
    if (e.status) return json({ ok: false, msg: e.message }, e.status);
    throw e;
  }
}

function workflowAttachmentOrder(attachmentId, sess) {
  const row = getDb().prepare(`SELECT a.*,s.order_id,o.supplier FROM repair_attachments a
    JOIN workflow_stages s ON a.record_type='workflow_stage' AND a.record_id=s.id
    JOIN workflow_orders o ON o.id=s.order_id WHERE a.id=?`).get(Number(attachmentId));
  return row && (isAdminRole(sess.role) || (isSupplierRole(sess.role) && row.supplier === sess.supplier)) ? row : null;
}

function apiWorkflowUpload(parts, sess) {
  const orderId = Number((parts.find(p => p.name === 'order_id') || {}).text);
  const stageIndex = Number((parts.find(p => p.name === 'stage_index') || {}).text);
  const order = workflowGetOrder(orderId, sess);
  if (!order) return json({ ok: false, msg: '工单不存在或无权访问' }, 404);
  if (order.status !== 'active' || stageIndex !== order.current_stage) return json({ ok: false, msg: '只能向当前阶段上传附件' }, 409);
  if (!workflowCanSubmitStage(order, stageIndex, sess)) return json({ ok: false, msg: workflowStageRequiresAdmin(order, stageIndex) ? '设备登记阶段仅超级管理员可上传附件' : '当前阶段仅绑定供应商可上传附件' }, 403);
  const stage = order.stages.find(s => s.stage_index === stageIndex && s.status === 'in_progress');
  if (!stage) return json({ ok: false, msg: '阶段状态已变化，请刷新' }, 409);
  const files = parts.filter(p => p.name === 'file' && p.filename);
  if (!files.length) return json({ ok: false, msg: '未找到上传文件' }, 400);
  if (files.some(p => p.data.length > MAX_UPLOAD_SIZE)) return json({ ok: false, msg: '单个附件不能超过 10MB' }, 413);
  const uploaded = [];
  for (const part of files) {
    const ext = nodePath.extname(nodePath.basename(part.filename)).slice(0, 12);
    const filename = `workflow_${order.id}_${stage.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(nodePath.join(UPLOAD_DIR, filename), part.data);
    const id = dbInsertAttachment('workflow_stage', stage.id, filename, nodePath.basename(part.filename), part.contentType, part.data.length);
    uploaded.push({ id: Number(id), name: nodePath.basename(part.filename) });
  }
  getDb().prepare('INSERT INTO workflow_logs (order_id,action,from_stage,to_stage,detail,operator,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(order.id, 'attachment_upload', stageIndex, stageIndex, `上传附件 ${uploaded.map(x => x.name).join(', ')}`, workflowActor(sess), Date.now());
  return json({ ok: true, uploaded });
}

function apiWorkflowAttachmentDownload(query, sess) {
  const att = workflowAttachmentOrder(query.id, sess);
  if (!att) return json({ ok: false, msg: '附件不存在或无权访问' }, 404);
  try {
    return { status: 200, headers: { 'Content-Type': att.mime_type || 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.original_name)}`, 'Content-Length': String(att.size) }, body: fs.readFileSync(nodePath.join(UPLOAD_DIR, att.filename)) };
  } catch {
    return json({ ok: false, msg: '附件文件不存在' }, 404);
  }
}

function supplierWorkflowNav(sess, activeType) {
  const links = Object.entries(WORKFLOW_TYPES).map(([type, cfg]) => `<a href="/supplier/workflows?type=${type}" style="padding:8px 12px;border-radius:6px;text-decoration:none;${activeType===type?'background:#2563eb;color:#fff;':'background:#fff;color:#2563eb;border:1px solid #dbeafe;'}">${cfg.label}</a>`).join('');
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;"><a href="/" style="padding:8px 12px;color:#475569;text-decoration:none;">产品与原填报</a>${links}<span style="margin-left:auto;color:#64748b;padding:8px;">${escapeHtml(sess.supplier)}</span></div>`;
}

function workflowPage(sess, query, admin) {
  const type = workflowConfig(query.type) ? query.type : 'manufacturing';
  const cfg = workflowConfig(type);
  const active = `workflow-${type === 'line_repair' ? 'line-repair' : type}`;
  const stage = query.stage !== undefined && query.stage !== '' ? Number(query.stage) : '';
  const suppliers = admin ? dbGetSupplierNames() : [];
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${cfg.label}</title><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://cdn.tailwindcss.com"></script><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}.wf-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:12px}.wf-stage{padding:7px 10px;border-radius:6px;background:#f1f5f9;font-size:12px}.wf-stage.done{background:#dcfce7;color:#166534}.wf-stage.in_progress{background:#dbeafe;color:#1d4ed8}.field{border:1px solid #d1d5db;border-radius:6px;padding:8px;width:100%;box-sizing:border-box}</style></head><body class="bg-slate-50 min-h-screen">
  ${admin ? ADMIN_NAV(active, sess) : ''}<main style="${admin ? 'margin-left:220px;padding:116px 24px 40px;' : 'max-width:1100px;margin:auto;padding:24px;'}">${admin ? '' : supplierWorkflowNav(sess,type)}
  <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:18px"><div><h2 style="font-size:22px;font-weight:700;margin:0">${cfg.label}</h2><div style="color:#64748b;font-size:13px;margin-top:4px">${cfg.stages.join(' → ')}</div></div>${admin && sess.role==='super_admin' ? '<button onclick="showCreate()" class="bg-blue-600 text-white px-4 py-2 rounded">新建工单</button>' : ''}</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"><input id="search" class="field" style="max-width:260px" placeholder="工单号/型号/批次/SN/MAC"><select id="status" class="field" style="max-width:150px"><option value="">全部状态</option><option value="active">处理中</option><option value="completed">已完成</option></select><button onclick="loadOrders()" class="bg-slate-700 text-white px-4 rounded">筛选</button></div><div id="orders">加载中...</div>
  </main><dialog id="createDlg" style="border:0;border-radius:12px;padding:24px;max-width:620px;width:90%"><h3 class="text-lg font-semibold mb-4">新建${cfg.label}工单</h3><form id="createForm" class="grid grid-cols-2 gap-3"><input name="product_model" class="field" placeholder="产品/型号 *" required><input name="batch_no" class="field" placeholder="批次"><input name="quantity" type="number" min="1" value="1" class="field" ${cfg.device?'readonly':''}><select name="supplier" class="field" required><option value="">选择供应商 *</option>${suppliers.map(x=>`<option>${escapeHtml(x)}</option>`).join('')}</select>${cfg.device?'<input name="sn" class="field" placeholder="SN（与MAC至少一个）"><input name="mac" class="field" placeholder="MAC（与SN至少一个）"><input name="customer" class="field col-span-2" placeholder="客户 *" required>':''}<div class="col-span-2 flex justify-end gap-2"><button type="button" onclick="createDlg.close()" class="px-4 py-2">取消</button><button class="bg-blue-600 text-white px-4 py-2 rounded">创建</button></div></form></dialog>
  <script>const TYPE=${JSON.stringify(type)},STAGE_FILTER=${JSON.stringify(stage)},IS_ADMIN=${admin?'true':'false'},IS_SUPER=${sess.role==='super_admin'?'true':'false'};const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const fmt=t=>t?new Date(t).toLocaleString('zh-CN'):'-';
  function showCreate(){document.getElementById('createDlg').showModal()}
  async function req(url,opts){const r=await fetch(url,opts),d=await r.json();if(!d.ok)throw new Error(d.msg||'操作失败');return d}
  async function loadOrders(){const searchEl=document.getElementById('search'),statusEl=document.getElementById('status'),ordersEl=document.getElementById('orders');let u='/api/workflows/list?type='+TYPE+'&q='+encodeURIComponent(searchEl.value)+'&status='+statusEl.value;if(STAGE_FILTER!=='')u+='&stage='+STAGE_FILTER;try{const d=await req(u);ordersEl.innerHTML=d.orders.length?d.orders.map(card).join(''):'<div class="text-slate-400 py-12 text-center">暂无工单</div>'}catch(e){ordersEl.innerHTML='<div class="text-red-600">'+esc(e.message)+'</div>'}}
  function card(o){return '<div class="wf-card"><div class="flex justify-between gap-3 flex-wrap"><div><b>'+esc(o.order_no)+'</b><div class="text-sm text-slate-500 mt-1">'+esc(o.product_model)+' / '+esc(o.supplier)+(o.batch_no?' / 批次 '+esc(o.batch_no):'')+(o.sn?' / SN '+esc(o.sn):'')+(o.mac?' / MAC '+esc(o.mac):'')+'</div></div><div><span class="text-sm '+(o.status==='completed'?'text-green-700':'text-blue-700')+'">'+(o.status==='completed'?'已完成':'当前：'+esc(${JSON.stringify(cfg.stages)}[o.current_stage]))+'</span> <button onclick="detail('+o.id+')" class="ml-2 text-blue-600">查看/处理</button></div></div></div>'}
  async function detail(id){try{const d=await req('/api/workflows/get?id='+id),o=d.order,c=d.config,cur=o.stages[o.current_stage];let h='<div class="wf-card"><div class="flex justify-between"><b>'+esc(o.order_no)+'</b><button onclick="loadOrders()" class="text-blue-600">返回列表</button></div><div class="text-sm text-slate-600 mt-2">产品/型号：'+esc(o.product_model)+'　批次：'+esc(o.batch_no||'-')+'　数量：'+o.quantity+'　供应商：'+esc(o.supplier)+(o.customer?'　客户：'+esc(o.customer):'')+(o.sn?'　SN：'+esc(o.sn):'')+(o.mac?'　MAC：'+esc(o.mac):'')+'</div><div class="flex gap-2 flex-wrap mt-4">'+o.stages.map(s=>'<span class="wf-stage '+s.status+'">'+esc(s.stage_name)+' · '+(s.status==='done'?'完成':s.status==='in_progress'?'当前':'待处理')+'</span>').join('')+'</div></div>';
  const maySubmit=(!IS_ADMIN&&!(c.device&&o.current_stage===0))||(IS_SUPER&&c.device&&o.current_stage===0);if(o.status==='active'&&maySubmit)h+='<div class="wf-card"><h3 class="font-semibold mb-3">提交当前阶段：'+esc(cur.stage_name)+'</h3><div class="grid grid-cols-2 md:grid-cols-3 gap-3"><input id="qty" type="number" min="0" class="field" value="'+(cur.quantity==null?o.quantity:cur.quantity)+'" placeholder="数量"><input id="good" type="number" min="0" class="field" value="'+(cur.qualified_count==null?'':cur.qualified_count)+'" placeholder="合格数"><input id="bad" type="number" min="0" class="field" value="'+(cur.defective_count==null?'':cur.defective_count)+'" placeholder="不良数"><input id="owner" class="field" value="'+esc(cur.responsible||'')+'" placeholder="负责人"><input id="when" type="datetime-local" class="field"><textarea id="problem" class="field md:col-span-3" placeholder="问题描述">'+esc(cur.problem_description||'')+'</textarea><input id="files" type="file" multiple class="field md:col-span-2"><button onclick="uploadFiles('+o.id+','+o.current_stage+')" class="bg-slate-600 text-white rounded">上传附件</button></div><div class="mt-3"><button onclick="submitStage('+o.id+','+o.current_stage+')" class="bg-blue-600 text-white px-4 py-2 rounded">提交并推进</button>'+(IS_SUPER&&o.current_stage>0?' <button onclick="adminAction('+o.id+',&apos;return&apos;,'+o.current_stage+')" class="bg-amber-600 text-white px-4 py-2 rounded">退回</button>':'')+(IS_SUPER?' <button onclick="adminAction('+o.id+',&apos;advance&apos;,'+o.current_stage+')" class="bg-red-600 text-white px-4 py-2 rounded">强制推进</button>':'')+'</div></div>';else if(o.status==='active')h+='<div class="wf-card text-slate-500">'+(!IS_ADMIN&&c.device&&o.current_stage===0?'等待超级管理员完成设备登记。':'当前阶段由绑定供应商填写；超级管理员可在下方执行退回、纠错或强制推进。')+'</div>'+(IS_SUPER?'<div class="wf-card"><button onclick="adminAction('+o.id+',&apos;return&apos;,'+o.current_stage+')" '+(o.current_stage===0?'disabled':'')+' class="bg-amber-600 disabled:bg-slate-300 text-white px-4 py-2 rounded">退回</button> <button onclick="adminAction('+o.id+',&apos;advance&apos;,'+o.current_stage+')" class="bg-red-600 text-white px-4 py-2 rounded">强制推进</button></div>':'');
  h+='<div class="wf-card"><h3 class="font-semibold mb-3">阶段历史（已完成只读）</h3>'+o.stages.map(s=>'<div class="border-t py-3 text-sm"><b>'+esc(s.stage_name)+'</b> · '+esc(s.status)+' · 合格 '+(s.qualified_count==null?'-':s.qualified_count)+' / 不良 '+(s.defective_count==null?'-':s.defective_count)+' · 负责人 '+esc(s.responsible||'-')+' · '+fmt(s.submitted_at)+(s.problem_description?'<div class="text-slate-600">问题：'+esc(s.problem_description)+'</div>':'')+(s.attachments||[]).map(a=>' <a class="text-blue-600" href="/api/workflows/attachment/download?id='+a.id+'">'+esc(a.original_name)+'</a>').join('')+(IS_SUPER&&s.status==='done'?'<button onclick="correct('+o.id+','+s.stage_index+')" class="ml-3 text-amber-700">纠错</button>':'')+'</div>').join('')+'</div><div class="wf-card"><h3 class="font-semibold mb-3">操作日志</h3>'+o.logs.map(l=>'<div class="text-sm border-t py-2">'+fmt(l.created_at)+' · '+esc(l.operator)+' · '+esc(l.action)+' · '+esc(l.detail||'')+'</div>').join('')+'</div>';orders.innerHTML=h}catch(e){alert(e.message)}}
  function stageData(id,index){return{order_id:id,stage_index:index,quantity:Number(qty.value),qualified_count:Number(good.value),defective_count:Number(bad.value),responsible:owner.value,problem_description:problem.value,happened_at:when.value?new Date(when.value).getTime():Date.now()}}
  async function submitStage(id,index){try{await req('/api/workflows/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(stageData(id,index))});detail(id)}catch(e){alert(e.message)}}
  async function uploadFiles(id,index){if(!files.files.length)return alert('请选择附件');const fd=new FormData();fd.append('order_id',id);fd.append('stage_index',index);for(const f of files.files){if(f.size>10*1024*1024)return alert('单个附件不能超过10MB');fd.append('file',f)}try{await req('/api/workflows/upload',{method:'POST',body:fd});detail(id)}catch(e){alert(e.message)}}
  async function adminAction(id,action,expectedStage){const reason=prompt(action==='return'?'退回原因':'强制推进原因');if(!reason)return;try{await req('/api/workflows/admin-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:id,action,reason,expected_stage:expectedStage})});detail(id)}catch(e){alert(e.message)}}
  async function correct(id,index){const d=await req('/api/workflows/get?id='+id),s=d.order.stages[index],reason=prompt('纠错原因');if(!reason)return;const val=n=>Number(prompt(n==='quantity'?'数量':n==='qualified_count'?'合格数':'不良数',s[n]==null?'':s[n]));const p={order_id:id,stage_index:index,action:'correct',reason,quantity:val('quantity'),qualified_count:val('qualified_count'),defective_count:val('defective_count'),responsible:prompt('负责人',s.responsible||'')||'',problem_description:prompt('问题描述',s.problem_description||'')||'',happened_at:s.happened_at||Date.now()};try{await req('/api/workflows/admin-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});detail(id)}catch(e){alert(e.message)}}
  const cf=document.getElementById('createForm');if(cf)cf.onsubmit=async e=>{e.preventDefault();const p=Object.fromEntries(new FormData(cf));p.type=TYPE;p.quantity=Number(p.quantity);try{const d=await req('/api/workflows/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});createDlg.close();detail(d.id)}catch(x){alert(x.message)}};loadOrders();</script></body></html>`;
}

// ============================================================
// 实验板管理模块 - Prototype Board Management
// ============================================================

// ---- 数据库初始化 ----


// ============================================================
// 供应商模块可见性配置 - Supplier Module Visibility Config
// ============================================================

function ensureSupplierModuleConfigTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_module_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_key TEXT NOT NULL UNIQUE,
      module_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER
    );
  `);
  const defaults = [
    { key: 'ffr', name: 'FFR 数据' },
    { key: 'prod_submit', name: '生产填报' },
    { key: 'return_submit', name: '退机填报' },
    { key: 'prod_history', name: '生产历史' },
    { key: 'return_history', name: '退机历史' },
    { key: 'proto_board', name: '实验板' },
  ];
  const stmt = db.prepare('INSERT OR IGNORE INTO supplier_module_config (module_key, module_name, enabled) VALUES (?, ?, 1)');
  for (const m of defaults) { stmt.run(m.key, m.name); }
}

function dbGetSupplierModuleConfig(moduleKey) {
  const db = getDb();
  const row = db.prepare('SELECT enabled FROM supplier_module_config WHERE module_key = ?').get(moduleKey);
  return row ? row.enabled === 1 : true;
}

function dbGetAllSupplierModuleConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM supplier_module_config ORDER BY id').all();
}

function dbSetSupplierModuleConfig(moduleKey, enabled) {
  const db = getDb();
  db.prepare('UPDATE supplier_module_config SET enabled = ?, updated_at = ? WHERE module_key = ?')
    .run(enabled ? 1 : 0, Date.now(), moduleKey);
}

function apiSupplierModuleConfigList(query, sess) {
  if (!isAdminRole(sess.role)) return json({ ok: false, msg: '仅管理员可访问' }, 403);
  const modules = dbGetAllSupplierModuleConfig();
  return json({ ok: true, modules });
}

function apiSupplierModuleConfigUpdate(parsed, sess) {
  if (sess.role !== 'super_admin') return json({ ok: false, msg: '仅超级管理员可修改' }, 403);
  const { module_key, enabled } = parsed;
  if (!module_key) return json({ ok: false, msg: '缺少 module_key' }, 400);
  dbSetSupplierModuleConfig(module_key, !!enabled);
  return json({ ok: true });
}

function adminSupplierModulesPage(sess) {
  const modules = dbGetAllSupplierModuleConfig();
  const rows = modules.map(m => {
    const checked = m.enabled ? 'checked' : '';
    return `<tr>
      <td style="padding:12px 16px;font-weight:500;">${escapeHtml(m.module_name)}</td>
      <td style="padding:12px 16px;text-align:center;">
        <label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer;">
          <input type="checkbox" ${checked} data-key="${escapeHtml(m.module_key)}" onchange="toggleModule(this)" style="opacity:0;width:0;height:0;">
          <span class="slider" style="position:absolute;top:0;left:0;right:0;bottom:0;background:${m.enabled?'#2563eb':'#d1d5db'};border-radius:26px;transition:.3s;"></span>
          <span class="dot" style="position:absolute;top:3px;left:${m.enabled?'25px':'3px'};width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 3px rgba(0,0,0,.2);"></span>
        </label>
      </td>
    </tr>`;
  }).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>供应商模块配置</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('supplier-modules', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
    <h1 style="font-size:22px;font-weight:700;color:#111827;">供应商模块配置</h1>
  </div>
  <p style="color:#6b7280;font-size:14px;margin-bottom:16px;">控制供应商用户登录后可以看到哪些功能模块。关闭后供应商端对应模块将隐藏。</p>
  <div style="background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
        <th style="padding:12px 16px;text-align:left;font-size:13px;font-weight:600;color:#6b7280;">模块名称</th>
        <th style="padding:12px 16px;text-align:center;font-size:13px;font-weight:600;color:#6b7280;">供应商可见</th>
      </tr></thead>
      <tbody id="module-list">${rows}</tbody>
    </table>
  </div>
</div>
<script>
function toggleModule(el) {
  const key = el.dataset.key;
  const enabled = el.checked;
  fetch('/api/admin/supplier-modules/update', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ module_key: key, enabled })
  }).then(r => r.json()).then(d => {
    if (!d.ok) { alert(d.msg || '保存失败'); el.checked = !enabled; return; }
    // Update slider visual
    const slider = el.nextElementSibling;
    const dot = slider.nextElementSibling;
    slider.style.background = enabled ? '#2563eb' : '#d1d5db';
    dot.style.left = enabled ? '25px' : '3px';
  }).catch(() => { el.checked = !enabled; alert('网络错误'); });
}
</script></body></html>`;
}

function ensureProtoBoardTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS proto_boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      model TEXT,
      pcb_version TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS proto_board_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      stage_name TEXT NOT NULL,
      stage_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER,
      completed_at INTEGER,
      operator TEXT,
      notes TEXT,
      attachments TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      FOREIGN KEY (board_id) REFERENCES proto_boards(id)
    );
    CREATE TABLE IF NOT EXISTS proto_board_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'viewer',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (board_id) REFERENCES proto_boards(id),
      UNIQUE(board_id, username)
    );
    CREATE TABLE IF NOT EXISTS proto_board_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      operator TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (board_id) REFERENCES proto_boards(id)
    );
  `);
}

const PROTO_STAGES = [
  '下单生产版本管理',
  'PCB制版',
  'SMT贴片',
  '产线测试',
  '快递寄出',
];

const PROTO_STAGE_ICONS = ['📋', '🔧', '🏭', '🧪', '📦'];

// ---- 数据库操作 ----
function dbCreateProtoBoard(name, model, pcbVersion, description, createdBy) {
  const db = getDb();
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO proto_boards (name, model, pcb_version, description, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(name, model || null, pcbVersion || null, description || null, createdBy, now, now);
  const boardId = info.lastInsertRowid;
  const stmt = db.prepare(
    'INSERT INTO proto_board_stages (board_id, stage_name, stage_order, status, created_at) VALUES (?,?,?,?,?)'
  );
  for (let i = 0; i < PROTO_STAGES.length; i++) {
    stmt.run(boardId, PROTO_STAGES[i], i, 'pending', now);
  }
  db.prepare(
    'INSERT INTO proto_board_logs (board_id, action, detail, operator, created_at) VALUES (?,?,?,?,?)'
  ).run(boardId, 'create', `创建实验板「${name}」`, createdBy, now);
  return boardId;
}

function dbListProtoBoards(viewerUsername, isAdmin) {
  const db = getDb();
  let boards;
  if (isAdmin) {
    boards = db.prepare('SELECT * FROM proto_boards WHERE status != ? ORDER BY id DESC').all('deleted');
  } else {
    boards = db.prepare(`
      SELECT pb.* FROM proto_boards pb
      INNER JOIN proto_board_members pm ON pb.id = pm.board_id
      WHERE pm.username = ? AND pb.status != ?
      ORDER BY pb.id DESC
    `).all(viewerUsername, 'deleted');
  }
  for (const board of boards) {
    board.stages = db.prepare(
      'SELECT * FROM proto_board_stages WHERE board_id = ? ORDER BY stage_order'
    ).all(board.id);
    board.members = db.prepare(
      'SELECT * FROM proto_board_members WHERE board_id = ?'
    ).all(board.id);
  }
  return boards;
}

function dbGetProtoBoard(boardId) {
  const db = getDb();
  const board = db.prepare('SELECT * FROM proto_boards WHERE id = ?').get(boardId);
  if (!board) return null;
  board.stages = db.prepare(
    'SELECT * FROM proto_board_stages WHERE board_id = ? ORDER BY stage_order'
  ).all(board.id);
  board.members = db.prepare(
    'SELECT * FROM proto_board_members WHERE board_id = ?'
  ).all(board.id);
  board.logs = db.prepare(
    'SELECT * FROM proto_board_logs WHERE board_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(board.id);
  return board;
}

function dbUpdateProtoBoardStage(stageId, status, operator, notes) {
  const db = getDb();
  const now = Date.now();
  const stage = db.prepare('SELECT * FROM proto_board_stages WHERE id = ?').get(stageId);
  if (!stage) return false;
  const updates = { status, updated_at: now };
  if (status === 'in_progress' && !stage.started_at) updates.started_at = now;
  if (status === 'done' && !stage.completed_at) updates.completed_at = now;
  if (notes) updates.notes = notes;
  if (operator) updates.operator = operator;
  const sets = Object.keys(updates).map(k => k + '=?').join(', ');
  db.prepare(`UPDATE proto_board_stages SET ${sets} WHERE id=?`).run(...Object.values(updates), stageId);
  const statusText = { pending: '待开始', in_progress: '进行中', done: '已完成' };
  db.prepare(
    'INSERT INTO proto_board_logs (board_id, action, detail, operator, created_at) VALUES (?,?,?,?,?)'
  ).run(stage.board_id, 'stage_update', `${stage.stage_name} → ${statusText[status] || status}`, operator, now);
  return true;
}

function dbUpdateProtoBoardMembers(boardId, usernames) {
  const db = getDb();
  const now = Date.now();
  db.prepare('DELETE FROM proto_board_members WHERE board_id = ?').run(boardId);
  const stmt = db.prepare('INSERT OR IGNORE INTO proto_board_members (board_id, username, role, created_at) VALUES (?,?,?,?)');
  for (const u of usernames) {
    stmt.run(boardId, u, 'viewer', now);
  }
}

function dbDeleteProtoBoard(boardId, operator) {
  const db = getDb();
  const now = Date.now();
  db.prepare('UPDATE proto_boards SET status = ?, updated_at = ? WHERE id = ?').run('deleted', now, boardId);
  db.prepare(
    'INSERT INTO proto_board_logs (board_id, action, detail, operator, created_at) VALUES (?,?,?,?,?)'
  ).run(boardId, 'delete', '删除实验板', operator, now);
}

async function dbGetAllUsers() {
  return await listUsers();
}

// ---- API 处理 ----
function apiProtoBoardsList(query, sess) {
  if (isSupplierRole(sess.role) && !dbGetSupplierModuleConfig('proto_board')) {
    return json({ ok: false, msg: '模块未启用' }, 403);
  }
  const isAdmin = isAdminRole(sess.role);
  const boards = dbListProtoBoards(sess.username, isAdmin);
  return json({ ok: true, boards });
}

function apiProtoBoardGet(query, sess) {
  if (isSupplierRole(sess.role) && !dbGetSupplierModuleConfig('proto_board')) {
    return json({ ok: false, msg: '模块未启用' }, 403);
  }
  const boardId = parseInt(query.id);
  if (!boardId) return json({ ok: false, msg: '缺少 id' }, 400);
  const board = dbGetProtoBoard(boardId);
  if (!board) return json({ ok: false, msg: '实验板不存在' }, 404);
  if (!isAdminRole(sess.role)) {
    const isMember = board.members.some(m => m.username === sess.username);
    if (!isMember) return json({ ok: false, msg: '无权限查看' }, 403);
  }
  return json({ ok: true, board });
}

function apiProtoBoardCreate(parsed, sess) {
  const { name, model, pcb_version, description, members } = parsed;
  if (!name || !name.trim()) return json({ ok: false, msg: '名称不能为空' }, 400);
  const boardId = dbCreateProtoBoard(name.trim(), model, pcb_version, description, sess.username);
  if (members && Array.isArray(members) && members.length > 0) {
    dbUpdateProtoBoardMembers(boardId, members);
  }
  return json({ ok: true, id: boardId });
}

function apiProtoBoardUpdateStage(parsed, sess) {
  const { stage_id, status, notes } = parsed;
  if (!stage_id) return json({ ok: false, msg: '缺少 stage_id' }, 400);
  if (!['pending', 'in_progress', 'done'].includes(status)) {
    return json({ ok: false, msg: '无效状态' }, 400);
  }
  const ok = dbUpdateProtoBoardStage(stage_id, status, sess.username, notes);
  return json({ ok });
}

function apiProtoBoardUpdateMembers(parsed, sess) {
  if (!isAdminRole(sess.role)) return json({ ok: false, msg: '仅管理员可配置' }, 403);
  const { board_id, members } = parsed;
  if (!board_id) return json({ ok: false, msg: '缺少 board_id' }, 400);
  dbUpdateProtoBoardMembers(board_id, members || []);
  const db = getDb();
  db.prepare(
    'INSERT INTO proto_board_logs (board_id, action, detail, operator, created_at) VALUES (?,?,?,?,?)'
  ).run(board_id, 'members_update', `更新相关人员: ${(members || []).join(', ')}`, sess.username, Date.now());
  return json({ ok: true });
}

function apiProtoBoardDelete(parsed, sess) {
  if (!isAdminRole(sess.role)) return json({ ok: false, msg: '仅管理员可删除' }, 403);
  const { board_id } = parsed;
  if (!board_id) return json({ ok: false, msg: '缺少 board_id' }, 400);
  dbDeleteProtoBoard(board_id, sess.username);
  return json({ ok: true });
}

function apiProtoBoardUpdateInfo(parsed, sess) {
  if (!isAdminRole(sess.role)) return json({ ok: false, msg: '仅管理员可修改' }, 403);
  const { board_id, name, model, pcb_version, description } = parsed;
  if (!board_id) return json({ ok: false, msg: '缺少 board_id' }, 400);
  const db = getDb();
  const now = Date.now();
  db.prepare(
    'UPDATE proto_boards SET name=?, model=?, pcb_version=?, description=?, updated_at=? WHERE id=?'
  ).run(name, model || null, pcb_version || null, description || null, now, board_id);
  return json({ ok: true });
}

async function apiProtoBoardUsers(sess) {
  if (!isAdminRole(sess.role)) return json({ ok: false, msg: '仅管理员可访问' }, 403);
  const users = await dbGetAllUsers();
  return json({ ok: true, users });
}

// ---- 页面渲染 ----
async function adminProtoBoardsPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const isAdmin = isAdminRole(sess.role);
  const boards = dbListProtoBoards(sess.username, isAdmin);
  const allUsers = isAdmin ? await dbGetAllUsers() : [];

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>实验板管理</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}
.stage-card{background:#fff;border-radius:8px;padding:12px 16px;border-left:4px solid #e5e7eb;transition:all 0.2s}
.stage-card.pending{border-left-color:#d1d5db;background:#f9fafb}
.stage-card.in_progress{border-left-color:#3b82f6;background:#eff6ff}
.stage-card.done{border-left-color:#22c55e;background:#f0fdf4}
.stage-icon{font-size:24px;margin-right:12px}
.progress-bar{height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#3b82f6,#22c55e);border-radius:3px;transition:width 0.3s}
.member-tag{display:inline-flex;align-items:center;background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:12px;font-size:12px;margin:2px}
.member-tag .remove{margin-left:4px;cursor:pointer;color:#93c5fd}
.member-tag .remove:hover{color:#1e40af}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:none;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:#fff;border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto}
.timeline-item{position:relative;padding-left:24px;padding-bottom:16px;border-left:2px solid #e5e7eb}
.timeline-item:last-child{border-left-color:transparent}
.timeline-dot{position:absolute;left:-7px;top:2px;width:12px;height:12px;border-radius:50%;background:#d1d5db;border:2px solid #fff}
.timeline-item.done .timeline-dot{background:#22c55e}
.timeline-item.in_progress .timeline-dot{background:#3b82f6}
</style></head><body class="bg-slate-50 min-h-screen">
${ADMIN_NAV('proto-boards', sess)}
<div class="admin-content p-4" style="margin-left:220px;padding-top:112px;width:calc(100% - 220px);box-sizing:border-box;">

  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
    <h2 style="font-size:18px;font-weight:600;color:#111;margin:0;">实验板管理</h2>
    ${isAdmin ? '<button onclick="showCreateModal()" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:14px;font-weight:500;cursor:pointer;">+ 新建实验板</button>' : ''}
  </div>

  <div id="boards-container">
    ${boards.length === 0 ? '<div style="text-align:center;padding:60px;color:#9ca3af;font-size:15px;">暂无实验板记录</div>' : ''}
    ${boards.map(board => renderProtoBoardCard(board, isAdmin)).join('')}
  </div>
</div>

<div id="modal-overlay" class="modal-overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <h3 id="modal-title" style="font-size:18px;font-weight:600;margin-bottom:16px;">新建实验板</h3>
    <input type="hidden" id="edit-board-id">
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">实验板名称 *</label>
      <input id="inp-name" style="width:100%;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:14px;box-sizing:border-box;" placeholder="如: MIC-PRO-X2 V1.0">
    </div>
    <div style="display:flex;gap:12px;margin-bottom:12px;">
      <div style="flex:1;">
        <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">产品型号</label>
        <input id="inp-model" style="width:100%;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:14px;box-sizing:border-box;" placeholder="如: MIC-PRO-X2">
      </div>
      <div style="flex:1;">
        <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">PCB版本</label>
        <input id="inp-pcb" style="width:100%;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:14px;box-sizing:border-box;" placeholder="如: V1.0">
      </div>
    </div>
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">描述</label>
      <textarea id="inp-desc" rows="2" style="width:100%;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:14px;box-sizing:border-box;resize:vertical;" placeholder="可选"></textarea>
    </div>
    ${isAdmin ? `
    <div style="margin-bottom:16px;">
      <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">相关人员（可查看进度）</label>
      <div id="members-input" style="border:1px solid #e5e7eb;border-radius:6px;padding:8px;min-height:40px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
        <input id="member-search" style="border:none;outline:none;flex:1;min-width:120px;font-size:14px;padding:4px;" placeholder="输入用户名搜索...">
      </div>
      <div id="member-dropdown" style="display:none;position:absolute;background:#fff;border:1px solid #e5e7eb;border-radius:6px;max-height:200px;overflow-y:auto;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>
      <div id="selected-members" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;"></div>
    </div>
    ` : ''}
    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button onclick="closeModal()" style="background:#f3f4f6;color:#374151;border:none;border-radius:6px;padding:8px 20px;font-size:14px;cursor:pointer;">取消</button>
      <button onclick="saveBoard()" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:14px;font-weight:500;cursor:pointer;">保存</button>
    </div>
  </div>
</div>

<div id="stage-modal-overlay" class="modal-overlay" onclick="if(event.target===this)closeStageModal()">
  <div class="modal">
    <h3 id="stage-modal-title" style="font-size:18px;font-weight:600;margin-bottom:16px;">阶段详情</h3>
    <div id="stage-modal-body"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
      <button onclick="closeStageModal()" style="background:#f3f4f6;color:#374151;border:none;border-radius:6px;padding:8px 20px;font-size:14px;cursor:pointer;">关闭</button>
      <button id="stage-save-btn" onclick="saveStage()" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:14px;font-weight:500;cursor:pointer;">保存</button>
    </div>
  </div>
</div>

<script>
const ALL_USERS = ${JSON.stringify(allUsers.map(u => ({username: u.username, display_name: u.display_name || u.username})))};
const STAGES = ${JSON.stringify(PROTO_STAGES)};
const STAGE_ICONS = ${JSON.stringify(PROTO_STAGE_ICONS)};
let currentStageId = null;
let selectedMembers = [];

function showCreateModal() {
  document.getElementById('modal-title').textContent = '新建实验板';
  document.getElementById('edit-board-id').value = '';
  document.getElementById('inp-name').value = '';
  document.getElementById('inp-model').value = '';
  document.getElementById('inp-pcb').value = '';
  document.getElementById('inp-desc').value = '';
  selectedMembers = [];
  renderSelectedMembers();
  document.getElementById('modal-overlay').classList.add('show');
}

function editBoard(boardId) {
  fetch('/api/proto-board/get?id=' + boardId)
    .then(r => r.json())
    .then(d => {
      if (!d.ok) return alert(d.msg);
      const b = d.board;
      document.getElementById('modal-title').textContent = '编辑实验板';
      document.getElementById('edit-board-id').value = b.id;
      document.getElementById('inp-name').value = b.name || '';
      document.getElementById('inp-model').value = b.model || '';
      document.getElementById('inp-pcb').value = b.pcb_version || '';
      document.getElementById('inp-desc').value = b.description || '';
      selectedMembers = (b.members || []).map(m => m.username);
      renderSelectedMembers();
      document.getElementById('modal-overlay').classList.add('show');
    });
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('show'); }

function saveBoard() {
  const boardId = document.getElementById('edit-board-id').value;
  const data = {
    name: document.getElementById('inp-name').value.trim(),
    model: document.getElementById('inp-model').value.trim(),
    pcb_version: document.getElementById('inp-pcb').value.trim(),
    description: document.getElementById('inp-desc').value.trim(),
    members: selectedMembers,
  };
  if (!data.name) return alert('请输入实验板名称');
  const url = boardId ? '/api/proto-board/update' : '/api/proto-board/create';
  if (boardId) data.board_id = parseInt(boardId);
  fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })
    .then(r => r.json())
    .then(d => { if (!d.ok) return alert(d.msg); location.reload(); });
}

function deleteBoard(boardId) {
  if (!confirm('确定删除此实验板？')) return;
  fetch('/api/proto-board/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({board_id: boardId}) })
    .then(r => r.json())
    .then(d => { if (!d.ok) return alert(d.msg); location.reload(); });
}

function showStageModal(stageId, stageName, currentStatus, currentNotes) {
  currentStageId = stageId;
  document.getElementById('stage-modal-title').textContent = stageName;
  document.getElementById('stage-modal-body').innerHTML =
    '<div style="margin-bottom:12px;">' +
    '<label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">状态</label>' +
    '<select id="stage-status" style="width:100%;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:14px;">' +
    '<option value="pending"' + (currentStatus==='pending'?' selected':'') + '>⏳ 待开始</option>' +
    '<option value="in_progress"' + (currentStatus==='in_progress'?' selected':'') + '>🔄 进行中</option>' +
    '<option value="done"' + (currentStatus==='done'?' selected':'') + '>✅ 已完成</option>' +
    '</select></div>' +
    '<div style="margin-bottom:12px;">' +
    '<label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">备注</label>' +
    '<textarea id="stage-notes" rows="3" style="width:100%;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-size:14px;resize:vertical;" placeholder="可选">' + (currentNotes || '') + '</textarea></div>';
  document.getElementById('stage-modal-overlay').classList.add('show');
}

function closeStageModal() { document.getElementById('stage-modal-overlay').classList.remove('show'); }

function saveStage() {
  const data = {
    stage_id: currentStageId,
    status: document.getElementById('stage-status').value,
    notes: document.getElementById('stage-notes').value,
  };
  fetch('/api/proto-board/update-stage', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })
    .then(r => r.json())
    .then(d => { if (!d.ok) return alert(d.msg); location.reload(); });
}

function renderSelectedMembers() {
  const container = document.getElementById('selected-members');
  if (!container) return;
  container.innerHTML = selectedMembers.map(u => {
    const user = ALL_USERS.find(x => x.username === u);
    const label = user ? user.display_name : u;
    return '<span class="member-tag">' + escapeHtml(label) + ' <span class="remove" onclick="removeMember(&quot;' + u + '&quot;)">&times;</span></span>';
  }).join('');
}

function removeMember(username) {
  selectedMembers = selectedMembers.filter(u => u !== username);
  renderSelectedMembers();
}

const memberSearch = document.getElementById('member-search');
if (memberSearch) {
  memberSearch.addEventListener('input', function() {
    const q = this.value.trim().toLowerCase();
    const dropdown = document.getElementById('member-dropdown');
    if (!q) { dropdown.style.display = 'none'; return; }
    const matches = ALL_USERS.filter(u =>
      (u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q)) &&
      !selectedMembers.includes(u.username)
    ).slice(0, 10);
    if (matches.length === 0) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = matches.map(u =>
      '<div style="padding:8px 12px;cursor:pointer;font-size:14px;" onmouseover="this.style.background=&quot;#f3f4f6&quot;" onmouseout="this.style.background=&quot;#fff&quot;" onclick="addMember(&quot;' + u.username + '&quot;)">' + escapeHtml(u.display_name) + ' (' + escapeHtml(u.username) + ')</div>'
    ).join('');
    const rect = memberSearch.getBoundingClientRect();
    dropdown.style.display = 'block';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = rect.bottom + 'px';
    dropdown.style.width = rect.width + 'px';
  });
}

function addMember(username) {
  if (!selectedMembers.includes(username)) {
    selectedMembers.push(username);
    renderSelectedMembers();
  }
  memberSearch.value = '';
  document.getElementById('member-dropdown').style.display = 'none';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}
</script>
</body></html>`;
}

function renderProtoBoardCard(board, isAdmin) {
  const stages = board.stages || [];
  const doneCount = stages.filter(s => s.status === 'done').length;
  const progress = stages.length > 0 ? Math.round(doneCount / stages.length * 100) : 0;
  const members = board.members || [];
  const currentStage = stages.find(s => s.status === 'in_progress') || stages.find(s => s.status === 'pending');

  return `
  <div style="background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,0.07);margin-bottom:16px;overflow:hidden;">
    <div style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #f3f4f6;">
      <div>
        <div style="font-size:16px;font-weight:600;color:#111;">${escapeHtml(board.name)}</div>
        <div style="font-size:13px;color:#9ca3af;margin-top:4px;">
          ${board.model ? '型号: ' + escapeHtml(board.model) : ''}
          ${board.pcb_version ? ' · PCB: ' + escapeHtml(board.pcb_version) : ''}
          ${currentStage ? ' · 当前: ' + escapeHtml(currentStage.stage_name) : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:13px;color:#6b7280;">${doneCount}/${stages.length}</span>
        ${isAdmin ? '<button onclick="editBoard(' + board.id + ')" style="background:#f3f4f6;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;color:#374151;">编辑</button>' : ''}
        ${isAdmin ? '<button onclick="deleteBoard(' + board.id + ')" style="background:#fef2f2;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;color:#dc2626;">删除</button>' : ''}
      </div>
    </div>
    <div style="padding:16px 20px;">
      <div class="progress-bar" style="margin-bottom:16px;">
        <div class="progress-fill" style="width:${progress}%"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${stages.map((s, i) => `
          <div class="stage-card ${s.status}" style="flex:1;min-width:140px;cursor:pointer;" onclick="showStageModal(${s.id},'${escapeHtml(s.stage_name)}','${s.status}','${escapeHtml(s.notes || '')}')">
            <div style="display:flex;align-items:center;">
              <span class="stage-icon">${PROTO_STAGE_ICONS[i] || '📋'}</span>
              <div>
                <div style="font-size:13px;font-weight:500;color:#111;">${escapeHtml(s.stage_name)}</div>
                <div style="font-size:12px;color:#9ca3af;margin-top:2px;">
                  ${s.status === 'pending' ? '待开始' : s.status === 'in_progress' ? '🔄 进行中' : '✅ 已完成'}
                  ${s.operator ? ' · ' + escapeHtml(s.operator) : ''}
                </div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
      ${members.length > 0 ? `
      <div style="margin-top:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span style="font-size:12px;color:#9ca3af;">相关人员:</span>
        ${members.map(m => '<span class="member-tag">' + escapeHtml(m.username) + '</span>').join('')}
      </div>
      ` : ''}
      ${board.description ? '<div style="margin-top:8px;font-size:13px;color:#6b7280;">' + escapeHtml(board.description) + '</div>' : ''}
    </div>
  </div>`;
}

// ---------------- standard HTTP server ----------------

function parseQuery(queryString) {
  const out = {};
  if (!queryString) return out;
  for (const part of queryString.split('&')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    const k = decodeURIComponent(idx >= 0 ? part.slice(0, idx) : part);
    const v = idx >= 0 ? decodeURIComponent(part.slice(idx + 1)) : '';
    out[k] = v;
  }
  return out;
}

async function handleRequest(method, pathname, query, cookies, body, headers, host) {
  if (pathname === '/assets/tailwind.min.css') {
    try {
      const css = require('fs').readFileSync(nodePath.join(PUBLIC_DIR, 'assets', 'tailwind.min.css'));
      return { status: 200, headers: { 'Content-Type': 'text/css', 'Cache-Control': 'public,max-age=86400' }, body: css };
    } catch(e) { return { status: 404, headers: {}, body: 'not found' }; }
  }
  // Serve static /libs/ files without authentication
  if (pathname.startsWith('/libs/')) {
    const safeName = nodePath.basename(pathname);
    const mimeMap = { '.js': 'application/javascript', '.css': 'text/css' };
    const ext = nodePath.extname(safeName);
    const mime = mimeMap[ext];
    if (!mime) return { status: 403, headers: {}, body: 'forbidden' };
    const fp = nodePath.join(LIBS_DIR, safeName);
    try {
      const data = require('fs').readFileSync(fp);
      return { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'public,max-age=86400' }, body: data };
    } catch(e) { return { status: 404, headers: {}, body: 'not found' }; }
  }
  // Serve product images without authentication
  if (pathname === "/feishu-logo.jpg") {
    const fp = nodePath.join(PUBLIC_DIR, 'feishu-logo.jpg');
    try { const data = require("fs").readFileSync(fp); return { status: 200, headers: { "Content-Type": "image/jpeg", "Cache-Control": "public,max-age=86400" }, body: data }; }
    catch(e) { return { status: 404, headers: {}, body: "not found" }; }
  }
  if (pathname.startsWith('/product-images/')) {
    const safeName = nodePath.basename(pathname);
    const imgMimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    const ext = nodePath.extname(safeName).toLowerCase();
    const mime = imgMimeMap[ext];
    if (!mime) return { status: 403, headers: {}, body: 'forbidden' };
    const fp = nodePath.join(PRODUCT_IMAGES_DIR, safeName);
    try {
      const stat = require('fs').statSync(fp);
      const etag = '"' + stat.mtimeMs.toString(36) + '-' + stat.size.toString(36) + '"';
      if (headers['if-none-match'] === etag) {
        return { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'public,max-age=31536000,immutable' }, body: '' };
      }
      const data = require('fs').readFileSync(fp);
      return { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'public,max-age=31536000,immutable', 'ETag': etag } , body: data };
    } catch(e) { return { status: 404, headers: {}, body: 'not found' }; }
  }
  if (pathname === '/healthz') return json({ ok: true, ts: Date.now() });
  if (pathname === '/login' && method === 'GET') return html(loginPage(query.err || ''));
  if (pathname === '/api/login' && method === 'POST') {
    const ip = (headers['x-forwarded-for'] || '').split(',')[0].trim() || headers['x-real-ip'] || 'unknown';
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    return await apiLogin(parsed, ip);
  }
  if (pathname === '/logout') return await handleLogout(cookies, method);
  if (pathname === '/api/logout' && method === 'POST') return await handleLogout(cookies, method);

  // Feishu OAuth routes (no session required)
  if (pathname === '/auth/feishu' && method === 'GET') {
    const state = await createOAuthState();
    const appId = process.env.FEISHU_APP_ID;
    const redirectUri = encodeURIComponent(FEISHU_REDIRECT_URI);
    const feishuAuthUrl = `https://open.feishu.cn/open-apis/authen/v1/index?app_id=${appId}&redirect_uri=${redirectUri}&state=${state}`;
    return htmlRedirect(feishuAuthUrl);
  }
  if (pathname === '/auth/feishu/callback' && method === 'GET') {
    const code = query.code;
    const state = query.state;
    const errParam = query.error;
    if (errParam) {
      return htmlRedirect('/login?err=' + encodeURIComponent('飞书授权被拒绝'));
    }
    if (!code || !state) {
      return htmlRedirect('/login?err=' + encodeURIComponent('无效的回调参数'));
    }
    const stateOk = await verifyAndConsumeOAuthState(state);
    if (!stateOk) {
      return htmlRedirect('/login?err=' + encodeURIComponent('授权状态无效或已过期，请重试'));
    }
    try {
      const tokenData = await feishuExchangeCode(code);
      const userInfo = await feishuGetUserInfo(tokenData.access_token);
      const user = await getOrCreateFeishuUser(userInfo.open_id, userInfo.name, userInfo.avatar_url);
      if (!user) {
        return htmlRedirect('/login?err=' + encodeURIComponent('该账号已被禁用，请联系管理员'));
      }
      const token = await createSession(user);
      const setCookie = buildCookie('sess', token, { maxAge: SESSION_TTL_SEC, sameSite: 'Lax' });
      const dest = (user.role === 'admin' || user.role === 'super_admin') ? '/admin/dashboard' : user.role === 'dev' ? '/admin/product-versions' : '/';
      return htmlRedirect(dest, { 'Set-Cookie': setCookie });
    } catch (e) {
      console.error('[feishu oauth error]', e.message);
      return htmlRedirect('/login?err=' + encodeURIComponent('飞书登录失败：' + e.message));
    }
  }

  // Ext API: API Key auth, no session required
  if (pathname === '/api/ext/mainboard-tests' && method === 'POST') {
    return await apiExtMainboardUpload(body, headers);
  }

  const sess = await getSession(cookies);
  const isApi = pathname.startsWith('/api/');
  if (!sess) {
    if (isApi) return json({ ok: false, msg: '未登录' }, 401);
    return htmlRedirect('/login');
  }

  // Shared workflow APIs. Every query is scoped again by role and sess.supplier.
  if (pathname === '/api/workflows/list' && method === 'GET') return apiWorkflowList(query, sess);
  if (pathname === '/api/workflows/get' && method === 'GET') return apiWorkflowGet(query, sess);
  if (pathname === '/api/workflows/attachment/download' && method === 'GET') return apiWorkflowAttachmentDownload(query, sess);
  if (pathname === '/api/workflows/upload' && method === 'POST') {
    if (!originOk(headers, host)) return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    const ct = headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/i);
    if (!boundaryMatch) return json({ ok: false, msg: 'Content-Type must be multipart/form-data' }, 400);
    if (body.length > MAX_UPLOAD_SIZE * 20 + 1024 * 1024) return json({ ok: false, msg: '上传请求过大' }, 413);
    return apiWorkflowUpload(parseMultipart(body, boundaryMatch[1].trim()), sess);
  }
  if (pathname.startsWith('/api/workflows/') && method === 'POST') {
    if (!originOk(headers, host)) return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    let parsed = {};
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    if (pathname === '/api/workflows/create') return apiWorkflowCreate(parsed, sess);
    if (pathname === '/api/workflows/submit') return apiWorkflowSubmit(parsed, sess);
    if (pathname === '/api/workflows/admin-action') return apiWorkflowAdminAction(parsed, sess);
    return json({ ok: false, msg: '未知工作流接口' }, 404);
  }

  // Supplier APIs (read from local SQLite)
  // ---- Prototype Board Management APIs ----
  if (pathname === '/api/proto-boards/list' && method === 'GET') return apiProtoBoardsList(query, sess);
  if (pathname === '/api/proto-board/get' && method === 'GET') return apiProtoBoardGet(query, sess);
  if (pathname === '/api/proto-board/users' && method === 'GET') return apiProtoBoardUsers(sess);
  if (pathname.startsWith('/api/proto-board/') && method === 'POST') {
    if (!sess) return json({ ok: false, msg: '未登录' }, 401);
    if (!originOk(headers, host)) return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    let parsed = {};
    if (body && body.length) { try { parsed = JSON.parse(body.toString('utf8')); } catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); } }
    if (pathname === '/api/proto-board/create') return apiProtoBoardCreate(parsed, sess);
    if (pathname === '/api/proto-board/update') return apiProtoBoardUpdateInfo(parsed, sess);
    if (pathname === '/api/proto-board/update-stage') return apiProtoBoardUpdateStage(parsed, sess);
    if (pathname === '/api/proto-board/update-members') return apiProtoBoardUpdateMembers(parsed, sess);
    if (pathname === '/api/proto-board/delete') return apiProtoBoardDelete(parsed, sess);
    return json({ ok: false, msg: '未知实验板接口' }, 404);
  }

  // Products API (supplier: filtered by binding; admin/unauthenticated: all)
  if (pathname === '/api/products' && method === 'GET') {
    let rows;
    if (sess && isSupplierRole(sess.role) && sess.supplier) {
      rows = dbGetProductsForSupplier(sess.supplier);
    } else {
      rows = getDb().prepare('SELECT id, model_name, model_code, image_path, status, vehicle_brand FROM products ORDER BY sort_order, id').all();
    }
    return json({ ok: true, products: rows });
  }

  if (pathname === '/api/history' && method === 'GET') return await apiHistory(query, sess);
  if (pathname === '/api/submit' && method === 'POST') {
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    return await apiSubmit(parsed, sess);
  }
  if (pathname === '/api/options' && method === 'GET') return apiOptions(sess);
  if (pathname === '/api/supplier/ffr' && method === 'GET') return apiSupplierFFR(sess);
  if (pathname === '/api/supplier/prod-upload' && method === 'POST') {
    if (!isSupplierRole(sess.role) || !sess.supplier) return json({ ok: false, msg: '无权访问' }, 403);
    const ct = headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/i);
    if (!boundaryMatch) return json({ ok: false, msg: 'Content-Type must be multipart/form-data' }, 400);
    const parts = parseMultipart(body, boundaryMatch[1].trim());
    const recordIdStr = (parts.find(p => p.name === 'record_id') || {}).text;
    const recordId = parseInt(recordIdStr, 10);
    if (!recordId) return json({ ok: false, msg: '缺少 record_id' }, 400);
    const rec = getDb().prepare('SELECT id FROM prod_records WHERE id=? AND supplier=? AND deleted_at IS NULL').get(recordId, sess.supplier);
    if (!rec) return json({ ok: false, msg: '记录不存在或无权访问' }, 404);
    const fileParts = parts.filter(p => p.name === 'file' && p.filename);
    if (!fileParts.length) return json({ ok: false, msg: '未找到上传文件' }, 400);
    const uploaded = [];
    for (const part of fileParts) {
      const ext = nodePath.extname(part.filename || '').toLowerCase() || '';
      const safeName = `supplier_prod_${recordId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      fs.writeFileSync(nodePath.join(UPLOAD_DIR, safeName), part.data);
      const attId = dbInsertAttachment('supplier_prod', recordId, safeName, part.filename, part.contentType, part.data.length);
      uploaded.push({ id: Number(attId), name: part.filename });
    }
    return json({ ok: true, uploaded });
  }
  if (pathname === '/api/supplier/return-upload' && method === 'POST') {
    if (!isSupplierRole(sess.role) || !sess.supplier) return json({ ok: false, msg: '无权访问' }, 403);
    const ct7 = headers['content-type'] || '';
    const bm7 = ct7.match(/boundary=(.+)/i);
    if (!bm7) return json({ ok: false, msg: 'Content-Type must be multipart/form-data' }, 400);
    const parts7 = parseMultipart(body, bm7[1].trim());
    const recordIdStr7 = (parts7.find(p => p.name === 'record_id') || {}).text;
    const recordId7 = parseInt(recordIdStr7, 10);
    if (!recordId7) return json({ ok: false, msg: '缺少 record_id' }, 400);
    const rec7 = getDb().prepare('SELECT id FROM return_records WHERE id=? AND supplier=? AND deleted_at IS NULL').get(recordId7, sess.supplier);
    if (!rec7) return json({ ok: false, msg: '记录不存在或无权访问' }, 404);
    const fileParts7 = parts7.filter(p => p.name === 'file' && p.filename);
    if (!fileParts7.length) return json({ ok: false, msg: '未找到上传文件' }, 400);
    const uploaded7 = [];
    for (const part of fileParts7) {
      const ext7 = nodePath.extname(part.filename || '').toLowerCase() || '';
      const safeName7 = `vendor_return_${recordId7}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext7}`;
      fs.writeFileSync(nodePath.join(UPLOAD_DIR, safeName7), part.data);
      const attId7 = dbInsertAttachment('vendor_return', recordId7, safeName7, part.filename, part.contentType, part.data.length);
      uploaded7.push({ id: Number(attId7), name: part.filename });
    }
    return json({ ok: true, uploaded: uploaded7 });
  }

  // Repair record APIs (supplier)
  if (pathname === '/api/repair/submit' && method === 'POST') {
    const kind = query.kind === 'repair_aftersales' ? 'repair_aftersales' : 'repair_line';
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    return apiRepairSubmit(parsed, sess, kind);
  }
  if (pathname === '/api/repair/history' && method === 'GET') {
    const kind = query.kind === 'repair_aftersales' ? 'repair_aftersales' : 'repair_line';
    return apiRepairHistory(query, sess, kind);
  }
  if (pathname === '/api/repair/upload' && method === 'POST') {
    const kind = query.kind === 'repair_aftersales' ? 'repair_aftersales' : 'repair_line';
    const ct = headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/i);
    if (!boundaryMatch) return json({ ok: false, msg: 'Content-Type must be multipart/form-data' }, 400);
    const parts = parseMultipart(body, boundaryMatch[1].trim());
    return apiRepairUpload(parts, sess, kind);
  }
  if (pathname === '/api/repair/attachments' && method === 'GET') {
    if (sess.role !== 'supplier_repair' && !isAdminRole(sess.role)) return json({ ok: false, msg: '无权访问' }, 403);
    return apiRepairAttachments(query);
  }
  if (pathname === '/api/repair/attachment/download' && method === 'GET') {
    if (!isSupplierRole(sess.role) && !isAdminRole(sess.role)) return json({ ok: false, msg: '无权访问' }, 403);
    return apiRepairAttachmentDownload(query);
  }

  // Supplier page
  if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/supplier/')) {
    if (sess.role === 'factory') {
      const target = sess.mes_station ? `/mes/station/${sess.mes_station}` : '/mes/station/incoming_stock';
      return htmlRedirect(target);
    }
    if (isAdminRole(sess.role)) return htmlRedirect('/admin/dashboard');
    if (sess.role === "dev") return htmlRedirect("/admin/product-versions");
    if (sess.role === 'user') {
      const uname = escapeHtml(sess.display_name || sess.username);
      return html(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>雷石质量管理系统</title><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-blue-100 min-h-screen flex items-center justify-center">
<div class="bg-white rounded-lg shadow-md p-8 w-full max-w-md text-center">
  <div class="text-4xl mb-4">👋</div>
  <h1 class="text-xl font-semibold mb-2">你好，${uname}</h1>
  <p class="text-slate-500 mb-6">你的飞书账号已登录成功，但尚未分配系统角色。<br>请联系超级管理员为你分配权限。</p>
  <a href="/logout" class="inline-block text-sm text-blue-600 hover:underline">退出登录</a>
</div></body></html>`);
    }
    if (!isSupplierRole(sess.role) || !sess.supplier) {
      return html('<h1>账号未绑定供应商</h1><p>请联系管理员</p><p><a href="/logout">退出</a></p>', 400);
    }
    if (pathname === '/supplier/workflows') return html(workflowPage(sess, query, false));
    if (sess.role === 'supplier_repair') return html(supplierRepairPage(sess));
    if (pathname === '/supplier/prod') return html(supplierProdPage(sess, query));
    if (pathname === '/supplier/return') return html(supplierReturnPage(sess, query));
    return html(appPage(sess));
  }

  // Admin pages
  if (pathname === '/admin') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminPage(sess));
  }
  if (pathname === '/admin/workflows') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(workflowPage(sess, query, true));
  }
  if (pathname === '/admin/proto-boards') {
    if (!sess) return htmlRedirect('/login');
    if (!isAdminRole(sess.role) && !isSupplierRole(sess.role)) return htmlRedirect('/login');
    if (isSupplierRole(sess.role) && !dbGetSupplierModuleConfig('proto_board')) return htmlRedirect('/login');
    return html(await adminProtoBoardsPage(sess));
  }
  if (pathname === '/admin/supplier-modules') {
    if (!sess) return htmlRedirect('/login');
    if (sess.role !== 'super_admin') return htmlRedirect('/login');
    return html(adminSupplierModulesPage(sess));
  }
  if (pathname === '/api/admin/supplier-modules/list' && method === 'GET') return apiSupplierModuleConfigList(query, sess);
  if (pathname === '/api/admin/supplier-modules/update' && method === 'POST') {
    if (!originOk(headers, host)) return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    let parsed = {};
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    return apiSupplierModuleConfigUpdate(parsed, sess);
  }
  if (pathname === '/admin/dashboard') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p><p><a href="/mes">返回工站</a></p>', 403);
    return html(adminDashboardPage(sess));
  }
  if (pathname === '/admin/brands') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminBrandsPage(sess));
  }
  if (pathname === '/admin/suppliers') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1>', 403);
    return html(adminSuppliersPage(sess));
  }
  if (pathname === '/admin/bindings') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminBindingsPage(sess));
  }
  if (pathname === '/admin/product-bindings') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminProductBindingsPage(sess));
  }
  if (pathname === '/admin/api-keys') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminApiKeysPage(sess));
  }
  if (pathname === '/admin/mainboard-tests') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminMainboardTestsPage(sess));
  }
  if (pathname === '/admin/repair-records') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminRepairRecordsPage(sess));
  }
  if (pathname === '/admin/supplier-data') {
    if (sess.role !== 'super_admin') return html('<h1>403</h1><p>仅超级管理员可访问</p>', 403);
    return html(adminSupplierDataPage(sess), 200, {'Cache-Control': 'no-cache, no-store, must-revalidate'});
  }

  // Admin APIs
  if (pathname === '/api/admin/supplier-data/prod/upload' && method === 'POST') {
    if (sess.role !== 'super_admin') return json({ ok: false, msg: '仅超级管理员可访问' }, 403);
    if (!originOk(headers, host)) return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    const ct = headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/i);
    if (!bm) return json({ ok: false, msg: 'Content-Type must be multipart/form-data' }, 400);
    const parts = parseMultipart(body, bm[1].trim());
    return apiSupplierDataProdUpload(parts, sess);
  }
  if (pathname.startsWith('/api/admin/supplier-data')) {
    if (sess.role !== 'super_admin') return json({ ok: false, msg: '仅超级管理员可访问' }, 403);
    if (method !== 'GET' && !originOk(headers, host)) return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    let parsed = {};
    if (method === 'POST' && body && body.length) {
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    }
    if (pathname === '/api/admin/supplier-data/ffr' && method === 'GET') return apiSupplierDataFFR(query);
    if (pathname === '/api/admin/supplier-data/prod' && method === 'POST') return apiSupplierDataProdCreate(parsed, sess);
    if (pathname === '/api/admin/supplier-data/return' && method === 'POST') return apiSupplierDataReturnCreate(parsed, sess);
    if (pathname === '/api/admin/supplier-data/prod-history' && method === 'GET') return apiSupplierDataProdHistory(query);
    if (pathname === '/api/admin/supplier-data/return-history' && method === 'GET') return apiSupplierDataReturnHistory(query);
    if (pathname === '/api/admin/supplier-data/prod/edit' && method === 'POST') return apiSupplierDataProdEdit(parsed, sess);
    if (pathname === '/api/admin/supplier-data/return/edit' && method === 'POST') return apiSupplierDataReturnEdit(parsed, sess);
    return json({ ok: false, msg: '未知供应商数据接口' }, 404);
  }
  // Product image upload (multipart, must be before JSON parser)
  if (pathname === '/api/admin/products/upload-image' && method === 'POST') {
    if (!isAdminRole(sess.role)) return json({ ok: false, msg: '仅管理员可访问' }, 403);
    if (method !== 'GET' && !originOk(headers, host)) return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    const ct = headers['content-type'] || '';
    const bm = ct.match(/boundary=(.+)/i);
    if (!bm) return json({ ok: false, msg: 'Content-Type must be multipart/form-data' }, 400);
    const parts = parseMultipart(body, bm[1].trim());
    const filePart = parts.find(p => p.name === 'file' && p.filename);
    if (!filePart) return json({ ok: false, msg: '未找到上传文件' }, 400);
    const ext = require('path').extname(filePart.filename || '').toLowerCase() || '.jpg';
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    if (!allowed.includes(ext)) return json({ ok: false, msg: '不支持的图片格式' }, 400);
    // SVG: save as-is (no raster compression needed)
    if (ext === '.svg') {
      const safeName = 'product_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + ext;
      require('fs').writeFileSync(require('path').join('/opt/quality-board/public/product-images', safeName), filePart.data);
      return json({ ok: true, image_path: '/product-images/' + safeName });
    }
    // Raster images: compress with sharp (max 1200px wide, JPEG quality 80)
    const safeName = 'product_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.jpg';
    const destPath = require('path').join('/opt/quality-board/public/product-images', safeName);
    try {
      await sharp(filePart.data)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toFile(destPath);
    } catch (sharpErr) {
      // Fallback: save original if sharp fails
      require('fs').writeFileSync(destPath, filePart.data);
    }
    return json({ ok: true, image_path: '/product-images/' + safeName });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdminRole(sess.role)) return json({ ok: false, msg: '仅管理员可访问' }, 403);
    if (method !== 'GET' && !originOk(headers, host)) {
      return json({ ok: false, msg: 'Origin 校验失败' }, 403);
    }
    let parsed = {};
    if (method === 'POST' && body && body.length) {
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return json({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    }

    // User management
    if (pathname === '/api/admin/list' && method === 'GET') return await apiAdminList();
    if (pathname === '/api/admin/create' && method === 'POST') return await apiAdminCreate(parsed);
    if (pathname === '/api/admin/chpwd' && method === 'POST') return await apiAdminChangePassword(parsed);
    if (pathname === '/api/admin/toggle' && method === 'POST') return await apiAdminToggle(parsed, sess);
    if (pathname === '/api/admin/delete' && method === 'POST') return await apiAdminDelete(parsed, sess);
    if (pathname === '/api/admin/setrole' && method === 'POST') return await apiAdminSetRole(parsed, sess);

    // Dashboard
    if (pathname === '/api/admin/dashboard' && method === 'GET') return apiDashboard(query);
    if (pathname === '/api/admin/dashboard/top-ffr' && method === 'GET') return apiTopFFR(query);
    if (pathname === '/api/admin/dashboard/daily-trend' && method === 'GET') return apiDailyTrend(query);
    if (pathname === '/api/admin/dashboard/user-stats' && method === 'GET') return apiUserStats(query);
    if (pathname === '/api/admin/dashboard/record-details' && method === 'GET') return apiRecordDetails(query);
    if (pathname === '/api/admin/records' && method === 'GET') return apiAdminRecords(query);
    if (pathname === '/api/admin/record/edit' && method === 'POST') return apiAdminEdit(parsed, sess);
    if (pathname === '/api/admin/record/delete' && method === 'POST') return apiAdminDeleteRecord(parsed, sess);
    if (pathname === '/api/admin/export' && method === 'GET') return apiAdminExport(query);
    if (pathname === '/api/admin/export-dashboard' && method === 'GET') return apiAdminExportDashboard(query);

    // Brands
    if (pathname === '/api/admin/brands/list' && method === 'GET') return apiAdminBrandsList();
    if (pathname === '/api/admin/brands/create' && method === 'POST') return apiAdminBrandsCreate(parsed);
    if (pathname === '/api/admin/brands/update' && method === 'POST') return apiAdminBrandsUpdate(parsed);
    if (pathname === '/api/admin/brands/delete' && method === 'POST') return apiAdminBrandsDelete(parsed);

    // Supplier-Brand Bindings
    if (pathname === '/api/admin/suppliers/list' && method === 'GET') {
      return json({ ok: true, suppliers: dbGetSuppliers() });
    }
    if (pathname === '/api/admin/suppliers/create' && method === 'POST') {
      const { name } = parsed;
      if (!name || !name.trim()) return json({ ok: false, msg: '供应商名称不能为空' }, 400);
      const existing = dbGetSupplierNames();
      if (existing.includes(name.trim())) return json({ ok: false, msg: '该供应商已存在' }, 400);
      dbCreateSupplier(name);
      return json({ ok: true });
    }
    if (pathname === '/api/admin/suppliers/delete' && method === 'POST') {
      const { id } = parsed;
      if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
      getDb().prepare('DELETE FROM suppliers WHERE id=?').run(id);
      return json({ ok: true });
    }
    if (pathname === '/api/admin/bindings/list' && method === 'GET') return apiAdminBindingsList();
    if (pathname === '/api/admin/bindings/update' && method === 'POST') return apiAdminBindingsUpdate(parsed);

    // Supplier-Product Bindings
    if (pathname === '/api/admin/product-bindings/list' && method === 'GET') return apiAdminProductBindingsList();
    if (pathname === '/api/admin/product-bindings/update' && method === 'POST') return apiAdminProductBindingsUpdate(parsed);

    // API Keys
    if (pathname === '/api/admin/api-keys/list' && method === 'GET') return apiAdminApiKeysList();
    if (pathname === '/api/admin/api-keys/create' && method === 'POST') return apiAdminApiKeysCreate(parsed);
    if (pathname === '/api/admin/api-keys/revoke' && method === 'POST') return apiAdminApiKeysRevoke(parsed);

    // Mainboard tests
    if (pathname === '/api/admin/mainboard-tests' && method === 'GET') return apiAdminMainboardTests(query);
    if (pathname === '/api/admin/mainboard-tests/export' && method === 'GET') return apiAdminMainboardTestsExport(query);

    // Repair records
    if (pathname === '/api/admin/repair-records' && method === 'GET') return apiAdminRepairRecords(query);
    if (pathname === '/api/admin/repair-records/export' && method === 'GET') return apiAdminRepairExport(query);
    if (pathname === '/api/admin/repair-record/edit' && method === 'POST') return apiAdminRepairEdit(parsed, sess);
    if (pathname === '/api/admin/repair-record/delete' && method === 'POST') return apiAdminRepairDelete(parsed, sess);


    // Products management
    if (pathname === '/api/admin/products/list' && method === 'GET') {
      const rows = getDb().prepare('SELECT * FROM products ORDER BY sort_order, id').all();
      return json({ ok: true, products: rows });
    }
    if (pathname === '/api/admin/products/model-codes' && method === 'GET') {
      const codes = getDb().prepare("SELECT DISTINCT model FROM prod_records WHERE model IS NOT NULL ORDER BY model").all().map(r => r.model);
      const returnCodes = getDb().prepare("SELECT DISTINCT model FROM return_records WHERE model IS NOT NULL ORDER BY model").all().map(r => r.model);
      const all = [...new Set([...codes, ...returnCodes])].sort();
      return json({ ok: true, codes: all });
    }
    if (pathname === '/api/admin/products/create' && method === 'POST') {
      const { model_name, model_code, image_path } = parsed;
      if (!model_name || !model_name.trim()) return json({ ok: false, msg: '名称不能为空' }, 400);
      const maxSort = getDb().prepare('SELECT MAX(sort_order) as m FROM products').get();
      const status = ['active','inactive'].includes(parsed.status) ? parsed.status : 'active';
      const vehicleBrand = (parsed.vehicle_brand||'').trim() || null;
      const category = (parsed.category||'').trim() || null;
      const stmt = getDb().prepare('INSERT INTO products (model_name, model_code, image_path, sort_order, created_at, status, vehicle_brand, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const r = stmt.run(model_name.trim(), (model_code||'').trim() || model_name.trim(), image_path || null, (maxSort.m || 0) + 1, Date.now(), status, vehicleBrand, category);
      return json({ ok: true, id: Number(r.lastInsertRowid) });
    }
    if (pathname === '/api/admin/products/update' && method === 'POST') {
      const { id, model_name, image_path } = parsed;
      if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
      if (!model_name || !model_name.trim()) return json({ ok: false, msg: '型号名称不能为空' }, 400);
      const cur = getDb().prepare("SELECT image_path, model_code, status, vehicle_brand, category FROM products WHERE id=?").get(id);
      const newImgPath = (image_path !== undefined) ? (image_path || null) : (cur && cur.image_path || null);
      const newCode = (parsed.model_code !== undefined) ? ((parsed.model_code||"").trim() || model_name.trim()) : (cur && cur.model_code || model_name.trim());
      const updStatus = parsed.status && ["active","inactive"].includes(parsed.status) ? parsed.status : (cur && cur.status || "active");
      const updBrand = (parsed.vehicle_brand !== undefined) ? ((parsed.vehicle_brand||"").trim() || null) : (cur && cur.vehicle_brand || null);
      const updCategory = (parsed.category !== undefined) ? ((parsed.category||"").trim() || null) : (cur && cur.category || null);
      getDb().prepare("UPDATE products SET model_name=?, model_code=?, image_path=?, updated_at=?, status=?, vehicle_brand=?, category=? WHERE id=?").run(model_name.trim(), newCode, newImgPath, Date.now(), updStatus, updBrand, updCategory, id);
      return json({ ok: true });
    }
    if (pathname === '/api/admin/products/delete' && method === 'POST') {
      const { id } = parsed;
      if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
      getDb().prepare('DELETE FROM products WHERE id=?').run(id);
      return json({ ok: true });
    }
    return json({ ok: false, msg: '未知管理接口' }, 404);
  }


  if (pathname === '/admin/products') {
    if (!isAdminRole(sess.role)) return html('<h1>403</h1><p>仅管理员可访问</p>', 403);
    return html(adminProductsPage(sess));
  }

    // ---- MES routes ----
  if (pathname.startsWith('/mes/') || pathname.startsWith('/api/mes/') || pathname === '/mes') {
    if (!sess || (!isAdminRole(sess.role) && sess.role !== 'factory')) {
      if (pathname.startsWith('/api/')) return json({ ok: false, msg: '无权访问' }, 403);
      return html('<h1>403</h1><p>无权访问工站管理</p><p><a href="/">返回</a></p>', 403);
    }
    // factory 账号工站访问控制
    if (sess.role === 'factory' && sess.mes_station) {
      const stationMatch = pathname.match(/^\/mes\/station\/([a-z_]+)$/);
      if (stationMatch && stationMatch[1] !== sess.mes_station) {
        const myLabel = require('./mes').MES_STATIONS.find(s => s.key === sess.mes_station)?.label || sess.mes_station;
        return html(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>403</title><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/libs/flatpickr.min.css">
<script src="/libs/flatpickr.min.js"></script>
<script src="/libs/flatpickr-zh.js"></script>
<script>
window.fp_config = {
  enableTime: false,
  dateFormat: 'Y-m-d',
  locale: 'zh',
  monthSelectorType: 'static',
  allowInput: true,
  disableMobile: true
};

</script></head><body class="bg-slate-50 min-h-screen flex items-center justify-center"><div class="bg-white rounded-lg shadow p-8 max-w-md text-center"><h1 class="text-2xl font-bold text-red-600 mb-3">403 无权访问</h1><p class="text-slate-600 mb-4">您只能访问自己绑定的工站</p><a href="/mes/station/${sess.mes_station}" class="inline-block bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700">返回我的工站 (${escapeHtml(myLabel)})</a></div></body></html>`, 403);
      }
      // /mes 或 /mes/ 重定向到绑定工站
      if (pathname === '/mes' || pathname === '/mes/') {
        return htmlRedirect(`/mes/station/${sess.mes_station}`);
      }
    }
    const mesResult = handleMes(method, pathname, query, sess, body, ADMIN_NAV);
    if (mesResult) return mesResult;
  }

  // ---- AI Analysis routes ----
  if (pathname.startsWith('/ai') || pathname.startsWith('/api/ai')) {
    if (!sess) {
      if (pathname.startsWith('/api')) return json({ ok: false, msg: '未登录' }, 401);
      return htmlRedirect('/login');
    }
    if (sess.role !== "dev" && sess.role !== "super_admin") {
      if (pathname.startsWith("/api")) return json({ ok: false, msg: "无权访问" }, 403);
      return html("<h1>403</h1><p>仅研发组可访问</p>", 403);
    }
    const aiResult = handleAiAnalysis(method, pathname, query, sess, body, headers);
    if (aiResult) return aiResult;
  }
  // ---- Product Version Hub routes ----
  if (pathname.startsWith('/admin/product-versions') || pathname.startsWith('/dev/product-versions') || pathname.startsWith('/api/product-versions')) {
    if (!sess) {
      if (pathname.startsWith('/api')) return json({ ok: false, msg: '未登录' }, 401);
      return htmlRedirect('/login');
    }
    if (sess.role !== "dev" && sess.role !== "super_admin") {
      if (pathname.startsWith("/api")) return json({ ok: false, msg: "无权访问" }, 403);
      return html("<h1>403</h1><p>仅研发组可访问</p>", 403);
    }
    const vhResult = handleVersionHub(method, pathname, query, sess, body, headers, ADMIN_NAV);
    if (vhResult) return vhResult;
  }

  return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not Found' };
}

// 数据库初始化必须完成后才能处理请求
const _dbReady = initDB().then(() => {
  ensureWorkflowTables();
  console.log('[db] Database initialized successfully');
}).catch(e => {
  console.error('[db] Database initialization failed:', e);
  process.exit(1);
});

const server = http.createServer(async (req, res) => {
  try {
    await _dbReady;
    await seedAdminIfNeeded();

    const rawUrl = req.url || '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const query = qIdx >= 0 ? parseQuery(rawUrl.slice(qIdx + 1)) : {};
    const method = req.method || 'GET';

    const headers = {};
    for (const k of Object.keys(req.headers)) {
      headers[k.toLowerCase()] = req.headers[k];
    }

    const cookies = parseCookies(headers.cookie);
    const host = headers.host || '';

    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', (c) => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const body = Buffer.concat(chunks);

    const result = await handleRequest(method, pathname, query, cookies, body, headers, host);

    res.statusCode = result.status;
    for (const [k, v] of Object.entries(result.headers || {})) {
      res.setHeader(k, v);
    }
    const out = result.body;
    if (Buffer.isBuffer(out)) {
      res.end(out);
    } else {
      res.end(out != null ? String(out) : '');
    }
  } catch (e) {
    console.error('request error:', e && e.stack || e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, msg: e.message || 'internal error' }));
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  await _dbReady;
  ensureAiTables();
  ensureVersionTables();
  ensureProtoBoardTables();
  ensureSupplierModuleConfigTable();
  console.log(`quality-board listening on port ${PORT}`);
  migrateFromFeishu().catch(e => console.error('[migration startup error]', e));
})
