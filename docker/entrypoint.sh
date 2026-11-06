#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_DIR:-/config}"
DOWNLOADS_DIR="${DOWNLOADS_DIR:-/downloads}"
ARIA2_SECRET="${ARIA2_SECRET:-nas-media-downloader}"
BT_PORT="${BT_PORT:-51413}"

mkdir -p "$CONFIG_DIR"
if [ ! -d "$DOWNLOADS_DIR" ]; then
  echo "[entrypoint] 警告：$DOWNLOADS_DIR 不存在，请检查 docker-compose 的 volumes 挂载"
  mkdir -p "$DOWNLOADS_DIR"
fi

# ---------- 运行用户 ----------
RUN_AS=""
if [ -n "$PUID" ] && [ -n "$PGID" ]; then
  if ! id -u appuser >/dev/null 2>&1; then
    addgroup -g "$PGID" appgroup 2>/dev/null || true
    adduser -D -u "$PUID" -G appgroup appuser 2>/dev/null || adduser -D -u "$PUID" appuser 2>/dev/null || true
  fi
  RUN_AS="$PUID:$PGID"
  # 只接管配置目录，不动用户的下载盘
  chown -R "$PUID:$PGID" "$CONFIG_DIR" 2>/dev/null || true
fi

# ---------- tracker 列表 ----------
TRACKERS=""
if [ -s "$CONFIG_DIR/trackers.txt" ]; then
  TRACKERS=$(tr -d '\r' < "$CONFIG_DIR/trackers.txt" | tr '\n' ',' | sed 's/,$//')
else
  if curl -fsSL --max-time 20 "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt" -o "$CONFIG_DIR/trackers.txt" 2>/dev/null; then
    TRACKERS=$(tr -d '\r' < "$CONFIG_DIR/trackers.txt" | tr '\n' ',' | sed 's/,$//')
    echo "[entrypoint] tracker 列表已更新"
  elif [ -s /app/docker/trackers-default.txt ]; then
    cp /app/docker/trackers-default.txt "$CONFIG_DIR/trackers.txt"
    TRACKERS=$(tr -d '\r' < "$CONFIG_DIR/trackers.txt" | tr '\n' ',' | sed 's/,$//')
    echo "[entrypoint] 使用内置 tracker 列表"
  fi
fi

# ---------- aria2 配置 ----------
[ -f "$CONFIG_DIR/aria2.session" ] || : > "$CONFIG_DIR/aria2.session"

cat > "$CONFIG_DIR/aria2.conf" <<EOF
# 由 entrypoint 每次启动重新生成，如需自定义请改 docker-compose 中的环境变量
enable-rpc=true
rpc-allow-origin-all=true
rpc-listen-all=false
rpc-listen-port=6800
rpc-secret=${ARIA2_SECRET}
dir=${DOWNLOADS_DIR}
continue=true
file-allocation=none
disk-cache=64M
max-concurrent-downloads=6
max-connection-per-server=16
min-split-size=8M
split=16
check-integrity=true
auto-save-interval=30
save-session=${CONFIG_DIR}/aria2.session
save-session-interval=30
input-file=${CONFIG_DIR}/aria2.session
force-save=true
follow-torrent=true
listen-port=${BT_PORT}
bt-enable-lpd=true
enable-dht=true
enable-dht6=false
dht-listen-port=${BT_PORT}
bt-max-peers=128
bt-request-peer-speed-limit=50M
bt-save-metadata=true
bt-load-saved-metadata=true
bt-detach-seed-only=true
bt-tracker-connect-timeout=10
bt-tracker-timeout=10
seed-time=0
seed-ratio=0.0
user-agent=Transmission/2.94
peer-id-prefix=-TR2940-
peer-agent=Transmission/2.94
log=${CONFIG_DIR}/aria2.log
log-level=warn
EOF

if [ -n "$TRACKERS" ]; then
  echo "bt-tracker=${TRACKERS}" >> "$CONFIG_DIR/aria2.conf"
fi

echo "[entrypoint] 启动 aria2c（BT 端口 ${BT_PORT} TCP/UDP）"
if [ -n "$RUN_AS" ]; then
  su-exec "$RUN_AS" aria2c --conf-path="$CONFIG_DIR/aria2.conf" -D \
    || echo "[entrypoint] aria2 启动失败，可在设置里改用 qBittorrent"
else
  aria2c --conf-path="$CONFIG_DIR/aria2.conf" -D \
    || echo "[entrypoint] aria2 启动失败，可在设置里改用 qBittorrent"
fi

# ---------- Web 服务 ----------
cd /app
if [ -n "$RUN_AS" ]; then
  echo "[entrypoint] 以 UID=$PUID GID=$PGID 运行 Web 服务"
  exec su-exec "$RUN_AS" node server/index.js
fi
exec node server/index.js
