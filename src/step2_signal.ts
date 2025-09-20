import "dotenv/config";
import ccxt from "ccxt";
import { EMA } from "technicalindicators";

const symbol = "BTC/KRW",
  tf = "15m";

function breakout(closes: number[], n = 20) {
  if (closes.length < n + 1) return false;
  const priorHigh = Math.max(...closes.slice(-n - 1, -1));
  return closes.at(-1)! > priorHigh;
}

async function main() {
  const ex = new ccxt.upbit({ enableRateLimit: true });
  const ohlcv = await ex.fetchOHLCV(symbol, tf, undefined, 400);
  const closes = ohlcv.map((c) => c[4]);

  const e50 = EMA.calculate({ period: 50, values: closes }).at(-1);
  const e200 = EMA.calculate({ period: 200, values: closes }).at(-1);
  const regimeUp = e50 && e200 && e50 > e200;

  const sig = regimeUp && breakout(closes, 20);
  console.log(`regimeUp=${!!regimeUp}, breakout=${!!sig}`);
  if (sig) console.log(">>> 매수 시그널!");
}
main().catch(console.error);
