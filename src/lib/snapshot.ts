import { parseOmniStats } from "./omni.ts";
import { normalizeSymbol, type FundingMap } from "./venues.ts";
import { VENUES, type Snapshot, type SourceStatus, type Venue } from "./types.ts";

export interface Inputs {
  t: number;
  omniRaw: unknown;
  venues: Partial<Record<Venue, FundingMap | Error>>;
}

/** Join Omni's markets with every venue's funding by base symbol. Omni failing is fatal; a venue failing is not. */
export function buildSnapshot({ t, omniRaw, venues }: Inputs): Snapshot {
  const { platform, markets } = parseOmniStats(omniRaw);
  const sources = { omni: { ok: true, count: markets.length } } as Snapshot["sources"];
  for (const v of VENUES) {
    const got = venues[v];
    const status: SourceStatus =
      got instanceof Map
        ? { ok: true, count: got.size }
        : { ok: false, count: 0, error: got instanceof Error ? got.message.slice(0, 160) : "not fetched" };
    sources[v] = status;
    if (!(got instanceof Map)) continue;
    for (const m of markets) {
      if (m.type !== "perp") continue; // Omni swaps are indices/commodities, no like-for-like perp elsewhere
      const rate = got.get(normalizeSymbol(m.base));
      if (rate !== undefined) m.v[v] = rate;
    }
  }
  return { t, platform, markets, sources };
}

/** Median of the other venues' funding, or null when none list the market. */
export function venueMedian(v: Partial<Record<Venue, number>>): number | null {
  const xs = Object.values(v).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
