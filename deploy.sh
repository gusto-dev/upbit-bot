#!/bin/bash
set -e

APP_NAME="btc-bot"

echo "🚀 배포 시작: $APP_NAME"

# 1. 최신 코드 가져오기
echo "📥 Git pull..."
git fetch --all
git reset --hard origin/main

# 2. 패키지 업데이트
echo "📦 npm install..."
npm install --production

# 3. pm2 재시작
echo "🔄 pm2 restart..."
pm2 restart $APP_NAME || pm2 start src/step8_live_trader.ts --name $APP_NAME --interpreter tsx

# 4. 상태 확인
pm2 status $APP_NAME

echo "✅ 배포 완료!"