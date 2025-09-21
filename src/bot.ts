// src/step8_live_trader.ts
// Multi-coin aggressive breakout trader for Upbit via ccxt.
// Uses your existing .env parameters (live/paper, kill-switch, breakout/regime filter, TP/SL/Trail, quiet hours, quotas).
// Requires: ccxt, dotenv, technicalindicators, node-fetch (installed in your package.json).

import "dotenv/config";
import ccxt from "ccxt";
import fetch from "node-fetch";
import { MACD, EMA } from "technicalindicators";

// -------------------- ENV & Helpers --------------------
const MODE = (process.env.MODE || "live").toLowerCase(); // live | paper
const KILL_SWITCH =
  (process.env.KILL_SWITCH || "false").toLowerCase() === "true";

// Multi-coin: ccxt-format symbols (e.g., BTC/KRW)
const TRADE_COINS = (process.env.TRADE_COINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Single-symbol fallback (ccxt-format)
const SYMBOL_CCXT = process.env.SYMBOL_CCXT || "BTC/KRW";

// Upbit CCXT auth
const UPBIT_API_KEY = process.env.UPBIT_API_KEY || "";
const UPBIT_SECRET = process.env.UPBIT_SECRET || "";

// Telegram
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Sizing / limits
const BASE_CAPITAL_KRW = toNum(process.env.BASE_CAPITAL_KRW, 500000);
const POS_PCT = toNum(process.env.POS_PCT, 0.12); // position size per entry (% of base)
const LIVE_MIN_ORDER_KRW = toNum(process.env.LIVE_MIN_ORDER_KRW, 5000);

// Execution tunings
const ENTRY_SLIPPAGE_BPS = toNum(process.env.ENTRY_SLIPPAGE_BPS, 30); // 0.30%
const ENTRY_TIMEOUT_SEC = toNum(process.env.ENTRY_TIMEOUT_SEC, 60);
const RETRY_MAX = toNum(process.env.RETRY_MAX, 2);

// Breakout
const BREAKOUT_LOOKBACK = toNum(process.env.BREAKOUT_LOOKBACK, 6);
const BREAKOUT_TOL_BPS = toNum(process.env.BREAKOUT_TOL_BPS, 15);
const USE_HIGH_BREAKOUT = toBool(process.env.USE_HIGH_BREAKOUT, true);

// Regime filter
const USE_REGIME_FILTER = toBool(process.env.USE_REGIME_FILTER, true);
const REGIME_EMA_FAST = toNum(process.env.REGIME_EMA_FAST, 20);
const REGIME_EMA_SLOW = toNum(process.env.REGIME_EMA_SLOW, 60);
const USE_MACD_CONFIRM = toBool(process.env.USE_MACD_CONFIRM, false);
const MACD_FAST = toNum(process.env.MACD_FAST, 12);
const MACD_SLOW = toNum(process.env.MACD_SLOW, 26);
const MACD_SIGNAL = toNum(process.env.MACD_SIGNAL, 9);

// Market fallback
const USE_MARKET_FALLBACK = toBool(process.env.USE_MARKET_FALLBACK, true);
const MARKET_FALLBACK_MAX_BPS = toNum(process.env.MARKET_FALLBACK_MAX_BPS, 35);

// Risk / exits
const STOP_LOSS = toNum(process.env.STOP_LOSS, -0.012); // -1.2%
const TP1 = toNum(process.env.TP1, 0.012); // +1.2%
const TP2 = toNum(process.env.TP2, 0.022); // +2.2%
const TRAIL = toNum(process.env.TRAIL, -0.015); // -1.5% from peak
const USE_BEP_AFTER_TP1 = toBool(process.env.USE_BEP_AFTER_TP1, true);
const BEP_OFFSET_BPS = toNum(process.env.BEP_OFFSET_BPS, 0);

// Daily limits & quiet hours (KST)
const MAX_TRADES_PER_DAY = toNum(process.env.MAX_TRADES_PER_DAY, 4);
const QUIET_HOUR_START = toNum(process.env.QUIET_HOUR_START, 2); // 02:00 KST
const QUIET_HOUR_END = toNum(process.env.QUIET_HOUR_END, 6); // 06:00 KST

// Chart
const TF = process.env.TF || "5m";
const LOOKBACK = toNum(process.env.LOOKBACK, 600);

// Runner
const MAX_CONCURRENT_POSITIONS = toNum(process.env.MAX_CONCURRENT_POSITIONS, 3); // optional new key
const LOOP_DELAY_MS = 5000; // poll delay per symbol

function toNum(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function toBool(v: any, d: boolean) {
  const s = String(v || "").toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return d;
}
const nowKST = () => new Date(Date.now() + 9 * 60 * 60 * 1000);
const hourKST = () => nowKST().getUTCHours();

// -------------------- Telegram --------------------
async function tg(text: string) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (_) {}
}

// -------------------- Exchange --------------------
const exchange = new ccxt.upbit({
  apiKey: UPBIT_API_KEY,
  secret: UPBIT_SECRET,
  enableRateLimit: true,
  options: { adjustForTimeDifference: true },
});

// -------------------- State --------------------
type Pos = {
  entry: number;
  size: number; // base amount
  invested: number; // KRW
  peak: number;
  tookTP1: boolean;
  symbol: string;
  openedAt: number;
  bePrice?: number; // break-even migrated stop
};
const positions = new Map<string, Pos>();
const tradesToday = new Map<string, number>(); // symbol -> count

function resetDailyCountersIfNeeded() {
  const k = nowKST();
  // Day-change check each loop is OK in this simple implementation.
  if (k.getUTCHours() === 0 && k.getUTCMinutes() < 1) {
    tradesToday.clear();
  }
}

function canEnterNow(symbol: string) {
  // quiet hours (new entries blocked)
  const h = hourKST();
  const quiet =
    QUIET_HOUR_START <= QUIET_HOUR_END
      ? h >= QUIET_HOUR_START && h < QUIET_HOUR_END
      : h >= QUIET_HOUR_START || h < QUIET_HOUR_END;
  if (quiet) return false;

  const n = tradesToday.get(symbol) || 0;
  if (n >= MAX_TRADES_PER_DAY) return false;

  if (positions.size >= MAX_CONCURRENT_POSITIONS) return false;

  return true;
}

function incTrade(symbol: string) {
  tradesToday.set(symbol, (tradesToday.get(symbol) || 0) + 1);
}

// -------------------- Indicators & Signals --------------------
function ema(arr: number[], len: number) {
  return EMA.calculate({ values: arr, period: len });
}
function macdHist(arr: number[]) {
  const res = MACD.calculate({
    values: arr,
    fastPeriod: MACD_FAST,
    slowPeriod: MACD_SLOW,
    signalPeriod: MACD_SIGNAL,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  // align length; take last hist
  return res.length ? res[res.length - 1].histogram ?? 0 : 0;
}

function regimeOK(closes: number[]) {
  if (!USE_REGIME_FILTER) return true;
  const efast = ema(closes, REGIME_EMA_FAST);
  const eslow = ema(closes, REGIME_EMA_SLOW);
  if (efast.length === 0 || eslow.length === 0) return false;
  const lastFast = efast[efast.length - 1];
  const lastSlow = eslow[eslow.length - 1];
  if (lastFast <= lastSlow) return false;
  if (USE_MACD_CONFIRM) {
    const hist = macdHist(closes);
    if (!(hist > 0)) return false;
  }
  return true;
}

function breakoutOK(ohlcv: number[][]) {
  // ohlcv: [timestamp, open, high, low, close, volume]
  const n = ohlcv.length;
  if (n < BREAKOUT_LOOKBACK + 2) return false;
  const last = ohlcv[n - 1];
  const closes = ohlcv.map((r) => r[4]);
  const highs = ohlcv.map((r) => r[2]);

  const priorHigh = Math.max(...highs.slice(n - 1 - BREAKOUT_LOOKBACK, n - 1));
  const tol = priorHigh * (BREAKOUT_TOL_BPS / 10000); // bps
  const closeOK = last[4] >= priorHigh - tol;
  const highOK = USE_HIGH_BREAKOUT ? last[2] >= priorHigh - tol : false;

  return closeOK || highOK;
}

// -------------------- Order sizing --------------------
function allocKRWPerEntry(): number {
  return Math.floor(BASE_CAPITAL_KRW * POS_PCT);
}

// -------------------- Orders --------------------
async function placeMarketBuy(symbol: string, krw: number, px: number) {
  if (krw < LIVE_MIN_ORDER_KRW)
    return { ok: false, reason: "below-min" as const };
  if (MODE === "paper" || KILL_SWITCH) {
    return { ok: true, paper: true, amount: krw / px };
  }
  try {
    // upbit needs amount in base currency (size). compute approximate size at market.
    const amount = krw / px;
    const o = await exchange.createOrder(symbol, "market", "buy", amount);
    return { ok: true, id: o.id, amount };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "createOrder-buy-failed" };
  }
}

async function placeMarketSell(symbol: string, amount: number) {
  if (amount <= 0) return { ok: false, reason: "zero-amount" as const };
  if (MODE === "paper" || KILL_SWITCH) {
    return { ok: true, paper: true };
  }
  try {
    const o = await exchange.createOrder(symbol, "market", "sell", amount);
    return { ok: true, id: o.id };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "createOrder-sell-failed" };
  }
}

// -------------------- Core loop per symbol --------------------
async function loopSymbol(symbol: string) {
  await tg(`▶️ 시작: ${symbol} | MODE=${MODE} | KILL_SWITCH=${KILL_SWITCH}`);
  while (true) {
    try {
      resetDailyCountersIfNeeded();

      // candles
      const ohlcv = await exchange.fetchOHLCV(symbol, TF, undefined, LOOKBACK);
      if (!ohlcv.length) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }
      const last = ohlcv[ohlcv.length - 1];
      const lastPx = last[4];
      const closes = ohlcv.map((r) => r[4]);

      const pos = positions.get(symbol);

      // manage exits if in position
      if (pos) {
        // take-profits
        if (!pos.tookTP1 && lastPx >= pos.entry * (1 + TP1)) {
          const sellAmt = pos.size * 0.3;
          const r = await placeMarketSell(symbol, sellAmt);
          if (r.ok) {
            pos.size -= sellAmt;
            pos.tookTP1 = true;
            if (USE_BEP_AFTER_TP1) {
              pos.bePrice = pos.entry * (1 + BEP_OFFSET_BPS / 10000);
            }
            await tg(
              `🟢 TP1 ${symbol} | +${(TP1 * 100).toFixed(
                2
              )}% | 남은수량 ${pos.size.toFixed(6)}`
            );
          }
        } else if (lastPx >= pos.entry * (1 + TP2)) {
          const sellAmt = pos.size * 0.3;
          const r = await placeMarketSell(symbol, sellAmt);
          if (r.ok) {
            pos.size -= sellAmt;
            await tg(
              `🟢 TP2 ${symbol} | +${(TP2 * 100).toFixed(
                2
              )}% | 남은수량 ${pos.size.toFixed(6)}`
            );
          }
        }

        // peak/trailing
        pos.peak = Math.max(pos.peak, lastPx);
        const trailLine = pos.peak * (1 + TRAIL);
        // stop loss or BEP stop
        const hardSL = pos.entry * (1 + STOP_LOSS);
        const dynSL = pos.bePrice ?? hardSL;
        const stopLine = Math.max(dynSL, trailLine);

        if (lastPx <= stopLine || pos.size <= 0) {
          const r = await placeMarketSell(symbol, pos.size);
          if (r.ok) {
            const pnl = (lastPx / pos.entry - 1) * 100;
            await tg(
              `🔴 EXIT ${symbol} | 진입 ${Math.round(
                pos.entry
              )} → 청산 ${Math.round(lastPx)} | 수익률 ${pnl.toFixed(2)}%`
            );
          }
          positions.delete(symbol);
        }

        await sleep(LOOP_DELAY_MS);
        continue;
      }

      // if flat → check entry
      if (!canEnterNow(symbol)) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      // regime & breakout
      const okRegime = regimeOK(closes);
      const okBreakout = breakoutOK(ohlcv);
      if (!(okRegime && okBreakout)) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      // entry
      const alloc = allocKRWPerEntry();
      if (alloc < LIVE_MIN_ORDER_KRW) {
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      // (optional) limit-follow logic (slippage window) → simplified to market + fallback by bps
      // In live mode you might implement price guard; here we rely on market + later guard with MARKET_FALLBACK_MAX_BPS if needed.
      const buy = await placeMarketBuy(symbol, alloc, lastPx);
      if (!buy.ok) {
        await tg(`⚠️ BUY 실패 ${symbol} | ${buy.reason}`);
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      const size =
        MODE === "paper" || KILL_SWITCH
          ? alloc / lastPx
          : (buy as any).amount ?? alloc / lastPx;
      const p: Pos = {
        entry: lastPx,
        size,
        invested: alloc,
        peak: lastPx,
        tookTP1: false,
        symbol,
        openedAt: Date.now(),
      };
      positions.set(symbol, p);
      incTrade(symbol);
      await tg(
        `🟩 ENTRY ${symbol} | 진입가 ${Math.round(
          p.entry
        )} | 수량 ${p.size.toFixed(6)} | 배분 ${alloc.toLocaleString()} KRW`
      );

      await sleep(LOOP_DELAY_MS);
    } catch (e: any) {
      await tg(`⚠️ 루프 에러 ${symbol}: ${e?.message || e}`);
      await sleep(5000);
    }
  }
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// -------------------- Main --------------------
async function main() {
  const symbols = TRADE_COINS.length ? TRADE_COINS : [SYMBOL_CCXT];
  await tg(
    `🚀 BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`
  );
  // run all symbols in parallel (simple fire-and-forget)
  symbols.forEach((s) => loopSymbol(s));
}

main().catch(async (e) => {
  await tg(`❌ FATAL: ${e?.message || e}`);
  process.exit(1);
});
