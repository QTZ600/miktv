#!/usr/bin/env bash
# ============================================================
# MikTV 一键部署到 NAS
# 目标地址：192.168.10.168:30000
# 使用方法（SSH 登录 NAS 后执行）：
#   方法 A（推荐，项目已上传）：
#      cd /volume1/docker/miktv && chmod +x deploy.sh && ./deploy.sh deploy
#   方法 B（Git 仓库部署）：
#      bash <(curl -s https://raw.githubusercontent.com/QTZ600/miktv/main/deploy/deploy-to-192.168.10.168.sh)
#   方法 C（离线，将项目 zip 上传后解压）：
#      unzip miktv.zip && cd miktv && chmod +x deploy.sh && ./deploy.sh deploy
# ============================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

NAS_IP="192.168.10.168"
NAS_PORT="30000"

echo -e "${BLUE}
  __  __ _ _  _____   __   
 |  \/  (_) |/ ____|  \ \  
 | \  / |_| | |_   __  \ \ 
 | |\/| | |  _| |/ _| | |
 | |  | |_| | | | (_| | | 
 |_|  |_|_|_|  \__,_| |_| 
${NC}MikTV → 目标：${GREEN}http://${NAS_IP}:${NAS_PORT}${NC}"
echo

# ---------- Step 1: 依赖检查 ----------
echo -e "${BLUE}[1/6]${NC} 检查 Docker 环境..."
HAS_DC=0
if command -v docker >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Docker: $(docker --version 2>&1 | awk '{print $3}' | tr -d ',')"
    if docker compose version >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Docker Compose Plugin: $(docker compose version 2>&1 | awk '{print $4}' | tr -d ',')"
        HAS_DC=1; DC_CMD="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Docker Compose: $(docker-compose --version 2>&1 | awk '{print $3}' | tr -d ',')"
        HAS_DC=1; DC_CMD="docker-compose"
    else
        echo -e "  ${RED}✗ 未安装 Docker Compose${NC} - 请在群晖套件中心安装 Container Manager，或 apt/yum 安装 docker-compose-plugin"
        exit 1
    fi
else
    echo -e "  ${RED}✗ 未安装 Docker${NC} - 请先在 NAS 上安装 Docker/Container Manager"
    exit 1
fi

# ---------- Step 2: 选择工作目录 ----------
echo -e "\n${BLUE}[2/6]${NC} 准备部署目录..."
WORK_DIR="${WORK_DIR:-/volume1/docker/miktv}"

# 威联通自动检测
if [ ! -d "/volume1" ] && [ -d "/share/CACHEDEV1_DATA" ]; then
    WORK_DIR="/share/CACHEDEV1_DATA/Container/miktv"
fi
# Unraid 自动检测
if [ ! -d "/volume1" ] && [ -d "/mnt/user" ]; then
    WORK_DIR="/mnt/user/appdata/miktv"
fi

if [ ! -d "$WORK_DIR" ]; then
    echo -e "  创建目录：${WORK_DIR}"
    mkdir -p "$WORK_DIR" "$WORK_DIR/data"
else
    echo -e "  使用已有目录：${WORK_DIR}"
fi
cd "$WORK_DIR"

# ---------- Step 3: 检查项目文件 ----------
echo -e "\n${BLUE}[3/6]${NC} 检查项目文件..."
NEED_PULL=0
if [ -f "Dockerfile" ] && [ -f "docker-compose.yml" ] && [ -d "backend" ] && [ -d "frontend" ]; then
    echo -e "  ${GREEN}✓${NC} 项目文件齐全"
else
    echo -e "  ${YELLOW}! 项目文件不完整，尝试从 GitHub 拉取${NC}"
    if command -v git >/dev/null 2>&1; then
        if [ -d ".git" ]; then
            git -C "$WORK_DIR" pull --ff-only || true
        else
            cd /tmp && rm -rf miktv-tmp && \
            git clone --depth 1 https://github.com/QTZ600/miktv.git miktv-tmp && \
            cp -a miktv-tmp/. "$WORK_DIR/" && rm -rf miktv-tmp && cd "$WORK_DIR"
        fi
        NEED_PULL=1
    else
        echo -e "  ${RED}✗ 未安装 git，且项目文件缺失${NC}"
        echo "  请手动将项目压缩包上传到 $WORK_DIR 后解压，再重新运行本脚本"
        exit 1
    fi
fi

# ---------- Step 4: 媒体目录映射 ----------
echo -e "\n${BLUE}[4/6]${NC} 配置媒体目录映射..."

# 尝试探测群晖/威联通默认媒体目录并交互式建议
MOVIES_SRC="/volume1/video/Movies"
TV_SRC="/volume1/video/TVShows"
OTHERS_SRC="/volume1/video/Others"

[ -d "/share/CACHEDEV1_DATA/Multimedia" ] && MOVIES_SRC="/share/CACHEDEV1_DATA/Multimedia/Movies"
[ -d "/mnt/user/Media" ] && MOVIES_SRC="/mnt/user/Media/Movies"

# 不存在则使用占位目录（部署后也能正常启动，只是空库）
mkdir -p "$WORK_DIR/sample_media/movies" "$WORK_DIR/sample_media/tvshows" 2>/dev/null || true

# 若默认宿主媒体目录不存在，用 sample_media 兜底（保证 compose 不会因路径不存在而失败）
[ -d "$MOVIES_SRC" ]  || MOVIES_SRC="$WORK_DIR/sample_media/movies"
[ -d "$TV_SRC" ]      || TV_SRC="$WORK_DIR/sample_media/tvshows"
[ -d "$OTHERS_SRC" ]  || OTHERS_SRC="$WORK_DIR/sample_media/movies"

# 写入一个带 30000 端口 + 自动路径的 compose 覆盖文件
cat > docker-compose.override.yml <<EOF
# 自动生成的本地覆盖文件 - 可按需修改
version: '3.8'
services:
  miktv:
    ports:
      - "${NAS_PORT}:3000"
    volumes:
      - ${MOVIES_SRC}:/media/movies:ro
      - ${TV_SRC}:/media/tvshows:ro
      - ${OTHERS_SRC}:/media/others:ro
      - ./data:/data
EOF

echo -e "  ${GREEN}✓${NC} 端口映射： ${NAS_PORT}:3000"
echo -e "  ${GREEN}✓${NC} 电影目录： ${MOVIES_SRC} -> /media/movies"
echo -e "  ${GREEN}✓${NC} 剧集目录： ${TV_SRC} -> /media/tvshows"
echo -e "  ${GREEN}✓${NC} 其他视频： ${OTHERS_SRC} -> /media/others"
echo -e "  ${YELLOW}! 如需修改请编辑：docker-compose.override.yml${NC}"

# ---------- Step 5: 构建镜像 & 启动 ----------
echo -e "\n${BLUE}[5/6]${NC} 构建镜像并启动容器（首次需要几分钟下载基础镜像）..."
$DC_CMD up -d --build

echo -e "\n  等待服务启动..."
sleep 5

# ---------- Step 6: 健康检查 ----------
echo -e "\n${BLUE}[6/6]${NC} 健康检查..."
HEALTH_URL="http://127.0.0.1:${NAS_PORT}/api/health"
for i in 1 2 3 4 5 6 7 8 9 10; do
    STATUS=$(curl -s --connect-timeout 3 "$HEALTH_URL" 2>/dev/null || true)
    if echo "$STATUS" | grep -q '"status":"ok"'; then
        echo -e "  ${GREEN}✓${NC} 容器健康检查通过"
        break
    fi
    echo -e "  等待服务就绪... （$i/10）"
    sleep 5
done

if [ -z "$STATUS" ] || ! echo "$STATUS" | grep -q '"status":"ok"'; then
    echo -e "  ${YELLOW}! 健康检查超时，尝试打印容器日志排查：${NC}"
    $DC_CMD logs --tail 30 miktv 2>&1 | tail -20
fi

# ---------- 完成 ----------
IP_CMD=""
command -v ip >/dev/null 2>&1 && IP_CMD="ip addr"
command -v ifconfig >/dev/null 2>&1 && IP_CMD="ifconfig"

echo
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  MikTV 部署完成！🎉${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo
echo "  浏览器访问（局域网任一设备）："
echo -e "    → ${GREEN}http://${NAS_IP}:${NAS_PORT}${NC}"
echo
echo "  若 NAS 其他 IP 也可访问，查看本机 IP："
echo "    $IP_CMD 2>/dev/null | grep 'inet ' | awk '{print \$2}'"
echo
echo "  常用运维命令（在 $WORK_DIR 目录下执行）："
echo "    查看日志：  $DC_CMD logs -f miktv"
echo "    重启：      $DC_CMD restart miktv"
echo "    停止：      $DC_CMD down"
echo "    重新构建：  $DC_CMD up -d --build"
echo "    扫描媒体：  页面右上角「扫描媒体库」按钮"
echo
echo "  数据持久化目录："
echo "    数据库/缓存： $WORK_DIR/data/  ← 建议定期备份"
echo
echo -e "${YELLOW}  提示：${NC}"
echo "    · 若看不到视频，请编辑 docker-compose.override.yml 修改媒体目录映射"
echo "      后执行：$DC_CMD up -d  即可生效，无需重建镜像"
echo "    · 外网访问建议：群晖 QuickConnect / Tailscale / frp 内网穿透"
echo "    · 访问保护建议：在 docker-compose.yml 中设置 AUTH_TOKEN 环境变量"
echo
