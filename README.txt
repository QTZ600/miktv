质量管理系统 - 迁移部署说明
==============================

【环境要求】
- Node.js: v20.x（推荐 v20.20.2 或以上）
- 操作系统：Linux（Ubuntu/CentOS 均可）

【目录结构】
解压后目录中已包含：
- node_modules/     依赖包（无需执行 npm install）
- data.db           主数据库（含现有业务数据）
- quality-board.db  备用数据库
- .env              环境配置文件（迁移后需修改其中的路径）

【迁移步骤】

1. 解压压缩包到目标目录（建议 /opt/quality-board）：
   tar -xzf quality-board-full.tar.gz -C /opt/
   
   注意：如果解压到其他目录，请修改 .env 中的 DB_PATH 路径。

2. 修改 .env 中的 DB_PATH（如解压目录不同）：
   DB_PATH=/你的解压路径/data.db

3. 启动服务：

   方式一（直接启动）：
   cd /opt/quality-board
   node server.js

   方式二（PM2 守护进程，推荐生产环境）：
   npm install -g pm2
   cd /opt/quality-board
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup

【服务信息】
- 监听端口：3000（可在 .env 中修改 PORT 变量）
- 数据库路径：默认为解压目录下的 data.db（可在 .env 中修改 DB_PATH）
- 访问地址：http://服务器IP:3000

【注意事项】
- 迁移后如功能异常，检查 .env 中的飞书应用配置是否需要更新
- 数据库文件 data.db 包含全量业务数据，请妥善保管
- 如原服务仍在运行，迁移完成后记得停止旧服务
