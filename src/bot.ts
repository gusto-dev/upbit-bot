// src/bot.ts — 안정 러너 + 주기 동기화 + 텔레그램 알림 (CJS 타깃)

import "dotenv/config";
import ccxt from "ccxt";
import { UpbitTickerFeed } from "./lib/wsTicker";
import { loadState, saveState } from "./lib/persist";

// ===================== ENV (Validated) =====================
function num(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function bool(v: any, d: boolean) {
  if (typeof v === "string") return v === "true" || v === "1";
  if (typeof v === "boolean") return v;
  return d;
}
function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

const MODE = (process.env.MODE || "live") as "live" | "paper";
const SYMBOL_CCXT = process.env.SYMBOL_CCXT || "BTC/KRW";
const TRADE_COINS = (process.env.TRADE_COINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TF = process.env.TF || "5m";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const UPBIT_API_KEY = process.env.UPBIT_API_KEY || "";
const UPBIT_SECRET = process.env.UPBIT_SECRET || "";

let BASE_CAPITAL_KRW = clamp(
  num(process.env.BASE_CAPITAL_KRW, 500_000),
  10_000,
  100_000_000
);
let POS_PCT = clamp(num(process.env.POS_PCT, 0.12), 0.001, 1);
let LIVE_MIN_ORDER_KRW = clamp(
  num(process.env.LIVE_MIN_ORDER_KRW, 5000),
  1000,
  20_000
);
let ENTRY_SLIPPAGE_BPS = clamp(num(process.env.ENTRY_SLIPPAGE_BPS, 30), 1, 500);
let BREAKOUT_LOOKBACK = clamp(num(process.env.BREAKOUT_LOOKBACK, 6), 2, 200);
let BREAKOUT_TOL_BPS = clamp(num(process.env.BREAKOUT_TOL_BPS, 15), 0, 1000);
const USE_REGIME_FILTER = bool(process.env.USE_REGIME_FILTER, true);
let REGIME_EMA_FAST = clamp(num(process.env.REGIME_EMA_FAST, 20), 2, 500);
let REGIME_EMA_SLOW = clamp(num(process.env.REGIME_EMA_SLOW, 60), 3, 1000);
if (REGIME_EMA_FAST >= REGIME_EMA_SLOW)
  REGIME_EMA_FAST = Math.max(2, REGIME_EMA_SLOW - 1);
let TP1 = clamp(num(process.env.TP1, 0.012), 0.001, 0.2);
let TP2 = clamp(num(process.env.TP2, 0.022), TP1 + 0.001, 0.5);
let TRAIL = clamp(num(process.env.TRAIL, -0.015), -0.2, -0.001);
const USE_BEP_AFTER_TP1 = bool(process.env.USE_BEP_AFTER_TP1, true);
let MAX_TRADES_PER_DAY = clamp(num(process.env.MAX_TRADES_PER_DAY, 4), 1, 50);
let MAX_CONCURRENT_POS = clamp(
  num(process.env.MAX_CONCURRENT_POSITIONS, 3),
  1,
  20
);
let QUIET_HOUR_START = clamp(num(process.env.QUIET_HOUR_START, 2), 0, 23);
let QUIET_HOUR_END = clamp(num(process.env.QUIET_HOUR_END, 6), 0, 23);

let SYNC_MIN_KRW = clamp(num(process.env.SYNC_MIN_KRW, 3000), 500, 1_000_000);
let SYNC_TOLERANCE_BPS = clamp(
  num(process.env.SYNC_TOLERANCE_BPS, 50),
  1,
  10_000
);
let SYNC_POS_INTERVAL_MIN = clamp(
  num(process.env.SYNC_POS_INTERVAL_MIN, 15),
  1,
  240
);
let REMOVE_STRIKE_REQUIRED = clamp(
  num(process.env.SYNC_REMOVE_STRIKE, 2),
  1,
  10
);
const STOP_LOSS_PCT = clamp(
  num(process.env.STOP_LOSS_PCT, -0.03),
  -0.3,
  -0.001
);
const USE_DYNAMIC_STOP = bool(process.env.USE_DYNAMIC_STOP, true);
const DYN_STOP_TIGHTEN_AFTER_TP1 = bool(
  process.env.DYN_STOP_TIGHTEN_AFTER_TP1,
  true
);
const DYN_STOP_BUFFER_BPS = clamp(
  num(process.env.DYN_STOP_BUFFER_BPS, 80),
  10,
  1000
); // peak - buffer 방식
const CANDLE_MIN_REFRESH_MS = clamp(
  num(process.env.CANDLE_MIN_REFRESH_MS, 5000),
  1000,
  60_000
);
const AUTOSAVE_MIN = clamp(num(process.env.AUTOSAVE_MIN, 5), 1, 120);

console.log("CONFIG", {
  MODE,
  SYMBOL_CCXT,
  TF,
  BASE_CAPITAL_KRW,
  POS_PCT,
  LIVE_MIN_ORDER_KRW,
  ENTRY_SLIPPAGE_BPS,
  BREAKOUT_LOOKBACK,
  BREAKOUT_TOL_BPS,
  REGIME_EMA_FAST,
  REGIME_EMA_SLOW,
  TP1,
  TP2,
  TRAIL,
  MAX_TRADES_PER_DAY,
  MAX_CONCURRENT_POS,
  STOP_LOSS_PCT,
});

// ===================== TYPES/STATE =====================
type Pos = {
  entry: number;
  size: number;
  invested: number;
  peak: number; // persist 타입에 맞춰 필수
  tookTP1: boolean; // persist 타입에 맞춰 필수
  openedAt: number;
  stopPrice?: number; // 동적/기본 손절가
  initialRiskPct?: number; // 최초 손절 퍼센트 기록
};
const positions: Map<string, Pos> = new Map();

// tradesToday: persist 규격에 맞게 "숫자만" 저장
const tradeCounter: Map<string, number> = new Map();
let paused = false; // persist용

// ===================== EXCHANGE =====================
const exchange = new ccxt.upbit({
  apiKey: UPBIT_API_KEY || undefined,
  secret: UPBIT_SECRET || undefined,
  enableRateLimit: true,
});

// ===================== TELEGRAM =====================
async function tg(text: string) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("TG disabled: missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
    type TgResp = { ok: boolean; [k: string]: any };
    const data: unknown = await res.json().catch(() => undefined);
    if (!isTgResp(data) || !data.ok) {
      console.error(
        "TG send failed:",
        res.status,
        typeof data === "object" ? JSON.stringify(data) : String(data)
      );
    }
  } catch (e: any) {
    console.error("TG error:", e?.message || e);
  } finally {
    clearTimeout(timer);
  }
}

function isTgResp(v: unknown): v is { ok: boolean } {
  return !!v && typeof v === "object" && "ok" in v;
}

// ===================== HELPERS =====================
function toUpbitCode(ccxtSymbol: string) {
  const [base, quote] = ccxtSymbol.split("/");
  return `${quote}-${base}`;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeWalletQty(balance: any, base: string): number {
  const byKey = (obj: any, k: string) => (obj && Number(obj[k])) || 0;
  const total =
    byKey(balance?.total, base) ||
    byKey(balance?.total, base.toUpperCase()) ||
    byKey(balance?.total, base.toLowerCase());
  const free =
    byKey(balance?.free, base) ||
    byKey(balance?.free, base.toUpperCase()) ||
    byKey(balance?.free, base.toLowerCase());
  const used =
    byKey(balance?.used, base) ||
    byKey(balance?.used, base.toUpperCase()) ||
    byKey(balance?.used, base.toLowerCase());
  const qty = total > 0 ? total : free + used;
  return qty > 0 ? qty : 0;
}

function nowSeoulHour(): number {
  const kst = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Seoul",
    hour12: false,
  });
  const d = new Date(kst);
  return d.getHours();
}
function inQuietHours(): boolean {
  const h = nowSeoulHour();
  if (QUIET_HOUR_START <= QUIET_HOUR_END)
    return h >= QUIET_HOUR_START && h < QUIET_HOUR_END;
  // 예: 22~02 형태
  return h >= QUIET_HOUR_START || h < QUIET_HOUR_END;
}

