// Points -> VAR airdrop estimate. Pure arithmetic: the value of one point is the
// airdropped share of the FDV split across every point issued by TGE.

export const DEFAULT_TOTAL_POINTS = 11_200_000;
export const DEFAULT_SHARE = 0.32; // genesis distribution, per Variational's docs
export const FDV_MIN = 100e6;
export const FDV_MAX = 10e9;
export const SCENARIOS = [300e6, 500e6, 1e9, 1.5e9, 2e9, 3e9, 4e9, 5e9, 7.5e9, 10e9];

/** Dollar value of one point. */
export function perPoint(fdv: number, totalPoints: number, share = DEFAULT_SHARE): number {
  if (!(fdv > 0) || !(totalPoints > 0) || !(share > 0)) return NaN;
  return (fdv * share) / totalPoints;
}

/** Points needed to reach `target` dollars at this FDV. */
export function pointsFor(target: number, fdv: number, totalPoints: number, share = DEFAULT_SHARE): number {
  const p = perPoint(fdv, totalPoints, share);
  return target > 0 && p > 0 ? target / p : NaN;
}

/** Dollars of spread paid per point: volume traded at a one-way cost in bps. */
export function costPerPoint(volume: number, costBps: number, points: number): number {
  if (!(volume > 0) || !(costBps >= 0) || !(points > 0)) return NaN;
  return (volume * costBps) / 1e4 / points;
}

/** FDV at which one point is worth exactly what it cost. */
export function breakEvenFdv(cpp: number, totalPoints: number, share = DEFAULT_SHARE): number {
  if (!(cpp >= 0) || !(totalPoints > 0) || !(share > 0)) return NaN;
  return (cpp * totalPoints) / share;
}

/** Slider position 0..1000 <-> FDV on a log scale between FDV_MIN and FDV_MAX. */
export function fdvFromSlider(pos: number): number {
  const k = Math.min(1000, Math.max(0, pos)) / 1000;
  const raw = FDV_MIN * Math.pow(FDV_MAX / FDV_MIN, k);
  return roundFdv(raw);
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

// Benchmarks: daily closes from each venue's own spot market (Hyperliquid HYPE/USDC
// @107, Lighter LIT/USDC market 2049), both with a 1B max supply, so FDV = price x 1B.
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

export const BENCHMARKS: Benchmark[] = [
  b("HYPE", "Launch day close", "2024-11-29", 6.25, "opened near $2 in the genesis auction, closed day one at $6.25"),
  b("HYPE", "Lowest close after the first month", "2025-04-06", 10.25, "HYPE never closed below its launch day"),
  b("HYPE", "Highest close", "2026-09-22", 97.2),
  b("LIT", "Launch day close", "2025-12-30", 2.58),
  b("LIT", "Lowest close", "2026-03-30", 0.81),
  b("LIT", "Highest close", "2026-09-23", 5.3),
];

/** Share of supply each benchmark token airdropped at launch, for context. */
export const BENCH_AIRDROP: Record<Benchmark["token"], number> = { HYPE: 0.31, LIT: 0.25 };

export interface DropState {
  points: number;
  total: number;
  share: number; // 0..1
  fdv: number;
  target: number; // 0 = none
  vol: number; // your Omni volume, 0 = not given
  cbps: number; // one-way cost in bps, 0 = use the default
}

export function readDrop(query: string): DropState {
  const q = new URLSearchParams(query);
  const pos = (k: string, d: number, max = Infinity) => {
    const v = Number(q.get(k));
    return q.get(k) !== null && Number.isFinite(v) && v > 0 && v <= max ? v : d;
  };
  return {
    points: pos("pts", 1000),
    total: pos("total", DEFAULT_TOTAL_POINTS),
    share: pos("share", DEFAULT_SHARE * 100, 100) / 100,
    fdv: Math.min(FDV_MAX, Math.max(FDV_MIN, pos("fdv", 1e9))),
    target: pos("target", 0),
    vol: pos("vol", 0),
    cbps: pos("cbps", 0, 1000),
  };
}

export function writeDrop(st: DropState): string {
  const q = new URLSearchParams({ pts: String(st.points), fdv: String(st.fdv) });
  if (st.total !== DEFAULT_TOTAL_POINTS) q.set("total", String(st.total));
  if (Math.abs(st.share - DEFAULT_SHARE) > 1e-9) q.set("share", String(+(st.share * 100).toFixed(2)));
  if (st.target > 0) q.set("target", String(st.target));
  if (st.vol > 0) q.set("vol", String(st.vol));
  if (st.cbps > 0) q.set("cbps", String(st.cbps));
  return q.toString();
}
