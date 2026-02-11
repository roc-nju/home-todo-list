#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/home-todo-list"
DATA_DIR="/opt/home-todo"
IMAGE_NAME="home-todo:latest"
CONTAINER_NAME="home-todo"
PORT="5173"
SQLITE_FILE="$DATA_DIR/data.sqlite"
BASE_PATH="/home-todo"

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
if [ ! -f "$SQLITE_FILE" ]; then
  if [ -f "$DATA_DIR/data.json" ]; then
    sudo cp "$DATA_DIR/data.json" "$SQLITE_FILE"
  elif [ -f "$APP_DIR/data.json" ]; then
    sudo cp "$APP_DIR/data.json" "$SQLITE_FILE"
  else
    sudo touch "$SQLITE_FILE"
  fi
fi
sudo docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
sudo docker run -d --restart=always \
  --name "$CONTAINER_NAME" \
  -p 80:$PORT \
  -e PORT=$PORT \
  -e BASE_PATH=$BASE_PATH \
  -e STORE=sqlite \
  -e SQLITE_FILE=/app/data.sqlite \
  -v "$SQLITE_FILE:/app/data.sqlite" \
  "$IMAGE_NAME"

echo "更新完成"
