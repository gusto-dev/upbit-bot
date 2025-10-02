import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

export type SavedState = {
  positions: Record<
    string,
    {
      entry: number;
      size: number;
      invested: number;
      peak: number;
      tookTP1: boolean;
      openedAt: number;
      bePrice?: number;
      stopPrice?: number;
      initialRiskPct?: number;
      originalEntry?: number;
      accFee?: number; // 누적 매수/부분 실현에서 집계된 실제 수수료 (quote 단위)
    }
  >;
  tradesToday: Record<string, number>;
  paused: boolean;
  realizedToday?: number; // 누적 실현손익 (KRW)
  failureCounts?: Record<string, number>;
  winsToday?: number;
  lossesToday?: number;
  grossToday?: number;
  feeToday?: number;
};

export function loadState(): SavedState {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STATE_FILE))
      return {
        positions: {},
        tradesToday: {},
        paused: false,
        realizedToday: 0,
        failureCounts: {},
        winsToday: 0,
        lossesToday: 0,
        grossToday: 0,
        feeToday: 0,
      };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (typeof raw.realizedToday !== "number") raw.realizedToday = 0;
    if (typeof raw.failureCounts !== "object" || !raw.failureCounts)
      raw.failureCounts = {};
    if (typeof raw.winsToday !== "number") raw.winsToday = 0;
    if (typeof raw.lossesToday !== "number") raw.lossesToday = 0;
    if (typeof raw.grossToday !== "number") raw.grossToday = 0;
    if (typeof raw.feeToday !== "number") raw.feeToday = 0;
    return raw;
  } catch {
    return {
      positions: {},
      tradesToday: {},
      paused: false,
      realizedToday: 0,
      failureCounts: {},
      winsToday: 0,
      lossesToday: 0,
      grossToday: 0,
      feeToday: 0,
    };
  }
}

export function saveState(state: SavedState) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
