#!/usr/bin/env bash
# 质量管理系统 —— 服务器端更新脚本
# 由 GitHub Actions 在 push 到 main 后通过 SSH 调用，也可在服务器上手动执行：bash deploy.sh
# 行为：拉取最新代码 -> 重建镜像 -> 滚动重启 -> 就绪探测 -> 清理旧镜像
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/quality-board}"
BRANCH="${BRANCH:-main}"
APP_PORT="${APP_PORT:-3000}"

cd "$DEPLOY_PATH"

echo ">>> [1/5] 拉取最新代码 ($BRANCH)"
git fetch origin "$BRANCH" --prune
git reset --hard "origin/$BRANCH"

echo ">>> [2/5] 确保 .env 存在（首次从模板生成）"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    已生成 .env，请按需修改管理员密码等（本次启动将使用默认值）"
fi

echo ">>> [3/5] 构建并滚动重启容器"
docker compose up -d --build

echo ">>> [4/5] 等待服务就绪（最多 60s）"
ready=0
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/login" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "    !! 服务未就绪，最近日志如下："
  docker compose logs --tail=40
  exit 1
fi
echo "    服务已就绪 ✓"

echo ">>> [5/5] 清理悬空旧镜像"
docker image prune -f >/dev/null 2>&1 || true

echo
echo "=== 部署完成 ==="
docker compose ps
