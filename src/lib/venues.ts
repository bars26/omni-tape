import { num } from "./omni.ts";
import type { Venue } from "./types.ts";

// Every venue is reduced to: base symbol -> annualized funding (decimal).
export type FundingMap = Map<string, number>;

const HOURS_PER_YEAR = 24 * 365;

export const HL_URL = "https://api.hyperliquid.xyz/info";
export const DYDX_URL = "https://indexer.dydx.trade/v4/perpetualMarkets";
export const LIGHTER_URL = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates";

/**
 * Venues list small-priced coins in multiples ("kPEPE", "1000PEPE", "1MBABYDOGE").
 * A funding rate is unitless, so the multiple does not matter for comparison.
 */
export function normalizeSymbol(sym: string): string {
  // Hyperliquid's thousand-multiple prefix is a lowercase "k" ("kPEPE"); a capital K is
  // part of real symbols (KAS, KAITO), so strip it before upper-casing.
  let s = sym.replace(/^k(?=[A-Z0-9])/, "").toUpperCase().replace(/-USD$/, "");
  s = s.replace(/^(1000000|1000|1M)(?=[A-Z]{2,})/, "");
  return s;
}

function put(map: FundingMap, sym: string, annual: number | null) {
  if (annual === null) return;
  const k = normalizeSymbol(sym);
  // Prefer the plain listing when both "PEPE" and "kPEPE" exist.
  if (!map.has(k) || sym.toUpperCase() === k) map.set(k, annual);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

/** Hyperliquid `metaAndAssetCtxs`: [meta, ctxs]; `funding` is the hourly rate. */
export function parseHyperliquid(raw: Raw): FundingMap {
  const out: FundingMap = new Map();
  const universe = raw?.[0]?.universe;
  const ctxs = raw?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) throw new Error("unexpected Hyperliquid response");
  universe.forEach((u: Raw, i: number) => {
    if (u?.isDelisted) return;
    const hourly = num(ctxs[i]?.funding);
    put(out, String(u?.name ?? ""), hourly === null ? null : hourly * HOURS_PER_YEAR);
  });
  return out;
}

/** dYdX v4 indexer: `nextFundingRate` is a 1-hour rate. */
export function parseDydx(raw: Raw): FundingMap {
  const out: FundingMap = new Map();
  const markets = raw?.markets;
  if (!markets || typeof markets !== "object") throw new Error("unexpected dYdX response");
  for (const [ticker, m] of Object.entries<Raw>(markets)) {
    if (m?.status && m.status !== "ACTIVE") continue;
    const hourly = num(m?.nextFundingRate);
    put(out, ticker, hourly === null ? null : hourly * HOURS_PER_YEAR);
  }
  return out;
}

/**
 * Lighter's aggregate endpoint reports Binance, Bybit, Hyperliquid and Lighter.
 * Rates are 8-hour equivalents (checked 2026-11-14: Binance 4h symbols appear at
 * 2x their native rate; Hyperliquid's hourly rate appears x8).
 */
export function parseLighterAggregate(raw: Raw): Partial<Record<Venue, FundingMap>> {
  const rows = raw?.funding_rates;
  if (!Array.isArray(rows)) throw new Error("unexpected Lighter response");
  const out: Partial<Record<Venue, FundingMap>> = {};
  const wanted: Record<string, Venue> = { binance: "binance", bybit: "bybit", lighter: "lighter" };
  for (const r of rows) {
    const venue = wanted[String(r?.exchange)];
    if (!venue) continue;
    const eightHour = num(r?.rate);
    const map = (out[venue] ??= new Map());
    put(map, String(r?.symbol ?? ""), eightHour === null ? null : eightHour * 3 * 365);
  }
  return out;
}
