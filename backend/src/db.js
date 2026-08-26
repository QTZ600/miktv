const path = require('path');
const fs = require('fs-extra');
const config = require('./config');

let store = null;
let dirty = false;

const DB_FILE = () => path.join(config.dataDir, 'miktv-db.json');

function saveSync() {
  if (!dirty || !store) return;
  try {
    fs.writeJsonSync(DB_FILE(), store, { spaces: 0 });
    dirty = false;
  } catch (err) {
    console.error('Save DB failed:', err.message);
  }
}

// Periodic save for data safety
setInterval(() => { if (dirty) saveSync(); }, 5000).unref();

function init() {
  fs.ensureDirSync(config.dataDir);
  fs.ensureDirSync(path.join(config.dataDir, 'thumbnails'));

  const file = DB_FILE();
  if (fs.existsSync(file)) {
    try {
      store = fs.readJsonSync(file);
    } catch (err) {
      console.warn('DB file corrupt, recreating:', err.message);
      store = null;
    }
  }

  if (!store) {
    store = {
      mediaItems: {},   // id -> item
      dirs: {},         // id -> {path, last_scanned_at}
      meta: { version: 1, created_at: Date.now() }
    };
    dirty = true;
    saveSync();
  }
}

function ensureInit() {
  if (!store) init();
}

function markDirty() { dirty = true; }

// ---------- Media Items ----------
function upsertMedia(item) {
  ensureInit();
  const existing = Object.values(store.mediaItems).find(m => m.file_path === item.file_path);
  if (existing) {
    const merged = { ...existing, ...item, id: existing.id, updated_at: item.updated_at || existing.updated_at };
    store.mediaItems[existing.id] = merged;
    dirty = true;
    return existing.id;
  }
  store.mediaItems[item.id] = item;
  dirty = true;
  return item.id;
}

function getMediaById(id) {
  ensureInit();
  return store.mediaItems[id] || null;
}

function queryMedia({ type, search, limit = 50, offset = 0, sort = 'created_at', order = 'desc' } = {}) {
  ensureInit();
  let rows = Object.values(store.mediaItems);

  if (type && type !== 'all') rows = rows.filter(r => r.type === type);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r => r.title.toLowerCase().includes(q));
  }

  const dirSign = order === 'asc' ? 1 : -1;
  const validSorts = ['created_at', 'updated_at', 'title', 'file_size', 'last_played_at', 'play_count'];
  const sortKey = validSorts.includes(sort) ? sort : 'created_at';

  rows.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * dirSign;
    return ((av || 0) - (bv || 0)) * dirSign;
  });

  const total = rows.length;
  const items = rows.slice(Number(offset), Number(offset) + Number(limit));
  return { items, total };
}

function removeMissingMedia(existingPathsSet) {
  ensureInit();
  const all = Object.entries(store.mediaItems);
  let removed = 0;
  for (const [id, item] of all) {
    if (!existingPathsSet.has(item.file_path)) {
      delete store.mediaItems[id];
      removed++;
    }
  }
  if (removed > 0) dirty = true;
  return removed;
}

function updateMediaPlay(id) {
  ensureInit();
  const item = store.mediaItems[id];
  if (!item) return false;
  item.last_played_at = Date.now();
  item.play_count = (item.play_count || 0) + 1;
  dirty = true;
  return true;
}

// ---------- Stats ----------
function getStats() {
  ensureInit();
  const items = Object.values(store.mediaItems);
  const byType = {};
  let totalSize = 0;
  for (const it of items) {
    byType[it.type] = (byType[it.type] || 0) + 1;
    totalSize += it.file_size || 0;
  }
  const byTypeArr = Object.entries(byType).map(([type, c]) => ({ type, c }));
  const lastPlayed = items
    .filter(i => i.last_played_at)
    .sort((a, b) => b.last_played_at - a.last_played_at)
    .slice(0, 5);
  return {
    total: items.length,
    byType: byTypeArr,
    totalSize,
    lastPlayed
  };
}

// ---------- Dirs ----------
function upsertDir(dirPath) {
  ensureInit();
  const existing = Object.values(store.dirs).find(d => d.path === dirPath);
  const now = Date.now();
  if (existing) {
    existing.last_scanned_at = now;
  } else {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
    store.dirs[id] = { id, path: dirPath, last_scanned_at: now };
  }
  dirty = true;
}

module.exports = {
  init,
  saveSync,
  markDirty,
  upsertMedia,
  getMediaById,
  queryMedia,
  removeMissingMedia,
  updateMediaPlay,
  getStats,
  upsertDir
};
