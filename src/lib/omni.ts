import type { MarketRow, Platform } from "./types.ts";
import { omniCost } from "./cost.ts";

export const OMNI_STATS_URL =
  "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/v2/stats";

/** Parse a decimal string; anything missing or non-finite becomes null (unknown stays unknown). */
export function num(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

export function baseOf(ticker: string): string {
  return ticker.replace(/-(PERP|SWAP)$/i, "").toUpperCase();
}

interface Side {
  bid?: string;
  ask?: string;
}

function spreadBps(q: Side | undefined): number | null {
  const bid = num(q?.bid);
  const ask = num(q?.ask);
  if (bid === null || ask === null || bid <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 1e4;
}

function impactBps(base: Side | undefined, big: Side | undefined): number | null {
  const bid = num(base?.bid);
  const ask = num(base?.ask);
  const bigAsk = num(big?.ask);
  if (bid === null || ask === null || bigAsk === null || bid <= 0) return null;
  const mid = (bid + ask) / 2;
  return ((bigAsk - mid) / mid) * 1e4;
}

// The documented response shape, loosely typed: every field is treated as optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export function parseOmniStats(raw: Raw): { platform: Platform; markets: MarketRow[] } {
  if (!raw || !Array.isArray(raw.listings)) {
    throw new Error(`unexpected Omni response: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  const markets: MarketRow[] = [];
  for (const l of raw.listings as Raw[]) {
    if (typeof l?.ticker !== "string") continue;
    const f = l.funding ?? null;
    const q = l.quotes ?? {};
    markets.push({
      tk: l.ticker,
      base: baseOf(l.ticker),
      type: l.contract_type === "swap" ? "swap" : "perp",
      name: typeof l.name === "string" ? l.name : l.ticker,
      mark: num(l.mark_price),
      vol: num(l.volume_24h),
      oiL: num(l.open_interest?.long_open_interest),
      oiS: num(l.open_interest?.short_open_interest),
      fNext: num(f?.next?.annualized_rate),
      fLast: num(f?.last?.annualized_rate),
      intS: num(f?.interval_seconds),
      spread: spreadBps(q.base),
      imp100k: impactBps(q.base, q.size_100k),
      o1k: omniCost(q.base, q.size_1k),
      o100k: omniCost(q.base, q.size_100k),
      v: {},
    });
  }
  markets.sort((a, b) => a.tk.localeCompare(b.tk));
  return {
    platform: {
      vol24: num(raw.total_volume_24h),
      cumVol: num(raw.cumulative_volume),
      tvl: num(raw.tvl),
      oi: num(raw.open_interest),
      markets: markets.length,
    },
    markets,
  };
}
