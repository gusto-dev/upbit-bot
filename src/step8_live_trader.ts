import "dotenv/config";
import fs from "fs";
import path from "path";
import ccxt from "ccxt";
import { EMA } from "technicalindicators";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

/** =========================
 *  설정값/환경변수
 *  ========================= */
const SYMBOL_CCXT = "BTC/KRW";
const CODE_UPBIT = process.env.CODE_UPBIT || "KRW-BTC";
const TF = "15m";
const LOOKBACK = 400;

const MODE = (process.env.MODE ?? "paper") as "paper" | "live";
const BASE_CAPITAL = Number(process.env.BASE_CAPITAL_KRW ?? 1_000_000);
const POS_PCT = Number(process.env.POS_PCT ?? 0.3);
const STOP = Number(process.env.STOP_LOSS ?? -0.01);
const TP1 = Number(process.env.TP1 ?? 0.015);
const TP2 = Number(process.env.TP2 ?? 0.025);
const TRAIL = Number(process.env.TRAIL ?? -0.015);
const MAX_TRADES_PER_DAY = Number(process.env.MAX_TRADES_PER_DAY ?? 3);

const LIVE_MIN_ORDER_KRW = Number(process.env.LIVE_MIN_ORDER_KRW ?? 5000);
const ENTRY_SLIPPAGE_BPS = Number(process.env.ENTRY_SLIPPAGE_BPS ?? 5); // 0.05%
const ENTRY_TIMEOUT_SEC = Number(process.env.ENTRY_TIMEOUT_SEC ?? 25);
const RETRY_MAX = Number(process.env.RETRY_MAX ?? 2);

const KILL_SWITCH = (process.env.KILL_SWITCH ?? "false") === "true";
const QUIET_HOURS = {
  start: Number(process.env.QUIET_HOUR_START ?? 2),
  end: Number(process.env.QUIET_HOUR_END ?? 6),
};

const DEBUG_FORCE_ENTRY = (process.env.DEBUG_FORCE_ENTRY ?? "false") === "true";
let debugForced = false;

/** ===== 텔레그램 알림 ===== */
const TG_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

async function notify(msg: string) {
  // 텔레그램 미설정이면 콘솔에만 출력
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("[NO-TELEGRAM]", msg);
    return;
  }
  try {
    // Node 18+ global fetch
    // @ts-ignore
    const res = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text: msg }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("[TELEGRAM FAIL]", res.status, text);
    }
  } catch (e: any) {
    console.error("[TELEGRAM ERROR]", e.message);
  }
}

/** =========================
 *  공통 유틸/상태
 *  ========================= */
const upbit = new ccxt.upbit({
  apiKey: process.env.UPBIT_API_KEY,
  secret: process.env.UPBIT_SECRET,
  enableRateLimit: true,
});
const nowKST = () =>
  new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const todayKey = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

type OpenPos = {
  entry: number;
  amount: number; // BTC 수량
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

/** =========================
 *  틱사이즈(업비트 KRW 호가단위)
 *  ========================= */
function krwTickUnit(price: number): number {
  if (price >= 2_000_000) return 1000;
  if (price >= 1_000_000) return 500;
  if (price >= 500_000) return 100;
  if (price >= 100_000) return 50;
  if (price >= 10_000) return 10;
  if (price >= 1_000) return 5;
  if (price >= 100) return 1;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  if (price >= 0.1) return 0.001;
  if (price >= 0.01) return 0.00001;
  if (price >= 0.001) return 0.000001;
  if (price >= 0.0001) return 0.0000001;
  return 0.00000001;
}
function roundToTick(price: number) {
  const u = krwTickUnit(price);
  return Math.round(price / u) * u;
}

/** =========================
 *  파일/상태
 *  ========================= */
const STATE_FILE = path.resolve("paper_state.json"); // 상태 공유
const CSV_FILE = path.resolve("paper_trades.csv");

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

/** =========================
 *  데이터/지표
 *  ========================= */
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
  const e200 = EMA.calculate({ period: 200, values: closes }).at(-1);
  const last = closes.at(-1)!;
  return !!(e200 && last > e200);
}
function breakout(closes: number[], lookback = 20) {
  if (closes.length < lookback + 1) return false;
  const priorHigh = Math.max(...closes.slice(-lookback - 1, -1));
  const last = closes.at(-1)!;
  return last > priorHigh;
}

/** =========================
 *  리스크 게이트 & 손익
 *  ========================= */
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
  if (s.dailyPnlKRW <= -0.03 * s.capitalKRW) return "DAILY_DD";
  const h = new Date().getHours();
  if (h >= QUIET_HOURS.start && h < QUIET_HOURS.end) return "QUIET_HOURS";
  return null;
}
function estimatePnl(entry: number, exit: number, amount: number) {
  return (exit - entry) * amount;
}

