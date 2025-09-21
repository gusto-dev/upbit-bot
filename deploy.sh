#!/bin/bash
set -e

APP_NAME="btc-bot"

echo "🚀 배포 시작: $APP_NAME"

# 1) 최신 코드
echo "📥 Git pull..."
git fetch --all
git reset --hard origin/main

# 2) 의존성 설치 (개발 의존성 포함: 빌드 필요)
echo "📦 npm ci..."
npm ci

# 3) 빌드
echo "🏗️ build..."
npm run build

# 4) PM2 재시작 (dist 실행)
echo "🔄 pm2 restart..."
pm2 describe "$APP_NAME" >/dev/null 2>&1 \
  && pm2 restart "$APP_NAME" \
  || pm2 start "npm start" --name "$APP_NAME"

# 5) 상태 확인
pm2 status "$APP_NAME"

echo "✅ 배포 완료!"
