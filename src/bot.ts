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
const KILL_SWITCH = bool(process.env.KILL_SWITCH, false); // 실거래 강제 차단 스위치

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
let FEE_BPS = clamp(num(process.env.FEE_BPS, 5), 0, 100); // 0.05% 기본 (5 bps)
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
// STOP_LOSS_PCT 우선, 없으면 과거 변수명 STOP_LOSS fallback
const STOP_LOSS_PCT = clamp(
  num(
    process.env.STOP_LOSS_PCT !== undefined
      ? process.env.STOP_LOSS_PCT
      : process.env.STOP_LOSS,
    -0.03
  ),
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
// 매수 실패 쿨다운(ms)
const BUY_FAIL_COOLDOWN_MS = clamp(
  num(process.env.BUY_FAIL_COOLDOWN_MS, 15_000),
  1_000,
  300_000
);
// 최소주문금액 여유 버퍼(KRW): 서버 라운딩/수수료 반영 오차 방지용
const MIN_TOTAL_SAFETY_KRW = clamp(
  num(process.env.MIN_TOTAL_SAFETY_KRW, 200),
  0,
  10_000
);

// ===== 추가 사이징/리스크 옵션 =====
// 고정 1회 진입 금액이 지정되면 POS_PCT 기반 계산을 덮어씀
const FIXED_ENTRY_KRW = clamp(
  num(process.env.FIXED_ENTRY_KRW, 0),
  0,
  1_000_000_000
);
// 심볼별 커스텀 진입 금액: PER_SYMBOL_ENTRY="BTC/KRW:70000,ETH/KRW:80000"
const PER_SYMBOL_ENTRY_RAW = process.env.PER_SYMBOL_ENTRY || "";
const PER_SYMBOL_ENTRY: Record<string, number> = {};
if (PER_SYMBOL_ENTRY_RAW.trim()) {
  PER_SYMBOL_ENTRY_RAW.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [sym, val] = pair.split(":");
      const v = Math.floor(Number(val));
      if (sym && Number.isFinite(v) && v > 0) PER_SYMBOL_ENTRY[sym.trim()] = v;
    });
}
// 총 익스포저 제한 (현재 오픈 포지션 invested 총합 + 신규 예정 금액) / BASE_CAPITAL_KRW <= 제한
const TOT_EXPOSURE_GUARD_PCT = clamp(
  num(process.env.TOT_EXPOSURE_GUARD_PCT, 0.9),
  0.05,
  5
); // 5배 이상은 비현실적이므로 상한

function plannedEntryCost(symbol: string): number {
  // 우선순위: 심볼별 > 고정 > 비율(POS_PCT)
  if (PER_SYMBOL_ENTRY[symbol]) return PER_SYMBOL_ENTRY[symbol];
  if (FIXED_ENTRY_KRW > 0) return FIXED_ENTRY_KRW;
  return Math.floor(BASE_CAPITAL_KRW * POS_PCT);
}

// ===== 불장(강상승) 대응 옵션 =====
// auto: EMA 갭 기준 자동 감지, on: 항상 불장 모드, off: 사용 안함
const BULL_MODE = (process.env.BULL_MODE || "auto") as "auto" | "on" | "off";
// fast>=slow && price가 slow 위로 일정 갭(bps) 이상이면 불장으로 간주
const BULL_EMA_GAP_BPS = clamp(num(process.env.BULL_EMA_GAP_BPS, 40), 0, 5000);
// 불장 시 TP1 분할 비율(기본 30%) / 일반 시 기본 50%
const TP1_SELL_FRAC = clamp(num(process.env.TP1_SELL_FRAC, 0.5), 0.05, 0.95);
const TP1_SELL_FRAC_BULL = clamp(
  num(process.env.TP1_SELL_FRAC_BULL, 0.3),
  0.05,
  0.95
);
// 불장 시 TP2, 트레일, 슬리피지, 동적 스톱 버퍼 상향 여유
const TP2_BULL = clamp(num(process.env.TP2_BULL, 0.035), TP1 + 0.001, 1);
const TRAIL_BULL = clamp(num(process.env.TRAIL_BULL, -0.03), -0.5, -0.001);
const ENTRY_SLIPPAGE_BPS_BULL = clamp(
  num(process.env.ENTRY_SLIPPAGE_BPS_BULL, 60),
  1,
  2000
);
const DYN_STOP_BUFFER_BPS_BULL = clamp(
  num(process.env.DYN_STOP_BUFFER_BPS_BULL, 150),
  10,
  5000
);
const QUIET_HOUR_BULL_OVERRIDE = bool(
  process.env.QUIET_HOUR_BULL_OVERRIDE,
  true
);

