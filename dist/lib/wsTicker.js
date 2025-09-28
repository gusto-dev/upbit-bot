"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpbitTickerFeed = void 0;
exports.toUpbitCode = toUpbitCode;
const ws_1 = __importDefault(require("ws"));
// Upbit WS: wss://api.upbit.com/websocket/v1 (binary), subscribe: [{ticket},{type:'ticker',codes:[...]}]
const WSS = "wss://api.upbit.com/websocket/v1";
// ccxt "BTC/KRW" → Upbit 코드 "KRW-BTC"
function toUpbitCode(ccxtSymbol) {
    const [base, quote] = ccxtSymbol.split("/");
    return `${quote}-${base}`; // KRW-BTC
}
class UpbitTickerFeed {
    constructor(codes) {
        this.ws = null;
        this.latest = new Map(); // code -> last trade price
        this.codes = [];
        this.alive = false;
        this.codes = codes;
    }
    get(code) {
        return this.latest.get(code);
    }
    connect() {
        this.ws = new ws_1.default(WSS);
        this.ws.binaryType = "arraybuffer";
        this.ws.on("open", () => {
            this.alive = true;
            const sub = [
                { ticket: `t-${Date.now()}` },
                { type: "ticker", codes: this.codes, isOnlyRealtime: true },
            ];
            this.ws?.send(Buffer.from(JSON.stringify(sub)));
        });
        this.ws.on("message", (buf) => {
            // message is binary(JSON string)
            try {
                const s = buf.toString();
                const j = JSON.parse(s);
                // j.code = "KRW-BTC", j.trade_price
                if (j && j.code && typeof j.trade_price === "number") {
                    this.latest.set(j.code, j.trade_price);
                }
            }
            catch {
                // ignore parse error (upbit sends binary frames; some envs need extra decode)
                try {
                    const text = new TextDecoder("utf-8").decode(buf);
                    const j = JSON.parse(text);
                    if (j && j.code && typeof j.trade_price === "number") {
                        this.latest.set(j.code, j.trade_price);
                    }
                }
                catch { }
            }
        });
        const ping = setInterval(() => {
            if (!this.alive)
                return;
            try {
                this.ws?.ping();
            }
            catch { }
        }, 15000);
        this.ws.on("close", () => {
            this.alive = false;
            clearInterval(ping);
            setTimeout(() => this.connect(), 2000);
        });
        this.ws.on("error", () => {
            this.alive = false;
            clearInterval(ping);
            try {
                this.ws?.close();
            }
            catch { }
        });
    }
}
exports.UpbitTickerFeed = UpbitTickerFeed;
//# sourceMappingURL=wsTicker.js.map