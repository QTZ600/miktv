require('dotenv').config();
const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  mediaDirs: (process.env.MEDIA_DIRS || '/media')
    .split(';')
    .map(d => d.trim())
    .filter(Boolean),
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, '..', 'data'),
  thumbnailWidth: parseInt(process.env.THUMBNAIL_WIDTH, 10) || 400,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  authToken: process.env.AUTH_TOKEN || '',
  videoExtensions: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg'],
  subtitleExtensions: ['.srt', '.ass', '.ssa', '.vtt', '.sub'],
  imageExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.bmp']
};

module.exports = config;
