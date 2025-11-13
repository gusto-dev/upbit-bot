#!/usr/bin/env node
/*
  Portable JSONL trade log summary (no external deps)
  Usage examples:
    node scripts/trades-summary.js --file analytics/trades.log
    node scripts/trades-summary.js --file analytics/trades.log --symbol BTC/KRW
    node scripts/trades-summary.js --file analytics/trades.log --day 2025-01-20
    node scripts/trades-summary.js --file analytics/trades.log --symbol BTC/KRW --last 2000
*/
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    file: "analytics/trades.log",
    symbol: null,
    day: null,
    last: 5000,
  };
  const arr = [...argv];
  function setKV(k, v) {
    if (k === "file") args.file = v;
    else if (k === "symbol") args.symbol = v;
    else if (k === "day") args.day = v;
    else if (k === "last") {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n) && n > 0) args.last = n;
    }
  }
  for (let i = 0; i < arr.length; i++) {
    const tok = arr[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      const k = tok.substring(2, eq);
      const v = tok.substring(eq + 1);
      setKV(k, v);
    } else {
      const k = tok.substring(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[++i] : "true";
      setKV(k, v);
    }
  }
  return args;
}

function fmtPct(x) {
  if (!isFinite(x)) return String(x);
  return (x * 100).toFixed(2) + "%";
}

function human(x, digits = 2) {
  if (!isFinite(x)) return String(x);
  return Number(x).toFixed(digits);
}

function loadLines(file) {
  if (!fs.existsSync(file)) return [];
  // Read whole file for simplicity (log is typically modest size)
  const data = fs.readFileSync(file, "utf8");
  return data.split(/\n+/).filter(Boolean);
}

function computeStats(lines, filter) {
  const stats = {
    count: 0,
    wins: 0,
    losses: 0,
    grossTotal: 0,
    feeTotal: 0,
    netTotal: 0,
    avgWin: 0,
    avgLoss: 0,
    winRate: 0,
    profitFactor: 0,
    expectancy: 0,
  };
  const netWins = [];
  const netLosses = [];
  for (const ln of lines) {
    try {
      const o = JSON.parse(ln);
      if (filter.symbol && o.symbol !== filter.symbol) continue;
      if (filter.day && o.day !== filter.day) continue;
      stats.count += 1;
      if (typeof o.gross === "number") stats.grossTotal += o.gross;
      if (typeof o.fee === "number") stats.feeTotal += o.fee;
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
    } catch (_) {
      // ignore malformed line
    }
  }
  const denom = stats.wins + stats.losses;
  stats.winRate = denom > 0 ? stats.wins / denom : 0;
  stats.avgWin = netWins.length
    ? netWins.reduce((a, b) => a + b, 0) / netWins.length
    : 0;
  stats.avgLoss = netLosses.length
    ? netLosses.reduce((a, b) => a + b, 0) / netLosses.length
    : 0;
  stats.profitFactor =
    stats.avgLoss > 0
      ? stats.avgWin / stats.avgLoss
      : stats.avgWin > 0
      ? Infinity
      : 0;
  stats.expectancy =
    stats.winRate * stats.avgWin - (1 - stats.winRate) * stats.avgLoss;
  return stats;
}

(function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(file)) {
    console.error(`[summary] Log file not found: ${file}`);
    process.exit(1);
  }
  let lines = loadLines(file);
  if (args.last && lines.length > args.last) {
    lines = lines.slice(-args.last);
  }
  const stats = computeStats(lines, { symbol: args.symbol, day: args.day });

  // Header
  console.log("=== Trade Summary ===");
  console.log(`file: ${args.file}`);
  if (args.symbol) console.log(`symbol: ${args.symbol}`);
  if (args.day) console.log(`day: ${args.day}`);
  console.log(`considered lines: ${lines.length}`);
  console.log("");

  // Stats
  console.log(`trades: ${stats.count}`);
  console.log(
    `wins: ${stats.wins}  losses: ${stats.losses}  winRate: ${fmtPct(
      stats.winRate
    )}`
  );
  console.log(
    `avgWin: ${human(stats.avgWin)}  avgLoss: ${human(
      stats.avgLoss
    )}  PF: ${human(stats.profitFactor)}`
  );
  console.log(`expectancy: ${human(stats.expectancy)}`);
  console.log(
    `grossTotal: ${human(stats.grossTotal)}  feeTotal: ${human(
      stats.feeTotal
    )}  netTotal: ${human(stats.netTotal)}`
  );
})();
