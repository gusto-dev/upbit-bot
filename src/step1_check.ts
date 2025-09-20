import "dotenv/config";
import ccxt from "ccxt";
import { EMA } from "technicalindicators";

async function main() {
  const upbit = new ccxt.upbit({ enableRateLimit: true });
  const symbol = "BTC/KRW";
  const tf = "15m";

  // 최근 300개 캔들
  const ohlcv = await upbit.fetchOHLCV(symbol, tf, undefined, 300);
  const closes = ohlcv.map((c) => c[4]);

  const ema50 = EMA.calculate({ period: 50, values: closes }).at(-1);
  const ema200 = EMA.calculate({ period: 200, values: closes }).at(-1);

  console.log(`[OK] closes=${closes.length}, ema50=${ema50}, ema200=${ema200}`);
}
main().catch((e) => console.error(e));
