#!/usr/bin/env bash
# 质量管理系统 —— 云服务器首次部署引导（只需执行一次）
# 用法：
#   1) 把本文件传到服务器，或直接：
#      curl -fsSL https://raw.githubusercontent.com/QTZ600/miktv/main/deploy/server-bootstrap.sh -o bootstrap.sh
#   2) sudo bash bootstrap.sh
# 之后所有更新由 GitHub Actions 自动完成（调用仓库根目录的 deploy.sh）。
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/QTZ600/miktv.git}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/quality-board}"
BRANCH="${BRANCH:-main}"

need_sudo=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then need_sudo="sudo"; else
    echo "请以 root 运行，或安装 sudo"; exit 1
  fi
fi

echo ">>> [1/4] 检查/安装 Docker（含 compose 插件）"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
$need_sudo systemctl enable --now docker
docker compose version >/dev/null 2>&1 || { echo "!! docker compose 插件不可用"; exit 1; }

echo ">>> [2/4] 准备部署目录 $DEPLOY_PATH"
$need_sudo mkdir -p "$DEPLOY_PATH"
$need_sudo chown "$(id -u):$(id -g)" "$DEPLOY_PATH" 2>/dev/null || true

if [ ! -d "$DEPLOY_PATH/.git" ]; then
  echo "    克隆仓库 ($BRANCH)..."
  git clone -b "$BRANCH" "$REPO_URL" "$DEPLOY_PATH"
else
  echo "    仓库已存在，更新到最新..."
  cd "$DEPLOY_PATH"
  git fetch origin "$BRANCH" --prune
  git reset --hard "origin/$BRANCH"
fi
cd "$DEPLOY_PATH"

echo ">>> [3/4] 生成 .env（如不存在）与持久化数据目录"
[ -f .env ] || cp .env.example .env
mkdir -p data
echo "    !! 请编辑 $DEPLOY_PATH/.env 修改管理员初始密码（默认 admin/admin123）"

echo ">>> [4/4] 构建并启动"
docker compose up -d --build

echo
echo "=== 首次部署完成 ==="
echo "数据持久化目录: $DEPLOY_PATH/data   （容器重建不丢失）"
echo "查看日志:       cd $DEPLOY_PATH && docker compose logs -f"
echo "更新方式:       推送到 main 分支后由 GitHub Actions 自动部署，或手动 bash $DEPLOY_PATH/deploy.sh"
