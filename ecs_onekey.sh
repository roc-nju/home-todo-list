#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/home-todo-list"
DATA_DIR="/opt/home-todo"
IMAGE_NAME="home-todo:latest"
CONTAINER_NAME="home-todo"
PORT="5173"
REPO_URL="https://github.com/roc-nju/home-todo-list"

sudo apt update
sudo apt install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
sudo rm -f /etc/apt/keyrings/docker.gpg
curl -fsSL --retry 5 --retry-delay 2 --retry-connrefused https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker

if [ ! -d "$APP_DIR" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull
fi

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

echo "部署完成"
