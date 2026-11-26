# 部署到你自己的服务器

目标：Ubuntu / Debian 等 Linux 服务器（x86_64），域名已解析到该服务器，最终通过
`https://你的域名` 访问，数据持久保存。

两种方式二选一，**不要同时装**。

---

## 一、准备（两种方式都要做）

在本地把项目传到服务器：

```bash
# 在你自己的电脑上，项目目录内执行
rsync -avz --exclude node_modules --exclude .git --exclude 'data.db*' \
  ./ root@你的服务器IP:/opt/quality-board-src/
```

或者用 git clone，能把代码拉到服务器上即可。

登录服务器后，先把域名 A 记录确认指向本机，并放行 80 / 443：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# 云服务器还需要在控制台的安全组里放行 80、443
```

---

## 二、方式 A：Docker Compose（推荐）

```bash
# 1. 装 Docker（已装可跳过）
curl -fsSL https://get.docker.com | sudo sh

# 2. 构建并启动
cd /opt/quality-board-src
sudo docker compose up -d --build

# 3. 查看状态
sudo docker compose ps
sudo docker compose logs -f --tail=50
```

服务会监听 `127.0.0.1:3000`，只对本机开放，由 Nginx 转发。

数据保存在项目下的 `data/` 目录（数据库 `data.db`、上传文件在 `uploads/`、
产品图片在 `product-images/`）。**这个目录就是你的数据，务必纳入备份。**

---

## 三、方式 B：Node + systemd

```bash
# 1. 装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
node -v   # 应显示 v20.x

# 2. 一键安装
cd /opt/quality-board-src
sudo sh deploy/install-node.sh
```

脚本会：创建 `quality` 系统用户 → 复制代码到 `/opt/quality-board` →
安装生产依赖 → 数据目录设为 `/var/lib/quality-board` →
安装并启动 systemd 服务（开机自启、崩溃自动重启）。

常用命令：

```bash
sudo systemctl status quality-board
sudo systemctl restart quality-board
journalctl -u quality-board -f
```

---

## 四、配置 Nginx 与 HTTPS（两种方式通用）

```bash
sudo apt-get install -y nginx

# 1. 放入反向代理配置，替换其中的域名
sudo cp deploy/nginx.conf /etc/nginx/sites-available/quality-board.conf
sudo sed -i 's/your-domain.com/你的真实域名/g' /etc/nginx/sites-available/quality-board.conf
sudo ln -sf /etc/nginx/sites-available/quality-board.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 2. 检查并重载
sudo nginx -t && sudo systemctl reload nginx

# 3. 申请证书，certbot 会自动改写配置追加 443
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的真实域名
```

完成后访问 `https://你的域名`，用 `admin` / `admin123` 登录。

> 登录后请立刻在「用户管理」里修改管理员密码，默认密码仅用于首次初始化。

---

## 五、备份

数据全在这两个位置，定期打包即可：

| 方式 | 数据路径 |
|------|----------|
| Docker | `/opt/quality-board-src/data/` |
| systemd | `/var/lib/quality-board/` |

```bash
# 示例：每天备份一次（Docker 方式）
tar czf /root/backup-$(date +%F).tar.gz -C /opt/quality-board-src data
```

SQLite 使用 WAL 模式，备份时最好先停服务，或直接用 `sqlite3 data.db ".backup copy.db"`。