function floorToStep(v: number, step: number) {
  if (!step || step <= 0) return v;
  return Math.floor(v / step) * step;
}
function getMarketInfo(symbol: string): { precision?: { amount?: number } } {
  const m = (exchange as any).markets?.[symbol];
  return (m || {}) as { precision?: { amount?: number } };
}

// 캔들/지표
async function fetchCandles(
  symbol: string,
  tf: string,
  limit = 200
): Promise<Candle[]> {
  try {
    return (await exchange.fetchOHLCV(
      symbol,
      tf,
      undefined,
      limit
    )) as Candle[];
  } catch {
    return [] as Candle[];
  }
}
// ===== Candle Cache =====
const candleCache: Map<string, { next: number; data: Candle[] }> = new Map();
function fetchTfMs(tf: string): number {
  const m = /^(\d+)([mhd])$/i.exec(tf.trim());
  if (!m) return 5 * 60 * 1000;
  const v = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === "m") return v * 60 * 1000;
  if (u === "h") return v * 60 * 60 * 1000;
  if (u === "d") return v * 24 * 60 * 60 * 1000;
  return v * 60 * 1000;
}
async function fetchCandlesCached(symbol: string, tf: string, limit = 200) {
  const key = `${symbol}:${tf}`;
  const now = Date.now();
  const rec = candleCache.get(key);
  if (rec && rec.next > now) return rec.data;
  const data = await fetchCandles(symbol, tf, limit);
  candleCache.set(key, { data, next: now + CANDLE_MIN_REFRESH_MS });
  return data;
}
function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let emaPrev = values[0];
  out.push(emaPrev);
  for (let i = 1; i < values.length; i++) {
    const e = values[i] * k + emaPrev * (1 - k);
    out.push(e);
    emaPrev = e;
  }
  return out;
}
function last<T>(arr: T[], n = 1) {
  return arr.slice(-n);
}

