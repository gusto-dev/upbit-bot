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
    }
  >;
  tradesToday: Record<string, number>;
  paused: boolean;
  realizedToday?: number; // 누적 실현손익 (KRW)
  failureCounts?: Record<string, number>;
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
      };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (typeof raw.realizedToday !== "number") raw.realizedToday = 0;
    if (typeof raw.failureCounts !== "object" || !raw.failureCounts)
      raw.failureCounts = {};
    return raw;
  } catch {
    return {
      positions: {},
      tradesToday: {},
      paused: false,
      realizedToday: 0,
      failureCounts: {},
    };
  }
}

export function saveState(state: SavedState) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
