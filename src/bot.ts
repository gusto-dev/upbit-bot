// src/bot.ts — 안정 러너 + 주기 동기화 + 텔레그램 알림 (CJS 타깃)

import "dotenv/config";
import ccxt from "ccxt";
import { UpbitTickerFeed } from "./lib/wsTicker";
import { loadState, saveState } from "./lib/persist";
// 뉴스 필터 제거됨

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
const USE_FEE_SAFE_BEP = bool(process.env.USE_FEE_SAFE_BEP, true);
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
// 손절 후 재진입 쿨다운(분) 및 연속 진입 최소 간격(분)
const STOP_AFTER_STOP_COOLDOWN_MIN = clamp(
  num(process.env.STOP_AFTER_STOP_COOLDOWN_MIN, 0),
  0,
  120
);
const MIN_GAP_BETWEEN_ENTRIES_MIN = clamp(
  num(process.env.MIN_GAP_BETWEEN_ENTRIES_MIN, 0),
  0,
  120
);
// 쿨다운 알림 최소 간격(분)
const COOLDOWN_NOTICE_MIN = clamp(
  num(process.env.COOLDOWN_NOTICE_MIN, 5),
  1,
  1440
);
const DISABLE_BUY = bool(process.env.DISABLE_BUY, false);
const DEBUG_ENTRY_GATES = bool(process.env.DEBUG_ENTRY_GATES, false);
const DEBUG_ENTRY_LOG_FREQ_SEC = clamp(
  num(process.env.DEBUG_ENTRY_LOG_FREQ_SEC, 60),
  5,
  3600
);

// ===== 롱홀드 모드(손절 여유 확대 + 최대 보유기간 관리) =====
const LONG_HOLD_MODE = bool(process.env.LONG_HOLD_MODE, false);
const LONG_HOLD_MAX_DAYS = clamp(num(process.env.LONG_HOLD_MAX_DAYS, 7), 1, 30);
// ATR 기반 추가 버퍼 배수: stop buffer = max(entry * (BPS/1e4), ATR * K)
const LONG_HOLD_ATR_K = clamp(num(process.env.LONG_HOLD_ATR_K, 3), 0, 20);
// 롱홀드 시 사용할 느슨한 트레일 임계(예: -6%)
const LONG_HOLD_TRAIL = clamp(
  num(process.env.LONG_HOLD_TRAIL, -0.06),
  -0.5,
  -0.001
);
// TP1 후 스톱 타이트닝 비활성화 (롱홀드 시 기본 true)
const LONG_HOLD_DISABLE_TP_TIGHTEN = bool(
  process.env.LONG_HOLD_DISABLE_TP_TIGHTEN,
  true
);
// 최대 보유기간 초과 시 자동 청산 여부(기본 false), 알림은 항상 전송
const LONG_HOLD_TIME_EXIT = bool(process.env.LONG_HOLD_TIME_EXIT, false);

// 일일 손실 트레이드 수 초과 시 신규 진입 중단 (0이면 비활성화)
const HALT_AFTER_N_LOSSES = clamp(
  num(process.env.HALT_AFTER_N_LOSSES, 0),
  0,
  100
);
const HALT_NOTIFY_ONCE = bool(process.env.HALT_NOTIFY_ONCE, true);

