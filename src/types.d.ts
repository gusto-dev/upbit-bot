// Ambient type declarations & shared interfaces
// Fallback declaration for 'ccxt' when @types/ccxt is not installed.
// Provides minimal shapes used in this project to satisfy the compiler.
// For more complete typing, install the official package: npm i -D ccxt

declare module "ccxt" {
  // Basic Market structure subset
  export interface Market {
    symbol: string;
    precision?: { amount?: number; price?: number };
    limits?: {
      amount?: { min?: number; max?: number };
      cost?: { min?: number; max?: number };
      price?: { min?: number; max?: number };
    };
  }

  export interface Balance {
    total?: Record<string, number>;
    free?: Record<string, number>;
    used?: Record<string, number>;
  }

  export interface Order {
    id: string;
    symbol: string;
    side: "buy" | "sell";
    type: string;
    amount: number;
    price?: number;
    status?: string;
    [k: string]: any; // keep flexible
  }

  export class upbit {
    constructor(params: {
      apiKey?: string;
      secret?: string;
      enableRateLimit?: boolean;
    });
    markets?: Record<string, Market>;
    loadMarkets(): Promise<Record<string, Market>>;
    fetchOHLCV(
      symbol: string,
      timeframe: string,
      since?: number,
      limit?: number
    ): Promise<[number, number, number, number, number, number][]>; // ts, open, high, low, close, volume
    fetchBalance(): Promise<Balance>;
    createOrder(
      symbol: string,
      type: string,
      side: "buy" | "sell",
      amount: number,
      price?: number,
      params?: Record<string, any>
    ): Promise<Order>;
  }

  const _default: { upbit: typeof upbit };
  export default _default;
}

// General candle tuple reused across source
declare type Candle = [
  number, // timestamp ms
  number, // open
  number, // high
  number, // low
  number, // close
  number // volume
];
