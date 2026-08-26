# ====== 通用：所有 Docker 平台 ======
# 注意：修改后需要重新 docker compose up -d

# 1) 媒体目录映射（修改左边本地路径即可）
# 常见路径：
#   群晖 Synology:  /volume1/video/Movies
#   威联通 QNAP:    /share/CACHEDEV1_DATA/Multimedia/Movies
#   Unraid:         /mnt/user/Media/Movies
#   OpenMediaVault: /srv/dev-disk-by-uuid-xxx/Media/Movies

# 2) 访问端口
#   默认 3000，如需修改直接改 ports 映射，例如 "8080:3000"
