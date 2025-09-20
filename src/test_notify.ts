// tsx src/sniff_updates.ts
import "dotenv/config";
// @ts-ignore (Node18+면 주석 필요 없음)
const token = process.env.TELEGRAM_TOKEN!;
(async () => {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2)); // 여기서 chat.id / chat.type 확인
})();
