// Points -> VAR airdrop estimate. Pure arithmetic: the value of one point is the
// airdropped share of the FDV split across every point issued by TGE.
//
// One rule set serves the form, the address bar, "Copy link" and "Share on X":
// readDrop() parses a link the same way the form parses typed input, dropErrors()
// validates both, and writeDrop() writes every number at full precision.

// At least 10.2M after the 13 Nov 2026 drop (BeInCrypto, 19 Nov 2026), plus the
// official 150K on each of the six Fridays left in 2026 (20 Nov - 25 Dec).
export const DEFAULT_TOTAL_POINTS = 11_100_000;
export const DEFAULT_SHARE = 0.32; // genesis distribution, per Variational's docs
export const DEFAULT_POINTS = 1000; // example balance when a link gives none
export const DEFAULT_FDV = 1e9;
export const MIN_POINTS = 1; // Variational's minimum balance to claim the genesis airdrop
export const MAX_BPS = 1000; // a one-way cost above 10% is a typo, not a spread
export const FDV_MIN = 100e6;
export const FDV_MAX = 10e9; // the slider's range
export const FDV_LINK_MAX = 1e12; // benchmark rows and links may go past the slider
export const SCENARIOS = [300e6, 500e6, 1e9, 1.5e9, 2e9, 3e9, 4e9, 5e9, 7.5e9, 10e9];

// ---------- arithmetic ----------

/** Dollar value of one point. */
export function perPoint(fdv: number, totalPoints: number, share = DEFAULT_SHARE): number {
  if (!(fdv > 0) || !(totalPoints > 0) || !(share > 0)) return NaN;
  return (fdv * share) / totalPoints;
}

/** Round up at 4 decimals, ignoring float noise (1.38750000001 stays 1.3875). */
export function ceil4(x: number): number {
  return Math.ceil(x * 1e4 - 1e-6) / 1e4;
}

export type TargetNeed = { reachable: true; points: number } | { reachable: false; pool: number };

/**
 * Points needed for `target` dollars at this FDV. A target above the whole
 * airdrop pool cannot be reached; otherwise the claim minimum applies and the
 * result is rounded up at 4 decimals, so it is always enough.
 */
export function targetNeed(target: number, fdv: number, totalPoints: number, share: number): TargetNeed | null {
  const per = perPoint(fdv, totalPoints, share);
  if (!(target > 0) || !(per > 0)) return null;
  const pool = fdv * share;
  if (target > pool) return { reachable: false, pool };
  return { reachable: true, points: Math.min(totalPoints, Math.max(MIN_POINTS, ceil4(target / per))) };
}

/** Dollars of spread per point: volume traded at a one-way cost in bps. 0 bps is a real, free answer. */
export function costPerPoint(volume: number, costBps: number, points: number): number {
  if (!(volume > 0) || !(costBps >= 0) || !(points > 0)) return NaN;
  return (volume * costBps) / 1e4 / points;
}

/** FDV at which one point is worth exactly what it cost. */
export function breakEvenFdv(cpp: number, totalPoints: number, share = DEFAULT_SHARE): number {
  if (!(cpp >= 0) || !(totalPoints > 0) || !(share > 0)) return NaN;
  return (cpp * totalPoints) / share;
}

// ---------- slider ----------

/** Slider position 0..1000 <-> FDV on a log scale between FDV_MIN and FDV_MAX. */
export function fdvFromSlider(pos: number): number {
  const k = Math.min(1000, Math.max(0, pos)) / 1000;
  return roundFdv(FDV_MIN * Math.pow(FDV_MAX / FDV_MIN, k));
}
export function sliderFromFdv(fdv: number): number {
  const f = Math.min(FDV_MAX, Math.max(FDV_MIN, fdv));
  return Math.round((1000 * Math.log(f / FDV_MIN)) / Math.log(FDV_MAX / FDV_MIN));
}
/** Two significant figures, so the slider lands on readable numbers. */
export function roundFdv(x: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / mag) * mag;
}

// ---------- labels (one set, used by cards, tables and the X text) ----------

/** Numbers below this many decimals are shown as typed. */
const DIGITS = 8;

/** A point balance as typed: separators, decimals kept, never rounded to the claim minimum. */
export function pointsLabel(x: number): string {
  return Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: DIGITS }) : "—";
}

/** A total of points: millions for big totals, the plain number otherwise. */
export function totalLabel(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return x >= 1e6 ? `${(x / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 })}M` : pointsLabel(x);
}

/** The airdrop share as typed: 0.325 -> "32.5%", 0.00004 -> "0.004%". */
export function sharePctLabel(share: number): string {
  return Number.isFinite(share) ? `${pctNumber(share)}%` : "—";
}
function pctNumber(share: number): number {
  return +(share * 100).toPrecision(12); // drops float noise such as 32.50000000004
}

/** Your points as a share of all points, readable at any size. */
export function shareLabel(points: number, total: number): string {
  if (!(points >= 0) || !(total > 0)) return "—";
  const p = (points / total) * 100;
  if (p === 0) return "0%";
  if (p >= 1) return `${+p.toFixed(2)}%`;
  return `${+p.toPrecision(2)}%`;
}

