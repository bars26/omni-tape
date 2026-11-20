// Rolling summaries built by the collector from each market's history: listing
// dates, 24 h changes and a 7-day digest. Pure functions so they can be tested.

import { persistence, type HistRow } from "./history.ts";
import type { Change, MarketRow, Platform } from "./types.ts";

export const DAY = 86400;
export const WEEK = 7 * DAY;

// ---------- listings ----------

export interface Listing {
  name: string;
  first: number; // first snapshot the market appeared in
  last: number; // last snapshot it appeared in
}
export interface Listings {
  since: number; // first snapshot of the whole history: markets seen then were already listed
  markets: Record<string, Listing>;
}

/**
 * Record which markets are in this snapshot. `firstSeen` backfills a market the
 * file does not know yet (from the first row of its history) so that adding this
 * file to an existing history does not make every market look new.
 */
export function updateListings(prev: Listings | null, since: number, markets: { tk: string; name: string }[], now: number, firstSeen: (tk: string) => number | null): Listings {
  const out: Listings = { since: prev?.since ?? since, markets: { ...(prev?.markets ?? {}) } };
  for (const m of markets) {
    const old = out.markets[m.tk];
    out.markets[m.tk] = old ? { ...old, name: m.name, last: now } : { name: m.name, first: firstSeen(m.tk) ?? now, last: now };
  }
  return out;
}

/** Markets that appeared after tracking began, newest first. */
export function newListings(l: Listings, now: number, windowS = WEEK): { tk: string; name: string; first: number }[] {
  const grace = 3600; // markets present in the first hour count as already listed
  return Object.entries(l.markets)
    .filter(([, x]) => x.first > l.since + grace && now - x.first <= windowS)
    .map(([tk, x]) => ({ tk, name: x.name, first: x.first }))
    .sort((a, b) => b.first - a.first);
}

/** Markets missing from the latest snapshot for more than two hours. */
export function goneListings(l: Listings, now: number, windowS = WEEK): { tk: string; name: string; last: number }[] {
  return Object.entries(l.markets)
    .filter(([, x]) => now - x.last > 2 * 3600 && now - x.last <= windowS)
    .map(([tk, x]) => ({ tk, name: x.name, last: x.last }))
    .sort((a, b) => b.last - a.last);
}

// ---------- changes ----------

/** The row nearest to `at`, if one lies within `tolerance` seconds of it. */
export function rowNear(rows: HistRow[], at: number, tolerance = 2 * 3600): HistRow | null {
  let best: HistRow | null = null;
  let gap = Infinity;
  for (const r of rows) {
    if (r.t === null) continue;
    const d = Math.abs(r.t - at);
    if (d < gap) {
      gap = d;
      best = r;
    }
  }
  return best && gap <= tolerance ? best : null;
}

const oiOf = (r: HistRow | null) => (r && r.oiL !== null && r.oiS !== null ? r.oiL + r.oiS : null);
const shareOf = (r: HistRow | null) => {
  const o = oiOf(r);
  return r && o !== null && o > 0 ? r.oiL! / o : null;
};
const rel = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b - 1);

/** Change between the snapshot nearest `now - windowS` and the latest one. */
export function change(rows: HistRow[], now: number, windowS = DAY): Change | null {
  const last = rowNear(rows, now, 3600);
  const then = rowNear(rows, now - windowS);
  if (!last || !then) return null;
  const ls = shareOf(last);
  const ts = shareOf(then);
  return { mark: rel(last.mark, then.mark), oi: rel(oiOf(last), oiOf(then)), long: ls === null || ts === null ? null : ls - ts };
}

// ---------- 7-day digest ----------

export interface DigestRow {
  tk: string;
  name: string;
  vol: number | null;
  value: number; // the figure the list is ranked by
  detail?: Record<string, number | null>;
}

export interface Digest {
  t: number;
  from: number; // start of the window actually covered
  week: string; // ISO week of `t`, e.g. 2026-W47
  platform: { now: Platform; then: Platform | null };
  newListings: { tk: string; name: string; first: number }[];
  gone: { tk: string; name: string; last: number }[];
  steadyGaps: DigestRow[]; // funding one way most of the week
  oiUp: DigestRow[];
  oiDown: DigestRow[];
  longShift: DigestRow[];
  omniCheaper: DigestRow[]; // median $100K cost, Omni vs Hyperliquid
  omniDearer: DigestRow[];
}

