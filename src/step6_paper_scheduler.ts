import "dotenv/config";
import fs from "fs";
import path from "path";
import ccxt from "ccxt";
import { EMA } from "technicalindicators";

/**
 * 업비트 15분봉 마감 직후(00/15/30/45분 + 7초)에만 신호를 평가하고
 * 가상 포지션을 관리/기록하는 스케줄러 + 페이퍼 엔진.
 *
 * 출력물:
 *  - paper_state.json : 현재 자본/포지션/일손익 등 상태
 *  - paper_trades.csv : 모든 가상 체결 로그
 */

// ===== 설정 =====
const SYMBOL_CCXT = "BTC/KRW";
const TF = "15m";
const LOOKBACK = 400;

const BASE_CAPITAL = Number(process.env.BASE_CAPITAL_KRW ?? 1_000_000); // 가상 초기자본
const POS_PCT = Number(process.env.POS_PCT ?? 0.3); // 30% (처음엔 보수적으로)
const STOP = Number(process.env.STOP_LOSS ?? -0.01); // -1.0%
const TP1 = Number(process.env.TP1 ?? 0.015); // +1.5%
const TP2 = Number(process.env.TP2 ?? 0.025); // +2.5%
const TRAIL = Number(process.env.TRAIL ?? -0.015); // 최고가 대비 -1.5%

const MAX_TRADES_PER_DAY = Number(process.env.MAX_TRADES_PER_DAY ?? 3);
const DAILY_LOSS_CAP = -0.03; // -3% (자본 기준)
const QUIET_HOURS = { start: 2, end: 6 }; // 02:00~06:00 매매 금지

// 디버그: 강제 1회 진입 테스트(보이는지 확인용). 운영시 false.
const DEBUG_FORCE_ENTRY = (process.env.DEBUG_FORCE_ENTRY ?? "false") === "true";
let debugForced = false;

// 파일 경로
const STATE_FILE = path.resolve("paper_state.json");
const CSV_FILE = path.resolve("paper_trades.csv");

// ===== 유틸/상태 =====
const upbit = new ccxt.upbit({ enableRateLimit: true });
const nowKST = () =>
  new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const todayKey = () => new Date().toISOString().slice(0, 10);

type OpenPos = {
  entry: number;
  amount: number;
  peak: number;
  tp1Done: boolean;
  tp2Done: boolean;
};

type State = {
  day: string;
  capitalKRW: number; // 가상 자본(누적 손익 반영)
  dailyTrades: number;
  consecutiveLosses: number;
  dailyPnlKRW: number;
  open: OpenPos | null; // 보유 포지션(가상)
};

