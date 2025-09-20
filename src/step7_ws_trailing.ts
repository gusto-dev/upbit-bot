import "dotenv/config";
import fs from "fs";
import path from "path";
import ccxt from "ccxt";
import { EMA } from "technicalindicators";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

/**
 * - 진입: 15분봉 마감(00/15/30/45분) + 7초에서만 신호 평가 -> 가상 진입
 * - 청산: 업비트 공개 웹소켓 실시간 가격으로 초 단위(기본 1초) 체크 -> 손절/TP/트레일링
 * - 출력물:
 *   - paper_state.json : 현재 자본/포지션/일손익 등 상태
 *   - paper_trades.csv : 모든 가상 체결 로그
 */

// ===== 설정 =====
const SYMBOL_CCXT = "BTC/KRW";
const CODE_UPBIT = process.env.CODE_UPBIT || "KRW-BTC"; // WS codes 용
const TF = "15m";
const LOOKBACK = 400;

const BASE_CAPITAL = Number(process.env.BASE_CAPITAL_KRW ?? 1_000_000); // 가상 초기자본
const POS_PCT = Number(process.env.POS_PCT ?? 0.3); // 30%
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

// ===== 공용 상태 =====
const upbit = new ccxt.upbit({ enableRateLimit: true });
const nowKST = () =>
  new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const todayKey = () => new Date().toISOString().slice(0, 10);

// 웹소켓 최신가(실시간 청산용)
let wsPrice = 0;
let wsTs = 0;
let ws: WebSocket | null = null;
let wsClosedByUser = false;
let wsReconnectAttempt = 0;
const WS_URL = "wss://api.upbit.com/websocket/v1";
const HEARTBEAT_SEC = 5;
const PING_SEC = 25;
const MAX_BACKOFF_SEC = 30;

type OpenPos = {
  entry: number;
  amount: number;
  peak: number;
  tp1Done: boolean;
  tp2Done: boolean;
};
type State = {
  day: string;
  capitalKRW: number;
  dailyTrades: number;
  consecutiveLosses: number;
  dailyPnlKRW: number;
  open: OpenPos | null;
};

// ===== 파일/상태 유틸 =====
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

// ===== 데이터/지표 =====
async function fetchCloses(limit = LOOKBACK) {
  const ohlcv = await upbit.fetchOHLCV(SYMBOL_CCXT, TF, undefined, limit);
  return {
    closes: ohlcv.map((c) => c[4]),
    lastCandleTs: ohlcv.at(-1)?.[0] ?? Date.now(),
  };
}
async function lastPriceREST(): Promise<number> {
  const t = await upbit.fetchTicker(SYMBOL_CCXT);
  return t.last!;
}
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

// ===== 손익 =====
function estimatePnl(entry: number, exit: number, amount: number) {
  return (exit - entry) * amount;
}

// ===== 캔들 마감 스케줄링(진입 전용) =====
function scheduleOnQuarter(delayMs = 7000) {
  const now = new Date();
  const mins = now.getMinutes();
  const secs = now.getSeconds();
  const ms = now.getMilliseconds();

  const nextQ = Math.ceil((mins + 0.001) / 15) * 15;
  const addMin = (nextQ % 60) - mins;
  let wait = addMin * 60_000 - secs * 1_000 - ms + delayMs;
  if (wait < 0) wait += 15 * 60_000;

  setTimeout(() => {
    // 첫 실행
    safeEntryTick().finally(() => {
      setInterval(() => safeEntryTick(), 15 * 60_000);
    });
  }, wait);
}

// ===== 엔트리 틱(마감 직후만) =====
let entryRunning = false;
async function safeEntryTick() {
  if (entryRunning) return;
  entryRunning = true;
  try {
    await entryTick();
  } catch (e: any) {
    console.error("[ENTRY TICK ERROR]", e.message);
    setTimeout(async () => {
      try {
        await entryTick();
      } catch (e2: any) {
        console.error("[ENTRY RETRY ERROR]", e2.message);
      }
    }, 3000);
  } finally {
    entryRunning = false;
  }
}
async function entryTick() {
  const state = loadState();
  resetIfNewDay(state);

  console.log(
    `[HB ${nowKST()}] cap=${Math.round(
      state.capitalKRW
    )}KRW, dailyPnL=${Math.round(state.dailyPnlKRW)}KRW, ` +
      `trades=${state.dailyTrades}, consecLoss=${
        state.consecutiveLosses
      }, pos=${state.open ? "OPEN" : "NONE"}`
  );

  // 이미 포지션 있으면 신규 진입 안함 (청산은 실시간 루프에서 관리)
  if (state.open) {
    saveState(state);
    return;
  }

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
    notes: `candleClose`,
  });

  saveState(state);
  console.log(
    `[${nowKST()}] ENTER(paper) entry=${entryPx} amt=${amount.toFixed(6)}`
  );
}

