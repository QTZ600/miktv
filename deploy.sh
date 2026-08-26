#!/usr/bin/env bash
# ============================================================
# MikTV - NAS 一键部署脚本
# 适用于：群晖 DSM / 威联通 QTS / Unraid / 通用 Linux
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BLUE}"
echo "  __  __ _ _  _____   __   "
echo " |  \/  (_) |/ ____|  \ \  "
echo " | \  / |_| | |_   __  \ \ "
echo " | |\/| | |  _| |/ _| | |"
echo " | |  | |_| | | | (_| | | "
echo " |_|  |_|_|_|  \__,_| |_| "
echo
echo -e "${NC}MikTV 家庭媒体中心 - 一键部署脚本"
echo

# ---------- 检查依赖 ----------
check_deps() {
    local missing=0
    echo -e "${BLUE}[1/5]${NC} 检查环境依赖..."

    if ! command -v docker &> /dev/null; then
        echo -e "${RED}✗ 未安装 Docker${NC} - 请先在 NAS 套件中心安装 Docker/Container Manager"
        missing=1
    else
        echo -e "${GREEN}✓${NC} Docker: $(docker --version | awk '{print $3}')"
    fi

    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        echo -e "${YELLOW}! 未找到 docker-compose${NC} - 将尝试使用 'docker compose' 插件"
    else
        if command -v docker-compose &> /dev/null; then
            echo -e "${GREEN}✓${NC} Docker Compose: $(docker-compose --version | awk '{print $3}')"
        else
            echo -e "${GREEN}✓${NC} Docker Compose Plugin: $(docker compose version | awk '{print $4}')"
        fi
    fi

    if [ "$missing" -ne 0 ]; then
        echo -e "${RED}缺少必要依赖，退出部署。${NC}"
        exit 1
    fi
}

# ---------- 创建必要目录 ----------
create_dirs() {
    echo -e "${BLUE}[2/5]${NC} 创建目录结构..."
    mkdir -p "$SCRIPT_DIR/data"
    mkdir -p "$SCRIPT_DIR/backend/data"
    echo -e "${GREEN}✓${NC} 数据目录已就绪"
}

# ---------- 配置文件生成 ----------
gen_config() {
    echo -e "${BLUE}[3/5]${NC} 环境配置检查..."
    if [ ! -f "$SCRIPT_DIR/.env" ]; then
        if [ -f "$SCRIPT_DIR/.env.example" ]; then
            cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
            echo -e "${YELLOW}! 已生成 .env 配置文件${NC} - 建议修改 AUTH_TOKEN 等参数"
        fi
    else
        echo -e "${GREEN}✓${NC} .env 文件已存在"
    fi

    if [ -f "$SCRIPT_DIR/backend/.env" ]; then
        echo -e "${GREEN}✓${NC} backend/.env 文件已存在"
    else
        cp "$SCRIPT_DIR/backend/.env.example" "$SCRIPT_DIR/backend/.env" 2>/dev/null || true
    fi
}

# ---------- 构建镜像 ----------
build_image() {
    echo -e "${BLUE}[4/5]${NC} 构建 Docker 镜像..."
    if docker compose build miktv 2>/dev/null; then
        echo -e "${GREEN}✓${NC} 镜像构建成功（docker compose）"
    elif docker-compose build miktv 2>/dev/null; then
        echo -e "${GREEN}✓${NC} 镜像构建成功（docker-compose）"
    else
        echo -e "${YELLOW}! docker compose 构建失败，尝试 docker build...${NC}"
        docker build -t miktv:latest "$SCRIPT_DIR"
        echo -e "${GREEN}✓${NC} 镜像构建成功"
    fi
}

# ---------- 启动服务 ----------
start_service() {
    echo -e "${BLUE}[5/5]${NC} 启动 MikTV 服务..."
    if docker compose up -d 2>/dev/null; then
        echo -e "${GREEN}✓${NC} 服务已启动（docker compose）"
    elif docker-compose up -d 2>/dev/null; then
        echo -e "${GREEN}✓${NC} 服务已启动（docker-compose）"
    else
        echo -e "${RED}✗ 启动失败，请手动执行：docker compose up -d${NC}"
        exit 1
    fi

    echo
    echo -e "${GREEN}══════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  MikTV 部署完成！${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════${NC}"
    echo
    echo "  访问地址: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '你的NAS_IP'):3000"
    echo "  容器名称: miktv"
    echo
    echo "  常用命令:"
    echo "    查看日志: $(command -v docker-compose >/dev/null 2>&1 && echo 'docker-compose' || echo 'docker compose') logs -f miktv"
    echo "    停止服务: $(command -v docker-compose >/dev/null 2>&1 && echo 'docker-compose' || echo 'docker compose') down"
    echo "    重启服务: $(command -v docker-compose >/dev/null 2>&1 && echo 'docker-compose' || echo 'docker compose') restart"
    echo
    echo -e "${YELLOW}  提示:${NC}"
    echo "    1. 编辑 docker-compose.yml 修改媒体目录映射（默认映射了 /volume1/video/*）"
    echo "    2. 首次启动会自动扫描媒体目录"
    echo "    3. 建议在 .env 中设置 AUTH_TOKEN 启用访问保护"
    echo
}

# ---------- Main ----------
case "${1:-deploy}" in
    deploy)
        check_deps
        create_dirs
        gen_config
        build_image
        start_service
        ;;
    update)
        echo -e "${BLUE}更新 MikTV...${NC}"
        git -C "$SCRIPT_DIR" pull --ff-only 2>/dev/null || echo -e "${YELLOW}! git pull 跳过（非 git 仓库）${NC}"
        build_image
        if docker compose up -d --force-recreate 2>/dev/null; then true
        else docker-compose up -d --force-recreate; fi
        echo -e "${GREEN}✓ 更新完成${NC}"
        ;;
    backup)
        BACKUP_FILE="miktv-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
        echo -e "${BLUE}备份数据到 ${BACKUP_FILE}...${NC}"
        tar -czf "$BACKUP_FILE" -C "$SCRIPT_DIR" data/ .env docker-compose.override.yml 2>/dev/null || true
        echo -e "${GREEN}✓ 备份完成: $BACKUP_FILE${NC}"
        ;;
    *)
        echo "用法: $0 {deploy|update|backup}"
        echo "  deploy  - 全新部署（默认）"
        echo "  update  - 更新代码并重启"
        echo "  backup  - 备份数据和配置"
        exit 1
        ;;
esac
