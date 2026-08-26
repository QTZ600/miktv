# MikTV - 家庭媒体中心

一个轻量级、适合部署在本地 NAS（群晖/威联通/Unraid 等）的家庭媒体服务器，用于管理和播放本地视频资源。

## ✨ 功能特性

- 🎬 **媒体库管理**：自动扫描本地视频，分类浏览（电影/剧集/其他）
- 📺 **网页播放器**：内置 HTML5 视频播放器，支持拖拽进度、倍速、全屏
- 💬 **自动字幕**：自动加载同名字幕文件（srt/ass/vtt 等）
- 🚀 **断点续传**：流媒体 Range 请求支持，完美支持拖动进度条
- 🔐 **访问保护**：可选 Token 认证，保护内网资源
- 📱 **响应式界面**：支持手机、平板、电视浏览器、PC
- 🐳 **Docker 部署**：开箱即用，完美适配 NAS 环境
- 💾 **SQLite 存储**：无需额外数据库，简单可靠

## 🏗️ 项目结构

```
miktv/
├── backend/              # Node.js 后端服务
│   ├── src/
│   │   ├── server.js     # 入口
│   │   ├── routes.js     # API 路由
│   │   ├── scanner.js    # 媒体扫描器
│   │   ├── streamer.js   # 流媒体（Range 支持）
│   │   ├── db.js         # SQLite 数据库
│   │   └── config.js     # 配置管理
│   ├── package.json
│   └── .env.example
├── frontend/             # React 前端界面
│   ├── src/
│   │   ├── pages/        # 首页/媒体库/播放器
│   │   ├── api.js
│   │   └── styles.css    # 深色主题
│   ├── package.json
│   └── vite.config.js
├── Dockerfile            # 多阶段构建（推荐）
├── docker-compose.yml    # NAS 部署主配置
├── deploy.sh             # 一键部署脚本
├── deploy/
│   ├── synology-nginx.conf   # 群晖反向代理模板
│   └── NAS-PATHS.md          # 各 NAS 路径对照表
└── package.json          # 根脚本集合
```

## 🚀 部署方式

### 方式一：NAS 一键部署（推荐）

适合 **群晖 / 威联通 / Unraid / Linux NAS**：

```bash
# 1. SSH 登录到 NAS
# 2. 克隆或上传项目到 NAS 任意目录，例如 /volume1/docker/miktv
cd /volume1/docker/miktv

# 3. 修改 docker-compose.yml 中的媒体目录映射（重要！）
#    volumes 左边改成你 NAS 实际的媒体路径

# 4. 执行一键部署
chmod +x deploy.sh
./deploy.sh deploy

# 其他命令：
./deploy.sh update   # 更新并重启
./deploy.sh backup   # 备份数据
```

启动后访问：`http://你的NAS_IP:3000`

### 方式二：Docker Compose 手动部署

```bash
# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f miktv

# 停止
docker compose down
```

### 方式三：本地开发运行

适合开发调试：

```bash
# 1. 安装依赖
npm run install:all

# 2. 复制并修改后端配置
cp backend/.env.example backend/.env
# 编辑 backend/.env，将 MEDIA_DIRS 改成你本地视频目录

# 3. 启动后端（端口 3000）
npm run dev:backend

# 4. 另开终端启动前端（端口 5173，代理到后端）
npm run dev:frontend
# 访问 http://localhost:5173
```

## ⚙️ 主要配置项

通过环境变量（`.env` 或 docker-compose 的 environment）配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `MEDIA_DIRS` | `/media` | 媒体目录，**多个用 `;` 分隔** |
| `DATA_DIR` | `./data` | 数据目录（数据库、缓存等） |
| `THUMBNAIL_WIDTH` | `400` | 缩略图宽度（像素） |
| `CORS_ORIGIN` | `*` | 允许跨域的来源 |
| `AUTH_TOKEN` | _(空)_ | 访问密码，留空不启用认证 |
| `TZ` | `Asia/Shanghai` | 时区 |

## 🔌 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/health` | 健康检查 |
| GET  | `/api/stats` | 统计信息 |
| GET  | `/api/media?type=&search=&limit=&offset=&sort=` | 媒体列表 |
| GET  | `/api/media/:id` | 媒体详情 |
| GET  | `/api/media/:id/stream` | 视频流（支持 Range） |
| GET  | `/api/media/:id/subtitles` | 字幕列表 |
| GET  | `/api/media/:id/subtitle/:name` | 字幕下载 |
| POST | `/api/media/:id/play` | 标记播放（+1 次） |
| POST | `/api/scan` | 触发全量扫描 |

> 若启用了 `AUTH_TOKEN`，需在请求头带上 `X-Auth-Token: <token>` 或 URL 参数 `?token=<token>`。

## 🛠️ 支持的媒体格式

- **视频**：`.mp4 .mkv .avi .mov .wmv .flv .webm .m4v .ts .mpg .mpeg`
- **字幕**：`.srt .ass .ssa .vtt .sub`（浏览器原生支持程度不同，建议 srt/vtt）

> 容器格式能否播放取决于浏览器解码能力。MKV/H.265 等在 Safari/部分浏览器可能不支持，
> 如需全格式可在后续版本接入 ffmpeg 转码。

## 📝 常见问题

**Q: 群晖启动后无法看到媒体文件？**
A: 检查 docker-compose.yml 的 volumes 映射是否正确，确保 NAS 路径存在且有读权限，
   然后首页点击「扫描媒体库」或调用 `POST /api/scan`。

**Q: 视频播放卡顿？**
A: 1. 确保 NAS 和播放器在同一局域网（千兆最佳）；
   2. 若视频码率极高（蓝光原盘）请考虑使用支持硬件解码的播放器；
   3. 可通过 Nginx 反向代理启用缓存。

**Q: 如何外网访问？**
A: 建议通过群晖 QuickConnect / Tailscale / frp 等方式内网穿透；
   同时务必设置 `AUTH_TOKEN` 保护访问。

## 📄 License

MIT