// ===== 웹소켓(실시간 가격) =====
function subPayload() {
  return JSON.stringify([
    { ticket: uuidv4() },
    { type: "ticker", codes: [CODE_UPBIT], isOnlyRealtime: true },
    { format: "DEFAULT" },
  ]);
}
async function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const backoff = Math.min(2 ** wsReconnectAttempt, MAX_BACKOFF_SEC);
  if (wsReconnectAttempt > 0) {
    console.log(`[WS] reconnect in ${backoff}s...`);
    await new Promise((res) => setTimeout(res, backoff * 1000));
  }

  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    wsReconnectAttempt = 0;
    console.log(`[WS] OPEN @ ${nowKST()}`);
    ws!.send(subPayload());
  });
  ws.on("message", (data) => {
    try {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      const msg = JSON.parse(raw);
      if (msg.type === "ticker") {
        wsPrice = msg.trade_price;
        wsTs = msg.timestamp;
      }
    } catch {
      /* ignore */
    }
  });
  ws.on("close", (code, reason) => {
    console.warn(
      `[WS] CLOSE code=${code} reason=${reason.toString()} @ ${nowKST()}`
    );
    ws = null;
    if (!wsClosedByUser) {
      wsReconnectAttempt++;
      connectWS().catch(console.error);
    }
  });
  ws.on("error", (err) => console.error("[WS] ERROR", (err as any).message));
}
function startWSHeartbeat() {
  setInterval(() => {
    const stamp = wsTs
      ? new Date(wsTs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
      : "-";
    console.log(
      `[HB-WS ${nowKST()}] ${CODE_UPBIT} price=${Math.round(
        wsPrice
      )} ts=${stamp}`
    );
  }, HEARTBEAT_SEC * 1000);
}
function startWSPing() {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {}
    }
  }, PING_SEC * 1000);
}
function setupShutdown() {
  const shut = async () => {
    wsClosedByUser = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000, "bye");
      } catch {}
    }
    console.log("[WS] Bye");
    process.exit(0);
  };
  process.on("SIGINT", shut);
  process.on("SIGTERM", shut);
}

// ===== 실시간 청산 루프(초 단위) =====
let exitRunning = false;
async function liveExitLoop() {
  if (exitRunning) return;
  exitRunning = true;
  try {
    const state = loadState();
    if (!state.open) return;

    // 최신가: WS 우선, 없으면 REST 폴백
    let px = wsPrice;
    if (!px || Number.isNaN(px)) {
      try {
        px = await lastPriceREST();
      } catch {
        return;
      }
    }

    const pos = state.open;
    pos.peak = Math.max(pos.peak, px);

    const sl = pos.entry * (1 + STOP);
    const tp1 = pos.entry * (1 + TP1);
    const tp2 = pos.entry * (1 + TP2);
    const trailLine = pos.peak * (1 + TRAIL);

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
        notes: "ws_exit",
      });
      state.capitalKRW += pnl;
      state.open = null;
      saveState(state);
      console.log(`[EXIT-WS ${nowKST()}] STOP pnl=${Math.round(pnl)} KRW`);
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
        notes: "ws_exit",
      });
      saveState(state);
      console.log(`[EXIT-WS ${nowKST()}] TP1 pnl=${Math.round(pnl)} KRW`);
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
        notes: "ws_exit",
      });
      saveState(state);
      console.log(`[EXIT-WS ${nowKST()}] TP2 pnl=${Math.round(pnl)} KRW`);
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
        notes: `ws_exit peak=${Math.round(pos.peak)}`,
      });
      state.capitalKRW += pnl;
      state.open = null;
      saveState(state);
      console.log(`[EXIT-WS ${nowKST()}] TRAIL pnl=${Math.round(pnl)} KRW`);
      return;
    }

    // 포지션 유지중 → 상태 저장만
    saveState(state);
  } catch (e: any) {
    console.error("[EXIT LOOP ERROR]", e.message);
  } finally {
    exitRunning = false;
  }
}

// ===== 부팅 =====
ensureCsv();
setupShutdown();
console.log(
  "Paper engine (entry on candle close, exit via websocket) started."
);

// 1) 캔들 마감 +7s 마다: 엔트리 판단
scheduleOnQuarter(7000);

// 2) 웹소켓 연결 + 하트비트/핑
connectWS().catch(console.error);
startWSHeartbeat();
startWSPing();

// 3) 실시간 청산 루프(초당 1회)
setInterval(liveExitLoop, 1000);
