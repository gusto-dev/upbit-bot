"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeleBot = void 0;
const node_fetch_1 = __importDefault(require("node-fetch"));
class TeleBot {
    constructor(token, chatId) {
        this.token = token;
        this.chatId = chatId;
    }
    async send(msg) {
        if (!this.token || !this.chatId)
            return;
        try {
            await (0, node_fetch_1.default)(`https://api.telegram.org/bot${this.token}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.chatId,
                    text: msg,
                    parse_mode: "HTML",
                }),
            });
        }
        catch { }
    }
}
exports.TeleBot = TeleBot;
//# sourceMappingURL=telebot.js.map