console.log("CONFIG", {
  MODE,
  SYMBOL_CCXT,
  TF,
  BASE_CAPITAL_KRW,
  POS_PCT,
  FIXED_ENTRY_KRW,
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
  FEE_BPS,
  TOT_EXPOSURE_GUARD_PCT,
  KILL_SWITCH,
  BUY_FAIL_COOLDOWN_MS,
  MIN_TOTAL_SAFETY_KRW,
  BULL_MODE,
  BULL_EMA_GAP_BPS,
  TP1_SELL_FRAC,
  TP1_SELL_FRAC_BULL,
  TP2_BULL,
  TRAIL_BULL,
  ENTRY_SLIPPAGE_BPS_BULL,
  DYN_STOP_BUFFER_BPS_BULL,
  QUIET_HOUR_BULL_OVERRIDE,
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
  originalEntry?: number; // 최초 진입가 (BEP 조정 전)
  accFee?: number; // 누적 수수료 (quote 단위)
  runningNet?: number; // 부분 실현 순익 누계
  runningGross?: number; // 부분 실현 총익
  runningFee?: number; // 부분 실현 수수료 합
};
const positions: Map<string, Pos> = new Map();

// tradesToday: persist 규격에 맞게 "숫자만" 저장
const tradeCounter: Map<string, number> = new Map();
let paused = false; // persist용
let realizedToday = 0; // 누적 실현 손익 (KRW)
const failureCounts: Record<string, number> = {};
function incFail(reason: string) {
  failureCounts[reason] = (failureCounts[reason] || 0) + 1;
}
let winsToday = 0;
let lossesToday = 0;
let grossToday = 0;
let feeToday = 0;
// realizedToday 는 netToday 로 사용 (기존 변수 재활용)
const MAX_DAILY_DRAWDOWN_PCT = clamp(
  num(process.env.MAX_DAILY_DRAWDOWN_PCT, -0.05),
  -0.5,
  -0.001
); // 음수: -0.05 => -5%
function canEnterByLossLimit(): boolean {
  if (MAX_DAILY_DRAWDOWN_PCT >= 0) return true; // 비활성화 의미
  const baseEq = BASE_CAPITAL_KRW;
  if (baseEq <= 0) return true;
  const ddPct = realizedToday / baseEq; // realizedToday가 손실이면 음수
  return ddPct > MAX_DAILY_DRAWDOWN_PCT; // 더 낮게 내려가면 false
}

// ===================== EXCHANGE =====================
const exchange = new ccxt.upbit({
  apiKey: UPBIT_API_KEY || undefined,
  secret: UPBIT_SECRET || undefined,
  enableRateLimit: true,
});
// 타입 제약으로 인한 사후 옵션 설정
try {
  (exchange as any).options = {
    ...((exchange as any).options || {}),
    createMarketBuyOrderRequiresPrice: false,
  };
} catch {}

// ===================== FEES =====================
// Upbit 기본 수수료 (예: 0.05% = 5 bps) 각 체결금액 기준 양쪽 모두 발생한다고 가정 (시장가/지정가 동일 비율 가정)
// 순손익(net) 계산: gross = (exit - entry) * qty, fee = (entry + exit) * qty * feeRate
// net = gross - fee
const FEE_RATE = FEE_BPS / 10000;
function netPnlAfterFees(entry: number, exit: number, qty: number) {
  const gross = (exit - entry) * qty;
  if (FEE_RATE <= 0) return gross;
  const fee = (entry + exit) * qty * FEE_RATE;
  return gross - fee;
}
function pnlBreakdown(entry: number, exit: number, qty: number) {
  const gross = (exit - entry) * qty;
  const fee = FEE_RATE > 0 ? (entry + exit) * qty * FEE_RATE : 0;
  const net = gross - fee;
  return { gross, fee, net };
}

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
  // Stable KST date string (YYYY-MM-DD) without timezone re-interpretation issues
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}
let counterDay = todayStrKST();
function ensureDayFresh() {
  const t = todayStrKST();
  if (t !== counterDay) {
    tradeCounter.clear(); // 날짜 바뀌면 일일 카운터 리셋
    // realizedToday 초기화는 데일리 리포트 타이머에서 처리
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

let _marketsLoaded = false;
const _upscaleNotified = new Set<string>();
const _stopFailCooldown: Map<string, number> = new Map(); // symbol -> next allowable sell attempt ts
// 매수 실패 쿨다운
const _buyFailCooldown: Map<string, number> = new Map();

function inStopCooldown(symbol: string) {
  const t = _stopFailCooldown.get(symbol) || 0;
  return Date.now() < t;
}
function setStopCooldown(symbol: string, ms: number) {
  _stopFailCooldown.set(symbol, Date.now() + ms);
}

function inBuyCooldown(symbol: string) {
  const t = _buyFailCooldown.get(symbol) || 0;
  return Date.now() < t;
}
function setBuyCooldown(symbol: string, ms: number) {
  _buyFailCooldown.set(symbol, Date.now() + ms);
}

async function preflight(symbols: string[]) {
  // Load markets once
  if (!_marketsLoaded) {
    try {
      await exchange.loadMarkets();
    } catch {}
    _marketsLoaded = true;
  }
  for (const sym of symbols) {
    const mi: any = getMarketInfo(sym) || {};
    const minCost = Number(mi?.limits?.cost?.min) || LIVE_MIN_ORDER_KRW;
    let baseTarget = plannedEntryCost(sym);
    if (baseTarget < LIVE_MIN_ORDER_KRW) baseTarget = LIVE_MIN_ORDER_KRW;
    // 마켓 최소 금액보다 작으면 자동 업스케일(기존 로직 유지)
    const precisionDigits = Number.isInteger(mi?.precision?.amount)
      ? mi.precision.amount
      : undefined;
    const minAmount = Number(mi?.limits?.amount?.min) || 0;
    const willUpscale = baseTarget < minCost;
    let msg = `🧪 PRECHECK ${sym} baseTarget=${baseTarget} minCost=${minCost}`;
    if (willUpscale) msg += ` → upscale to ${minCost}`;
    msg += ` | minAmount=${minAmount || 0} prec=${precisionDigits ?? "n/a"}`;
    await tg(msg);
    if (willUpscale) _upscaleNotified.add(sym);
  }
}

async function marketBuy(symbol: string, lastPx: number) {
  if (!_marketsLoaded) {
    try {
      await exchange.loadMarkets();
    } catch {}
    _marketsLoaded = true;
  }
  const mi: any = getMarketInfo(symbol);

  // 목표 예산(KRW) 산출 + 안전 버퍼
  let targetCost = plannedEntryCost(symbol);
  if (targetCost < LIVE_MIN_ORDER_KRW) targetCost = LIVE_MIN_ORDER_KRW;

  // 마켓 최소 비용/수량 확인 (Upbit는 최소 주문 금액 제한 존재)
  const minCost = Number(mi?.limits?.cost?.min) || LIVE_MIN_ORDER_KRW;
  if (targetCost < minCost) {
    // Option 2: 자동 상향
    if (!_upscaleNotified.has(symbol)) {
      tg(
        `⚠️ targetCost(${targetCost}) < minCost(${minCost}) → auto upscale for ${symbol}`
      );
      _upscaleNotified.add(symbol);
    }
    targetCost = minCost;
  }

  // ===== 수량 계산 (정밀도/최소비용 고려) =====
  const rawAmount = (targetCost + MIN_TOTAL_SAFETY_KRW) / lastPx; // 희망 base 수량(안전 버퍼 적용)
  const precisionDigits = Number.isInteger(mi?.precision?.amount)
    ? mi.precision.amount
    : undefined;
  const step =
    precisionDigits !== undefined ? Math.pow(10, -precisionDigits) : 0;

  let amount: number;
  if (precisionDigits !== undefined) {
    amount = parseFloat(rawAmount.toFixed(precisionDigits));
  } else if (step) {
    amount = floorToStep(rawAmount, step);
  } else {
    amount = rawAmount;
  }

  // 만약 라운딩으로 0이 되었으면 최소 단위로 보정
  if (amount === 0 && precisionDigits !== undefined) {
    amount = Number(`0.${"0".repeat(Math.max(0, precisionDigits - 1))}1`);
  }

  const minAmount = Number(mi?.limits?.amount?.min) || 0;
  if (minAmount && amount < minAmount) {
    amount = minAmount;
  }

  // 최소 비용 충족 못 하면 비용을 minCost로 올려 재산출 시도
  let finalCost = amount * lastPx;
  if (finalCost < minCost + MIN_TOTAL_SAFETY_KRW) {
    amount = (minCost + MIN_TOTAL_SAFETY_KRW) / lastPx;
    if (precisionDigits !== undefined)
      amount = parseFloat(amount.toFixed(precisionDigits));
    finalCost = amount * lastPx;
  }

  // 여전히 0 또는 너무 작은 경우
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false as const,
      reason: `amount-too-small(raw=${rawAmount}, step=${step || "n/a"}, prec=${
        precisionDigits ?? "n/a"
      })`,
    };
  }

  if (finalCost < minCost) {
    return {
      ok: false as const,
      reason: `final-cost-below-min (final=${finalCost.toFixed(
        2
      )} < min=${minCost})`,
    };
  }

  if (KILL_SWITCH || MODE === "paper") {
    return { ok: true as const, paper: true as const, amt: Number(amount) };
  }

  try {
    // 1) 비용(cost) 기반 우선 시도: 안전버퍼 포함한 quote 비용으로 주문
    const quoteCost = Math.ceil(
      Math.max(finalCost, minCost) + MIN_TOTAL_SAFETY_KRW
    );
    const oCost = await (exchange as any).createOrder(
      symbol,
      "market",
      "buy",
      quoteCost,
      undefined,
      { createMarketBuyOrderRequiresPrice: false }
    );
    return { ok: true as const, order: oCost, amt: Number(amount) };
  } catch (e: any) {
    const msg = String(e?.message || "");
    // under_min_total_bid일 때 한 번 더 비용을 키워 재시도
    if (/under_min_total_bid/i.test(msg)) {
      try {
        const bumpCost = Math.ceil(minCost + MIN_TOTAL_SAFETY_KRW + 1000);
        const oBump = await (exchange as any).createOrder(
          symbol,
          "market",
          "buy",
          bumpCost,
          undefined,
          { createMarketBuyOrderRequiresPrice: false }
        );
        return { ok: true as const, order: oBump, amt: Number(amount) };
      } catch (e2: any) {
        // 마지막 대안: base 수량 + price 힌트로 시도
        try {
          const oBase = await exchange.createOrder(
            symbol,
            "market",
            "buy",
            amount,
            lastPx
          );
          return { ok: true as const, order: oBase, amt: Number(amount) };
        } catch (e3: any) {
          return { ok: false as const, reason: e3?.message || "buy-failed" };
        }
      }
    }
    // 일반 오류: base 수량 + price 힌트로 재시도
    try {
      const oBase = await exchange.createOrder(
        symbol,
        "market",
        "buy",
        amount,
        lastPx
      );
      return { ok: true as const, order: oBase, amt: Number(amount) };
    } catch (e4: any) {
      return { ok: false as const, reason: e4?.message || "buy-failed" };
    }
  }
}

