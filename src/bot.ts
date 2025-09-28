/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import ccxt from "ccxt";
import { UpbitTickerFeed } from "./wsTicker";
import { loadState, saveState } from "./persist";

// ===================== ENV =====================
const MODE = (process.env.MODE || "live") as "live" | "paper";
const SYMBOL_CCXT = process.env.SYMBOL_CCXT || "BTC/KRW";
const TRADE_COINS = (process.env.TRADE_COINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const TF = process.env.TF || "5m";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const UPBIT_API_KEY = process.env.UPBIT_API_KEY || "";
const UPBIT_SECRET = process.env.UPBIT_SECRET || "";

// 안전장치/전략 파라미터 (필요시 .env로 조정)
const BASE_CAPITAL_KRW = Number(process.env.BASE_CAPITAL_KRW ?? 500000);  // 기준 자본
const POS_PCT          = Number(process.env.POS_PCT ?? 0.12);             // 12% 배팅
const LIVE_MIN_ORDER_KRW = Number(process.env.LIVE_MIN_ORDER_KRW ?? 5000);// 거래소 최소주문가 이상

const ENTRY_SLIPPAGE_BPS = Number(process.env.ENTRY_SLIPPAGE_BPS ?? 30);  // 0.30% 이내 체결 허용

const BREAKOUT_LOOKBACK  = Number(process.env.BREAKOUT_LOOKBACK ?? 6);    // 최근 N봉 고가 돌파 시 진입
const BREAKOUT_TOL_BPS   = Number(process.env.BREAKOUT_TOL_BPS ?? 15);    // 돌파 허용 오차

const USE_REGIME_FILTER  = String(process.env.USE_REGIME_FILTER ?? "true") === "true";
const REGIME_EMA_FAST    = Number(process.env.REGIME_EMA_FAST ?? 20);
const REGIME_EMA_SLOW    = Number(process.env.REGIME_EMA_SLOW ?? 60);

const TP1                = Number(process.env.TP1 ?? 0.012);              // +1.2% 절반 익절
const TP2                = Number(process.env.TP2 ?? 0.022);              // +2.2% 전량 익절
const TRAIL              = Number(process.env.TRAIL ?? -0.015);           // -1.5% 트레일
const USE_BEP_AFTER_TP1  = String(process.env.USE_BEP_AFTER_TP1 ?? "true") === "true";

const MAX_TRADES_PER_DAY = Number(process.env.MAX_TRADES_PER_DAY ?? 4);
const MAX_CONCURRENT_POS = Number(process.env.MAX_CONCURRENT_POSITIONS ?? 3);

const QUIET_HOUR_START   = Number(process.env.QUIET_HOUR_START ?? 2);     // 02:00~06:00 엔트리 금지
const QUIET_HOUR_END     = Number(process.env.QUIET_HOUR_END ?? 6);

// 동기화 옵션
const SYNC_MIN_KRW = Number(process.env.SYNC_MIN_KRW ?? 3000);
const SYNC_TOLERANCE_BPS = Number(process.env.SYNC_TOLERANCE_BPS ?? 50);
const SYNC_POS_INTERVAL_MIN = Number(process.env.SYNC_POS_INTERVAL_MIN ?? 15);
const REMOVE_STRIKE_REQUIRED = Number(process.env.SYNC_REMOVE_STRIKE ?? 2);

// ===================== TYPES/STATE =====================
type Pos = {
  entry: number;
  size: number;
  invested: number;
  peak?: number;
  tookTP1?: boolean;
  openedAt: number;
};
const positions: Map<string, Pos> = new Map();

type DayCounter = { day: string; count: number };
const tradeCounter: Map<string, DayCounter> = new Map(); // 심볼별 일일 진입횟수

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
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (!data?.ok) console.error("TG send failed:", res.status, JSON.stringify(data));
  } catch (e:any) {
    console.error("TG error:", e?.message || e);
  } finally {
    clearTimeout(timer);
  }
}

// ===================== HELPERS =====================
function toUpbitCode(ccxtSymbol: string) {
  const [base, quote] = ccxtSymbol.split("/");
  return `${quote}-${base}`;
}
function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }

