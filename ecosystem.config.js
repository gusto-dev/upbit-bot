module.exports = {
  apps: [
    {
      name: "btc-bot",
      cwd: "/home/ubuntu/upbit-bot", // <- 프로젝트 절대경로로 맞추기
      script: "dist/bot.js", // <- 빌드 산출물 실행 (권장)
      env_file: ".env", // <- 여기서 .env를 로드
      node_args: ["--enable-source-maps"], // 선택
      max_restarts: 20,
      restart_delay: 3000,
      watch: false,
    },
  ],
};
