import fetch from "node-fetch";

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

export async function notify(msg: string) {
  if (!token || !chatId) {
    console.log("[NO-TELEGRAM]", msg);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    });
  } catch (e: any) {
    console.error("[TELEGRAM ERROR]", e.message);
  }
}
