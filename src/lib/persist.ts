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
    }
  >;
  tradesToday: Record<string, number>;
  paused: boolean;
};

export function loadState(): SavedState {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STATE_FILE))
      return { positions: {}, tradesToday: {}, paused: false };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { positions: {}, tradesToday: {}, paused: false };
  }
}

export function saveState(state: SavedState) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
