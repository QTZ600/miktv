#!/usr/bin/env bash
# 一键恢复脚本：沙箱新会话后执行一次即可启动质量管理系统
# 用法：cd /workspace && bash setup.sh
set -euo pipefail

echo ">>> 检查环境..."
node -v | head -1

echo ">>> 安装依赖..."
if [ ! -d "node_modules" ]; then
  npm install
else
  echo "node_modules 已存在，跳过 npm install"
fi

echo ">>> 创建 .env..."
if [ ! -f ".env" ]; then
  cat > .env << 'EOF'
PORT=3000
DB_PATH=/workspace/data.db
ADMIN_INITIAL_USERNAME=admin
ADMIN_INITIAL_PASSWORD=admin123
EOF
  echo ".env 已创建"
else
  echo ".env 已存在，跳过"
fi

echo ">>> 清理孤儿 WAL（如有）..."
[ -f data.db-wal ] && rm -f data.db data.db-wal data.db-shm db-export.json || true

echo ">>> 启动服务..."
# 停掉可能存在的旧进程（同端口）
PIDS=$(ss -tlnp 2>/dev/null | grep ':3000' | grep -oP 'pid=\K[0-9]+' | sort -u || true)
for pid in $PIDS; do
  echo "停掉旧进程 PID=$pid"
  kill "$pid" 2>/dev/null && sleep 1 || true
done

# 后台启动
nohup node server.js > /tmp/quality-board.log 2>&1 &
SERVER_PID=$!
echo "服务 PID=$SERVER_PID"
echo "$SERVER_PID" > /tmp/quality-board.pid

# 等它起来
for i in $(seq 1 15); do
  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/ ; then
    echo
    echo "✅ 服务已就绪，访问 http://localhost:3000/"
    echo "   管理员账号: admin / admin123"
    exit 0
  fi
  sleep 1
done

echo "❌ 启动超时，日志："
cat /tmp/quality-board.log
exit 1