function safeWalletQty(balance: any, base: string): number {
  const byKey = (obj: any, k: string) => (obj && Number(obj[k])) || 0;
  const total = byKey(balance?.total, base) || byKey(balance?.total, base.toUpperCase()) || byKey(balance?.total, base.toLowerCase());
  const free  = byKey(balance?.free,  base) || byKey(balance?.free,  base.toUpperCase()) || byKey(balance?.free,  base.toLowerCase());
  const used  = byKey(balance?.used,  base) || byKey(balance?.used,  base.toUpperCase()) || byKey(balance?.used,  base.toLowerCase());
  const qty = total > 0 ? total : free + used;
  return qty > 0 ? qty : 0;
}

function nowSeoulHour(): number {
  const kst = new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul", hour12: false });
  const d = new Date(kst);
  return d.getHours();
}

function inQuietHours(): boolean {
  const h = nowSeoulHour();
  if (QUIET_HOUR_START <= QUIET_HOUR_END) {
    return h >= QUIET_HOUR_START && h < QUIET_HOUR_END;
  } else {
    // 예: 22~02 형태
    return h >= QUIET_HOUR_START || h < QUIET_HOUR_END;
  }
}

function floorToStep(v:number, step:number){
  if (!step || step<=0) return v;
  return Math.floor(v/step)*step;
}
function getMarketInfo(symbol:string){
  const m = exchange.markets?.[symbol];
  return m || {};
}

// 캔들/지표
async function fetchCandles(symbol:string, tf:string, limit=200){
  try{
    return await exchange.fetchOHLCV(symbol, tf, undefined, limit);
  }catch(e){ return []; }
}
function ema(values:number[], period:number): number[]{
  const k = 2/(period+1);
  const out:number[]=[];
  let emaPrev = values[0];
  out.push(emaPrev);
  for(let i=1;i<values.length;i++){
    const e = values[i]*k + emaPrev*(1-k);
    out.push(e); emaPrev=e;
  }
  return out;
}
function last<T>(arr:T[], n=1){ return arr.slice(-n); }

// ===================== SYNC (지갑↔포지션) =====================
const _noWalletStrike: Map<string, number> = new Map();
let _syncLock = false;

async function syncPositionsFromWalletOnce(symbols: string[], feed: UpbitTickerFeed) {
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

      positions.set(s, { entry: lastPx, size: qty, invested: krw, peak: lastPx, tookTP1: false, openedAt: Date.now() });
      await tg(`🔄 동기화: ${s} | qty≈${qty.toFixed(6)} | KRW≈${Math.round(krw)} (entry≈${Math.round(lastPx)})`);
    }
  } catch (e:any) {
    await tg(`⚠️ 초기 동기화 실패: ${e?.message || e}`);
  }
}

async function reconcilePositionsFromWallet(symbols: string[], feed: UpbitTickerFeed) {
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
        positions.set(s, { entry: lastPx, size: walletQty, invested: walletKRW, peak: lastPx, tookTP1: false, openedAt: Date.now() });
        _noWalletStrike.delete(s);
        await tg(`🔄 동기화: ${s} 신규등록 | qty≈${walletQty.toFixed(6)} | KRW≈${Math.round(walletKRW)} (entry≈${Math.round(lastPx)})`);
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
          pos.peak = Math.max(pos.peak ?? lastPx, lastPx);
          positions.set(s, pos);
          await tg(`🔄 동기화: ${s} 사이즈 보정 | qty≈${walletQty.toFixed(6)} | KRW≈${Math.round(pos.invested)} (entry 유지 ${Math.round(pos.entry)})`);
        }
      }
    }
  } catch (e:any) {
    await tg(`⚠️ 동기화 오류: ${e?.message || e}`);
  } finally {
    _syncLock = false;
  }
}

// ===================== ORDER HELPERS =====================
function todayStrKST(){
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul"})).toISOString().slice(0,10);
}
function incTradeCount(sym:string){
  const t = tradeCounter.get(sym);
  const today = todayStrKST();
  if (!t || t.day !== today) {
    tradeCounter.set(sym, { day: today, count: 1 });
    return 1;
  } else {
    t.count += 1;
    tradeCounter.set(sym, t);
    return t.count;
  }
}
function getTradeCount(sym:string){
  const t = tradeCounter.get(sym);
  const today = todayStrKST();
  if (!t || t.day !== today) return 0;
  return t.count;
}

