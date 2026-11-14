import { VENUES, type MarketRow, type Platform, type Venue } from "./types.ts";

// Per-market history is a small CSV, one row per snapshot. Kept as text so the
// data branch diffs cleanly and the browser can parse it without a library.

export const MARKET_COLS = ["t", "mark", "vol", "oiL", "oiS", "fo", ...VENUES, "spread", "imp100k", "o1k", "o100k", "h1k", "h100k"] as const;
export const PLATFORM_COLS = ["t", "vol24", "cumVol", "tvl", "oi", "markets"] as const;

export type HistRow = Record<string, number | null>;

/** Rows older than this keep hourly resolution only... */
export const FULL_RES_SECONDS = 7 * 86400;
/** ...and rows older than this keep one row per 4 hours (about 190 MB of CSV a year for ~600 markets). */
export const HOURLY_SECONDS = 30 * 86400;

function fmt(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "";
  // 6 significant digits is plenty for charts and keeps files small.
  return Number(x.toPrecision(6)).toString();
}

export function marketToCsvRow(t: number, m: MarketRow): string {
  const vals: (number | null | undefined)[] = [t, m.mark, m.vol, m.oiL, m.oiS, m.fNext];
  for (const v of VENUES) vals.push(m.v[v as Venue]);
  vals.push(m.spread, m.imp100k, m.o1k, m.o100k, m.h1k, m.h100k);
  return vals.map((x, i) => (i === 0 ? String(x) : fmt(x))).join(",");
}

export function platformToCsvRow(t: number, p: Platform): string {
  return [String(t), fmt(p.vol24), fmt(p.cumVol), fmt(p.tvl), fmt(p.oi), String(p.markets)].join(",");
}

export function parseCsv(text: string): HistRow[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const head = lines[0].split(",");
  const out: HistRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const row: HistRow = {};
    head.forEach((h, j) => {
      const c = cells[j];
      row[h] = c === undefined || c === "" ? null : Number(c);
    });
    if (row.t !== null && Number.isFinite(row.t)) out.push(row);
  }
  return out;
}

/**
 * Append a row to CSV text (creating the header when empty), then thin rows older
 * than FULL_RES_SECONDS to the first row of each UTC hour, and rows older than
 * HOURLY_SECONDS to the first row of each 4-hour bucket. Rows are kept sorted
 * and a repeated timestamp replaces the earlier one.
 */
export function appendAndCompact(existing: string, header: readonly string[], row: string, now: number): string {
  const head = header.join(",");
  const lines = existing.split("\n").filter((l) => l.trim() !== "");
  const body = lines.length && lines[0] === head ? lines.slice(1) : lines.length ? migrate(lines, header) : [];
  const byT = new Map<number, string>();
  for (const l of body) byT.set(Number(l.slice(0, l.indexOf(","))), l);
  byT.set(Number(row.slice(0, row.indexOf(","))), row);
  const ts = [...byT.keys()].filter(Number.isFinite).sort((a, b) => a - b);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const t of ts) {
    const age = now - t;
    if (age > FULL_RES_SECONDS) {
      const bucket = age > HOURLY_SECONDS ? `4h:${Math.floor(t / 14400)}` : `1h:${Math.floor(t / 3600)}`;
      if (seen.has(bucket)) continue;
      seen.add(bucket);
    }
    kept.push(byT.get(t)!);
  }
  return [head, ...kept].join("\n") + "\n";
}

/** Re-map rows written under an older header to the current column order. */
function migrate(lines: string[], header: readonly string[]): string[] {
  const oldHead = lines[0].split(",");
  if (oldHead[0] !== "t") return lines; // no header at all: keep as-is
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    const at = new Map(oldHead.map((h, i) => [h, cells[i] ?? ""]));
    return header.map((h) => at.get(h) ?? "").join(",");
  });
}

/** Safe file name for a ticker. */
export function marketFile(tk: string): string {
  return `m/${tk.replace(/[^A-Za-z0-9_-]/g, "_")}.csv`;
}
