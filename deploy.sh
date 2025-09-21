#!/bin/bash
set -euo pipefail

APP_NAME="btc-bot"
BRANCH="${1:-main}"          # 기본 main, 필요시 ./deploy.sh develop 처럼 지정

echo "🚀 배포 시작: $APP_NAME (branch=$BRANCH)"

# 1) 최신 코드 동기화
echo "📥 Git pull..."
git fetch --all --prune
git reset --hard "origin/${BRANCH}"

# 2) 의존성 설치 (lock 기준, 깨끗하게)
echo "📦 npm ci..."
npm ci

# 3) 빌드
echo "🏗️ build..."
npm run build

# 4) PM2 시작/재시작 (빌드된 JS 실행)
echo "🔄 pm2 restart or start..."
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  # package.json의 start = node dist/bot.js 가정
  pm2 start "npm start" --name "$APP_NAME"
fi

# 5) 상태/로그
pm2 status "$APP_NAME"
echo "ℹ️ 최근 로그 보기: pm2 logs $APP_NAME --lines 100"

echo "✅ 배포 완료!"
