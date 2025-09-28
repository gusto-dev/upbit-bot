// src/bot.ts
// Upbit multi-coin aggressive trader (TSX runtime, no build).
// - .env를 'dotenv' 패키지 없이 직접 로드(경량 로더).
// - 보유중이면 신규매수 스킵, 지갑 잔고 기준 매도(정밀도/최소금액 체크).
// - TP1/TP2 + BEP + 트레일 + 고정 손절 + 강제 손절(FORCE_EXIT_DD_BPS).
// - Upbit 시장가 매수는 KRW cost 방식(ccxt option) 사용.
// - 텔레그램 전송 실패는 콘솔에 이유 출력.

import fs from "fs";
import path from "path";
import ccxt from "ccxt";
import WebSocket from "ws";
import { EMA, MACD } from "technicalindicators";

// =============== .env 경량 로더 (dotenv 대체) ===============
(function loadEnv() {
  try {
    const p = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(p)) return;
    const txt = fs.readFileSync(p, "utf8");
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
})();

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
const TRAIL = num(process.env.TRAIL, -0.015); // 피크 대비 -1.5%
const USE_BEP_AFTER_TP1 = bool(process.env.USE_BEP_AFTER_TP1, true);
const BEP_OFFSET_BPS = num(process.env.BEP_OFFSET_BPS, 0);

const MAX_TRADES_PER_DAY = num(process.env.MAX_TRADES_PER_DAY, 4);
const MAX_CONCURRENT_POSITIONS = num(process.env.MAX_CONCURRENT_POSITIONS, 3);
const QUIET_HOUR_START = num(process.env.QUIET_HOUR_START, 2);
const QUIET_HOUR_END =
  num(
    process.env.QUI_HOUR_END,
    Number.isFinite(Number(process.env.QUIET_HOUR_END))
      ? Number(process.env.QUIET_HOUR_END)
      : 6
  ) || 6; // 안전

const TF = process.env.TF || "5m";
const LOOKBACK = num(process.env.LOOKBACK, 600);

const ENTRY_SKIP_IF_WALLET = bool(process.env.ENTRY_SKIP_IF_WALLET, true);
const ENTRY_WALLET_MIN_KRW = num(
  process.env.ENTRY_WALLET_MIN_KRW,
  LIVE_MIN_ORDER_KRW
);

const FORCE_EXIT_DD_BPS = Number(process.env.FORCE_EXIT_DD_BPS ?? "0"); // 예:-500 -> -5%

const LOOP_DELAY_MS = 1500;

const DUST_KRW_MIN = 3000;

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

