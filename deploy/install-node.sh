#!/bin/sh
# 非 Docker 方式安装脚本（systemd 常驻）
# 用法：在项目目录下执行  sudo sh deploy/install-node.sh
set -eu

APP_DIR=/opt/quality-board
DATA_DIR=/var/lib/quality-board
SERVICE_USER=quality
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVICE_SRC="$SRC_DIR/deploy/quality-board.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "错误：请使用 root 或 sudo 执行本脚本" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node，请先安装 Node.js 20 及以上版本" >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "错误：需要 Node.js 20 及以上，当前为 $(node -v)" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未找到 npm" >&2
  exit 1
fi

echo ">>> 创建运行用户 $SERVICE_USER"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo ">>> 创建目录"
mkdir -p "$APP_DIR/public"
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/product-images"

echo ">>> 复制应用文件到 $APP_DIR"
cp "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" \
   "$SRC_DIR/server.js" "$SRC_DIR/kv.js" "$SRC_DIR/mes.js" \
   "$SRC_DIR/ai-analysis.js" "$SRC_DIR/version-hub.js" \
   "$APP_DIR/"

echo ">>> 安装生产依赖"
cd "$APP_DIR"
npm ci --omit=dev --registry=https://registry.npmjs.org/
npm cache clean --force

echo ">>> 设置权限"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR"

echo ">>> 安装 systemd 服务"
install -m 644 "$SERVICE_SRC" /etc/systemd/system/quality-board.service
systemctl daemon-reload
systemctl enable quality-board
systemctl restart quality-board

echo ">>> 等待服务启动"
sleep 3
if systemctl is-active --quiet quality-board; then
  echo "✅ 服务已启动"
  echo "   访问：http://127.0.0.1:3000/"
  echo "   日志：journalctl -u quality-board -f"
  echo "   数据目录：$DATA_DIR"
else
  echo "❌ 服务启动失败，请查看日志：journalctl -u quality-board -n 50 --no-pager" >&2
  exit 1
fi
