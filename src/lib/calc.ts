// Dollar estimates for holding a perp position. Pure functions; the page feeds
// them costs (bps, one way) and funding (annualized decimal).
//
// Sign convention, verified 2026-11-20 for Omni, Hyperliquid and Lighter docs:
// a positive funding rate means longs pay shorts.

export type Side = "long" | "short";

export const HOURS_PER_YEAR = 24 * 365;

/**
 * Omni quotes only $1K and $100K. Between them, interpolate the one-way cost
 * linearly in size; below $1K use the $1K quote; above $100K there is no quote.
 */
export function omniCostAt(size: number, c1k: number | null, c100k: number | null): number | null {
  if (!(size > 0)) return null;
  if (size <= 1_000) return c1k;
  if (size > 100_000 || c1k === null || c100k === null) return null;
  return c1k + ((c100k - c1k) * (size - 1_000)) / 99_000;
}

/** Dollars for one fill of `size` at a one-way cost in bps. */
export function fillUsd(size: number, bps: number): number {
  return (size * bps) / 1e4;
}

/**
 * Funding paid over `hours` (positive = you pay, negative = you receive) for a
 * position of `size` USD at an annualized rate. Assumes the rate holds.
 */
export function fundingUsd(size: number, annualRate: number, hours: number, side: Side): number {
  const paidByLong = (size * annualRate * hours) / HOURS_PER_YEAR;
  return side === "long" ? paidByLong : -paidByLong;
}

export interface LegEstimate {
  entry: number | null; // $ to open
  exit: number | null; // $ to close (same one-way cost assumed)
  fundingNow: number | null; // $ over the hold at the current rate
  fundingAvg: number | null; // $ over the hold at the trailing 24 h average rate
  totalNow: number | null;
  totalAvg: number | null;
}

export function legEstimate(
  size: number,
  hours: number,
  side: Side,
  oneWayBps: number | null,
  rateNow: number | null,
  rateAvg: number | null,
): LegEstimate {
  const entry = oneWayBps === null ? null : fillUsd(size, oneWayBps);
  const exit = entry;
  const fundingNow = rateNow === null ? null : fundingUsd(size, rateNow, hours, side);
  const fundingAvg = rateAvg === null ? null : fundingUsd(size, rateAvg, hours, side);
  const sum = (f: number | null) => (entry === null || exit === null || f === null ? null : entry + exit + f);
  return { entry, exit, fundingNow, fundingAvg, totalNow: sum(fundingNow), totalAvg: sum(fundingAvg) };
}

export interface PairEstimate {
  trading: number | null; // $ for all four fills
  fundingPerDayNow: number | null; // net $/day, negative = you collect
  fundingPerDayAvg: number | null;
  totalNow: number | null; // trading + net funding over the hold
  totalAvg: number | null;
  breakEvenHoursNow: number | null; // hold needed for collected funding to cover trading cost
  breakEvenHoursAvg: number | null;
}

/** Long `size` on one venue and short the same size on another. */
export function pairEstimate(
  size: number,
  hours: number,
  longLeg: { bps: number | null; rateNow: number | null; rateAvg: number | null },
  shortLeg: { bps: number | null; rateNow: number | null; rateAvg: number | null },
): PairEstimate {
  const trading = longLeg.bps === null || shortLeg.bps === null ? null : 2 * fillUsd(size, longLeg.bps) + 2 * fillUsd(size, shortLeg.bps);
  const perDay = (a: number | null, b: number | null) => (a === null || b === null ? null : fundingUsd(size, a, 24, "long") + fundingUsd(size, b, 24, "short"));
  const fundingPerDayNow = perDay(longLeg.rateNow, shortLeg.rateNow);
  const fundingPerDayAvg = perDay(longLeg.rateAvg, shortLeg.rateAvg);
  const total = (d: number | null) => (trading === null || d === null ? null : trading + (d * hours) / 24);
  const breakEven = (d: number | null) => (trading === null || d === null || d >= 0 ? null : (trading / -d) * 24);
  return {
    trading,
    fundingPerDayNow,
    fundingPerDayAvg,
    totalNow: total(fundingPerDayNow),
    totalAvg: total(fundingPerDayAvg),
    breakEvenHoursNow: breakEven(fundingPerDayNow),
    breakEvenHoursAvg: breakEven(fundingPerDayAvg),
  };
}

/** Mean of a column over the trailing window, ignoring missing values. */
export function trailingMean(rows: Record<string, number | null>[], col: string, now: number, windowS = 86400): number | null {
  let n = 0;
  let sum = 0;
  for (const r of rows) {
    const t = r.t;
    const v = r[col];
    if (t === null || t === undefined || now - t > windowS || t > now) continue;
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    n++;
    sum += v;
  }
  return n ? sum / n : null;
}

/** Median of `col` per UTC hour of day (0-23), from rows inside the window. */
export function byHour(rows: Record<string, number | null>[], col: string, now: number, windowS = 7 * 86400): (number | null)[] {
  const buckets: number[][] = Array.from({ length: 24 }, () => []);
  for (const r of rows) {
    const t = r.t;
    const v = r[col];
    if (t === null || t === undefined || now - t > windowS || t > now) continue;
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    buckets[new Date(t * 1000).getUTCHours()].push(v);
  }
  return buckets.map((b) => {
    if (b.length < 3) return null;
    b.sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  });
}