// ===================== SYNC (지갑↔포지션) =====================
const _noWalletStrike: Map<string, number> = new Map();
let _syncLock = false;

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

      const qty = safeWalletQty(bal, base);
      const krw = qty * lastPx;
      if (krw < SYNC_MIN_KRW) continue;

      positions.set(s, {
        entry: lastPx,
        size: qty,
        invested: krw,
        peak: lastPx,
        tookTP1: false,
        openedAt: Date.now(),
      });
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

      const walletQty = safeWalletQty(bal, base);
      const walletKRW = walletQty * lastPx;
      const hasWallet = walletKRW >= SYNC_MIN_KRW;

      const pos = positions.get(s);

      if (!pos && hasWallet) {
        positions.set(s, {
          entry: lastPx,
          size: walletQty,
          invested: walletKRW,
          peak: lastPx,
          tookTP1: false,
          openedAt: Date.now(),
        });
        _noWalletStrike.delete(s);
        await tg(
          `🔄 동기화: ${s} 신규등록 | qty≈${walletQty.toFixed(
            6
          )} | KRW≈${Math.round(walletKRW)} (entry≈${Math.round(lastPx)})`
        );
        continue;
      }
      if (pos && !hasWallet) {
        const n = (_noWalletStrike.get(s) || 0) + 1;
        _noWalletStrike.set(s, n);
        if (n >= REMOVE_STRIKE_REQUIRED) {
          positions.delete(s);
          _noWalletStrike.delete(s);
          await tg(`🔄 동기화: ${s} 제거(지갑 잔량 없음 ${n}회 연속)`);
        } else {
          await tg(`⚠️ 동기화: ${s} 지갑 잔량 없음 1회 감지(보류)`);
        }
        continue;
      }
      if (pos && hasWallet) {
        _noWalletStrike.delete(s);
        const diffAbs = Math.abs(walletQty - pos.size);
        const diffPctBps = pos.size > 0 ? (diffAbs / pos.size) * 10000 : 0;
        if (diffPctBps > SYNC_TOLERANCE_BPS) {
          pos.size = walletQty;
          pos.invested = walletQty * lastPx;
          pos.peak = Math.max(pos.peak, lastPx);
          positions.set(s, pos);
          await tg(
            `🔄 동기화: ${s} 사이즈 보정 | qty≈${walletQty.toFixed(
              6
            )} | KRW≈${Math.round(pos.invested)} (entry 유지 ${Math.round(
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

// ===================== ORDER HELPERS =====================
function todayStrKST() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  )
    .toISOString()
    .slice(0, 10);
}
let counterDay = todayStrKST();
function ensureDayFresh() {
  const t = todayStrKST();
  if (t !== counterDay) {
    tradeCounter.clear(); // 날짜 바뀌면 일일 카운터 리셋
    counterDay = t;
  }
}
function incTradeCount(sym: string) {
  ensureDayFresh();
  const n = (tradeCounter.get(sym) || 0) + 1;
  tradeCounter.set(sym, n);
  return n;
}
function getTradeCount(sym: string) {
  ensureDayFresh();
  return tradeCounter.get(sym) || 0;
}

async function marketBuy(symbol: string, lastPx: number) {
  const budgetKRW = Math.max(
    LIVE_MIN_ORDER_KRW,
    Math.floor(BASE_CAPITAL_KRW * POS_PCT)
  );
  const amount = budgetKRW / lastPx;

  await exchange.loadMarkets();
  const mi = getMarketInfo(symbol);
  const step = mi?.precision?.amount ? Math.pow(10, -mi.precision.amount) : 0; // upbit precision 대응
  const amt = step ? floorToStep(amount, step) : amount;

  if (budgetKRW < LIVE_MIN_ORDER_KRW || amt <= 0)
    return { ok: false as const, reason: "amount-too-small" };

  if (MODE === "paper")
    return { ok: true as const, paper: true as const, amt: Number(amt) };

  try {
    const o = await exchange.createOrder(symbol, "market", "buy", amt);
    return { ok: true as const, order: o, amt: Number(amt) };
  } catch (e: any) {
    return { ok: false as const, reason: e?.message || "buy-failed" };
  }
}

async function marketSell(symbol: string, amt: number) {
  if (amt <= 0) return { ok: false as const, reason: "zero-amt" };
  if (MODE === "paper") return { ok: true as const, paper: true as const, amt };
  try {
    const o = await exchange.createOrder(symbol, "market", "sell", amt);
    return { ok: true as const, order: o };
  } catch (e: any) {
    return { ok: false as const, reason: e?.message || "sell-failed" };
  }
}

// ===================== STRATEGY RUNNER =====================
async function runner(symbol: string, feed: UpbitTickerFeed) {
  const code = toUpbitCode(symbol);
  await tg(`▶️ 시작: ${symbol} | MODE=${MODE} | paused=false`);

  let lastBarTs = 0;

  for (;;) {
    try {
      // 조용시간엔 신규 진입만 막고, 보유포지션 관리는 계속
      const quiet = inQuietHours();

      // 실시간 가격
      const lastPx = feed.get(code);
      if (!lastPx) {
        await sleep(1000);
        continue;
      }

      // 캔들 갱신 (캐시)
      const candles = await fetchCandlesCached(symbol, TF, 120);
      if (!candles.length) {
        await sleep(1000);
        continue;
      }

      // 마지막 봉 안전 파싱
      const lastCandle: Candle | undefined = last(candles, 1)[0];
      const tOpen = lastCandle ? Number(lastCandle[0]) : lastBarTs || 0;
      const tClose = lastCandle ? Number(lastCandle[4]) : lastPx || 0;

      // 같은 봉/같은 가격이면 간격만 둔다
      if (tOpen === lastBarTs && lastPx === tClose) {
        await sleep(1000);
      } else {
        lastBarTs = tOpen;

        // number[]로 강제 변환
        const closes: number[] = candles.map((c: Candle) => Number(c[4]) || 0);
        const highs: number[] = candles.map((c: Candle) => Number(c[2]) || 0);

        const len = closes.length;
        const fastLen = Math.min(REGIME_EMA_FAST, len);
        const slowLen = Math.min(REGIME_EMA_SLOW, len);
        const emaFast = ema(closes, fastLen);
        const emaSlow = ema(closes, slowLen);
        const fast = last(emaFast, 1)[0] ?? 0;
        const slow = last(emaSlow, 1)[0] ?? 0;

        // 직전 N봉 고가 (현재 봉 제외)
        const lookback = Math.max(2, BREAKOUT_LOOKBACK + 1);
        const highsForHH = highs.slice(-lookback, -1);
        const hh = highsForHH.length ? Math.max(...highsForHH) : 0;

        const pos = positions.get(symbol);
        const inPos = !!pos;

        // ====== 보유 포지션 관리 ======
        if (inPos && pos) {
          // 트레일링/TP/손절
          if (lastPx > pos.peak) pos.peak = lastPx;

          const pnlPct = (lastPx - pos.entry) / pos.entry;

          // 동적 / 기본 손절 갱신
          if (USE_DYNAMIC_STOP) {
            const buffer = pos.entry * (DYN_STOP_BUFFER_BPS / 10000);
            const candidate = pos.peak - buffer;
            if (!pos.stopPrice || candidate > pos.stopPrice) {
              pos.stopPrice = candidate;
            }
            if (pos.tookTP1 && DYN_STOP_TIGHTEN_AFTER_TP1 && pos.stopPrice) {
              const tighten = pos.entry * 0.002; // 0.2% tighten
              pos.stopPrice = Math.max(pos.stopPrice, pos.entry + tighten);
            }
          } else {
            // static stop (최초 지정 없으면 entry 기반)
            if (!pos.stopPrice) pos.stopPrice = pos.entry * (1 + STOP_LOSS_PCT);
          }

          const activeStop = pos.stopPrice ?? pos.entry * (1 + STOP_LOSS_PCT);
          if (lastPx <= activeStop) {
            const r = await marketSell(symbol, pos.size);
            if (r.ok) {
              positions.delete(symbol);
              await tg(
                `❌ 손절: ${symbol} @${Math.round(lastPx)} (${(
                  ((lastPx - pos.entry) / pos.entry) *
                  100
                ).toFixed(2)}%) stop=${Math.round(activeStop)}`
              );
            } else {
              await tg(`❗ 손절 실패: ${symbol} | ${r.reason}`);
            }
          }

          // TP1 (절반 익절)
          if (!pos.tookTP1 && pnlPct >= TP1) {
            const sellAmt = pos.size * 0.5;
            const r = await marketSell(symbol, sellAmt);
            if (r.ok) {
              pos.size -= sellAmt;
              pos.invested = pos.size * lastPx;
              pos.tookTP1 = true;
              if (USE_BEP_AFTER_TP1) pos.entry = Math.min(pos.entry, lastPx);
              if (pos.stopPrice && pos.stopPrice < pos.entry) {
                pos.stopPrice = pos.entry * 0.999; // 수수료 고려 살짝 아래
              }
              positions.set(symbol, pos);
              await tg(
                `✅ TP1: ${symbol} 50% 익절 | 잔여=${pos.size.toFixed(6)}`
              );
            } else {
              await tg(`❗ TP1 실패: ${symbol} | ${r.reason}`);
            }
          }

          // TP2 (전량 익절) or 트레일
          if (pnlPct >= TP2) {
            const r = await marketSell(symbol, pos.size);
            if (r.ok) {
              positions.delete(symbol);
              await tg(`🎯 TP2: ${symbol} 전량 익절`);
            } else {
              await tg(`❗ TP2 실패: ${symbol} | ${r.reason}`);
            }
          } else if ((lastPx - pos.peak) / pos.peak <= TRAIL) {
            const r = await marketSell(symbol, pos.size);
            if (r.ok) {
              positions.delete(symbol);
              await tg(`🛑 트레일 스탑: ${symbol} 청산`);
            } else {
              await tg(`❗ 트레일 실패: ${symbol} | ${r.reason}`);
            }
          }
        }

        // ====== 신규 진입 ======
        if (!inPos && !quiet) {
          if (Array.from(positions.keys()).length >= MAX_CONCURRENT_POS) {
            // 동시 포지션 제한 → 스킵
          } else if (getTradeCount(symbol) >= MAX_TRADES_PER_DAY) {
            // 일일 진입 제한 → 스킵
          } else {
            const regimeOk = !USE_REGIME_FILTER || fast >= slow;
            const tol = hh * (BREAKOUT_TOL_BPS / 10000);
            const breakoutOk = lastPx >= hh + tol;

            if (regimeOk && breakoutOk) {
              // 슬리피지 제한
              const ref = tClose || lastPx;
              const slip = ((lastPx - ref) / ref) * 10000;
              if (slip <= ENTRY_SLIPPAGE_BPS) {
                const r = await marketBuy(symbol, lastPx);
                if (r.ok) {
                  const size: number = Number(r.amt);
                  if (!Number.isFinite(size) || size <= 0) {
                    await tg(`❗ 진입 실패: ${symbol} | invalid-size`);
                  } else {
                    const baseStop = lastPx * (1 + STOP_LOSS_PCT);
                    positions.set(symbol, {
                      entry: lastPx,
                      size,
                      invested: size * lastPx,
                      peak: lastPx,
                      tookTP1: false,
                      openedAt: Date.now(),
                      stopPrice: baseStop,
                      initialRiskPct: STOP_LOSS_PCT,
                    });
                    incTradeCount(symbol);
                    await tg(
                      `🟢 진입: ${symbol} @${Math.round(
                        lastPx
                      )} | size≈${size.toFixed(6)}`
                    );
                  }
                } else {
                  await tg(`❗ 진입 실패: ${symbol} | ${r.reason}`);
                }
              } else {
                await tg(
                  `⚠️ 슬리피지 초과로 진입 취소: ${symbol} slip=${slip.toFixed(
                    1
                  )}bps`
                );
              }
            }
          }
        }

        await sleep(1500);
      }
    } catch (e: any) {
      await tg(`❗ runner error(${symbol}): ${e?.message || e}`);
      await sleep(2000);
    }
  }
}

// ===================== MAIN =====================
async function main() {
  const symbols = TRADE_COINS.length ? TRADE_COINS : [SYMBOL_CCXT];
  const codes = symbols.map(toUpbitCode);

  // 이전 상태 복구
  try {
    const prev = await loadState();
    if (prev?.positions) {
      for (const [k, raw] of Object.entries(prev.positions as any)) {
        const vRaw: any = raw as any;
        const v: Pos = {
          entry: Number(vRaw.entry) || 0,
          size: Number(vRaw.size) || 0,
          invested: Number(vRaw.invested) || 0,
          peak: Number(vRaw.peak ?? vRaw.entry) || 0,
          tookTP1: Boolean(vRaw.tookTP1),
          openedAt: Number(vRaw.openedAt) || Date.now(),
          stopPrice:
            typeof vRaw.stopPrice === "number"
              ? Number(vRaw.stopPrice)
              : undefined,
          initialRiskPct:
            typeof vRaw.initialRiskPct === "number"
              ? Number(vRaw.initialRiskPct)
              : undefined,
        };
        positions.set(k, v);
      }
    }
    if (prev?.tradesToday) {
      // Record<string, number>
      for (const [k, v] of Object.entries(
        prev.tradesToday as Record<string, number>
      )) {
        tradeCounter.set(k, Number(v) || 0);
      }
    }
    if (typeof (prev as any).paused !== "undefined") {
      paused = Boolean((prev as any).paused);
    }
  } catch {}

  const feed = new UpbitTickerFeed(codes);
  feed.connect();

  console.log(
    `BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`
  );
  await tg(
    `🚀 BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`
  );

  // 시작 1회 동기화
  await syncPositionsFromWalletOnce(symbols, feed);

  // 전략 루프 시작
  symbols.forEach((s) => {
    runner(s, feed).catch((e) =>
      tg(`❗ runner error(${s}): ${e?.message || e}`)
    );
  });

  // 주기 동기화(지연 시작)
  const syncMs = Math.max(1, SYNC_POS_INTERVAL_MIN) * 60 * 1000;
  setTimeout(() => {
    reconcilePositionsFromWallet(symbols, feed).catch((e) =>
      tg(`⚠️ 주기 동기화 오류: ${e?.message || e}`)
    );
    setInterval(() => {
      reconcilePositionsFromWallet(symbols, feed).catch((e) =>
        tg(`⚠️ 주기 동기화 오류: ${e?.message || e}`)
      );
    }, syncMs);
  }, syncMs);

  // Autosave
  const autosaveMs = AUTOSAVE_MIN * 60 * 1000;
  setInterval(() => {
    try {
      const out: Record<string, Pos> = {};
      positions.forEach((v, k) => (out[k] = { ...v }));
      const trades: Record<string, number> = {};
      tradeCounter.forEach((cnt, k) => (trades[k] = cnt));
      saveState({ positions: out as any, tradesToday: trades, paused });
      console.log("[AUTOSAVE] persisted");
    } catch (e) {
      console.error("[AUTOSAVE] fail", e);
    }
  }, autosaveMs);

  process.on("SIGINT", async () => {
    await tg("👋 종료(SIGINT)");
    try {
      // persist 타입에 딱 맞게 정규화하여 저장
      const outStrict: Record<
        string,
        {
          entry: number;
          size: number;
          invested: number;
          peak: number;
          tookTP1: boolean;
          openedAt: number;
          bePrice?: number;
        }
      > = {};
      positions.forEach((v, k) => {
        outStrict[k] = {
          entry: Number(v.entry) || 0,
          size: Number(v.size) || 0,
          invested: Number(v.invested) || 0,
          peak: Number(v.peak ?? v.entry) || 0,
          tookTP1: Boolean(v.tookTP1),
          openedAt: Number(v.openedAt) || Date.now(),
          // 추가 메타 (백업용)
          stopPrice: typeof v.stopPrice === "number" ? v.stopPrice : undefined,
          initialRiskPct:
            typeof v.initialRiskPct === "number" ? v.initialRiskPct : undefined,
        } as any;
      });

      const tradesTodayObj: Record<string, number> = {};
      tradeCounter.forEach((cnt, k) => (tradesTodayObj[k] = Number(cnt) || 0));

      await saveState({
        positions: outStrict,
        tradesToday: tradesTodayObj,
        paused,
      });
    } catch {}
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await tg("👋 종료(SIGTERM)");
    try {
      const outStrict: Record<
        string,
        {
          entry: number;
          size: number;
          invested: number;
          peak: number;
          tookTP1: boolean;
          openedAt: number;
          bePrice?: number;
        }
      > = {};
      positions.forEach((v, k) => {
        outStrict[k] = {
          entry: Number(v.entry) || 0,
          size: Number(v.size) || 0,
          invested: Number(v.invested) || 0,
          peak: Number(v.peak ?? v.entry) || 0,
          tookTP1: Boolean(v.tookTP1),
          openedAt: Number(v.openedAt) || Date.now(),
          stopPrice: typeof v.stopPrice === "number" ? v.stopPrice : undefined,
          initialRiskPct:
            typeof v.initialRiskPct === "number" ? v.initialRiskPct : undefined,
        } as any;
      });

      const tradesTodayObj: Record<string, number> = {};
      tradeCounter.forEach((cnt, k) => (tradesTodayObj[k] = Number(cnt) || 0));

      await saveState({
        positions: outStrict,
        tradesToday: tradesTodayObj,
        paused,
      });
    } catch {}
    process.exit(0);
  });
}

main().catch(async (e) => {
  console.error(e);
  await tg(`💥 FATAL: ${e?.message || e}`);
  process.exit(1);
});
