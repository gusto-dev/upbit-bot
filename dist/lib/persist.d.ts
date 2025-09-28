export type SavedState = {
    positions: Record<string, {
        entry: number;
        size: number;
        invested: number;
        peak: number;
        tookTP1: boolean;
        openedAt: number;
        bePrice?: number;
    }>;
    tradesToday: Record<string, number>;
    paused: boolean;
};
export declare function loadState(): SavedState;
export declare function saveState(state: SavedState): void;
//# sourceMappingURL=persist.d.ts.map