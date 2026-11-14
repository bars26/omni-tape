// Shared shapes for the collector (Node) and the site (browser).

export const VENUES = ["hl", "dydx", "binance", "bybit", "lighter"] as const;
export type Venue = (typeof VENUES)[number];

export const VENUE_LABEL: Record<Venue, string> = {
  hl: "Hyperliquid",
  dydx: "dYdX",
  binance: "Binance",
  bybit: "Bybit",
  lighter: "Lighter",
};

/** One Omni market at one moment. Funding rates are annualized decimals (0.1 = 10%/yr). */
export interface MarketRow {
  tk: string; // Omni ticker, e.g. "BTC-PERP"
  base: string; // "BTC"
  type: "perp" | "swap";
  name: string;
  mark: number | null;
  vol: number | null; // 24h volume, USD
  oiL: number | null; // long open interest, USD
  oiS: number | null; // short open interest, USD
  fNext: number | null; // Omni next funding, annualized
  fLast: number | null; // Omni last funding, annualized
  intS: number | null; // funding interval, seconds
  spread: number | null; // base bid/ask spread, bps of mid
  imp100k: number | null; // cost to buy $100k vs mid, bps
  v: Partial<Record<Venue, number>>; // other venues' funding, annualized
}

export interface Platform {
  vol24: number | null;
  cumVol: number | null;
  tvl: number | null;
  oi: number | null;
  markets: number;
}

export interface SourceStatus {
  ok: boolean;
  count: number;
  error?: string;
}

export interface Snapshot {
  t: number; // unix seconds
  platform: Platform;
  markets: MarketRow[];
  sources: Record<"omni" | Venue, SourceStatus>;
}
