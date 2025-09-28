"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadState = loadState;
exports.saveState = saveState;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DATA_DIR = path_1.default.resolve(process.cwd(), "data");
const STATE_FILE = path_1.default.join(DATA_DIR, "state.json");
function loadState() {
    try {
        if (!fs_1.default.existsSync(DATA_DIR))
            fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
        if (!fs_1.default.existsSync(STATE_FILE))
            return { positions: {}, tradesToday: {}, paused: false };
        return JSON.parse(fs_1.default.readFileSync(STATE_FILE, "utf8"));
    }
    catch {
        return { positions: {}, tradesToday: {}, paused: false };
    }
}
function saveState(state) {
    if (!fs_1.default.existsSync(DATA_DIR))
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    fs_1.default.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
//# sourceMappingURL=persist.js.map