async function marketBuy(symbol:string, lastPx:number){
  // 배팅 금액
  const budgetKRW = Math.max(LIVE_MIN_ORDER_KRW, Math.floor(BASE_CAPITAL_KRW * POS_PCT));
  const amount = budgetKRW / lastPx;

  // 스텝/정밀도
  await exchange.loadMarkets();
  const mi = getMarketInfo(symbol);
  const step = mi?.precision?.amount ? Math.pow(10, -mi.precision.amount) : 0; // upbit는 정밀도 표기가 다를 수 있음
  const amt = step ? floorToStep(amount, step) : amount;

  if (budgetKRW < LIVE_MIN_ORDER_KRW || amt <= 0) return { ok:false, reason:"amount-too-small" };

  if (MODE === "paper") return { ok:true, paper:true, amt };

  try{
    const o = await exchange.createOrder(symbol, "market", "buy", amt);
    return { ok:true, order:o, amt };
  }catch(e:any){
    return { ok:false, reason:e?.message || "buy-failed" };
  }
}

async function marketSell(symbol:string, amt:number){
  if (amt <= 0) return { ok:false, reason:"zero-amt" };
  if (MODE === "paper") return { ok:true, paper:true, amt };
  try{
    const o = await exchange.createOrder(symbol, "market", "sell", amt);
    return { ok:true, order:o };
  }catch(e:any){
    return { ok:false, reason:e?.message || "sell-failed" };
  }
}

// ===================== STRATEGY RUNNER =====================
async function runner(symbol: string, feed: UpbitTickerFeed) {
  const code = toUpbitCode(symbol);
  await tg(`▶️ 시작: ${symbol} | MODE=${MODE} | paused=false`);

  let lastBarTs = 0;

  for (;;) {
    try{
      // 조용시간엔 신규 진입만 막고, 보유포지션은 관리(익절/손절) 계속
      const quiet = inQuietHours();

      // 실시간 가격
      const lastPx = feed.get(code);
      if (!lastPx) { await sleep(1000); continue; }

      // 캔들 최신화 (봉이 바뀌었을 때만 계산 비용)
      const candles = await fetchCandles(symbol, TF, 120);
      if (!candles.length){ await sleep(1000); continue; }
      const [tOpen, tHigh, tLow, tClose] = last(candles,1)[0].slice(0,5);
      if (tOpen === lastBarTs && lastPx === tClose) {
        // 같은 봉/같은 가격이면 간격만 둔다
        await sleep(1000);
      } else {
        lastBarTs = tOpen;

        const closes = candles.map(c => c[4]);
        const emaFast = ema(closes, Math.min(REGIME_EMA_FAST, closes.length));
        const emaSlow = ema(closes, Math.min(REGIME_EMA_SLOW, closes.length));
        const fast = last(emaFast,1)[0];
        const slow = last(emaSlow,1)[0];

        // 최근 N봉 고가
        const highs = candles.map(c => c[2]);
        const hh = Math.max(...highs.slice(-BREAKOUT_LOOKBACK - 1, -1)); // 직전 N봉 고가

        const pos = positions.get(symbol);
        const inPos = !!pos;

        // ====== 보유 포지션 관리(우선) ======
        if (inPos) {
          // 트레일링/TP/손절 관리
          if (!pos.peak || lastPx > pos.peak) pos.peak = lastPx;

          const pnlPct = (lastPx - pos.entry) / pos.entry;

          // TP1: 절반 익절 -> BEP 보호
          if (!pos.tookTP1 && pnlPct >= TP1) {
            const sellAmt = pos.size * 0.5;
            const r = await marketSell(symbol, sellAmt);
            if (r.ok) {
              pos.size -= sellAmt;
              pos.invested = pos.size * lastPx;
              pos.tookTP1 = true;
              if (USE_BEP_AFTER_TP1) pos.entry = Math.min(pos.entry, lastPx); // BEP 상향(보수적으로 진입가 유지 또는 진입가로 이동)
              positions.set(symbol, pos);
              await tg(`✅ TP1: ${symbol} 50% 익절 | 나머지=${pos.size.toFixed(6)}`);
            } else {
              await tg(`❗ TP1 실패: ${symbol} | ${r.reason}`);
            }
          }

          // TP2: 전량 익절
          if (pnlPct >= TP2) {
            const r = await marketSell(symbol, pos.size);
            if (r.ok) {
              positions.delete(symbol);
              await tg(`🎯 TP2: ${symbol} 전량 익절`);
            } else {
              await tg(`❗ TP2 실패: ${symbol} | ${r.reason}`);
            }
          } else {
            // 트레일링 스탑: peak 대비 하락폭이 |TRAIL| 이상이면 청산
            if (pos.peak && (lastPx - pos.peak) / pos.peak <= TRAIL) {
              const r = await marketSell(symbol, pos.size);
              if (r.ok) {
                positions.delete(symbol);
                await tg(`🛑 트레일 스탑: ${symbol} 청산`);
              } else {
                await tg(`❗ 트레일 실패: ${symbol} | ${r.reason}`);
              }
            }
          }
        }

        // ====== 신규 진입 조건 ======
        if (!inPos && !quiet) {
          // 동시 포지션/일일 거래 제한
          if (Array.from(positions.keys()).length >= MAX_CONCURRENT_POS) {
            // 용량 초과 → 스킵
          } else if (getTradeCount(symbol) >= MAX_TRADES_PER_DAY) {
            // 일일 횟수 초과 → 스킵
          } else {
            // 레짐 필터: 추세 우상향일 때만
            const regimeOk = !USE_REGIME_FILTER || fast >= slow;
            // 돌파: 현재가가 직전 N봉 고가를 소폭 상향 돌파
            const tol = hh * (BREAKOUT_TOL_BPS / 10000);
            const breakoutOk = lastPx >= hh + tol;

            if (regimeOk && breakoutOk) {
              // 슬리피지: 최근 종가 대비 급등 진입 방지
              const ref = tClose || lastPx;
              const slip = (lastPx - ref) / ref * 10000;
              if (slip <= ENTRY_SLIPPAGE_BPS) {
                // 매수
                const r = await marketBuy(symbol, lastPx);
                if (r.ok) {
                  // 포지션 기록
                  const size = r.paper ? (BASE_CAPITAL_KRW * POS_PCT) / lastPx : r.amt;
                  positions.set(symbol, {
                    entry: lastPx,
                    size,
                    invested: size * lastPx,
                    peak: lastPx,
                    tookTP1: false,
                    openedAt: Date.now(),
                  });
                  incTradeCount(symbol);
                  await tg(`🟢 진입: ${symbol} @${Math.round(lastPx)} | size≈${size.toFixed(6)}`);
                } else {
                  await tg(`❗ 진입 실패: ${symbol} | ${r.reason}`);
                }
              } else {
                await tg(`⚠️ 슬리피지 초과로 진입 취소: ${symbol} slip=${slip.toFixed(1)}bps`);
              }
            }
          }
        }

        // 루프 간격
        await sleep(1500);
      }
    }catch(e:any){
      await tg(`❗ runner error(${symbol}): ${e?.message || e}`);
      await sleep(2000);
    }
  }
}

