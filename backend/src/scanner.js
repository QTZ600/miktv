const path = require('path');
const fs = require('fs-extra');
const { nanoid } = require('nanoid');
const config = require('./config');
const db = require('./db');

const VIDEO_EXT = new Set(config.videoExtensions.map(e => e.toLowerCase()));

function isVideoFile(filePath) {
  return VIDEO_EXT.has(path.extname(filePath).toLowerCase());
}

function extractTitle(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function guessType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes('movie') || lower.includes('电影')) return 'movie';
  if (lower.includes('tv') || lower.includes('series') || lower.includes('电视剧') || lower.includes('剧集')) return 'tvshow';
  return 'other';
}

async function scanDir(dirPath) {
  const results = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      console.warn(`Cannot read directory: ${current}`, err.message);
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isVideoFile(fullPath)) {
        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }
        results.push({
          filePath: fullPath,
          fileSize: stat.size,
          mtime: stat.mtimeMs
        });
      }
    }
  }
  return results;
}

async function scanAll() {
  db.init();
  const now = Date.now();
  const allFiles = [];

  for (const dir of config.mediaDirs) {
    if (!(await fs.pathExists(dir))) {
      console.warn(`Media directory not found: ${dir}`);
      continue;
    }
    console.log(`Scanning: ${dir}`);
    const files = await scanDir(dir);
    allFiles.push(...files);
    db.upsertDir(dir);
  }

  for (const f of allFiles) {
    db.upsertMedia({
      id: nanoid(),
      type: guessType(f.filePath),
      title: extractTitle(f.filePath),
      file_path: f.filePath,
      file_size: f.fileSize,
      directory: path.dirname(f.filePath),
      created_at: now,
      updated_at: f.mtime
    });
  }

  const existingPaths = new Set(allFiles.map(f => f.filePath));
  const removed = db.removeMissingMedia(existingPaths);
  if (removed > 0) console.log(`Removed ${removed} missing files`);

  db.saveSync();
  console.log(`Scan complete: ${allFiles.length} items processed`);
  return { total: allFiles.length, removed };
}

module.exports = { scanAll, scanDir };
