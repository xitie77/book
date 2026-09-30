#!/usr/bin/env bash
# 夜读 · 一键部署（Linux / macOS）
# 用法：
#   ./deploy.sh              构建镜像并启动（监听 127.0.0.1:8080）
#   ./deploy.sh --port 9000  指定宿主机端口
#   ./deploy.sh --public     允许外部直接访问（默认只监听 127.0.0.1）
#   ./deploy.sh --logs       查看日志
#   ./deploy.sh --down       停止并移除容器（数据保留）
#   ./deploy.sh --restart    重启容器
set -euo pipefail

IMAGE="book:latest"
NAME="book"
PORT="8080"
HOST_BIND="127.0.0.1"
DATA_VOL="book-data"

cd "$(dirname "$0")"

# ---------- 读取 .env（若存在） ----------
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
: "${ADMIN_USERNAME:=wbx}"
: "${MAX_UPLOAD_MB:=50}"
if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "❌ 未设置管理员密码。请任选一种："
  echo "   1) cp .env.example .env ，然后编辑 .env 里的 ADMIN_PASSWORD"
  echo "   2) 直接：ADMIN_PASSWORD='你的密码' ./deploy.sh"
  exit 1
fi

# ---------- 参数 ----------
ACTION="up"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --public) HOST_BIND="0.0.0.0"; shift ;;
    --logs) ACTION="logs"; shift ;;
    --down) ACTION="down"; shift ;;
    --restart) ACTION="restart"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "❌ 未找到 docker，请先安装：curl -fsSL https://get.docker.com | sh"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker 守护进程未运行：sudo systemctl start docker"
    exit 1
  fi
}

case "$ACTION" in
  logs)  docker logs -f --tail 200 "$NAME" ;;
  down)  docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "✅ 已停止（数据卷 $DATA_VOL 保留）" ;;
  restart) docker restart "$NAME"; echo "✅ 已重启" ;;
esac
[[ "$ACTION" != "up" ]] && exit 0

need_docker

echo "==> 构建镜像 $IMAGE（首次约 1~3 分钟）"
docker build -t "$IMAGE" .

# 保留已有数据卷：仅在不存在时创建
docker volume inspect "$DATA_VOL" >/dev/null 2>&1 || docker volume create "$DATA_VOL" >/dev/null

echo "==> 启动容器（$HOST_BIND:$PORT -> 4000）"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${HOST_BIND}:${PORT}:4000" \
  -e PORT=4000 \
  -e MAX_UPLOAD_MB="$MAX_UPLOAD_MB" \
  -e ADMIN_USERNAME="$ADMIN_USERNAME" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -v "${DATA_VOL}:/app/server/data" \
  "$IMAGE" >/dev/null

echo -n "==> 等待健康检查"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo " ✅"
    echo
    echo "🎉 部署完成"
    echo "   本机地址：http://127.0.0.1:${PORT}"
    echo "   账号：${ADMIN_USERNAME}（密码见 .env / 你传入的 ADMIN_PASSWORD）"
    echo
    echo "下一步（对外访问）：把仓库里的 Caddyfile 复制到 /etc/caddy/Caddyfile 并 reload："
    echo "   sudo cp Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " ❌ 健康检查超时，查看日志："
docker logs --tail 50 "$NAME"
exit 1
