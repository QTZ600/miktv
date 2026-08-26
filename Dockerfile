# ============== Stage 1: Build Frontend ==============
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund --loglevel=error

COPY frontend/ ./
RUN npm run build

# ============== Stage 2: Build Backend ==============
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend
COPY backend/package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-audit --no-fund --loglevel=error --omit=dev

# ============== Stage 3: Runtime ==============
FROM node:20-alpine AS runtime

LABEL maintainer="MikTV"
LABEL description="MikTV - Home Media Center"

# 基础依赖：ffmpeg 用于后续缩略图/媒体信息（可选），sqlite 依赖
RUN apk add --no-cache \
    tzdata \
    curl \
    ffmpeg

ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# 后端依赖
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules

# 后端源码
COPY backend/ ./backend/

# 前端构建产物
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist/

# 启动脚本
RUN echo '#!/bin/sh\n\
set -e\n\
cd /app/backend\n\
exec node src/server.js\n' > /app/entrypoint.sh && \
    chmod +x /app/entrypoint.sh

# 数据卷：媒体文件、数据、配置
VOLUME ["/media", "/data", "/app/backend/.env"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