// 일일 순이익 목표 도달 시 신규 진입 중단 (0이면 비활성화)
const DAILY_NET_PROFIT_CAP_PCT = clamp(
  num(process.env.DAILY_NET_PROFIT_CAP_PCT, 0),
  0,
  1
);
const DAILY_PROFIT_NOTIFY_ONCE = bool(
  process.env.DAILY_PROFIT_NOTIFY_ONCE,
  true
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
// 불장 토글 안정화: 히스테리시스(진입/이탈 임계)와 최소 유지 시간
const BULL_EMA_GAP_ENTER_BPS = clamp(
  num(process.env.BULL_EMA_GAP_ENTER_BPS, BULL_EMA_GAP_BPS),
  0,
  10000
);
const BULL_EMA_GAP_EXIT_BPS = clamp(
  num(
    process.env.BULL_EMA_GAP_EXIT_BPS,
    Math.max(0, BULL_EMA_GAP_ENTER_BPS - 15)
  ),
  0,
  10000
);
const BULL_MIN_HOLD_SEC = clamp(
  num(process.env.BULL_MIN_HOLD_SEC, 300),
  0,
  86400
);
const FLAT_MIN_HOLD_SEC = clamp(
  num(process.env.FLAT_MIN_HOLD_SEC, 300),
  0,
  86400
);
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
// Bull/Flat 전환 알림 최소 간격(초) - 알림 스팸 방지용
const BULL_EVENT_MIN_INTERVAL_SEC = clamp(
  num(process.env.BULL_EVENT_MIN_INTERVAL_SEC, 60),
  0,
  3600
);

// ===== 정교한 진입 게이트(손절 빈도 감소 목적) =====
// 이전 완성봉 종가가 돌파선(hh+tol) 위에서 마감되어야 진입 허용
const REQUIRE_BREAKOUT_CLOSE = bool(process.env.REQUIRE_BREAKOUT_CLOSE, true);
// 불장 시에는 완화할 수 있는 별도 스위치(기본 false=완화)
const REQUIRE_BREAKOUT_CLOSE_BULL = bool(
  process.env.REQUIRE_BREAKOUT_CLOSE_BULL,
  false
);
// 가격이 돌파선 위에서 최소 유지되어야 진입 (ms), 0이면 비활성화
const HOLD_ABOVE_BREAKOUT_MS = clamp(
  num(process.env.HOLD_ABOVE_BREAKOUT_MS, 1500),
  0,
  60_000
);
// 불장 시 유지시간을 더 짧게(완화)
const HOLD_ABOVE_BREAKOUT_MS_BULL = clamp(
  num(process.env.HOLD_ABOVE_BREAKOUT_MS_BULL, 500),
  0,
  60_000
);
// 돌파선 대비 과도한 확장 시 진입 금지 (bps). 0이면 비활성화
const MAX_BREAKOUT_EXTENSION_BPS = clamp(
  num(process.env.MAX_BREAKOUT_EXTENSION_BPS, 0),
  0,
  5000
);

// 불장 시 더 큰 확장을 허용(완화)
const MAX_BREAKOUT_EXTENSION_BPS_BULL = clamp(
  num(process.env.MAX_BREAKOUT_EXTENSION_BPS_BULL, 80),
  0,
  10000
);

// ===== 추가 필터: 상위 시간대 정합, 변동성 가드(ATR), 과매수(RSI), 이중 종가 확인 =====
const USE_HTF_FILTER = bool(process.env.USE_HTF_FILTER, true);
const HTF_TF = process.env.HTF_TF || "15m";
const HTF_EMA_FAST = clamp(num(process.env.HTF_EMA_FAST, 20), 2, 500);
const HTF_EMA_SLOW = clamp(num(process.env.HTF_EMA_SLOW, 60), 3, 1000);
const HTF_GAP_BPS = clamp(num(process.env.HTF_GAP_BPS, 20), 0, 10000);
const ATR_PERIOD = clamp(num(process.env.ATR_PERIOD, 14), 2, 200);
const ATR_MAX_PCT = clamp(num(process.env.ATR_MAX_PCT, 0.02), 0, 1);
const RSI_PERIOD = clamp(num(process.env.RSI_PERIOD, 14), 2, 200);
const RSI_OVERBOUGHT = clamp(num(process.env.RSI_OVERBOUGHT, 72), 0, 100);
const RSI_OVERBOUGHT_BULL = clamp(
  num(process.env.RSI_OVERBOUGHT_BULL, 78),
  0,
  100
);
const REQUIRE_DOUBLE_CLOSE = bool(process.env.REQUIRE_DOUBLE_CLOSE, false);

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
  BULL_EMA_GAP_ENTER_BPS,
  BULL_EMA_GAP_EXIT_BPS,
  BULL_MIN_HOLD_SEC,
  FLAT_MIN_HOLD_SEC,
  TP1_SELL_FRAC,
  TP1_SELL_FRAC_BULL,
  TP2_BULL,
  TRAIL_BULL,
  ENTRY_SLIPPAGE_BPS_BULL,
  DYN_STOP_BUFFER_BPS_BULL,
  QUIET_HOUR_BULL_OVERRIDE,
  REQUIRE_BREAKOUT_CLOSE,
  REQUIRE_BREAKOUT_CLOSE_BULL,
  HOLD_ABOVE_BREAKOUT_MS,
  HOLD_ABOVE_BREAKOUT_MS_BULL,
  MAX_BREAKOUT_EXTENSION_BPS,
  MAX_BREAKOUT_EXTENSION_BPS_BULL,
  USE_HTF_FILTER,
  HTF_TF,
  HTF_EMA_FAST,
  HTF_EMA_SLOW,
  HTF_GAP_BPS,
  ATR_PERIOD,
  ATR_MAX_PCT,
  RSI_PERIOD,
  RSI_OVERBOUGHT,
  RSI_OVERBOUGHT_BULL,
  REQUIRE_DOUBLE_CLOSE,
  STOP_AFTER_STOP_COOLDOWN_MIN,
  MIN_GAP_BETWEEN_ENTRIES_MIN,
  COOLDOWN_NOTICE_MIN,
  LONG_HOLD_MODE,
  LONG_HOLD_MAX_DAYS,
  LONG_HOLD_ATR_K,
  LONG_HOLD_TRAIL,
  LONG_HOLD_DISABLE_TP_TIGHTEN,
  LONG_HOLD_TIME_EXIT,
  HALT_AFTER_N_LOSSES,
  HALT_NOTIFY_ONCE,
  USE_FEE_SAFE_BEP,
  DAILY_NET_PROFIT_CAP_PCT,
  DAILY_PROFIT_NOTIFY_ONCE,
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

// 일일 손실 트레이드 수 기준 추가 게이트
let dailyLossTrades = 0; // 당일 손실로 마감된 트레이드 수
let _haltNoticeSentForDay = ""; // KST 날짜 문자열로 중복 알림 방지
function canEnterByDailyLossTrades(): boolean {
  if (HALT_AFTER_N_LOSSES <= 0) return true;
  return dailyLossTrades < HALT_AFTER_N_LOSSES;
}
// 일일 손실금액 한도 초과 알림(하루 1회)
let _ddNoticeSentForDay = "";
let _profitCapNoticeSentForDay = "";

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

function getMinOrderCost(symbol: string): number {
  const mi: any = getMarketInfo(symbol) || {};
  const minCost = Number(mi?.limits?.cost?.min) || LIVE_MIN_ORDER_KRW;
  return Math.max(minCost || 0, LIVE_MIN_ORDER_KRW || 0);
}

function normalizeSellAmount(symbol: string, amt: number): number {
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const mi: any = getMarketInfo(symbol);
  const precisionDigits = Number.isInteger(mi?.precision?.amount)
    ? mi.precision.amount
    : undefined;
  const step =
    precisionDigits !== undefined ? Math.pow(10, -precisionDigits) : 0;
  let out = amt;
  if (step > 0) out = floorToStep(out, step); // floor to avoid over-selling
  // Avoid negative zero
  if (!Number.isFinite(out) || out <= 0) return 0;
  return out;
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

// ===== Technical helpers: RSI and ATR =====
function rsi(values: number[], period: number): number[] {
  const n = values.length;
  if (n < period + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < n; i++) {
    const diff = values[i] - values[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  // initial averages (simple)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  const out: number[] = new Array(period).fill(NaN);
  // Wilder's smoothing for subsequent
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    const r = 100 - 100 / (1 + rs);
    out.push(r);
  }
  return out;
}

function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number
): number[] {
  const len = Math.min(highs.length, lows.length, closes.length);
  if (len < period + 1) return [];
  const trs: number[] = [];
  for (let i = 1; i < len; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  // Wilder's smoothing
  let atrPrev = 0;
  for (let i = 0; i < period; i++) atrPrev += trs[i];
  atrPrev /= period;
  const out: number[] = new Array(period).fill(NaN);
  out.push(atrPrev);
  for (let i = period; i < trs.length; i++) {
    const a = (atrPrev * (period - 1) + trs[i]) / period;
    out.push(a);
    atrPrev = a;
  }
  return out;
}

// ===================== SYNC (지갑↔포지션) =====================
const _noWalletStrike: Map<string, number> = new Map();
let _syncLock = false;
// 심볼별 불장 상태와 전역 집계 불장 상태(알림 전환용)
const _symbolBullBias: Map<string, boolean> = new Map();
let _prevAggregateBull: boolean | null = null;
let _lastBullEventTs = 0;
// 손절/진입 타임스탬프 추적
const _lastStopAt: Map<string, number> = new Map();
const _lastEntryAt: Map<string, number> = new Map();
// 쿨다운 알림 타임스탬프 추적 (스팸 방지)
const _lastStopCooldownNoticeAt: Map<string, number> = new Map();
const _lastEntryGapNoticeAt: Map<string, number> = new Map();
// 신규 진입 디버그 로그 스로틀
const _lastEntryDebugAt: Map<string, number> = new Map();

function maybeDebugEntry(symbol: string, msg: string) {
  if (!DEBUG_ENTRY_GATES) return;
  const now = Date.now();
  const last = _lastEntryDebugAt.get(symbol) || 0;
  if (now - last >= DEBUG_ENTRY_LOG_FREQ_SEC * 1000) {
    _lastEntryDebugAt.set(symbol, now);
    tg(`🧭 Entry skip ${symbol}: ${msg}`);
  }
}

function canEnterByStopCooldown(symbol: string) {
  if (STOP_AFTER_STOP_COOLDOWN_MIN <= 0) return true;
  const last = _lastStopAt.get(symbol) || 0;
  return Date.now() - last >= STOP_AFTER_STOP_COOLDOWN_MIN * 60_000;
}
function canEnterByMinGap(symbol: string) {
  if (MIN_GAP_BETWEEN_ENTRIES_MIN <= 0) return true;
  const last = _lastEntryAt.get(symbol) || 0;
  return Date.now() - last >= MIN_GAP_BETWEEN_ENTRIES_MIN * 60_000;
}

function shouldNotifyCooldown(map: Map<string, number>, symbol: string) {
  const now = Date.now();
  const last = map.get(symbol) || 0;
  if (last === 0 || now - last >= COOLDOWN_NOTICE_MIN * 60_000) {
    map.set(symbol, now);
    return true;
  }
  return false;
}

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
// 돌파선 상단 유지 시간 체크를 위한 심볼별 타임스탬프
const _holdAboveBreakoutSince: Map<string, number> = new Map();
// TP1가 최소 주문금액 미만이라 스킵한 경우 중복 알림 방지
const _tp1SkipNotified = new Set<string>();

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
  amt = normalizeSellAmount(symbol, amt);
  if (amt <= 0) return { ok: false as const, reason: "zero-amt-or-precision" };
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

        // 불장 감지 (히스테리시스 + 최소 유지시간)
        let bullBias = false;
        if (BULL_MODE === "on") bullBias = true;
        else if (BULL_MODE === "auto") {
          const gapBps = slow > 0 ? ((lastPx - slow) / slow) * 10000 : 0;
          const prev = _symbolBullBias.get(symbol) ?? false;
          let next = prev;
          const nowSec = Math.floor(Date.now() / 1000);
          const stateKey = `${symbol}::bullT`;
          const flatKey = `${symbol}::flatT`;
          // @ts-ignore - augment state store on positions map for simple key-value
          const store: any = positions as any;
          const lastBullTs: number = store[stateKey] || 0;
          const lastFlatTs: number = store[flatKey] || 0;

          const inUptrend = USE_REGIME_FILTER ? fast >= slow : true;
          if (!prev) {
            // 평상 상태 → 불장 진입 조건: 상향 추세 + enter 임계 초과 + 평상 최소 유지 충족
            const flatHeldOk = lastFlatTs
              ? nowSec - lastFlatTs >= FLAT_MIN_HOLD_SEC
              : true;
            if (inUptrend && gapBps >= BULL_EMA_GAP_ENTER_BPS && flatHeldOk) {
              next = true;
              store[stateKey] = nowSec;
            } else {
              next = false;
              if (!lastFlatTs) store[flatKey] = nowSec;
            }
          } else {
            // 불장 상태 → 이탈 조건: 내려온 추세 또는 exit 임계 미만 + 불장 최소 유지 충족
            const bullHeldOk = lastBullTs
              ? nowSec - lastBullTs >= BULL_MIN_HOLD_SEC
              : false;
            if (bullHeldOk && (!inUptrend || gapBps < BULL_EMA_GAP_EXIT_BPS)) {
              next = false;
              store[flatKey] = nowSec;
            } else {
              next = true;
              if (!lastBullTs) store[stateKey] = nowSec;
            }
          }
          bullBias = next;
        }
        // 불장 전환 이벤트 기반 알림 (전역 집계 기준: 하나라도 불장이면 불장으로 간주)
        _symbolBullBias.set(symbol, bullBias);
        const anyBull = Array.from(_symbolBullBias.values()).some(Boolean);
        if (_prevAggregateBull === null) {
          _prevAggregateBull = anyBull;
        } else if (_prevAggregateBull !== anyBull) {
          const now = Date.now();
          if (
            now - _lastBullEventTs >
            Math.max(2000, BULL_EVENT_MIN_INTERVAL_SEC * 1000)
          ) {
            // 최소 간격 적용 (기본 60초), 하한 2초
            await tg(anyBull ? "🟢 불장 진입" : "⚪ 불장 종료");
            _lastBullEventTs = now;
          }
          _prevAggregateBull = anyBull;
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
            let buffer = pos.entry * (activeDynStopBps / 10000);
            // 롱홀드 모드면 ATR 기반 추가 버퍼 적용(가능할 때)
            if (LONG_HOLD_MODE && LONG_HOLD_ATR_K > 0) {
              try {
                const a = atr(
                  candles.map((c) => Number(c[2]) || 0),
                  candles.map((c) => Number(c[3]) || 0),
                  candles.map((c) => Number(c[4]) || 0),
                  ATR_PERIOD
                );
                const aLast = last(a, 1)[0];
                if (Number.isFinite(aLast) && aLast > 0) {
                  buffer = Math.max(buffer, aLast * LONG_HOLD_ATR_K);
                }
              } catch {}
            }
            const candidate = pos.peak - buffer;
            if (!pos.stopPrice || candidate > pos.stopPrice) {
              // stop은 entry보다 아래로 (롱 기준) 너무 올라가지 않도록 (진입 직후 peak=entry 상황 보호)
              pos.stopPrice = Math.min(candidate, pos.peak * 0.9995);
            } else {
              // 돌파 조건이 깨지면 타임스탬프 초기화
              _holdAboveBreakoutSince.delete(symbol);
            }
            const tightenAllowed = LONG_HOLD_MODE
              ? !LONG_HOLD_DISABLE_TP_TIGHTEN
              : DYN_STOP_TIGHTEN_AFTER_TP1;
            if (pos.tookTP1 && tightenAllowed && pos.stopPrice) {
              // 수수료까지 고려한 BEP 스톱 보정 (옵션)
              if (USE_FEE_SAFE_BEP) {
                // 남은 수량을 pos.size로, 진입/청산 시 수수료를 모두 고려하여 순손익>=0이 되도록 하는 최소 가격을 추정
                // 순손익(net) = (Px - entry) * qty - (entry + Px) * qty * feeRate
                //           = qty * [ Px*(1 - feeRate) - entry*(1 + feeRate) ]
                // net >= 0 → Px >= entry * (1 + feeRate) / (1 - feeRate)
                const fee = FEE_RATE;
                const bePx =
                  fee < 1 ? pos.entry * ((1 + fee) / (1 - fee)) : pos.entry; // 안전장치
                pos.stopPrice = Math.max(pos.stopPrice, bePx);
              } else {
                const tighten = pos.entry * 0.002; // 0.2% tighten
                pos.stopPrice = Math.max(pos.stopPrice, pos.entry + tighten);
              }
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
                // 누적 포지션 손익 집계
                pos.runningNet = (pos.runningNet || 0) + net;
                pos.runningGross = (pos.runningGross || 0) + gross;
                pos.runningFee = (pos.runningFee || 0) + fee;
                const remaining = pos.size - adaptive.sold;
                const pct = ((lastPx - refEntry) / refEntry) * 100;
                if (remaining <= pos.size * 0.05 || remaining <= 0) {
                  positions.delete(symbol);
                  fullyExited = true;
                  _lastStopAt.set(symbol, Date.now());
                  // 손절로 전량 종료: 손실 트레이드로 계산
                  dailyLossTrades += 1;
                  const today = todayStrKST();
                  if (
                    HALT_AFTER_N_LOSSES > 0 &&
                    dailyLossTrades >= HALT_AFTER_N_LOSSES &&
                    (!HALT_NOTIFY_ONCE || _haltNoticeSentForDay !== today)
                  ) {
                    await tg(
                      `⛔ 손실 트레이드 누적 ${dailyLossTrades}회 → 금일 신규 진입 중단`
                    );
                    _haltNoticeSentForDay = today;
                  }
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
                  _lastStopAt.set(symbol, Date.now());
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
            let sellAmt = normalizeSellAmount(
              symbol,
              pos.size * tp1SellFracActive
            );
            // Upbit 최소 주문금액(시장가 매도) 충족 보정
            const minCost = getMinOrderCost(symbol);
            const estQuote = sellAmt * lastPx;
            if (minCost > 0 && estQuote < minCost) {
              const totalQuote = pos.size * lastPx;
              if (totalQuote >= minCost) {
                const targetAmt = Math.min(
                  pos.size,
                  (minCost + MIN_TOTAL_SAFETY_KRW) / lastPx
                );
                sellAmt = normalizeSellAmount(symbol, targetAmt);
              } else {
                if (!_tp1SkipNotified.has(symbol)) {
                  await tg(
                    `ℹ️ TP1 스킵(${symbol}): 포지션 가치가 최소주문금액(${Math.round(
                      minCost
                    )}) 미만`
                  );
                  _tp1SkipNotified.add(symbol);
                }
                await sleep(300);
                continue;
              }
            }

            const adaptive = await tryAdaptiveSell(symbol, sellAmt, lastPx);
            const r = adaptive.result;
            if (r.ok && adaptive.sold > 0) {
              const amountSold = adaptive.sold;
              pos.size -= amountSold;
              pos.invested = pos.size * lastPx;
              pos.tookTP1 = true;
              if (USE_BEP_AFTER_TP1) pos.entry = Math.min(pos.entry, lastPx);
              if (pos.stopPrice) {
                if (USE_FEE_SAFE_BEP) {
                  const fee = FEE_RATE;
                  const bePx =
                    fee < 1 ? pos.entry * ((1 + fee) / (1 - fee)) : pos.entry;
                  pos.stopPrice = Math.max(pos.stopPrice, bePx);
                } else if (pos.stopPrice < pos.entry) {
                  pos.stopPrice = pos.entry * 0.999; // 수수료 고려 살짝 아래
                }
              }
              positions.set(symbol, pos);
              const refEntry = pos.originalEntry ?? pos.entry;
              const { gross, fee, net } = pnlBreakdown(
                refEntry,
                lastPx,
                amountSold
              );
              realizedToday += net;
              grossToday += gross;
              feeToday += fee;
              pos.runningNet = (pos.runningNet || 0) + net;
              pos.runningGross = (pos.runningGross || 0) + gross;
              pos.runningFee = (pos.runningFee || 0) + fee;
              if (net >= 0) winsToday++;
              else lossesToday++;
              await tg(
                `✅ TP1: ${symbol} ${(tp1SellFracActive * 100).toFixed(
                  0
                )}% 익절 | 잔여=${pos.size.toFixed(6)}\n gross=${gross.toFixed(
                  0
                )} fee=${fee.toFixed(0)} net=${net.toFixed(0)} cum=${Math.round(
                  realizedToday
                )}`
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
              pos.runningNet = (pos.runningNet || 0) + net;
              pos.runningGross = (pos.runningGross || 0) + gross;
              pos.runningFee = (pos.runningFee || 0) + fee;
              const remaining = pos.size - adaptive.sold;
              if (remaining <= pos.size * 0.05 || remaining <= 0) {
                positions.delete(symbol);
                if ((pos.runningNet || 0) >= 0) winsToday++;
                else {
                  lossesToday++;
                  dailyLossTrades += 1;
                  const today = todayStrKST();
                  if (
                    HALT_AFTER_N_LOSSES > 0 &&
                    dailyLossTrades >= HALT_AFTER_N_LOSSES &&
                    (!HALT_NOTIFY_ONCE || _haltNoticeSentForDay !== today)
                  ) {
                    await tg(
                      `⛔ 손실 트레이드 누적 ${dailyLossTrades}회 → 금일 신규 진입 중단`
                    );
                    _haltNoticeSentForDay = today;
                  }
                }
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
          } else {
            const trailRef = LONG_HOLD_MODE
              ? Math.min(activeTrail, LONG_HOLD_TRAIL)
              : activeTrail;
            if ((lastPx - pos.peak) / pos.peak <= trailRef) {
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
                pos.runningNet = (pos.runningNet || 0) + net;
                pos.runningGross = (pos.runningGross || 0) + gross;
                pos.runningFee = (pos.runningFee || 0) + fee;
                const remaining = pos.size - adaptive.sold;
                if (remaining <= pos.size * 0.05 || remaining <= 0) {
                  positions.delete(symbol);
                  if ((pos.runningNet || 0) >= 0) winsToday++;
                  else {
                    lossesToday++;
                    dailyLossTrades += 1;
                    const today = todayStrKST();
                    if (
                      HALT_AFTER_N_LOSSES > 0 &&
                      dailyLossTrades >= HALT_AFTER_N_LOSSES &&
                      (!HALT_NOTIFY_ONCE || _haltNoticeSentForDay !== today)
                    ) {
                      await tg(
                        `⛔ 손실 트레이드 누적 ${dailyLossTrades}회 → 금일 신규 진입 중단`
                      );
                      _haltNoticeSentForDay = today;
                    }
                  }
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

          // 롱홀드: 최대 보유기간 관리 (KST 기준)
          if (LONG_HOLD_MODE && LONG_HOLD_MAX_DAYS > 0) {
            const heldMs = Date.now() - (pos.openedAt || Date.now());
            const maxMs = LONG_HOLD_MAX_DAYS * 24 * 60 * 60 * 1000;
            if (heldMs >= maxMs) {
              await tg(
                `⏳ 보유기간 만료(${LONG_HOLD_MAX_DAYS}d): ${symbol} | pnl=${(
                  pnlPct * 100
                ).toFixed(2)}%`
              );
              if (LONG_HOLD_TIME_EXIT) {
                const adaptive = await tryAdaptiveSell(
                  symbol,
                  pos.size,
                  lastPx
                );
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
                  pos.runningNet = (pos.runningNet || 0) + net;
                  pos.runningGross = (pos.runningGross || 0) + gross;
                  pos.runningFee = (pos.runningFee || 0) + fee;
                  positions.delete(symbol);
                  if ((pos.runningNet || 0) >= 0) winsToday++;
                  else {
                    lossesToday++;
                    dailyLossTrades += 1;
                  }
                  await tg(
                    `📆 롱홀드 만료 청산: ${symbol} sold=${adaptive.sold.toFixed(
                      6
                    )} net=${net.toFixed(0)} cum=${Math.round(realizedToday)}`
                  );
                  await sleep(1000);
                  continue;
                } else {
                  await tg(`❗ 롱홀드 만료 청산 실패: ${symbol} | ${r.reason}`);
                }
              }
            }
          }
        }

        // ====== 신규 진입 ======
        if (!inPos && !quiet) {
          // 손실 한도/일일 손실 트레이드 수 제한 체크
          if (!canEnterByLossLimit()) {
            const today = todayStrKST();
            if (_ddNoticeSentForDay !== today) {
              await tg("⛔ 일일 손실금액 한도 도달: 금일 신규 진입 중단");
              _ddNoticeSentForDay = today;
            }
            maybeDebugEntry(symbol, "daily drawdown gate");
            await sleep(500);
            continue;
          }
          // 일일 순이익 목표 도달 시 신규 진입 중단
          if (DAILY_NET_PROFIT_CAP_PCT > 0) {
            const baseEq = BASE_CAPITAL_KRW;
            if (
              baseEq > 0 &&
              realizedToday / baseEq >= DAILY_NET_PROFIT_CAP_PCT
            ) {
              const today = todayStrKST();
              if (
                !DAILY_PROFIT_NOTIFY_ONCE ||
                _profitCapNoticeSentForDay !== today
              ) {
                await tg(
                  `✅ 일일 순이익 목표 도달 (${(
                    DAILY_NET_PROFIT_CAP_PCT * 100
                  ).toFixed(2)}%) → 금일 신규 진입 중단`
                );
                _profitCapNoticeSentForDay = today;
              }
              await sleep(500);
              continue;
            }
          }
          if (!canEnterByDailyLossTrades()) {
            const today = todayStrKST();
            if (!HALT_NOTIFY_ONCE || _haltNoticeSentForDay !== today) {
              await tg(
                `⛔ 일일 손실 트레이드 ${HALT_AFTER_N_LOSSES}회 도달: 신규 진입 중단 (금일)`
              );
              _haltNoticeSentForDay = today;
            }
            maybeDebugEntry(symbol, "daily loss-trades halt");
            await sleep(500);
            continue;
          }
          // 뉴스 필터 제거됨
          if (Array.from(positions.keys()).length >= MAX_CONCURRENT_POS) {
            // 동시 포지션 제한 → 스킵
            maybeDebugEntry(symbol, "max concurrent positions");
          } else if (getTradeCount(symbol) >= MAX_TRADES_PER_DAY) {
            // 일일 진입 제한 → 스킵
            maybeDebugEntry(symbol, "max trades per day");
          } else if (inBuyCooldown(symbol)) {
            // 매수 실패 쿨다운 중 → 스킵
            maybeDebugEntry(symbol, "buy fail cooldown");
          } else if (!canEnterByStopCooldown(symbol)) {
            if (shouldNotifyCooldown(_lastStopCooldownNoticeAt, symbol)) {
              await tg(
                `⏳ 손절 후 쿨다운: ${symbol} ${STOP_AFTER_STOP_COOLDOWN_MIN}분 대기`
              );
            }
            maybeDebugEntry(symbol, "stop-after-stop cooldown");
            await sleep(300);
            continue;
          } else if (!canEnterByMinGap(symbol)) {
            if (shouldNotifyCooldown(_lastEntryGapNoticeAt, symbol)) {
              await tg(
                `⏳ 연속 진입 간격 유지: ${symbol} ${MIN_GAP_BETWEEN_ENTRIES_MIN}분 대기`
              );
            }
            maybeDebugEntry(symbol, "min gap between entries");
            await sleep(300);
            continue;
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
                maybeDebugEntry(symbol, "exposure cap");
                await sleep(1500);
                continue;
              }
            } catch {}
            const regimeOk = !USE_REGIME_FILTER || fast >= slow;
            // 상위TF 필터: 상위 추세 정합 + 가격이 상위 slow 위로 일정 갭 이상
            let htfOk = true;
            if (USE_HTF_FILTER) {
              try {
                const htfCandles = await fetchCandlesCached(
                  symbol,
                  HTF_TF as any,
                  120
                );
                const htfCloses: number[] = htfCandles.map(
                  (c: any) => Number(c[4]) || 0
                );
                const htfHighs: number[] = htfCandles.map(
                  (c: any) => Number(c[2]) || 0
                );
                const htfLows: number[] = htfCandles.map(
                  (c: any) => Number(c[3]) || 0
                );
                const eFast = ema(
                  htfCloses,
                  Math.min(HTF_EMA_FAST, htfCloses.length)
                );
                const eSlow = ema(
                  htfCloses,
                  Math.min(HTF_EMA_SLOW, htfCloses.length)
                );
                const f = last(eFast, 1)[0] ?? 0;
                const s = last(eSlow, 1)[0] ?? 0;
                const gap = s > 0 ? ((lastPx - s) / s) * 10000 : 0;
                htfOk = f >= s && gap >= HTF_GAP_BPS;
                // ATR 변동성 가드: 최근 ATR%가 레벨 초과면 신규 진입 보류
                if (htfOk && ATR_MAX_PCT > 0) {
                  const a = atr(htfHighs, htfLows, htfCloses, ATR_PERIOD);
                  const aLast = last(a, 1)[0];
                  if (Number.isFinite(aLast) && aLast && lastPx) {
                    const atrPct = aLast / lastPx;
                    if (atrPct > ATR_MAX_PCT) htfOk = false;
                  }
                }
              } catch {}
            }
            const tol = hh * (BREAKOUT_TOL_BPS / 10000);
            const breakoutLine = hh + tol;
            const breakoutOk = lastPx >= breakoutLine;
            // 이중 종가 확인: 직전 2개 완성봉 모두 돌파선 위 마감
            let doubleCloseOk = true;
            if (REQUIRE_DOUBLE_CLOSE) {
              const prev2 = last(candles, 3);
              const c1 = prev2[0] ? Number(prev2[0][4]) : 0;
              const c2 = prev2[1] ? Number(prev2[1][4]) : 0;
              doubleCloseOk = c1 > breakoutLine && c2 > breakoutLine;
            }

            // 이전 봉 종가가 돌파선 위로 마감해야 하는 옵션 (불장 완화 지원)
            let closeFilterOk = true;
            const requireCloseActive = bullBias
              ? REQUIRE_BREAKOUT_CLOSE_BULL
              : REQUIRE_BREAKOUT_CLOSE;
            if (requireCloseActive) {
              const prevCandle: Candle | undefined = last(candles, 2)[0];
              const prevClose = prevCandle ? Number(prevCandle[4]) : 0;
              closeFilterOk = prevClose > breakoutLine;
            }

            // 과도한 확장 제한 (돌파선 대비 확장 bps 상한), 불장에선 완화
            let extensionOk = true;
            const maxExtBpsActive = bullBias
              ? MAX_BREAKOUT_EXTENSION_BPS_BULL
              : MAX_BREAKOUT_EXTENSION_BPS;
            if (maxExtBpsActive > 0 && breakoutOk) {
              const extBps =
                breakoutLine > 0
                  ? ((lastPx - breakoutLine) / breakoutLine) * 10000
                  : 0;
              extensionOk = extBps <= maxExtBpsActive;
              if (!extensionOk) incFail("over-extended");
            }

            // RSI 과매수 필터: 불장에선 완화 임계 사용
            let rsiOk = true;
            try {
              const r = rsi(closes, RSI_PERIOD);
              const rLast = last(r, 1)[0];
              if (Number.isFinite(rLast)) {
                const limit = bullBias ? RSI_OVERBOUGHT_BULL : RSI_OVERBOUGHT;
                rsiOk = rLast <= limit;
              }
            } catch {}

            // 디버그: 어떤 게이트에서 막혔는지 주기적으로 보고
            if (
              !(
                regimeOk &&
                htfOk &&
                breakoutOk &&
                closeFilterOk &&
                extensionOk &&
                doubleCloseOk &&
                rsiOk
              )
            ) {
              const reasons: string[] = [];
              if (!regimeOk) reasons.push("regime");
              if (!htfOk) reasons.push("htf");
              if (!breakoutOk) reasons.push("breakout");
              if (!closeFilterOk) reasons.push("prev-close");
              if (!extensionOk) reasons.push("extension");
              if (!doubleCloseOk) reasons.push("double-close");
              if (!rsiOk) reasons.push("rsi");
              maybeDebugEntry(symbol, reasons.join(","));
            }

            if (
              regimeOk &&
              htfOk &&
              breakoutOk &&
              closeFilterOk &&
              extensionOk &&
              doubleCloseOk &&
              rsiOk
            ) {
              // 돌파선 상단 유지 시간 게이트 (불장에선 완화)
              const holdMsActive = bullBias
                ? HOLD_ABOVE_BREAKOUT_MS_BULL
                : HOLD_ABOVE_BREAKOUT_MS;
              if (holdMsActive > 0) {
                const hts = _holdAboveBreakoutSince.get(symbol) || 0;
                const now = Date.now();
                if (hts === 0) {
                  _holdAboveBreakoutSince.set(symbol, now);
                  await sleep(300); // 짧은 안정 대기
                  continue; // 다음 루프에서 다시 평가
                } else if (now - hts < holdMsActive) {
                  await sleep(300);
                  continue;
                }
              } else {
                // 비활성화면 타임스탬프 초기화
                _holdAboveBreakoutSince.delete(symbol);
              }
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
                    _lastEntryAt.set(symbol, Date.now());
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
    if (typeof (prev as any).dailyLossTrades === "number")
      dailyLossTrades = Number((prev as any).dailyLossTrades) || 0;
  } catch {}

  const feed = new UpbitTickerFeed(codes);
  feed.connect();

  // 뉴스 필터 제거됨

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
        dailyLossTrades,
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
          dailyLossTrades,
        });
      } catch {}
      // reset counters for new day
      lastSummaryDay = d;
      winsToday = 0;
      lossesToday = 0;
      grossToday = 0;
      feeToday = 0;
      realizedToday = 0;
      dailyLossTrades = 0;
      _haltNoticeSentForDay = "";
      _ddNoticeSentForDay = "";
      _profitCapNoticeSentForDay = "";
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
        dailyLossTrades,
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
        dailyLossTrades,
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
