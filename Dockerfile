# 依赖安装阶段（使用 bookworm-slim 的 glibc 环境，better-sqlite3 / sharp 可直接使用预编译包）
FROM node:20-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org/ \
    && npm cache clean --force


# 运行阶段
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/data.db \
    UPLOAD_DIR=/data/uploads \
    PRODUCT_IMAGES_DIR=/data/product-images

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js kv.js mes.js ai-analysis.js version-hub.js ./

RUN mkdir -p /app/public /data/uploads /data/product-images \
    && chown -R node:node /data /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