/** Dollars at any size, including a break-even FDV under $1K. */
export function fdvLabel(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1e9) return `$${+(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${+(x / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${+(x / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return `$${+x.toFixed(a >= 10 ? 0 : 2)}`;
}

// ---------- state, links and validation ----------

export interface DropState {
  points: number;
  total: number;
  share: number; // 0..1
  fdv: number;
  target: number; // 0 = none
  vol: number; // your Omni volume, 0 = none
  cbps: number | null; // one-way cost the user typed; null = use the automatic one, 0 = free
  abps: number | null; // automatic cost pinned when the scenario was first computed or shared
}

const FIELDS = ["pts", "total", "share", "fdv", "target", "vol", "cbps"] as const;
export type DropField = (typeof FIELDS)[number];
export type DropErrors = Partial<Record<DropField, string>>;

/** A typed or linked number: blank -> null; anything else -> its number (NaN if not one). */
export function parseNum(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Read a link. Defaults apply only to parameters that are missing; a parameter
 * that is present but wrong is kept, so dropErrors() can explain it instead of
 * the page quietly turning it into the example scenario.
 */
export function readDrop(query: string): DropState {
  const q = new URLSearchParams(query);
  const val = (k: string, d: number) => parseNum(q.get(k)) ?? d;
  const share = parseNum(q.get("share"));
  const abps = parseNum(q.get("abps"));
  return {
    points: val("pts", DEFAULT_POINTS),
    total: val("total", DEFAULT_TOTAL_POINTS),
    share: share === null ? DEFAULT_SHARE : share / 100,
    fdv: val("fdv", DEFAULT_FDV),
    target: val("target", 0),
    vol: val("vol", 0),
    cbps: parseNum(q.get("cbps")),
    abps: abps !== null && abps >= 0 && abps <= MAX_BPS ? abps : null,
  };
}

/** Write a link with every number at full precision; total and share always, so defaults can change safely. */
export function writeDrop(st: DropState): string {
  const q = new URLSearchParams({ pts: String(st.points), fdv: String(st.fdv), total: String(st.total), share: String(pctNumber(st.share)) });
  if (st.target !== 0) q.set("target", String(st.target));
  if (st.vol !== 0) q.set("vol", String(st.vol));
  if (st.cbps !== null) q.set("cbps", String(st.cbps));
  else if (st.vol > 0 && st.abps !== null) q.set("abps", String(st.abps));
  return q.toString();
}

/** Same rules for typed input and for links. */
export function dropErrors(st: DropState): DropErrors {
  const e: DropErrors = {};
  if (!(st.total > 0)) e.total = "Enter a total above 0";
  if (!(st.points > 0)) e.pts = "Enter a point balance above 0";
  else if (st.total > 0 && st.points > st.total) e.pts = "Your points cannot exceed total points";
  if (!(st.share > 0) || st.share > 1) e.share = "Airdrop share must be above 0 and at most 100%";
  if (!(st.fdv >= FDV_MIN) || st.fdv > FDV_LINK_MAX) e.fdv = `FDV must be between ${fdvLabel(FDV_MIN)} and ${fdvLabel(FDV_LINK_MAX)}`;
  if (!(st.target >= 0)) e.target = "Target cannot be negative";
  if (!(st.vol >= 0)) e.vol = "Volume cannot be negative";
  if (st.cbps !== null && !(st.cbps >= 0 && st.cbps <= MAX_BPS)) e.cbps = `Cost per fill must be between 0 and ${MAX_BPS} bps`;
  return e;
}

/** Errors that make the whole estimate meaningless (the rest only affect their own section). */
export function coreError(e: DropErrors): boolean {
  return Boolean(e.pts || e.total || e.share || e.fdv);
}

/** The one-way cost the cost section uses: typed, else pinned, else live; null if none exists. */
export function effectiveBps(st: DropState, live: number | null): number | null {
  if (st.cbps !== null) return st.cbps;
  if (st.abps !== null) return st.abps;
  return live !== null && Number.isFinite(live) && live >= 0 ? live : null;
}

/**
 * Before any link is written, pin the live automatic cost when it is in use, so
 * the address bar, Copy link and Share on X all carry the same scenario.
 */
export function pinAuto(st: DropState, live: number | null): DropState {
  if (st.cbps === null && st.abps === null && st.vol > 0 && live !== null && Number.isFinite(live) && live >= 0) return { ...st, abps: live };
  return st;
}

// ---------- benchmarks ----------

// Daily UTC closes from each venue's own spot market (Hyperliquid HYPE/USDC @107,
// Lighter LIT/USDC market 2049), both with a 1B max supply, so FDV = price x 1B.
export const BENCH_SCANNED_THROUGH = "2026-11-24";

export interface Benchmark {
  token: "HYPE" | "LIT";
  label: string;
  date: string;
  price: number;
  fdv: number;
  note?: string;
}
export const SUPPLY = 1e9;
const b = (token: Benchmark["token"], label: string, date: string, price: number, note?: string): Benchmark => ({ token, label, date, price, fdv: price * SUPPLY, note });

// Launch days first: they answer "what if VAR opened where HYPE or LIT did".
// Lows use the same rule for both tokens: lowest daily close after launch day.
export const BENCHMARKS: Benchmark[] = [
  b("HYPE", "Launch day close", "2024-11-29", 6.25, "opened near $2 in the genesis auction, closed day one at $6.25"),
  b("LIT", "Launch day close", "2025-12-30", 2.58),
  b("HYPE", "Lowest close after launch day", "2024-12-02", 8.43, "HYPE never closed below its launch day"),
  b("LIT", "Lowest close after launch day", "2026-03-30", 0.81),
  b("HYPE", "Highest close", "2026-09-22", 97.2),
  b("LIT", "Highest close", "2026-09-23", 5.3),
];

/** Share of supply each benchmark token airdropped at launch, for context. */
export const BENCH_AIRDROP: Record<Benchmark["token"], number> = { HYPE: 0.31, LIT: 0.25 };