/** =========================
 *  주문 유틸 (실거래)
 *  ========================= */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= RETRY_MAX; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      console.warn(
        `[RETRY ${label}] ${i + 1}/${RETRY_MAX + 1} err=${e.message}`
      );
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

async function placeLimitBuyKRW(
  sizeKRW: number,
  timeoutSec: number,
  slippageBps: number
) {
  const pxNow = await withRetry(() => lastPriceREST(), "lastPrice");
  const targetPxRaw = pxNow * (1 + slippageBps / 10000);
  const targetPx = roundToTick(targetPxRaw);
  const amountRaw = sizeKRW / targetPx;
  const amount = Number(upbit.amountToPrecision(SYMBOL_CCXT, amountRaw));
  const price = Number(upbit.priceToPrecision(SYMBOL_CCXT, targetPx));

  if (KILL_SWITCH || MODE !== "live") {
    console.log(`[DRY] 지정가 매수(모의) ${amount} @ ${price}`);
    return { filled: amount, avg: price, orderId: "dry" };
  }

  const order = await withRetry(
    () => upbit.createOrder(SYMBOL_CCXT, "limit", "buy", amount, price),
    "createOrder"
  );
  const id = order.id;
  const tEnd = Date.now() + timeoutSec * 1000;
  let filled = order.filled ?? 0;
  let avg = order.average ?? price;

  while (Date.now() < tEnd && filled < amount) {
    await sleep(900);
    const od = await withRetry(
      () => upbit.fetchOrder(id, SYMBOL_CCXT),
      "fetchOrder"
    );
    filled = od.filled ?? 0;
    avg = od.average ?? avg;
    if (od.status === "closed") break;
  }

  if (filled < amount) {
    try {
      await withRetry(() => upbit.cancelOrder(id, SYMBOL_CCXT), "cancelOrder");
    } catch {}
  }

  return { filled, avg: avg ?? price, orderId: id };
}

async function placeMarketSell(amount: number) {
  const amt = Number(upbit.amountToPrecision(SYMBOL_CCXT, amount));
  if (amt <= 0) return { sold: 0, avg: 0, orderId: "skipped" };

  if (KILL_SWITCH || MODE !== "live") {
    const px = await lastPriceREST();
    console.log(`[DRY] 시장가 매도(모의) ${amt} ~ ${px}`);
    return { sold: amt, avg: px, orderId: "dry" };
  }
  const od = await withRetry(
    () => upbit.createOrder(SYMBOL_CCXT, "market", "sell", amt),
    "marketSell"
  );
  // 평균가 갱신
  let avg = od.average ?? 0;
  try {
    const od2 = await withRetry(
      () => upbit.fetchOrder(od.id!, SYMBOL_CCXT),
      "fetchOrderAvg"
    );
    avg = od2.average ?? avg;
  } catch {}
  return { sold: amt, avg, orderId: od.id! };
}

/** =========================
 *  웹소켓 (실시간 청산)
 *  ========================= */
let wsPrice = 0;
let wsTs = 0;
let ws: WebSocket | null = null;
let wsClosedByUser = false;
let wsReconnectAttempt = 0;
const WS_URL = "wss://api.upbit.com/websocket/v1";
const HEARTBEAT_SEC = 5;
const PING_SEC = 25;
const MAX_BACKOFF_SEC = 30;

function wsPayload() {
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
    console.log(`[WS] 재연결 대기 ${backoff}s`);
    await sleep(backoff * 1000);
  }
  ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    wsReconnectAttempt = 0;
    console.log(`[WS] OPEN @ ${nowKST()}`);
    ws!.send(wsPayload());
  });
  ws.on("message", (data) => {
    try {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      const m = JSON.parse(raw);
      if (m.type === "ticker") {
        wsPrice = m.trade_price;
        wsTs = m.timestamp;
      }
    } catch {}
  });
  ws.on("close", (code, reason) => {
    console.warn(`[WS] CLOSE ${code} ${reason.toString()}`);
    ws = null;
    if (!wsClosedByUser) {
      wsReconnectAttempt++;
      connectWS().catch(console.error);
    }
  });
  ws.on("error", (e: any) => console.error("[WS] ERROR", e.message));
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

/** =========================
 *  캔들 마감 스케줄링 (진입 전용)
 *  ========================= */
