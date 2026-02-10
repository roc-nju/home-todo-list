#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/home-todo-list"
DATA_DIR="/opt/home-todo"
IMAGE_NAME="home-todo:latest"
CONTAINER_NAME="home-todo"
PORT="5173"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker 未安装，请先运行 ecs_onekey.sh"
  exit 1
fi

if [ ! -d "$APP_DIR" ]; then
  echo "未找到代码目录：$APP_DIR"
  exit 1
fi

git -C "$APP_DIR" pull
cd "$APP_DIR"
sudo docker build -t "$IMAGE_NAME" .
sudo mkdir -p "$DATA_DIR"
if [ ! -f "$DATA_DIR/data.json" ]; then
  sudo cp data.json "$DATA_DIR/data.json"
fi
sudo docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
sudo docker run -d --restart=always \
  --name "$CONTAINER_NAME" \
  -p 80:$PORT \
  -e PORT=$PORT \
  -v "$DATA_DIR/data.json:/app/data.json" \
  "$IMAGE_NAME"

echo "更新完成"
