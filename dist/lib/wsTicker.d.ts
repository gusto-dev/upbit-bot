export declare function toUpbitCode(ccxtSymbol: string): string;
export declare class UpbitTickerFeed {
    private ws;
    private latest;
    private codes;
    private alive;
    constructor(codes: string[]);
    get(code: string): number | undefined;
    connect(): void;
}
//# sourceMappingURL=wsTicker.d.ts.map