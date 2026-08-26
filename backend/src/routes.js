const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { scanAll } = require('./scanner');
const { streamVideo, streamSubtitle } = require('./streamer');

const router = express.Router();

function auth(req, res, next) {
  if (!config.authToken) return next();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === config.authToken) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

router.get('/media', auth, (req, res) => {
  const { type, search, limit = 50, offset = 0, sort = 'created_at', order = 'desc' } = req.query;
  const result = db.queryMedia({ type, search, limit, offset, sort, order });
  res.json({ items: result.items, total: result.total });
});

router.get('/media/:id', auth, (req, res) => {
  const item = db.getMediaById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

router.get('/media/:id/stream', auth, (req, res) => {
  const item = db.getMediaById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(item.file_path)) return res.status(410).json({ error: 'File not found on disk' });
  streamVideo(req, res, item.file_path);
});

router.get('/media/:id/subtitles', auth, (req, res) => {
  const item = db.getMediaById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const dir = path.dirname(item.file_path);
  const base = path.basename(item.file_path, path.extname(item.file_path));
  const subtitles = [];
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (config.subtitleExtensions.includes(ext)) {
        const fbase = path.basename(f, ext);
        if (fbase === base || base.startsWith(fbase) || f.startsWith(base)) {
          subtitles.push({ name: f, lang: 'unknown' });
        }
      }
    }
  }
  res.json({ subtitles });
});

router.get('/media/:id/subtitle/:name', auth, (req, res) => {
  const item = db.getMediaById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const subPath = path.join(path.dirname(item.file_path), req.params.name);
  if (!fs.existsSync(subPath)) return res.status(404).json({ error: 'Subtitle not found' });
  streamSubtitle(req, res, subPath);
});

router.post('/media/:id/play', auth, (req, res) => {
  const ok = db.updateMediaPlay(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/scan', auth, async (req, res) => {
  try {
    const result = await scanAll();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', auth, (req, res) => {
  res.json(db.getStats());
});

module.exports = router;
