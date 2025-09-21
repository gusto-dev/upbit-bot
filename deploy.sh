#!/bin/bash
set -euo pipefail

APP_NAME="btc-bot"
BRANCH="${1:-main}"

echo "🚀 배포 시작: $APP_NAME (branch=$BRANCH)"

echo "📥 Git pull..."
git fetch --all --prune
git reset --hard "origin/${BRANCH}"

echo "📦 npm ci..."
npm ci

echo "🔄 pm2 restart/start (tsx 실행)..."
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start "npm start" --name "$APP_NAME"
fi

pm2 status "$APP_NAME"
echo "ℹ️ 로그: pm2 logs $APP_NAME --lines 100"
echo "✅ 배포 완료!"