function fileExists(p: string) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureCsv() {
  if (!fileExists(CSV_FILE)) {
    fs.writeFileSync(
      CSV_FILE,
      "datetime_kst,side,entry,exit,amount,pnl_krw,reason,notes\n",
      "utf-8"
    );
  }
}
function loadState(): State {
  if (!fileExists(STATE_FILE)) {
    const init: State = {
      day: todayKey(),
      capitalKRW: BASE_CAPITAL,
      dailyTrades: 0,
      consecutiveLosses: 0,
      dailyPnlKRW: 0,
      open: null,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(init, null, 2));
    ensureCsv();
    return init;
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}
function saveState(s: State) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function appendCsv(row: Record<string, string | number>) {
  const line =
    [
      row.datetime_kst,
      row.side,
      row.entry,
      row.exit,
      row.amount,
      row.pnl_krw,
      row.reason,
      row.notes ?? "",
    ].join(",") + "\n";
  fs.appendFileSync(CSV_FILE, line, "utf-8");
}

async function fetchCloses(limit = LOOKBACK) {
  // 마감 직후 7초 대기 스케줄이지만, 혹시 모를 지연 대비로 최근 캔들을 넉넉히 요청
  const ohlcv = await upbit.fetchOHLCV(SYMBOL_CCXT, TF, undefined, limit);
  return {
    closes: ohlcv.map((c) => c[4]),
    lastCandleTs: ohlcv.at(-1)?.[0] ?? Date.now(),
  };
}
async function lastPrice(): Promise<number> {
  const t = await upbit.fetchTicker(SYMBOL_CCXT);
  return t.last!;
}

// ===== 시그널/레짐 =====
function regimeUp(closes: number[]) {
  const e50 = EMA.calculate({ period: 50, values: closes }).at(-1);
  const e200 = EMA.calculate({ period: 200, values: closes }).at(-1);
  return !!(e50 && e200 && e50 > e200);
}
function breakout(closes: number[], lookback = 20) {
  if (closes.length < lookback + 1) return false;
  const priorHigh = Math.max(...closes.slice(-lookback - 1, -1));
  const last = closes.at(-1)!;
  return last > priorHigh;
}

// ===== 리스크 게이트 =====
function resetIfNewDay(s: State) {
  const k = todayKey();
  if (s.day !== k) {
    s.day = k;
    s.dailyTrades = 0;
    s.consecutiveLosses = 0;
    s.dailyPnlKRW = 0;
  }
}
function riskBlocked(s: State): string | null {
  if (s.dailyTrades >= MAX_TRADES_PER_DAY) return "MAX_TRADES";
  if (s.consecutiveLosses >= 2) return "CONSEC_LOSSES";
  if (s.dailyPnlKRW <= DAILY_LOSS_CAP * s.capitalKRW) return "DAILY_DD";
  const h = new Date().getHours();
  if (h >= QUIET_HOURS.start && h < QUIET_HOURS.end) return "QUIET_HOURS";
  return null;
}

// ===== 손익 계산 =====
function estimatePnl(entry: number, exit: number, amount: number) {
  return (exit - entry) * amount;
}

// ===== 캔들 마감 스케줄링 =====
/** 다음 15분 경계(00/15/30/45) + 딜레이(ms)까지 기다렸다가 fn 실행 */
function scheduleOnQuarter(fn: () => void, delayMs = 7000) {
  const now = new Date();
  const mins = now.getMinutes();
  const secs = now.getSeconds();
  const ms = now.getMilliseconds();

  const nextQ = Math.ceil((mins + 0.001) / 15) * 15; // 15분 경계
  const addMin = (nextQ % 60) - mins;
  let wait = addMin * 60_000 - secs * 1_000 - ms + delayMs;
  if (wait < 0) wait += 15 * 60_000;

  setTimeout(() => {
    // 첫 실행
    safeTick().finally(() => {
      // 이후엔 15분마다 고정 실행
      setInterval(() => safeTick(), 15 * 60_000);
    });
  }, wait);
}

// ===== 안전 실행 래퍼(중복 방지 + 재시도) =====
let running = false;
async function safeTick() {
  if (running) {
    console.log(`[SKIP] previous tick still running @ ${nowKST()}`);
    return;
  }
  running = true;
  try {
    await tick();
  } catch (e: any) {
    console.error("[TICK ERROR]", e.message);
    // 간단 재시도 1회(3초 후)
    setTimeout(async () => {
      try {
        await tick();
      } catch (e2: any) {
        console.error("[RETRY ERROR]", e2.message);
      }
    }, 3000);
  } finally {
    running = false;
  }
}

// ===== 메인 로직(마감 직후 1회 실행) =====
async function tick() {
  const state = loadState();
  resetIfNewDay(state);

  // 하트비트
  console.log(
    `[HB ${nowKST()}] cap=${Math.round(state.capitalKRW)}KRW, ` +
      `dailyPnL=${Math.round(state.dailyPnlKRW)}KRW, ` +
      `trades=${state.dailyTrades}, consecLoss=${state.consecutiveLosses}, ` +
      `pos=${
        state.open
          ? `ENTRY ${Math.round(
              state.open.entry
            )} x ${state.open.amount.toFixed(6)}`
          : "NONE"
      }`
  );

  // 보유 포지션 관리(청산 로직은 캔들 마감 가격 기준 — 다음 단계에서 WS로 초단위 강화 예정)
  if (state.open) {
    const px = await lastPrice(); // 실전은 WS 최신가를 사용하는 것이 더 정밀(A단계)
    const pos = state.open;
    pos.peak = Math.max(pos.peak, px);

    const sl = pos.entry * (1 + STOP);
    const tp1 = pos.entry * (1 + TP1);
    const tp2 = pos.entry * (1 + TP2);
    const trailLine = pos.peak * (1 + TRAIL);

    console.log(
      `[POS] px=${Math.round(px)} | SL<=${Math.round(sl)} | TP1>=${Math.round(
        tp1
      )} | TP2>=${Math.round(tp2)} | TR<=${Math.round(
        trailLine
      )} (peak=${Math.round(pos.peak)})`
    );

    // 손절
    if (px <= sl) {
      const pnl = estimatePnl(pos.entry, px, pos.amount);
      state.dailyPnlKRW += pnl;
      state.consecutiveLosses += pnl < 0 ? 1 : 0;
      appendCsv({
        datetime_kst: nowKST(),
        side: "SELL(paper)",
        entry: pos.entry,
        exit: px,
        amount: pos.amount,
        pnl_krw: Math.round(pnl),
        reason: "stop",
        notes: "손절 -1%",
      });
      state.capitalKRW += pnl;
      state.open = null;
      saveState(state);
      console.log(`[${nowKST()}] STOP exit, pnl=${Math.round(pnl)} KRW`);
      return;
    }
    // TP1
    if (!pos.tp1Done && px >= tp1) {
      const part = pos.amount * 0.3;
      const pnl = estimatePnl(pos.entry, px, part);
      pos.amount -= part;
      pos.tp1Done = true;
      state.dailyPnlKRW += pnl;
      state.capitalKRW += pnl;
      appendCsv({
        datetime_kst: nowKST(),
        side: "SELL(paper)",
        entry: pos.entry,
        exit: px,
        amount: part,
        pnl_krw: Math.round(pnl),
        reason: "tp1",
        notes: `+${(TP1 * 100).toFixed(2)}%`,
      });
      console.log(`[${nowKST()}] TP1 partial, pnl=${Math.round(pnl)} KRW`);
    }
    // TP2
    if (!pos.tp2Done && px >= tp2) {
      const part = pos.amount * 0.3;
      const pnl = estimatePnl(pos.entry, px, part);
      pos.amount -= part;
      pos.tp2Done = true;
      state.dailyPnlKRW += pnl;
      state.capitalKRW += pnl;
      appendCsv({
        datetime_kst: nowKST(),
        side: "SELL(paper)",
        entry: pos.entry,
        exit: px,
        amount: part,
        pnl_krw: Math.round(pnl),
        reason: "tp2",
        notes: `+${(TP2 * 100).toFixed(2)}%`,
      });
      console.log(`[${nowKST()}] TP2 partial, pnl=${Math.round(pnl)} KRW`);
    }
    // 트레일링
    if (px <= trailLine) {
      const pnl = estimatePnl(pos.entry, px, pos.amount);
      state.dailyPnlKRW += pnl;
      state.consecutiveLosses = pnl < 0 ? state.consecutiveLosses + 1 : 0;
      appendCsv({
        datetime_kst: nowKST(),
        side: "SELL(paper)",
        entry: pos.entry,
        exit: px,
        amount: pos.amount,
        pnl_krw: Math.round(pnl),
        reason: "trail",
        notes: `peak=${Math.round(pos.peak)}`,
      });
      state.capitalKRW += pnl;
      state.open = null;
      saveState(state);
      console.log(`[${nowKST()}] TRAIL exit, pnl=${Math.round(pnl)} KRW`);
      return;
    }

    // 포지션 유지
    saveState(state);
    return;
  }

  // 신규 진입(오직 마감 직후에만 평가)
  const block = riskBlocked(state);
  if (block) {
    console.log(`[BLOCK] reason=${block}`);
    return;
  }

  const { closes, lastCandleTs } = await fetchCloses(LOOKBACK);
  const up = regimeUp(closes);
  const sigRaw = up && breakout(closes, 20);

  const last = closes.at(-1)!;
  console.log(
    `[SIG] up=${up} breakout=${sigRaw} lastClose=${Math.round(
      last
    )} ts=${lastCandleTs}`
  );

  let sig = sigRaw;
  if (!sigRaw && DEBUG_FORCE_ENTRY && !debugForced) {
    console.log("[DEBUG] force enter once for visibility");
    debugForced = true;
    sig = true;
  }
  if (!sig) return;

  // 가상 진입(마감 종가 체결 가정)
  const entryPx = last;
  const sizeKRW = state.capitalKRW * POS_PCT;
  const amount = sizeKRW / entryPx;

  state.open = {
    entry: entryPx,
    amount,
    peak: entryPx,
    tp1Done: false,
    tp2Done: false,
  };
  state.dailyTrades += 1;

  appendCsv({
    datetime_kst: nowKST(),
    side: "BUY(paper)",
    entry: entryPx,
    exit: entryPx,
    amount,
    pnl_krw: 0,
    reason: "enter",
    notes: `ts=${lastCandleTs}`,
  });

  saveState(state);
  console.log(
    `[${nowKST()}] ENTER(paper) entry=${entryPx} amt=${amount.toFixed(6)}`
  );
}

// ===== 부팅 =====
ensureCsv();
console.log("Paper engine (candle-close scheduler) started.");
scheduleOnQuarter(() => {}, 7000); // 내부에서 safeTick을 시작(첫 실행 + 15분 반복)
