// src/bot.ts
// Upbit multi-coin aggressive trader (single-file, TSX runtime).
// - Start: npm start  (package.json: "start": "tsx src/bot.ts")
// - Includes:
//   * WebSocket ticker guard (Upbit)
//   * Safe OHLCV normalization (ccxt Num -> number)
//   * Entry filters: EMA(20>60) + breakout(lookback)
//   * Market BUY by KRW cost (Upbit-specific via ccxt option)
//   * Market SELL with precision/min-notional guard + retry-friendly logic
//   * TP1/TP2 + BEP shift + trailing stop + hard stop
//   * Clear Telegram reasons on SELL skip/failure/dust
//   * Basic balance-vs-state mismatch warning on start

import "dotenv/config";
import ccxt from "ccxt";
import WebSocket from "ws";
import { EMA, MACD } from "technicalindicators";

// =============== ENV ===============
const MODE = (process.env.MODE || "live").toLowerCase(); // live | paper
const KILL_SWITCH =
  (process.env.KILL_SWITCH || "false").toLowerCase() === "true";

const TRADE_COINS = (process.env.TRADE_COINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SYMBOL_CCXT = process.env.SYMBOL_CCXT || "BTC/KRW";

const UPBIT_API_KEY = process.env.UPBIT_API_KEY || "";
const UPBIT_SECRET = process.env.UPBIT_SECRET || "";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const BASE_CAPITAL_KRW = num(process.env.BASE_CAPITAL_KRW, 500000);
const POS_PCT = num(process.env.POS_PCT, 0.12);
const LIVE_MIN_ORDER_KRW = num(process.env.LIVE_MIN_ORDER_KRW, 5000);

const ENTRY_SLIPPAGE_BPS = num(process.env.ENTRY_SLIPPAGE_BPS, 30); // 0.30%
const RETRY_MAX = num(process.env.RETRY_MAX, 2);

const BREAKOUT_LOOKBACK = num(process.env.BREAKOUT_LOOKBACK, 6);
const BREAKOUT_TOL_BPS = num(process.env.BREAKOUT_TOL_BPS, 15);
const USE_HIGH_BREAKOUT = bool(process.env.USE_HIGH_BREAKOUT, true);

const USE_REGIME_FILTER = bool(process.env.USE_REGIME_FILTER, true);
const REGIME_EMA_FAST = num(process.env.REGIME_EMA_FAST, 20);
const REGIME_EMA_SLOW = num(process.env.REGIME_EMA_SLOW, 60);
const USE_MACD_CONFIRM = bool(process.env.USE_MACD_CONFIRM, false);
const MACD_FAST = num(process.env.MACD_FAST, 12);
const MACD_SLOW = num(process.env.MACD_SLOW, 26);
const MACD_SIGNAL = num(process.env.MACD_SIGNAL, 9);

const STOP_LOSS = num(process.env.STOP_LOSS, -0.012); // -1.2%
const TP1 = num(process.env.TP1, 0.012); // +1.2%
const TP2 = num(process.env.TP2, 0.022); // +2.2%
const TRAIL = num(process.env.TRAIL, -0.015); // -1.5% from peak
const USE_BEP_AFTER_TP1 = bool(process.env.USE_BEP_AFTER_TP1, true);
const BEP_OFFSET_BPS = num(process.env.BEP_OFFSET_BPS, 0);

const MAX_TRADES_PER_DAY = num(process.env.MAX_TRADES_PER_DAY, 4);
const MAX_CONCURRENT_POSITIONS = num(process.env.MAX_CONCURRENT_POSITIONS, 3);
const QUIET_HOUR_START = num(process.env.QUIET_HOUR_START, 2);
const QUIET_HOUR_END = num(process.env.QUIET_HOUR_END, 6);

const TF = process.env.TF || "5m";
const LOOKBACK = num(process.env.LOOKBACK, 600);

const LOOP_DELAY_MS = 1500;

// =============== HELPERS ===============
function num(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function bool(v: any, d: boolean) {
  const s = String(v || "").toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return d;
}
const nowKST = () => new Date(Date.now() + 9 * 3600 * 1000);
const hourKST = () => nowKST().getUTCHours();

type NumT = number | undefined | null;
const asNum = (v: NumT): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

type OHLCVRow = [number, number, number, number, number, number];
function normalizeOHLCV(rows: any[]): OHLCVRow[] {
  return rows
    .map(
      (r) =>
        [
          asNum(r[0]),
          asNum(r[1]),
          asNum(r[2]),
          asNum(r[3]),
          asNum(r[4]),
          asNum(r[5]),
        ] as OHLCVRow
    )
    .filter((r) => r[4] > 0);
}
function bps(from: number, to: number) {
  return (to / from - 1) * 10000;
}

// precision & min-notional helpers
function floorToPrecision(v: number, step?: number) {
  if (!step || step <= 0) return v;
  return Math.floor(v / step) * step;
}
async function getAmountStep(symbol: string): Promise<number | undefined> {
  try {
    const m =
      exchange.markets[symbol] || (await exchange.loadMarkets())[symbol];
    if (!m) return undefined;
    if (m.precision && typeof m.precision.amount === "number") {
      const p = m.precision.amount; // e.g., 6 -> 0.000001
      return Number((1 / Math.pow(10, p)).toFixed(p));
    }
    return m.limits?.amount?.min ?? undefined;
  } catch {
    return undefined;
  }
}

// =============== TELEGRAM ===============
async function tg(text: string) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    // Node 18+ has global fetch; if not, install node-fetch and import.
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch {}
}

// =============== WS TICKER (Upbit) ===============
const WSS = "wss://api.upbit.com/websocket/v1";
function toUpbitCode(ccxtSymbol: string) {
  const [base, quote] = ccxtSymbol.split("/");
  return `${quote}-${base}`; // KRW-BTC
}
class UpbitTickerFeed {
  private ws: WebSocket | null = null;
  private latest = new Map<string, number>(); // code -> trade_price
  private codes: string[];
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
    this.ws.on("message", (buf: WebSocket.RawData) => {
      try {
        const s = buf.toString();
        const j = JSON.parse(s);
        if (j && j.code && typeof j.trade_price === "number")
          this.latest.set(j.code, j.trade_price);
      } catch {
        try {
          const text = new TextDecoder().decode(buf as Buffer);
          const j = JSON.parse(text);
          if (j && j.code && typeof j.trade_price === "number")
            this.latest.set(j.code, j.trade_price);
        } catch {}
      }
    });
    const ping = setInterval(() => {
      if (this.alive) {
        try {
          this.ws?.ping();
        } catch {}
      }
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

// =============== EXCHANGE ===============
const exchange = new ccxt.upbit({
  apiKey: UPBIT_API_KEY,
  secret: UPBIT_SECRET,
  enableRateLimit: true,
  options: {
    adjustForTimeDifference: true,
    // allow market buy by KRW cost (Upbit-specific)
    createMarketBuyOrderRequiresPrice: false,
  },
});

// =============== STATE ===============
type Pos = {
  entry: number;
  size: number; // base amount
  invested: number; // KRW
  peak: number;
  tookTP1: boolean;
  openedAt: number;
  bePrice?: number;
};
const positions = new Map<string, Pos>();
const tradesToday = new Map<string, number>();
let paused = false;

function allocKRW() {
  return Math.floor(BASE_CAPITAL_KRW * POS_PCT);
}
function canEnter(symbol: string) {
  if (paused) return false;
  const h = hourKST();
  const quiet =
    QUIET_HOUR_START <= QUIET_HOUR_END
      ? h >= QUIET_HOUR_START && h < QUIET_HOUR_END
      : h >= QUIET_HOUR_START || h < QUIET_HOUR_END;
  if (quiet) return false;
  if (positions.size >= MAX_CONCURRENT_POSITIONS) return false;
  const n = tradesToday.get(symbol) || 0;
  if (n >= MAX_TRADES_PER_DAY) return false;
  return true;
}
function incTrade(symbol: string) {
  tradesToday.set(symbol, (tradesToday.get(symbol) || 0) + 1);
}

// =============== INDICATORS ===============
function ema(values: number[], period: number) {
  return EMA.calculate({ values, period });
}
function macdHist(values: number[]) {
  const r = MACD.calculate({
    values,
    fastPeriod: MACD_FAST,
    slowPeriod: MACD_SLOW,
    signalPeriod: MACD_SIGNAL,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  if (!r.length) return 0;
  const last = r[r.length - 1];
  const h =
    last && typeof last.histogram === "number" ? (last.histogram as number) : 0;
  return h;
}
function regimeOK(closes: number[]) {
  if (!USE_REGIME_FILTER) return true;
  const ef = ema(closes, REGIME_EMA_FAST);
  const es = ema(closes, REGIME_EMA_SLOW);
  if (!ef.length || !es.length) return false;
  const lastFast = ef[ef.length - 1]!;
  const lastSlow = es[es.length - 1]!;
  if (!(lastFast > lastSlow)) return false;
  if (USE_MACD_CONFIRM && !(macdHist(closes) > 0)) return false;
  return true;
}
function breakoutOK(ohlcv: OHLCVRow[]) {
  const n = ohlcv.length;
  if (n < BREAKOUT_LOOKBACK + 2) return false;
  const highs = ohlcv.map((r) => r[2]);
  const last = ohlcv[n - 1]!;
  const priorSlice = highs.slice(n - 1 - BREAKOUT_LOOKBACK, n - 1);
  if (!priorSlice.length) return false;
  const priorHigh = Math.max(...priorSlice);
  const tol = priorHigh * (BREAKOUT_TOL_BPS / 10000);
  const closeOK = last[4] >= priorHigh - tol;
  const highOK = USE_HIGH_BREAKOUT ? last[2] >= priorHigh - tol : false;
  return closeOK || highOK;
}

// =============== ORDERS ===============
async function marketBuy(symbol: string, krw: number, pxGuide: number) {
  if (krw < LIVE_MIN_ORDER_KRW)
    return { ok: false, reason: "below-min" as const };
  if (MODE === "paper" || KILL_SWITCH)
    return { ok: true, paper: true, amount: krw / pxGuide };
  try {
    const params: any = { cost: krw }; // Upbit market buy by KRW cost
    const o = await exchange.createOrder(
      symbol,
      "market",
      "buy",
      undefined,
      undefined,
      params
    );
    const filledAmount = (o as any).amount ?? krw / pxGuide;
    return { ok: true, id: o.id, amount: filledAmount };
  } catch (e: any) {
    try {
      const qty = krw / pxGuide;
      const o2 = await exchange.createOrder(
        symbol,
        "market",
        "buy",
        qty,
        undefined,
        { cost: krw }
      );
      return { ok: true, id: o2.id, amount: (o2 as any).amount ?? qty };
    } catch (e2: any) {
      return { ok: false, reason: e2?.message || e?.message || "buy-failed" };
    }
  }
}

async function marketSell(symbol: string, amount: number) {
  if (amount <= 0) return { ok: false, reason: "zero-amount" as const };
  if (MODE === "paper" || KILL_SWITCH) return { ok: true, paper: true };
  try {
    const step = await getAmountStep(symbol);
    const amt = floorToPrecision(amount, step);
    if (amt <= 0)
      return { ok: false, reason: "precision-trim-to-zero" as const };
    const o = await exchange.createOrder(symbol, "market", "sell", amt);
    return { ok: true, id: o.id };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "sell-failed" };
  }
}

async function reconcile(symbol: string) {
  try {
    const open = await exchange.fetchOpenOrders(symbol);
    if (open.length) await tg(`⏳ 미체결 주문 감지: ${symbol} x${open.length}`);
  } catch {}
}

// =============== RUNNER ===============
async function runner(symbol: string, feed: UpbitTickerFeed) {
  await tg(`▶️ 시작: ${symbol} | MODE=${MODE} | paused=${paused}`);
  while (true) {
    try {
      await reconcile(symbol);

      // Candles
      const raw = await exchange.fetchOHLCV(symbol, TF, undefined, LOOKBACK);
      const ohlcv = normalizeOHLCV(raw);
      if (!ohlcv.length) {
        await sleep(3000);
        continue;
      }

      const closes = ohlcv.map((r) => r[4]);
      const last = ohlcv[ohlcv.length - 1]!;
      const lastPx = last[4];

      // Price
      const code = toUpbitCode(symbol);
      const wsPx = feed.get(code) ?? lastPx;

      const pos = positions.get(symbol);

      if (pos) {
        // ---- TP ladder ----
        if (!pos.tookTP1 && wsPx >= pos.entry * (1 + TP1)) {
          const step = await getAmountStep(symbol);
          let amt = floorToPrecision(pos.size * 0.3, step);
          if (amt <= 0 || amt * wsPx < LIVE_MIN_ORDER_KRW) {
            await tg(
              `⚠️ TP1 스킵 ${symbol} | 최소금액/정밀도 미달 (amt≈${amt.toFixed(
                8
              )}, KRW≈${Math.round(amt * wsPx)})`
            );
          } else {
            const r = await marketSell(symbol, amt);
            if (r.ok) {
              pos.size -= amt;
              pos.tookTP1 = true;
              if (USE_BEP_AFTER_TP1)
                pos.bePrice = pos.entry * (1 + BEP_OFFSET_BPS / 10000);
              await tg(
                `🟢 TP1 ${symbol} | +${(TP1 * 100).toFixed(2)}% | ${amt.toFixed(
                  6
                )} 청산 | 남은 ${pos.size.toFixed(6)}`
              );
            } else {
              await tg(
                `❗ TP1 매도 실패 ${symbol} | ${
                  r.reason || "unknown"
                } (보유 유지 후 재시도)`
              );
            }
          }
        } else if (wsPx >= pos.entry * (1 + TP2)) {
          const step = await getAmountStep(symbol);
          let amt = floorToPrecision(pos.size * 0.3, step);
          if (amt <= 0 || amt * wsPx < LIVE_MIN_ORDER_KRW) {
            await tg(
              `⚠️ TP2 스킵 ${symbol} | 최소금액/정밀도 미달 (amt≈${amt.toFixed(
                8
              )}, KRW≈${Math.round(amt * wsPx)})`
            );
          } else {
            const r = await marketSell(symbol, amt);
            if (r.ok) {
              pos.size -= amt;
              await tg(
                `🟢 TP2 ${symbol} | +${(TP2 * 100).toFixed(2)}% | ${amt.toFixed(
                  6
                )} 청산 | 남은 ${pos.size.toFixed(6)}`
              );
            } else {
              await tg(
                `❗ TP2 매도 실패 ${symbol} | ${
                  r.reason || "unknown"
                } (보유 유지 후 재시도)`
              );
            }
          }
        }

        // ---- trailing & stops ----
        pos.peak = Math.max(pos.peak, wsPx);
        const trailLine = pos.peak * (1 + TRAIL);
        const hardSL = pos.entry * (1 + STOP_LOSS);
        const dynSL = pos.bePrice ?? hardSL;
        const stopLine = Math.max(dynSL, trailLine);

        if (wsPx <= stopLine || pos.size <= 0) {
          const step = await getAmountStep(symbol);
          let amt = floorToPrecision(pos.size, step);

          if (amt <= 0) {
            await tg(`⚠️ EXIT 보류 ${symbol} | 정밀도 보정 결과 수량 0`);
            await sleep(LOOP_DELAY_MS);
            continue;
          }
          if (amt * wsPx < LIVE_MIN_ORDER_KRW) {
            await tg(
              `⚠️ EXIT 불가(먼지) ${symbol} | 가치≈${Math.round(
                amt * wsPx
              )} KRW < ${LIVE_MIN_ORDER_KRW} KRW`
            );
            await sleep(LOOP_DELAY_MS);
            continue; // keep position; retry later
          }

          const r = await marketSell(symbol, amt);
          if (r.ok) {
            const pnl = (wsPx / pos.entry - 1) * 100;
            await tg(
              `🔴 EXIT ${symbol} | ${Math.round(pos.entry)} → ${Math.round(
                wsPx
              )} | ${pnl.toFixed(2)}%`
            );
            positions.delete(symbol);
          } else {
            await tg(
              `❗ EXIT 매도 실패 ${symbol} | ${
                r.reason || "unknown"
              } | 재시도 대기`
            );
            // keep position for retry
          }

          await sleep(LOOP_DELAY_MS);
          continue;
        }

        await sleep(LOOP_DELAY_MS);
        continue;
      }

      // ---- Entry ----
      if (!canEnter(symbol)) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }
      const okRegime = regimeOK(closes);
      const okBreakout = breakoutOK(ohlcv);
      if (!(okRegime && okBreakout)) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      const drift = Math.abs(bps(lastPx, wsPx));
      if (drift > ENTRY_SLIPPAGE_BPS) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      const alloc = allocKRW();
      if (alloc < LIVE_MIN_ORDER_KRW) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      const buy = await marketBuy(symbol, alloc, wsPx);
      if (!buy.ok) {
        await tg(`⚠️ BUY 실패 ${symbol} | ${buy.reason}`);
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      const size =
        MODE === "paper" || KILL_SWITCH
          ? alloc / wsPx
          : (buy as any).amount ?? alloc / wsPx;
      const p: Pos = {
        entry: wsPx,
        size,
        invested: alloc,
        peak: wsPx,
        tookTP1: false,
        openedAt: Date.now(),
      };
      positions.set(symbol, p);
      incTrade(symbol);
      await tg(
        `🟩 ENTRY ${symbol} | 진입 ${Math.round(
          p.entry
        )} | 수량 ${p.size.toFixed(6)} | 배분 ${alloc.toLocaleString()} KRW`
      );

      await sleep(LOOP_DELAY_MS);
    } catch (e: any) {
      await tg(`⚠️ 루프 에러 ${symbol}: ${e?.message || e}`);
      await sleep(4000);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// =============== MAIN ===============
async function main() {
  const symbols = TRADE_COINS.length ? TRADE_COINS : [SYMBOL_CCXT];
  const codes = symbols.map(toUpbitCode);
  const feed = new UpbitTickerFeed(codes);
  feed.connect();

  await tg(
    `🚀 BOT START | MODE=${MODE} | symbols=${symbols.join(
      ", "
    )} | TF=${TF} | paused=${paused}`
  );

  // Balance vs state mismatch warning (read-only)
  try {
    const bal = await exchange.fetchBalance();
    for (const s of symbols) {
      const base = s.split("/")[0];
      const qty = (bal.total?.[base] as number) || 0;
      if (qty > 0 && !positions.has(s)) {
        await tg(
          `⚠️ 잔고-상태 불일치: ${s} 보유≈${qty} (봇 내부 포지션 없음). 수동 확인 권장.`
        );
      }
    }
  } catch {}

  symbols.forEach((s) => {
    runner(s, feed);
  });

  process.on("SIGINT", async () => {
    await tg("👋 종료(SIGINT)");
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await tg("👋 종료(SIGTERM)");
    process.exit(0);
  });
}

main().catch(async (e) => {
  await tg(`❌ FATAL: ${e?.message || e}`);
  process.exit(1);
});
