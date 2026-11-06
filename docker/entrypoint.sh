#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_DIR:-/config}"
DOWNLOADS_DIR="${DOWNLOADS_DIR:-/downloads}"
ARIA2_SECRET="${ARIA2_SECRET:-nas-media-downloader}"
BT_PORT="${BT_PORT:-51413}"
CONF="${CONFIG_DIR}/aria2.conf"
PIDFILE="${CONFIG_DIR}/aria2.pid"
STOPFILE="${CONFIG_DIR}/.stopping"
STDOUT_LOG="${CONFIG_DIR}/aria2.stdout.log"

mkdir -p "$CONFIG_DIR"
rm -f "$STOPFILE"
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
DHT6="${ENABLE_DHT6:-false}"
case "$DHT6" in
  1|true|yes|on) DHT6=true ;;
  *) DHT6=false ;;
esac

gen_conf() {
  cat > "$CONF" <<EOF
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
# 会话落在持久化目录：容器更新/重建后任务列表靠它恢复
save-session=${CONFIG_DIR}/aria2.session
save-session-interval=30
input-file=${CONFIG_DIR}/aria2.session
force-save=true
follow-torrent=true
listen-port=${BT_PORT}
# DHT 路由表必须落在可写的挂载目录，否则加载失败 DHT 起不来，磁力一个 peer 都找不到
dht-file-path=${CONFIG_DIR}/aria2.dht.dat
bt-enable-lpd=true
enable-dht=true
enable-dht6=$1
dht-listen-port=${BT_PORT}
bt-max-peers=128
bt-request-peer-speed-limit=5M
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
log-level=notice
EOF
  if [ "$1" = "true" ]; then
    cat >> "$CONF" <<EOF
# IPv6 DHT 用独立端口，避免和 IPv4 DHT 抢同一个 UDP 端口导致 aria2 启动即退出
dht-file-path6=${CONFIG_DIR}/aria2.dht6.dat
dht-listen-port6=$((BT_PORT + 1))
EOF
  fi
  if [ -n "$TRACKERS" ]; then
    echo "bt-tracker=${TRACKERS}" >> "$CONF"
  fi
}

rpc_call() {
  curl -fsS --max-time 3 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"entrypoint\",\"method\":\"$1\",\"params\":[\"token:${ARIA2_SECRET}\"]}" \
    http://127.0.0.1:6800/jsonrpc >/dev/null 2>&1
}

aria2_pid() {
  cat "$PIDFILE" 2>/dev/null || echo ""
}

# aria2 不再用 -D 后台模式：前台进程挂在监督循环里，
# 退出（配置错误 / 崩溃）都会被 wait 捕获并自动拉起，也不会留下僵尸进程。
start_supervisor() {
  rm -f "$STOPFILE"
  (
    while [ ! -f "$STOPFILE" ]; do
      if [ -n "$RUN_AS" ]; then
        su-exec "$RUN_AS" aria2c --conf-path="$CONF" >> "$STDOUT_LOG" 2>&1 &
      else
        aria2c --conf-path="$CONF" >> "$STDOUT_LOG" 2>&1 &
      fi
      pid=$!
      echo "$pid" > "$PIDFILE"
      wait "$pid" 2>/dev/null || true
      [ -f "$STOPFILE" ] && exit 0
      echo "[entrypoint] aria2 退出，3 秒后自动重启" >&2
      sleep 3
    done
  ) &
  SUP_PID=$!
}

wait_ready() {
  i=0
  while [ "$i" -lt 12 ]; do
    if rpc_call aria2.getVersion; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

stop_supervisor() {
  : > "$STOPFILE"
  pid=$(aria2_pid)
  if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  kill -TERM "$SUP_PID" 2>/dev/null || true
  sleep 1
}

echo "[entrypoint] 启动 aria2c（BT 端口 ${BT_PORT} TCP/UDP）"
gen_conf "$DHT6"
start_supervisor

# 启动即失败以前会被 -D 静默吞掉，这里主动探测 RPC；失败则自动降级重试
if ! wait_ready; then
  echo "[entrypoint] aria2 未就绪，请查看 ${CONFIG_DIR}/aria2.log"
  stop_supervisor
  if [ "$DHT6" = "true" ]; then
    echo "[entrypoint] 自动关闭 IPv6 DHT 后重试（部分环境不支持该配置）"
    DHT6=false
    gen_conf "$DHT6"
  fi
  start_supervisor
  if wait_ready; then
    echo "[entrypoint] aria2 已就绪（IPv6 DHT 已自动关闭）"
  else
    echo "[entrypoint] 警告：aria2 仍不可用，下载功能会提示离线；监督进程会继续重试"
  fi
else
  echo "[entrypoint] aria2 已就绪（IPv6 DHT: ${DHT6}）"
fi

# ---------- Web 服务 ----------
cd /app
if [ -n "$RUN_AS" ]; then
  echo "[entrypoint] 以 UID=$PUID GID=$PGID 运行 Web 服务"
  su-exec "$RUN_AS" node server/index.js &
else
  node server/index.js &
fi
WEB_PID=$!

# 容器停止时先让 aria2 落盘会话再退出，否则任务列表会在更新后丢失
stop() {
  : > "$STOPFILE"
  echo "[entrypoint] 正在停止，保存下载会话…"
  rpc_call aria2.saveSession || true
  pid=$(aria2_pid)
  if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  kill -TERM "$WEB_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap stop TERM INT

wait "$WEB_PID"