async function marketSell(symbol: string, amt: number) {
  if (amt <= 0) return { ok: false as const, reason: "zero-amt" };
  if (KILL_SWITCH || MODE === "paper")
    return { ok: true as const, paper: true as const, amt };
  try {
    const o = await exchange.createOrder(symbol, "market", "sell", amt);
    return { ok: true as const, order: o };
  } catch (e: any) {
    return { ok: false as const, reason: e?.message || "sell-failed" };
  }
}

// ===== 실제 체결 기반 보정 (엔트리) =====
async function refineEntryFromTrades(
  symbol: string,
  expectedAmt: number,
  pos: Pos
) {
  try {
    const since = Date.now() - 60_000; // 최근 1분 내 체결 탐색
    // ccxt upbit fetchMyTrades(symbol?, since?, limit?)
    const trades: any[] = await (exchange as any)
      .fetchMyTrades(symbol, since, 50)
      .catch(() => []);
    if (!Array.isArray(trades) || !trades.length) return;
    // side==='buy' & amount 합이 예상 수량에 근접한 것들 (최근 것부터 역순 누적)
    const buys = trades.filter((t) => t.side === "buy" && t.symbol === symbol);
    if (!buys.length) return;
    // 시간 역순 정렬
    buys.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    let accAmt = 0;
    let costSum = 0;
    let feeSum = 0;
    for (const tr of buys) {
      const a = Number(tr.amount) || 0;
      const p = Number(tr.price) || 0;
      if (a <= 0 || p <= 0) continue;
      accAmt += a;
      costSum += a * p;
      if (tr.fee && typeof tr.fee.cost === "number") {
        // Upbit 수수료는 quote (KRW) 차감 가정
        feeSum += tr.fee.cost;
      }
      // 충분히 누적되면 종료
      if (accAmt >= expectedAmt * 0.95) break; // 95% 이상 수집되면 인정
    }
    if (accAmt > 0) {
      const avg = costSum / accAmt;
      pos.entry = avg; // 실제 평균 매수가
      if (!pos.originalEntry) pos.originalEntry = avg;
      pos.accFee = (pos.accFee || 0) + feeSum;
    }
  } catch {}
}