// ===================== MAIN =====================
async function main() {
  const symbols = TRADE_COINS.length ? TRADE_COINS : [SYMBOL_CCXT];
  const codes = symbols.map(toUpbitCode);

  // 이전 상태 복구(선택)
  try {
    const prev = await loadState();
    if (prev?.positions) {
      for (const [k, v] of Object.entries(prev.positions as Record<string, Pos>)) {
        positions.set(k, v);
      }
    }
  } catch {}

  const feed = new UpbitTickerFeed(codes);
  feed.connect();

  console.log(`BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`);
  await tg(`🚀 BOT START | MODE=${MODE} | symbols=${symbols.join(", ")} | TF=${TF}`);

  // 시작 1회 동기화
  await syncPositionsFromWalletOnce(symbols, feed);

  // 전략 루프 시작
  symbols.forEach(s => {
    runner(s, feed).catch(e => tg(`❗ runner error(${s}): ${e?.message || e}`));
  });

  // 주기 동기화(지연 시작)
  const syncMs = Math.max(1, SYNC_POS_INTERVAL_MIN) * 60 * 1000;
  setTimeout(() => {
    reconcilePositionsFromWallet(symbols, feed).catch(e => tg(`⚠️ 주기 동기화 오류: ${e?.message || e}`));
    setInterval(() => {
      reconcilePositionsFromWallet(symbols, feed).catch(e => tg(`⚠️ 주기 동기화 오류: ${e?.message || e}`));
    }, syncMs);
  }, syncMs);

  process.on("SIGINT", async () => {
    await tg("👋 종료(SIGINT)");
    try {
      const out: Record<string, Pos> = {};
      positions.forEach((v,k)=>out[k]=v);
      await saveState({ positions: out, ts: Date.now() });
    }catch{}
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await tg("👋 종료(SIGTERM)");
    try {
      const out: Record<string, Pos> = {};
      positions.forEach((v,k)=>out[k]=v);
      await saveState({ positions: out, ts: Date.now() });
    }catch{}
    process.exit(0);
  });
}

main().catch(async e => {
  console.error(e);
  await tg(`💥 FATAL: ${e?.message || e}`);
  process.exit(1);
});
