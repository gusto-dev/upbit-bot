// Simple trade analytics logging and aggregation
// JSON Lines file for easy append-only writes.
import * as fs from "fs";
import * as path from "path";

export type TradeEvent = {
  ts: number; // unix ms
  day: string; // KST day string (YYYY-MM-DD)
  symbol: string;
  event: string; // open|tp1|tp2|trail|stop|partial_stop|bep_exit|fee_safe_adjust
  entryPrice?: number;
  exitPrice?: number;
  size?: number; // remaining size after event (for open = full size)
  soldSize?: number; // size executed in this event
  gross?: number;
  fee?: number;
  net?: number;
  pnlPct?: number; // position pct result (for exit events)
  cumNetAfter?: number; // cumulative realizedToday after event
  regime?: string; // bull|flat
  longHold?: boolean;
  filters?: string[]; // e.g. ["breakout","htf","atr","rsi"]
};

export interface AggregatedStats {
  count: number;
  wins: number;
  losses: number;
  grossTotal: number;
  feeTotal: number;
  netTotal: number;
  avgWin?: number;
  avgLoss?: number;
  winRate?: number;
  profitFactor?: number;
  expectancy?: number; // (winRate * avgWin) - (lossRate * avgLoss)
}

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function appendTrade(file: string, ev: TradeEvent) {
  try {
    ensureDir(file);
    fs.appendFileSync(file, JSON.stringify(ev) + "\n", "utf8");
  } catch (e) {
    console.error("[analytics] append error", e);
  }
}

export function loadStats(file: string): AggregatedStats {
  const stats: AggregatedStats = {
    count: 0,
    wins: 0,
    losses: 0,
    grossTotal: 0,
    feeTotal: 0,
    netTotal: 0,
  };
  if (!fs.existsSync(file)) return stats;
  try {
    const data = fs.readFileSync(file, "utf8");
    const lines = data.split(/\n+/).filter(Boolean);
    const netWins: number[] = [];
    const netLosses: number[] = [];
    for (const ln of lines.slice(-5000)) {
      // limit for performance
      try {
        const o: TradeEvent = JSON.parse(ln);
        if (typeof o.net === "number") {
          stats.netTotal += o.net;
          if (o.net > 0) {
            stats.wins += 1;
            netWins.push(o.net);
          } else if (o.net < 0) {
            stats.losses += 1;
            netLosses.push(Math.abs(o.net));
          }
        }
        if (typeof o.gross === "number") stats.grossTotal += o.gross;
        if (typeof o.fee === "number") stats.feeTotal += o.fee;
        stats.count += 1;
      } catch {}
    }
    const winRate =
      stats.wins + stats.losses > 0
        ? stats.wins / (stats.wins + stats.losses)
        : 0;
    const avgWin = netWins.length
      ? netWins.reduce((a, b) => a + b, 0) / netWins.length
      : 0;
    const avgLoss = netLosses.length
      ? netLosses.reduce((a, b) => a + b, 0) / netLosses.length
      : 0;
    const profitFactor =
      avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
    const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
    stats.winRate = winRate;
    stats.avgWin = avgWin;
    stats.avgLoss = avgLoss;
    stats.profitFactor = profitFactor;
    stats.expectancy = expectancy;
    return stats;
  } catch (e) {
    console.error("[analytics] loadStats error", e);
    return stats;
  }
}