function scheduleOnQuarter(delayMs = 12000) {
  const now = new Date();
  const mins = now.getMinutes();
  const secs = now.getSeconds();
  const ms = now.getMilliseconds();
  const nextQ = Math.ceil((mins + 0.001) / 15) * 15;
  const addMin = (nextQ % 60) - mins;
  let wait = addMin * 60_000 - secs * 1_000 - ms + delayMs;
  if (wait < 0) wait += 15 * 60_000;
  setTimeout(() => {
    safeEntryTick().finally(() => {
      setInterval(() => safeEntryTick(), 15 * 60_000);
    });
  }, wait);
}

/** =========================
 *  엔트리 틱 (마감 직후만)
 *  ========================= */
let entryRunning = false;
async function safeEntryTick() {
  if (entryRunning) return;
  entryRunning = true;
  try {
    await entryTick();
  } catch (e: any) {
    console.error("[ENTRY ERROR]", e.message);
    await sleep(1500);
  } finally {
    entryRunning = false;
  }
}
function reasonKR(key: string) {
  switch (key) {
    case "MAX_TRADES":
      return "일일 거래수 제한";
    case "CONSEC_LOSSES":
      return "연속 손실 제한";
    case "DAILY_DD":
      return "일 손실 한도 초과";
    case "QUIET_HOURS":
      return "조용한 시간대(신규 진입 차단)";
    default:
      return key;
  }
}
async function entryTick() {
  const state = loadState();
  resetIfNewDay(state);

  const hb = `자본=${Math.round(state.capitalKRW)}원 | 일손익=${Math.round(
    state.dailyPnlKRW
  )}원 | 거래수=${state.dailyTrades} | 연속손실=${
    state.consecutiveLosses
  } | 모드=${MODE} | 킬스위치=${KILL_SWITCH}`;
  console.log(`[HB ${nowKST()}] ${hb}`);
  await notify(`📊 상태 보고 (${nowKST()})\n${hb}`);

  if (state.open) {
    saveState(state);
    return;
  }

  const block = riskBlocked(state);
  if (block) {
    const msg = `⛔ 진입 차단: ${reasonKR(block)}`;
    console.log(msg);
    await notify(msg);
    return;
  }

  const { closes, lastCandleTs } = await fetchCloses(LOOKBACK);
  const up = regimeUp(closes);
  const sigRaw =
    up && breakout(closes, Number(process.env.BREAKOUT_LOOKBACK ?? 12));
  const last = closes.at(-1)!;
  const when = new Date(lastCandleTs).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
  });
  const sigMsg = `🕒 캔들 마감 신호\n상승장=${up ? "예" : "아니오"} | 돌파=${
    sigRaw ? "예" : "아니오"
  }\n종가=${Math.round(last)}원 | 시각=${when}`;
  console.log(sigMsg);
  await notify(sigMsg);

  let sig = sigRaw;
  if (!sigRaw && DEBUG_FORCE_ENTRY && !debugForced) {
    console.log("[DEBUG] force enter once");
    debugForced = true;
    sig = true;
  }
  if (!sig) return;

  // 잔고
  let krw = BASE_CAPITAL;
  try {
    const bal = await upbit.fetchBalance();
    krw = bal.total?.KRW ?? bal.free?.KRW ?? BASE_CAPITAL;
  } catch {}
  const sizeKRW = Math.max(
    LIVE_MIN_ORDER_KRW,
    Math.min(krw * POS_PCT, krw * 0.95)
  );
  if (sizeKRW < LIVE_MIN_ORDER_KRW) {
    const m = `⚠️ KRW 잔고 부족 (보유: ${Math.round(krw)}원)`;
    console.log(m);
    await notify(m);
    return;
  }

  // 진입
  let filled = 0,
    avg = last;
  if (MODE === "live" && !KILL_SWITCH) {
    const res = await placeLimitBuyKRW(
      sizeKRW,
      ENTRY_TIMEOUT_SEC,
      ENTRY_SLIPPAGE_BPS
    );
    filled = res.filled;
    avg = res.avg;
  } else {
    filled = sizeKRW / last;
    avg = last;
    console.log(`[PAPER] LIMIT BUY filled=${filled} @ ${avg}`);
  }
  if (filled <= 0) {
    const m = "⚠️ 매수 미체결 (타임아웃 취소됨)";
    console.log(m);
    await notify(m);
    return;
  }

  // 포지션 등록
  state.open = {
    entry: avg,
    amount: filled,
    peak: avg,
    tp1Done: false,
    tp2Done: false,
  };
  state.dailyTrades += 1;
  appendCsv({
    datetime_kst: nowKST(),
    side: MODE === "live" ? "BUY(live)" : "BUY(paper)",
    entry: avg,
    exit: avg,
    amount: filled,
    pnl_krw: 0,
    reason: "enter",
    notes: MODE,
  });
  saveState(state);

  const em = `🚀 매수 체결\n진입가=${Math.round(avg)}원\n수량=${filled}`;
  console.log(em);
  await notify(em);
}

