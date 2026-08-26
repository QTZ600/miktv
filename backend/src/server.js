const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const config = require('./config');
const db = require('./db');
const { scanAll } = require('./scanner');
const routes = require('./routes');

async function start() {
  db.init();

  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '10mb' }));

  app.use('/api', routes);

  const frontendDist = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    console.log('Serving frontend from:', frontendDist);
    app.use(express.static(frontendDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`MikTV backend running on http://0.0.0.0:${config.port}`);
  });

  // Save DB on shutdown
  const shutdown = () => {
    console.log('Shutting down... saving data');
    db.saveSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', () => db.saveSync());

  setTimeout(async () => {
    try {
      await scanAll();
    } catch (err) {
      console.warn('Initial scan failed:', err.message);
    }
  }, 1000);
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
