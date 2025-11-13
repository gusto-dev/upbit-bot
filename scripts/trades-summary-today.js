#!/usr/bin/env node
// Wrapper to show today's (KST) trade summary quickly.
const { spawnSync } = require("child_process");

function kstToday() {
  const now = new Date();
  // Convert to KST (UTC+9)
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const day = kstToday();
const args = [
  "scripts/trades-summary.js",
  "--file",
  "analytics/trades.log",
  "--day",
  day,
];
const res = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(res.status || 0);