function getBalanceTotal(bal: any, base: string): number {
  try {
    const t = (bal?.total ?? {}) as Record<string, number>;
    const v = Number(t[base] ?? 0);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
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

// wallet helpers
async function getWalletBaseAmount(symbol: string): Promise<number> {
  try {
    const base = symbol.split("/")[0];
    const bal = await exchange.fetchBalance();
    const q = getBalanceTotal(bal, base);
    return Number.isFinite(q) ? q : 0;
  } catch {
    return 0;
  }
}

// =============== TELEGRAM ===============
async function tg(text: string) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("TG disabled: missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" };

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000); // 5s timeout

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!res.ok) {
      const j = await res.text().catch(() => "");
      console.error("TG send failed:", res.status, j);
    }
  } catch (e: any) {
    clearTimeout(to);
    console.error("TG error:", e?.message || e);
  }
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
  size: number; // 내부 추적 수량
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
  const lastSlow = es[ef.length - 1]!;
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
    // ✅ Upbit/ccxt: amount 자리에 "지출할 KRW"를 넣는다 (price 생략)
    const o = await exchange.createOrder(symbol, "market", "buy", krw);
    const filledAmount = (o as any).amount ?? krw / pxGuide; // 체결된 베이스 수량
    return { ok: true, id: o.id, amount: filledAmount };
  } catch (e: any) {
    // 폴백: 견적가로 수량을 계산해 시도
    try {
      const qty = krw / pxGuide;
      const o2 = await exchange.createOrder(symbol, "market", "buy", qty);
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
          const wallet = await getWalletBaseAmount(symbol);
          let target = Math.min(pos.size, wallet) * 0.3;
          let amt = floorToPrecision(target, step);

          if (amt <= 0 || amt * wsPx < LIVE_MIN_ORDER_KRW) {
            await tg(
              `⚠️ TP1 스킵 ${symbol} | 최소금액/정밀도/잔고 미달 (amt≈${amt.toFixed(
                8
              )}, KRW≈${Math.round(amt * wsPx)}, wallet≈${wallet.toFixed(6)})`
            );
          } else {
            const r = await marketSell(symbol, amt);
            if (r.ok) {
              pos.size = Math.max(0, pos.size - amt);
              pos.tookTP1 = true;
              if (USE_BEP_AFTER_TP1)
                pos.bePrice = pos.entry * (1 + BEP_OFFSET_BPS / 10000);
              await tg(
                `🟢 TP1 ${symbol} | +${(TP1 * 100).toFixed(2)}% | ${amt.toFixed(
                  6
                )} 청산 | 남은 pos≈${pos.size.toFixed(6)}`
              );
            } else {
              await tg(
                `❗ TP1 매도 실패 ${symbol} | ${
                  r.reason || "unknown"
                } (보유 유지)`
              );
            }
          }
        } else if (wsPx >= pos.entry * (1 + TP2)) {
          const step = await getAmountStep(symbol);
          const wallet = await getWalletBaseAmount(symbol);
          let target = Math.min(pos.size, wallet) * 0.3;
          let amt = floorToPrecision(target, step);

          if (amt <= 0 || amt * wsPx < LIVE_MIN_ORDER_KRW) {
            await tg(
              `⚠️ TP2 스킵 ${symbol} | 최소금액/정밀도/잔고 미달 (amt≈${amt.toFixed(
                8
              )}, KRW≈${Math.round(amt * wsPx)}, wallet≈${wallet.toFixed(6)})`
            );
          } else {
            const r = await marketSell(symbol, amt);
            if (r.ok) {
              pos.size = Math.max(0, pos.size - amt);
              await tg(
                `🟢 TP2 ${symbol} | +${(TP2 * 100).toFixed(2)}% | ${amt.toFixed(
                  6
                )} 청산 | 남은 pos≈${pos.size.toFixed(6)}`
              );
            } else {
              await tg(
                `❗ TP2 매도 실패 ${symbol} | ${
                  r.reason || "unknown"
                } (보유 유지)`
              );
            }
          }
        }

        // ---- trailing & stops (+ force-exit) ----
        pos.peak = Math.max(pos.peak, wsPx);
        const trailLine = pos.peak * (1 + TRAIL);
        const hardSL = pos.entry * (1 + STOP_LOSS);
        const dynSL = pos.bePrice ?? hardSL;
        const stopLine = Math.max(dynSL, trailLine);

        const ddBps = Math.round(bps(pos.entry, wsPx)); // 음수면 손실
        const forceExit = FORCE_EXIT_DD_BPS !== 0 && ddBps <= FORCE_EXIT_DD_BPS;

        if (forceExit || wsPx <= stopLine || pos.size <= 0) {
          const step = await getAmountStep(symbol);
          const wallet = await getWalletBaseAmount(symbol);
          let amt = floorToPrecision(Math.min(pos.size, wallet), step);

          if (forceExit) {
            await tg(
              `⛔ FORCE-EXIT ${symbol} | DD=${(ddBps / 100).toFixed(
                2
              )}% | pos≈${pos.size.toFixed(6)} wallet≈${wallet.toFixed(6)}`
            );
          }

          if (amt <= 0) {
            await tg(
              `⚠️ EXIT 보류 ${symbol} | 정밀도/잔고 보정 후 0 (pos≈${pos.size.toFixed(
                6
              )} wallet≈${wallet.toFixed(6)})`
            );
            await sleep(LOOP_DELAY_MS);
            continue;
          }
          if (amt * wsPx < LIVE_MIN_ORDER_KRW) {
            await tg(
              `⚠️ EXIT 불가(먼지) ${symbol} | 가치≈${Math.round(
                amt * wsPx
              )} KRW < ${LIVE_MIN_ORDER_KRW} (pos≈${pos.size.toFixed(
                6
              )} wallet≈${wallet.toFixed(6)})`
            );
            await sleep(LOOP_DELAY_MS);
            continue;
          }

          const r = await marketSell(symbol, amt);
          if (r.ok) {
            const pnl = (wsPx / pos.entry - 1) * 100;
            await tg(
              `🔴 EXIT ${symbol} | ${Math.round(pos.entry)} → ${Math.round(
                wsPx
              )} | ${pnl.toFixed(2)}% | amt=${amt.toFixed(6)}`
            );
            pos.size = Math.max(0, pos.size - amt);
            if (pos.size <= (step || 0)) positions.delete(symbol);
          } else {
            await tg(
              `❗ EXIT 매도 실패 ${symbol} | ${
                r.reason || "unknown"
              } | 재시도 예정 (pos≈${pos.size.toFixed(
                6
              )} wallet≈${wallet.toFixed(6)})`
            );
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

      // 보유 중이면 신규 매수 스킵
      if (ENTRY_SKIP_IF_WALLET) {
        const wallet = await getWalletBaseAmount(symbol);
        const walletKrw = wallet * wsPx;
        if (walletKrw >= ENTRY_WALLET_MIN_KRW) {
          await tg(
            `⏸️ 보유중 진입 스킵 ${symbol} | 지갑≈${wallet.toFixed(
              6
            )} (${Math.round(walletKrw)} KRW)`
          );
          await sleep(LOOP_DELAY_MS);
          continue;
        }
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

/**
 * 시작 시 1회: 지갑 잔고를 현재 가격으로 환산하여 포지션 맵(positions)에 채워 넣는다.
 * - DUST_KRW_MIN 미만 금액은 무시(먼지)
 * - 이미 포지션이 있는 심볼은 건너뜀(중복 방지)
 * - 동기화된 심볼마다 텔레그램에 보고
 */
async function syncPositionsFromWallet(
  symbols: string[],
  feed: UpbitTickerFeed
) {
  try {
    const bal = await exchange.fetchBalance();
    for (const s of symbols) {
      if (positions.has(s)) continue; // 이미 포지션이 있으면 스킵
      const base = s.split("/")[0];
      const code = toUpbitCode(s);
      const lastPx = feed.get(code);
      if (!lastPx || lastPx <= 0) continue; // 아직 WS 틱을 못 받았으면 스킵

      const qty = getBalanceTotal(bal, base); // 지갑에 있는 베이스 수량
      if (!Number.isFinite(qty) || qty <= 0) continue;

      const krw = qty * lastPx;
      if (krw < DUST_KRW_MIN) continue; // 먼지 잔고는 무시

      const p: Pos = {
        entry: lastPx,
        size: qty,
        invested: krw,
        peak: lastPx,
        tookTP1: false,
        openedAt: Date.now(),
      };
      positions.set(s, p);
      await tg(
        `🔄 잔고 동기화: ${s} | 수량≈${qty.toFixed(6)} | KRW≈${Math.round(
          krw
        )} (entry≈${Math.round(lastPx)})`
      );
    }
  } catch (e: any) {
    await tg(`⚠️ 잔고 동기화 실패: ${e?.message || e}`);
  }
}

// ───────────────── 잔고 ←→ 포지션 동기화 공통 파라미터 ─────────────────
const SYNC_MIN_KRW = Number(process.env.SYNC_MIN_KRW ?? 3000); // 먼지 기준
const SYNC_TOLERANCE_BPS = Number(process.env.SYNC_TOLERANCE_BPS ?? 50); // 0.5% 기본
const SYNC_POS_INTERVAL_MIN = Number(process.env.SYNC_POS_INTERVAL_MIN ?? 15); // 15분 기본

let _syncLock = false; // 동기화 중복 실행 방지

/**
 * 시작/주기: 지갑 잔고를 현재 가격으로 환산하여
 * 1) 포지션이 없는데 잔고가 있으면 → 새 포지션으로 "등록"
 * 2) 포지션이 있는데 잔고가 거의 없으면 → 포지션 "제거"(수동 청산 간주)
 * 3) 둘 다 있는데 수량 차이가 크면 → 포지션 "사이즈 보정"
 *    - entry는 보수적으로 유지(알 수 없는 체결가). invested/peak만 현재가로 재계산
 */
async function reconcilePositionsFromWallet(
  symbols: string[],
  feed: UpbitTickerFeed
) {
  if (_syncLock) return;
  _syncLock = true;

  try {
    const bal = await exchange.fetchBalance();

    for (const s of symbols) {
      const base = s.split("/")[0];
      const code = toUpbitCode(s);
      const lastPx = feed.get(code);
      if (!lastPx || lastPx <= 0) continue;

      const walletQty = getBalanceTotal(bal, base);
      const walletKRW = walletQty * lastPx;
      const hasWallet = walletKRW >= SYNC_MIN_KRW;
      const pos = positions.get(s);

      if (!pos && hasWallet) {
        // 케이스 1: 포지션 없음 + 잔고 있음 → 신규 등록
        const newPos: Pos = {
          entry: lastPx,
          size: walletQty,
          invested: walletKRW,
          peak: lastPx,
          tookTP1: false,
          openedAt: Date.now(),
        };
        positions.set(s, newPos);
        await tg(
          `🔄 동기화: ${s} 신규등록 | qty≈${walletQty.toFixed(
            6
          )} | KRW≈${Math.round(walletKRW)} (entry≈${Math.round(lastPx)})`
        );
        continue;
      }

      if (pos && !hasWallet) {
        // 케이스 2: 포지션 있음 + 잔고 없음 → 포지션 제거(수동 청산 간주)
        positions.delete(s);
        await tg(`🔄 동기화: ${s} 제거(지갑 잔량 없음으로 판단)`);
        continue;
      }

      if (pos && hasWallet) {
        // 케이스 3: 둘 다 있음 → 사이즈 차이 허용치 검사
        const diffAbs = Math.abs(walletQty - pos.size);
        const diffPct = pos.size > 0 ? (diffAbs / pos.size) * 10000 : 10000; // bps
        if (diffPct > SYNC_TOLERANCE_BPS) {
          // 사이즈만 보정(알 수 없는 평균단가 문제로 entry는 유지)
          pos.size = walletQty;
          pos.invested = walletQty * lastPx;
          pos.peak = Math.max(pos.peak ?? lastPx, lastPx);
          positions.set(s, pos);
          await tg(
            `🔄 동기화: ${s} 사이즈 보정 | qty≈${walletQty.toFixed(
              6
            )} | KRW≈${Math.round(pos.invested)} (entry=keep ${Math.round(
              pos.entry
            )})`
          );
        }
      }
    }
  } catch (e: any) {
    await tg(`⚠️ 동기화 오류: ${e?.message || e}`);
  } finally {
    _syncLock = false;
  }
}

/** 시작 시 1회: 포지션이 비어있는 심볼만 잔고→포지션 등록(먼지 제외) */
async function syncPositionsFromWalletOnce(
  symbols: string[],
  feed: UpbitTickerFeed
) {
  try {
    const bal = await exchange.fetchBalance();

    for (const s of symbols) {
      if (positions.has(s)) continue;
      const base = s.split("/")[0];
      const code = toUpbitCode(s);
      const lastPx = feed.get(code);
      if (!lastPx || lastPx <= 0) continue;

      const qty = getBalanceTotal(bal, base);
      const krw = qty * lastPx;
      if (krw < SYNC_MIN_KRW) continue;

      const p: Pos = {
        entry: lastPx,
        size: qty,
        invested: krw,
        peak: lastPx,
        tookTP1: false,
        openedAt: Date.now(),
      };
      positions.set(s, p);
      await tg(
        `🔄 동기화: ${s} | qty≈${qty.toFixed(6)} | KRW≈${Math.round(
          krw
        )} (entry≈${Math.round(lastPx)})`
      );
    }
  } catch (e: any) {
    await tg(`⚠️ 초기 동기화 실패: ${e?.message || e}`);
  }
}

// =============== MAIN ===============
async function main() {
  const symbols = TRADE_COINS.length ? TRADE_COINS : [SYMBOL_CCXT];
  const codes = symbols.map(toUpbitCode);
  const feed = new UpbitTickerFeed(codes);
  feed.connect();

  console.log(
    `BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`
  );
  await tg(
    `🚀 BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`
  );

  // ✅ 시작 시 1회: 포지션 비어있는 심볼만 등록(먼지 제외)
  await syncPositionsFromWalletOnce(symbols, feed);

  // 이후 실행 루프(전략 러너) 시작
  symbols.forEach((s) => {
    runner(s, feed);
  });

  // ✅ 주기적 재동기화(지갑↔포지션 불일치 자동 조정)
  const syncMs = Math.max(1, SYNC_POS_INTERVAL_MIN) * 60 * 1000;
  setInterval(() => {
    reconcilePositionsFromWallet(symbols, feed).catch((e) =>
      tg(`⚠️ 주기 동기화 오류: ${e?.message || e}`)
    );
  }, syncMs);

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