export function isoWeek(t: number): string {
  const d = new Date(t * 1000);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * DAY * 1000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface DigestInput {
  now: number;
  markets: MarketRow[];
  history: (tk: string) => HistRow[];
  platformRows: HistRow[];
  listings: Listings;
  top?: number;
  minVol?: number; // ignore markets thinner than this in 24 h volume
  minOi?: number; // ignore OI changes on markets smaller than this
}

export function buildDigest({ now, markets, history, platformRows, listings, top = 10, minVol = 100_000, minOi = 1_000_000 }: DigestInput): Digest {
  const steady: DigestRow[] = [];
  const oi: DigestRow[] = [];
  const longs: DigestRow[] = [];
  const cost: DigestRow[] = [];
  let from = now;
  const recent = new Set(newListings(listings, now).map((x) => x.tk));

  for (const m of markets) {
    const rows = history(m.tk).filter((r) => r.t !== null && now - r.t <= WEEK && r.t <= now);
    if (!rows.length) continue;
    from = Math.min(from, rows[0].t!);
    const liquid = (m.vol ?? 0) >= minVol;

    const p = persistence(rows, now, WEEK);
    if (liquid && p && p.n >= 96) {
      const share = Math.max(p.above, p.below) / p.n;
      steady.push({ tk: m.tk, name: m.name, vol: m.vol, value: share, detail: { above: p.above, below: p.below, n: p.n, avg: p.avg } });
    }

    const first = rows[0];
    const span = now - first.t!;
    const c = span >= 3 * DAY && !recent.has(m.tk) ? change(rows, now, span) : null;
    const oiNow = m.oiL !== null && m.oiS !== null ? m.oiL + m.oiS : null;
    const oiThen = first.oiL !== null && first.oiS !== null ? first.oiL! + first.oiS! : null;
    // Ratios off a tiny base (a market that just opened) are noise, not news.
    if (c && oiNow !== null && oiNow >= minOi && oiThen !== null && oiThen >= minOi / 4) {
      if (c.oi !== null) oi.push({ tk: m.tk, name: m.name, vol: m.vol, value: c.oi, detail: { oiNow, mark: c.mark } });
      if (c.long !== null) longs.push({ tk: m.tk, name: m.name, vol: m.vol, value: c.long, detail: { longNow: oiNow > 0 ? m.oiL! / oiNow : null } });
    }

    if (liquid) {
      const pairs = rows.filter((r) => r.o100k !== null && r.h100k !== null && r.o100k !== undefined && r.h100k !== undefined);
      if (pairs.length >= 96) {
        const o = median(pairs.map((r) => r.o100k!));
        const h = median(pairs.map((r) => r.h100k!));
        if (o !== null && h !== null) cost.push({ tk: m.tk, name: m.name, vol: m.vol, value: h - o, detail: { omni: o, hl: h, n: pairs.length } });
      }
    }
  }

  const byAbs = (a: DigestRow, b: DigestRow) => Math.abs(b.value) - Math.abs(a.value);
  const plat = (r: HistRow | null): Platform | null =>
    r ? { vol24: r.vol24 ?? null, cumVol: r.cumVol ?? null, tvl: r.tvl ?? null, oi: r.oi ?? null, markets: r.markets ?? 0 } : null;
  const pNow = rowNear(platformRows, now, 3600);
  const pThen = rowNear(platformRows, Math.max(from, now - WEEK), 3 * 3600);

  return {
    t: now,
    from,
    week: isoWeek(now),
    platform: { now: plat(pNow) ?? { vol24: null, cumVol: null, tvl: null, oi: null, markets: markets.length }, then: plat(pThen) },
    newListings: newListings(listings, now),
    gone: goneListings(listings, now),
    steadyGaps: steady.sort((a, b) => b.value - a.value || Math.abs(b.detail!.avg ?? 0) - Math.abs(a.detail!.avg ?? 0)).slice(0, top),
    oiUp: oi.filter((r) => r.value > 0).sort(byAbs).slice(0, top),
    oiDown: oi.filter((r) => r.value < 0).sort(byAbs).slice(0, top),
    longShift: longs.sort(byAbs).slice(0, top),
    omniCheaper: cost.filter((r) => r.value > 0).sort((a, b) => (b.vol ?? 0) - (a.vol ?? 0)).slice(0, top),
    omniDearer: cost.filter((r) => r.value < 0).sort((a, b) => (b.vol ?? 0) - (a.vol ?? 0)).slice(0, top),
  };
}
