import { num } from "./omni.ts";

// "Cost" here is the one-way cost of a market order of a given USD size, in basis
// points of that venue's own mid price, including the taker fee: the average of
// buying and selling that size. Venues are compared on cost against their own mid,
// so a venue whose whole price sits higher is not penalised for it.

export const SIZES = [1_000, 100_000] as const; // Omni quotes these two sizes

/** Taker fees as a fraction, for the lowest tier / standard account (checked 2026-11-14). */
export const TAKER_FEE = {
  omni: 0, // "There are no trading fees on Omni" — revenue comes from the spread
  hl: 0.00045, // Hyperliquid tier 0 perps
  lighter: 0, // Lighter standard account
} as const;

export type Level = [price: number, size: number]; // size in base units

export function midOf(bids: Level[], asks: Level[]): number | null {
  return bids.length && asks.length ? (bids[0][0] + asks[0][0]) / 2 : null;
}

/**
 * Average fill price for taking `notional` USD from one side of a book (best level
 * first). Null when the visible book is too thin to fill the whole size.
 */
export function fillPrice(levels: Level[], notional: number): number | null {
  let need = notional;
  let base = 0;
  for (const [px, sz] of levels) {
    if (!(px > 0) || !(sz > 0)) continue;
    const lvl = px * sz;
    if (lvl >= need) {
      base += need / px;
      need = 0;
      break;
    }
    base += sz;
    need -= lvl;
  }
  return need > 1e-9 || base <= 0 ? null : notional / base;
}

/**
 * One-way cost in bps (buy and sell averaged) from both sides of a book, fee included.
 * Pass `midIn` when the levels are aggregated, so the mid still comes from the exact book.
 */
export function bookCost(bids: Level[], asks: Level[], notional: number, fee: number, midIn?: number): number | null {
  if (!bids.length || !asks.length) return null;
  const mid = midIn ?? (bids[0][0] + asks[0][0]) / 2;
  if (!(mid > 0)) return null;
  const buy = fillPrice(asks, notional);
  const sell = fillPrice(bids, notional);
  if (buy === null || sell === null) return null;
  const slip = (buy / mid - 1 + (1 - sell / mid)) / 2;
  return (slip + fee) * 1e4;
}

interface Side {
  bid?: unknown;
  ask?: unknown;
}

/** Omni's indicative quote for a size, against the base-quote mid. */
export function omniCost(base: Side | undefined, sized: Side | undefined): number | null {
  const b = num(base?.bid);
  const a = num(base?.ask);
  const sb = num(sized?.bid);
  const sa = num(sized?.ask);
  if (b === null || a === null || sb === null || sa === null || b <= 0 || a < b) return null;
  const mid = (a + b) / 2;
  return ((sa / mid - 1 + (1 - sb / mid)) / 2 + TAKER_FEE.omni) * 1e4;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

/** Hyperliquid `l2Book`: { levels: [bids, asks] } with { px, sz } strings. */
export function parseHlBook(raw: Raw): { bids: Level[]; asks: Level[] } {
  const lv = raw?.levels;
  if (!Array.isArray(lv) || lv.length !== 2) throw new Error("unexpected Hyperliquid book");
  const side = (xs: Raw[]): Level[] => xs.map((x) => [Number(x?.px), Number(x?.sz)] as Level).filter(([p, s]) => p > 0 && s > 0);
  return { bids: side(lv[0]), asks: side(lv[1]) };
}

/** Lighter `orderBookOrders`: individual orders with price and remaining_base_amount. */
export function parseLighterBook(raw: Raw): { bids: Level[]; asks: Level[] } {
  if (!Array.isArray(raw?.bids) || !Array.isArray(raw?.asks)) throw new Error("unexpected Lighter book");
  const side = (xs: Raw[], desc: boolean): Level[] =>
    xs
      .map((x) => [Number(x?.price), Number(x?.remaining_base_amount)] as Level)
      .filter(([p, s]) => p > 0 && s > 0)
      .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]));
  return { bids: side(raw.bids, true), asks: side(raw.asks, false) };
}
