import fetch from "node-fetch";

type CmdHandler = (args: string[]) => Promise<string>;

export class TeleBot {
  constructor(private token: string, private chatId: string) {}
  async send(msg: string) {
    if (!this.token || !this.chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: msg,
          parse_mode: "HTML",
        }),
      });
    } catch {}
  }
}