/** =========================
 *  실시간 청산 루프 (웹소켓 가격 사용)
 *  ========================= */
let exitRunning = false;
async function liveExitLoop() {
  if (exitRunning) return;
  exitRunning = true;
  try {
    const state = loadState();
    if (!state.open) return;

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
      const { sold, avg } = await placeMarketSell(pos.amount);
      const pnl = estimatePnl(pos.entry, avg || px, sold);
      state.dailyPnlKRW += pnl;
      state.consecutiveLosses += pnl < 0 ? 1 : 0;
      state.capitalKRW += pnl;
      appendCsv({
        datetime_kst: nowKST(),
        side: MODE === "live" ? "SELL(live)" : "SELL(paper)",
        entry: pos.entry,
        exit: avg || px,
        amount: sold,
        pnl_krw: Math.round(pnl),
        reason: "stop",
        notes: "ws",
      });
      state.open = null;
      saveState(state);
      const msg = `⛔ 손절 청산\n손익=${Math.round(pnl)}원`;
      console.log(msg);
      await notify(msg);
      return;
    }

    // TP1
    if (!pos.tp1Done && px >= tp1) {
      const part = pos.amount * 0.3;
      const { sold, avg } = await placeMarketSell(part);
      const pnl = estimatePnl(pos.entry, avg || px, sold);
      pos.amount -= sold;
      pos.tp1Done = true;
      state.dailyPnlKRW += pnl;
      state.capitalKRW += pnl;
      appendCsv({
        datetime_kst: nowKST(),
        side: MODE === "live" ? "SELL(live)" : "SELL(paper)",
        entry: pos.entry,
        exit: avg || px,
        amount: sold,
        pnl_krw: Math.round(pnl),
        reason: "tp1",
        notes: "ws",
      });
      saveState(state);
      const msg = `✅ 1차 익절 (+${(TP1 * 100).toFixed(2)}%)\n손익=${Math.round(
        pnl
      )}원`;
      console.log(msg);
      await notify(msg);
    }

    // TP2
    if (!pos.tp2Done && px >= tp2) {
      const part = pos.amount * 0.3;
      const { sold, avg } = await placeMarketSell(part);
      const pnl = estimatePnl(pos.entry, avg || px, sold);
      pos.amount -= sold;
      pos.tp2Done = true;
      state.dailyPnlKRW += pnl;
      state.capitalKRW += pnl;
      appendCsv({
        datetime_kst: nowKST(),
        side: MODE === "live" ? "SELL(live)" : "SELL(paper)",
        entry: pos.entry,
        exit: avg || px,
        amount: sold,
        pnl_krw: Math.round(pnl),
        reason: "tp2",
        notes: "ws",
      });
      saveState(state);
      const msg = `✅ 2차 익절 (+${(TP2 * 100).toFixed(2)}%)\n손익=${Math.round(
        pnl
      )}원`;
      console.log(msg);
      await notify(msg);
    }

    // 트레일링
    if (px <= trailLine) {
      const { sold, avg } = await placeMarketSell(pos.amount);
      const pnl = estimatePnl(pos.entry, avg || px, sold);
      state.dailyPnlKRW += pnl;
      state.consecutiveLosses = pnl < 0 ? state.consecutiveLosses + 1 : 0;
      state.capitalKRW += pnl;
      appendCsv({
        datetime_kst: nowKST(),
        side: MODE === "live" ? "SELL(live)" : "SELL(paper)",
        entry: pos.entry,
        exit: avg || px,
        amount: sold,
        pnl_krw: Math.round(pnl),
        reason: "trail",
        notes: `ws peak=${Math.round(pos.peak)}`,
      });
      state.open = null;
      saveState(state);
      const msg = `📉 트레일링 청산\n손익=${Math.round(pnl)}원`;
      console.log(msg);
      await notify(msg);
      return;
    }

    saveState(state);
  } catch (e: any) {
    console.error("[EXIT LOOP ERROR]", e.message);
  } finally {
    exitRunning = false;
  }
}

/** =========================
 *  부팅
 *  ========================= */
(async () => {
  ensureCsv();
  setupShutdown();
  console.log(`Live trader started. MODE=${MODE}, KILL_SWITCH=${KILL_SWITCH}`);
  await notify(`🟢 봇 시작\nMODE=${MODE} | KILL_SWITCH=${KILL_SWITCH}`);
  // 1) 캔들 마감 +7s 마다 엔트리
  scheduleOnQuarter(12000);
  // 2) WS 가격
  connectWS().catch(console.error);
  startWSHeartbeat();
  startWSPing();
  // 3) 실시간 청산 루프(초당 1회)
  setInterval(liveExitLoop, 1000);
})();