async function tryAdaptiveSell(
  symbol: string,
  desiredAmt: number,
  lastPx: number
) {
  // 1차 시도
  let first = await marketSell(symbol, desiredAmt);
  if (first.ok) return { attempt: 1, sold: desiredAmt, result: first };
  const reason = first.reason || "";
  if (!/insufficient_funds/i.test(reason)) {
    return { attempt: 1, sold: 0, result: first };
  }
  // 잔고 재조회 후 가능한 수량으로 재시도
  try {
    const bal = await exchange.fetchBalance();
    const base = symbol.split("/")[0];
    let avail = safeWalletQty(bal, base);
    if (avail <= 0) {
      return { attempt: 2, sold: 0, result: first };
    }
    // 약간의 수수료/잔량 버퍼
    avail *= 0.9995;
    if (avail <= 0) return { attempt: 2, sold: 0, result: first };
    // 정밀도 보정
    const mi: any = getMarketInfo(symbol);
    const precisionDigits = Number.isInteger(mi?.precision?.amount)
      ? mi.precision.amount
      : undefined;
    if (precisionDigits !== undefined) {
      avail = parseFloat(avail.toFixed(precisionDigits));
    }
    const minAmount = Number(mi?.limits?.amount?.min) || 0;
    if (minAmount && avail < minAmount) {
      // 사실상 버릴만한 먼지: 포지션 제거 처리
      return {
        attempt: 2,
        sold: 0,
        result: { ok: false, reason: "dust-below-min-amount" },
      } as any;
    }
    if (avail <= 0) return { attempt: 2, sold: 0, result: first };
    const second = await marketSell(symbol, avail);
    if (second.ok) return { attempt: 2, sold: avail, result: second };
    return { attempt: 2, sold: 0, result: second };
  } catch (e: any) {
    return {
      attempt: 2,
      sold: 0,
      result: { ok: false, reason: e?.message || "adaptive-sell-failed" },
    };
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
      let quiet = inQuietHours();

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

        // 불장 감지
        let bullBias = false;
        if (BULL_MODE === "on") bullBias = true;
        else if (BULL_MODE === "auto") {
          const gapBps = slow > 0 ? ((lastPx - slow) / slow) * 10000 : 0;
          bullBias =
            (USE_REGIME_FILTER ? fast >= slow : true) &&
            gapBps >= BULL_EMA_GAP_BPS;
        }
        // 불장에서 조용시간 무시 옵션
        if (bullBias && QUIET_HOUR_BULL_OVERRIDE) quiet = false;

        // 불장/일반 별 파라미터 활성값
        const tp1SellFracActive = bullBias ? TP1_SELL_FRAC_BULL : TP1_SELL_FRAC;
        const tp2Active = bullBias ? TP2_BULL : TP2;
        const activeTrail = bullBias ? TRAIL_BULL : TRAIL;
        const activeDynStopBps = bullBias
          ? DYN_STOP_BUFFER_BPS_BULL
          : DYN_STOP_BUFFER_BPS;
        const slipAllowedBps = bullBias
          ? ENTRY_SLIPPAGE_BPS_BULL
          : ENTRY_SLIPPAGE_BPS;

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
            const buffer = pos.entry * (activeDynStopBps / 10000);
            const candidate = pos.peak - buffer;
            if (!pos.stopPrice || candidate > pos.stopPrice) {
              // stop은 entry보다 아래로 (롱 기준) 너무 올라가지 않도록 (진입 직후 peak=entry 상황 보호)
              pos.stopPrice = Math.min(candidate, pos.peak * 0.9995);
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
          let fullyExited = false;
          if (lastPx <= activeStop) {
            if (inStopCooldown(symbol)) {
              // 쿨다운 중 → 재시도 지연
            } else {
              const adaptive = await tryAdaptiveSell(symbol, pos.size, lastPx);
              const r = adaptive.result;
              if (r.ok && adaptive.sold > 0) {
                const refEntry = pos.originalEntry ?? pos.entry;
                const { gross, fee, net } = pnlBreakdown(
                  refEntry,
                  lastPx,
                  adaptive.sold
                );
                realizedToday += net;
                grossToday += gross;
                feeToday += fee;
                const remaining = pos.size - adaptive.sold;
                const pct = ((lastPx - refEntry) / refEntry) * 100;
                if (remaining <= pos.size * 0.05 || remaining <= 0) {
                  positions.delete(symbol);
                  fullyExited = true;
                  await tg(
                    `❌ 손절: ${symbol} @${Math.round(lastPx)} (${pct.toFixed(
                      2
                    )}%) sold=${adaptive.sold.toFixed(
                      6
                    )} full-exit\n gross=${gross.toFixed(0)} fee=${fee.toFixed(
                      0
                    )} net=${net.toFixed(0)} cum=${Math.round(realizedToday)}`
                  );
                } else {
                  pos.size = remaining;
                  pos.invested = pos.size * lastPx;
                  if (pos.stopPrice && pos.stopPrice > activeStop) {
                    pos.stopPrice = activeStop;
                  }
                  positions.set(symbol, pos);
                  await tg(
                    `❌ 부분 손절: ${symbol} @${Math.round(
                      lastPx
                    )} 남은=${pos.size.toFixed(6)} sold=${adaptive.sold.toFixed(
                      6
                    )}\n gross=${gross.toFixed(0)} fee=${fee.toFixed(
                      0
                    )} net=${net.toFixed(0)} cum=${Math.round(realizedToday)}`
                  );
                }
              } else {
                await tg(`❗ 손절 실패: ${symbol} | ${r.reason}`);
                if (/insufficient_funds/i.test(r.reason || "")) {
                  setStopCooldown(symbol, 10_000); // 10초 쿨다운
                }
              }
            }
          }
          if (fullyExited) {
            await sleep(1000);
            continue; // 손절 후 다른 청산 로직 중복 방지
          }

          // TP1 (절반 익절)
          if (!pos.tookTP1 && pnlPct >= TP1) {
            const sellAmt = pos.size * tp1SellFracActive;
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
              const refEntry = pos.originalEntry ?? pos.entry;
              const { gross, fee, net } = pnlBreakdown(
                refEntry,
                lastPx,
                sellAmt
              );
              realizedToday += net;
              grossToday += gross;
              feeToday += fee;
              if (net >= 0) winsToday++;
              else lossesToday++;
              await tg(
                `✅ TP1: ${symbol} 50% 익절 | 잔여=${pos.size.toFixed(
                  6
                )}\n gross=${gross.toFixed(0)} fee=${fee.toFixed(
                  0
                )} net=${net.toFixed(0)} cum=${Math.round(realizedToday)}`
              );
            } else {
              await tg(`❗ TP1 실패: ${symbol} | ${r.reason}`);
            }
          }

          // TP2 (전량 익절) or 트레일
          if (pnlPct >= tp2Active) {
            const adaptive = await tryAdaptiveSell(symbol, pos.size, lastPx);
            const r = adaptive.result;
            if (r.ok && adaptive.sold > 0) {
              const refEntry = pos.originalEntry ?? pos.entry;
              const { gross, fee, net } = pnlBreakdown(
                refEntry,
                lastPx,
                adaptive.sold
              );
              realizedToday += net;
              grossToday += gross;
              feeToday += fee;
              const remaining = pos.size - adaptive.sold;
              if (remaining <= pos.size * 0.05 || remaining <= 0) {
                positions.delete(symbol);
                if (net >= 0) winsToday++;
                else lossesToday++;
                await tg(
                  `🎯 TP2: ${symbol} 전량/거의 전량 익절 sold=${adaptive.sold.toFixed(
                    6
                  )}\n gross=${gross.toFixed(0)} fee=${fee.toFixed(
                    0
                  )} net=${net.toFixed(0)} cum=${Math.round(realizedToday)}`
                );
              } else {
                pos.size = remaining;
                pos.invested = pos.size * lastPx;
                positions.set(symbol, pos);
                await tg(
                  `🎯 TP2 부분: ${symbol} 남은=${remaining.toFixed(
                    6
                  )} sold=${adaptive.sold.toFixed(6)}\n gross=${gross.toFixed(
                    0
                  )} fee=${fee.toFixed(0)} net=${net.toFixed(
                    0
                  )} cum=${Math.round(realizedToday)}`
                );
              }
            } else {
              await tg(`❗ TP2 실패: ${symbol} | ${r.reason}`);
            }
          } else if ((lastPx - pos.peak) / pos.peak <= activeTrail) {
            const adaptive = await tryAdaptiveSell(symbol, pos.size, lastPx);
            const r = adaptive.result;
            if (r.ok && adaptive.sold > 0) {
              const refEntry = pos.originalEntry ?? pos.entry;
              const { gross, fee, net } = pnlBreakdown(
                refEntry,
                lastPx,
                adaptive.sold
              );
              realizedToday += net;
              grossToday += gross;
              feeToday += fee;
              const remaining = pos.size - adaptive.sold;
              if (remaining <= pos.size * 0.05 || remaining <= 0) {
                positions.delete(symbol);
                if (net >= 0) winsToday++;
                else lossesToday++;
                await tg(
                  `🛑 트레일 스탑: ${symbol} 청산 sold=${adaptive.sold.toFixed(
                    6
                  )}\n gross=${gross.toFixed(0)} fee=${fee.toFixed(
                    0
                  )} net=${net.toFixed(0)} cum=${Math.round(realizedToday)}`
                );
              } else {
                pos.size = remaining;
                pos.invested = pos.size * lastPx;
                positions.set(symbol, pos);
                await tg(
                  `🛑 트레일 부분: ${symbol} 남은=${remaining.toFixed(
                    6
                  )} sold=${adaptive.sold.toFixed(6)}\n gross=${gross.toFixed(
                    0
                  )} fee=${fee.toFixed(0)} net=${net.toFixed(
                    0
                  )} cum=${Math.round(realizedToday)}`
                );
              }
            } else {
              await tg(`❗ 트레일 실패: ${symbol} | ${r.reason}`);
            }
          }
        }

        // ====== 신규 진입 ======
        if (!inPos && !quiet && canEnterByLossLimit()) {
          if (Array.from(positions.keys()).length >= MAX_CONCURRENT_POS) {
            // 동시 포지션 제한 → 스킵
          } else if (getTradeCount(symbol) >= MAX_TRADES_PER_DAY) {
            // 일일 진입 제한 → 스킵
          } else if (inBuyCooldown(symbol)) {
            // 매수 실패 쿨다운 중 → 스킵
          } else {
            // 총 익스포저 가드 확인
            try {
              const curExposure = Array.from(positions.values()).reduce(
                (acc, p) => acc + (Number(p.invested) || 0),
                0
              );
              const plannedCost = plannedEntryCost(symbol);
              const limitCap = BASE_CAPITAL_KRW * TOT_EXPOSURE_GUARD_PCT;
              if (limitCap > 0 && curExposure + plannedCost > limitCap) {
                incFail("exposure-cap");
                // 노출 한도 초과 → 스킵 (텔레그램 한번 알림)
                await tg(
                  `⛔ 익스포저 제한: cur=${curExposure.toFixed(
                    0
                  )} + plan=${plannedCost.toFixed(0)} > cap=${limitCap.toFixed(
                    0
                  )}`
                );
                await sleep(1500);
                continue;
              }
            } catch {}
            const regimeOk = !USE_REGIME_FILTER || fast >= slow;
            const tol = hh * (BREAKOUT_TOL_BPS / 10000);
            const breakoutOk = lastPx >= hh + tol;

            if (regimeOk && breakoutOk) {
              // 슬리피지 제한
              const ref = tClose || lastPx;
              const slip = ((lastPx - ref) / ref) * 10000;
              if (slip <= slipAllowedBps) {
                const r = await marketBuy(symbol, lastPx);
                if (r.ok) {
                  const size: number = Number(r.amt);
                  if (!Number.isFinite(size) || size <= 0) {
                    await tg(`❗ 진입 실패: ${symbol} | invalid-size`);
                  } else {
                    const baseStop = lastPx * (1 + STOP_LOSS_PCT);
                    positions.set(symbol, {
                      entry: lastPx,
                      originalEntry: lastPx,
                      size,
                      invested: size * lastPx,
                      peak: lastPx,
                      tookTP1: false,
                      openedAt: Date.now(),
                      stopPrice: baseStop,
                      initialRiskPct: STOP_LOSS_PCT,
                    });
                    const posRef = positions.get(symbol)!;
                    // 약간의 지연 후 실제 체결 기반 평균가격/수수료 재보정
                    setTimeout(() => {
                      refineEntryFromTrades(symbol, size, posRef).catch(
                        () => {}
                      );
                    }, 2500);
                    incTradeCount(symbol);
                    await tg(
                      `🟢 진입: ${symbol} @${Math.round(
                        lastPx
                      )} | size≈${size.toFixed(6)}`
                    );
                  }
                } else {
                  await tg(`❗ 진입 실패: ${symbol} | ${r.reason}`);
                  incFail(r.reason);
                  // 매수 실패 시 쿨다운 적용 (대표적인 실패 사유에 한함)
                  if (
                    /amount-too-small|final-cost-below-min|buy-failed/i.test(
                      r.reason
                    )
                  ) {
                    setBuyCooldown(symbol, BUY_FAIL_COOLDOWN_MS);
                  }
                }
              } else {
                await tg(
                  `⚠️ 슬리피지 초과로 진입 취소: ${symbol} slip=${slip.toFixed(
                    1
                  )}bps`
                );
                incFail("slippage-exceeded");
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
          originalEntry:
            typeof vRaw.originalEntry === "number"
              ? Number(vRaw.originalEntry)
              : Number(vRaw.entry) || 0,
          accFee: typeof vRaw.accFee === "number" ? Number(vRaw.accFee) : 0,
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
    if (prev?.failureCounts) {
      for (const [k, v] of Object.entries(prev.failureCounts)) {
        failureCounts[k] = Number(v) || 0;
      }
    }
    if (typeof (prev as any).realizedToday === "number") {
      realizedToday = Number((prev as any).realizedToday) || 0;
    }
    if (typeof (prev as any).winsToday === "number")
      winsToday = Number((prev as any).winsToday) || 0;
    if (typeof (prev as any).lossesToday === "number")
      lossesToday = Number((prev as any).lossesToday) || 0;
    if (typeof (prev as any).grossToday === "number")
      grossToday = Number((prev as any).grossToday) || 0;
    if (typeof (prev as any).feeToday === "number")
      feeToday = Number((prev as any).feeToday) || 0;
  } catch {}

  const feed = new UpbitTickerFeed(codes);
  feed.connect();

  console.log(
    `BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`
  );
  await tg(
    `🚀 BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`
  );

  // Preflight (시장 최소 조건 확인 및 upscale 통지)
  try {
    await preflight(symbols);
  } catch (e: any) {
    await tg(`⚠️ PRECHECK 실패: ${e?.message || e}`);
  }

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
      saveState({
        positions: out as any,
        tradesToday: trades,
        paused,
        realizedToday,
        failureCounts,
        winsToday,
        lossesToday,
        grossToday,
        feeToday,
      });
      console.log("[AUTOSAVE] persisted", { realizedToday });
    } catch (e) {
      console.error("[AUTOSAVE] fail", e);
    }
  }, autosaveMs);

  // Daily summary (KST) - run every 60s, detect date change
  let lastSummaryDay = todayStrKST();
  setInterval(() => {
    const d = todayStrKST();
    if (d !== lastSummaryDay) {
      // 날짜 바뀜 → 이전 날 요약 전송
      const totalTrades = winsToday + lossesToday;
      const winRate = totalTrades > 0 ? (winsToday / totalTrades) * 100 : 0;
      // 상위 실패 사유 3개 추출
      const failEntries = Object.entries(failureCounts).sort(
        (a, b) => b[1] - a[1]
      );
      const topFails = failEntries
        .slice(0, 3)
        .map(([r, c]) => `${r}:${c}`)
        .join(", ");
      tg(
        `📊 Daily Summary (${lastSummaryDay})\n gross=${grossToday.toFixed(
          0
        )} fee=${feeToday.toFixed(0)} net=${realizedToday.toFixed(
          0
        )}\n wins=${winsToday} losses=${lossesToday} winRate=${winRate.toFixed(
          1
        )}%\n fails:${topFails || "-"}`
      );
      // 날짜 넘어가기 직전 상태 저장
      try {
        const out: Record<string, Pos> = {};
        positions.forEach((v, k) => (out[k] = { ...v }));
        const trades: Record<string, number> = {};
        tradeCounter.forEach((cnt, k) => (trades[k] = cnt));
        saveState({
          positions: out as any,
          tradesToday: trades,
          paused,
          realizedToday,
          failureCounts,
          winsToday,
          lossesToday,
          grossToday,
          feeToday,
        });
      } catch {}
      // reset counters for new day
      lastSummaryDay = d;
      winsToday = 0;
      lossesToday = 0;
      grossToday = 0;
      feeToday = 0;
      realizedToday = 0;
    }
  }, 60_000);

  process.on("SIGINT", async () => {
    await tg("👋 종료(SIGINT)");
    try {
      // persist 타입에 딱 맞게 정규화하여 저장
      const outStrict: Record<string, any> = {};
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
          originalEntry:
            typeof v.originalEntry === "number" ? v.originalEntry : undefined,
          accFee: typeof v.accFee === "number" ? v.accFee : undefined,
        };
      });

      const tradesTodayObj: Record<string, number> = {};
      tradeCounter.forEach((cnt, k) => (tradesTodayObj[k] = Number(cnt) || 0));

      await saveState({
        positions: outStrict,
        tradesToday: tradesTodayObj,
        paused,
        realizedToday,
        failureCounts,
        winsToday,
        lossesToday,
        grossToday,
        feeToday,
      });
    } catch {}
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await tg("👋 종료(SIGTERM)");
    try {
      const outStrict: Record<string, any> = {};
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
          originalEntry:
            typeof v.originalEntry === "number" ? v.originalEntry : undefined,
          accFee: typeof v.accFee === "number" ? v.accFee : undefined,
        };
      });

      const tradesTodayObj: Record<string, number> = {};
      tradeCounter.forEach((cnt, k) => (tradesTodayObj[k] = Number(cnt) || 0));

      await saveState({
        positions: outStrict,
        tradesToday: tradesTodayObj,
        paused,
        realizedToday,
        failureCounts,
        winsToday,
        lossesToday,
        grossToday,
        feeToday,
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
