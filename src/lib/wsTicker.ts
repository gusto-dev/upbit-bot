import WebSocket from "ws";

// Upbit WS: wss://api.upbit.com/websocket/v1 (binary), subscribe: [{ticket},{type:'ticker',codes:[...]}]
const WSS = "wss://api.upbit.com/websocket/v1";

// ccxt "BTC/KRW" → Upbit 코드 "KRW-BTC"
export function toUpbitCode(ccxtSymbol: string) {
  const [base, quote] = ccxtSymbol.split("/");
  return `${quote}-${base}`; // KRW-BTC
}

export class UpbitTickerFeed {
  private ws: WebSocket | null = null;
  private latest = new Map<string, number>(); // code -> last trade price
  private codes: string[] = [];
  private alive = false;

  constructor(codes: string[]) {
    this.codes = codes;
  }

  get(code: string) {
    return this.latest.get(code);
  }

  connect() {
    this.ws = new WebSocket(WSS);
    this.ws.binaryType = "arraybuffer";

    this.ws.on("open", () => {
      this.alive = true;
      const sub = [
        { ticket: `t-${Date.now()}` },
        { type: "ticker", codes: this.codes, isOnlyRealtime: true },
      ];
      this.ws?.send(Buffer.from(JSON.stringify(sub)));
    });

    this.ws.on("message", (buf: Buffer) => {
      // message is binary(JSON string)
      try {
        const s = buf.toString();
        const j = JSON.parse(s);
        // j.code = "KRW-BTC", j.trade_price
        if (j && j.code && typeof j.trade_price === "number") {
          this.latest.set(j.code, j.trade_price);
        }
      } catch {
        // ignore parse error (upbit sends binary frames; some envs need extra decode)
        try {
          const text = new TextDecoder("utf-8").decode(buf);
          const j = JSON.parse(text);
          if (j && j.code && typeof j.trade_price === "number") {
            this.latest.set(j.code, j.trade_price);
          }
        } catch {}
      }
    });

    const ping = setInterval(() => {
      if (!this.alive) return;
      try {
        this.ws?.ping();
      } catch {}
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
      } catch {}
    });
  }
}
