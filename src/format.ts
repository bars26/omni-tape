export const DASH = "—";

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(0)}`;
}

export function price(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  const a = Math.abs(x);
  const digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return x.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Annualized decimal -> "12.3%". Large values drop decimals. */
export function apr(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  const p = x * 100;
  const a = Math.abs(p);
  return `${p.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : 2)}%`;
}

export function bps(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  return `${x.toFixed(x < 10 ? 1 : 0)}`;
}

export function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  return `${(x * 100).toFixed(0)}%`;
}

export function ago(t: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function when(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Signed relative change: 0.0123 -> "+1.23%". */
export function chg(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  return `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(digits)}%`;
}

/** Signed share points: 0.05 -> "+5.0 pts". */
export function pts(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  return `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)} pts`;
}
