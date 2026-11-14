import { describe, expect, it } from "vitest";
import { baseOf, num, parseOmniStats } from "../src/lib/omni.ts";
import { normalizeSymbol, parseDydx, parseHyperliquid, parseLighterAggregate } from "../src/lib/venues.ts";
import { buildSnapshot, venueMedian } from "../src/lib/snapshot.ts";
import { appendAndCompact, FULL_RES_SECONDS, HOURLY_SECONDS, MARKET_COLS, marketFile, marketToCsvRow, parseCsv } from "../src/lib/history.ts";

const listing = (over: Record<string, unknown> = {}) => ({
  ticker: "BTC-PERP",
  contract_type: "perpetual",
  name: "Bitcoin",
  mark_price: "100",
  volume_24h: "1000",
  open_interest: { long_open_interest: "60", short_open_interest: "40" },
  funding: { last: { annualized_rate: "0.05" }, next: { annualized_rate: "0.1" }, interval_seconds: 28800 },
  quotes: { base: { bid: "99.9", ask: "100.1" }, size_100k: { bid: "99", ask: "101" } },
  ...over,
});
const omni = (listings: unknown[]) => ({ total_volume_24h: "5", cumulative_volume: "9", tvl: "7", open_interest: "3", listings });

describe("omni", () => {
  it("parses a listing", () => {
    const { markets, platform } = parseOmniStats(omni([listing()]));
    expect(platform).toEqual({ vol24: 5, cumVol: 9, tvl: 7, oi: 3, markets: 1 });
    const m = markets[0];
    expect(m).toMatchObject({ tk: "BTC-PERP", base: "BTC", type: "perp", mark: 100, oiL: 60, oiS: 40, fNext: 0.1, fLast: 0.05, intS: 28800 });
    expect(m.spread).toBeCloseTo(20, 6); // 0.2 / 100 = 20 bps
    expect(m.imp100k).toBeCloseTo(100, 6); // 101 vs mid 100 = 100 bps
  });
  it("keeps unknowns as null instead of zero", () => {
    const { markets } = parseOmniStats(omni([listing({ funding: null, quotes: {}, mark_price: "NaN" })]));
    expect(markets[0]).toMatchObject({ fNext: null, fLast: null, intS: null, spread: null, imp100k: null, mark: null });
  });
  it("rejects an error body (rate limit)", () => {
    expect(() => parseOmniStats({ error: "rate_limited" })).toThrow(/unexpected Omni response/);
  });
  it("maps swaps and bases", () => {
    expect(parseOmniStats(omni([listing({ ticker: "XAU-SWAP", contract_type: "swap" })])).markets[0].type).toBe("swap");
    expect(baseOf("1000PEPE-PERP")).toBe("1000PEPE");
    expect(num("")).toBeNull();
  });
});

describe("venues", () => {
  it("normalizes multiples without eating real K symbols", () => {
    expect(normalizeSymbol("kPEPE")).toBe("PEPE");
    expect(normalizeSymbol("1000PEPE")).toBe("PEPE");
    expect(normalizeSymbol("1000000MOG")).toBe("MOG");
    expect(normalizeSymbol("1MBABYDOGE")).toBe("BABYDOGE");
    expect(normalizeSymbol("KAS")).toBe("KAS");
    expect(normalizeSymbol("KAITO")).toBe("KAITO");
    expect(normalizeSymbol("BTC-USD")).toBe("BTC");
  });
  it("annualizes Hyperliquid hourly funding and skips delisted", () => {
    const m = parseHyperliquid([{ universe: [{ name: "BTC" }, { name: "OLD", isDelisted: true }] }, [{ funding: "0.00001" }, { funding: "1" }]]);
    expect(m.get("BTC")).toBeCloseTo(0.0876, 6);
    expect(m.has("OLD")).toBe(false);
  });
  it("annualizes dYdX hourly funding, active markets only", () => {
    const m = parseDydx({ markets: { "ETH-USD": { status: "ACTIVE", nextFundingRate: "0.00001" }, "X-USD": { status: "FINAL_SETTLEMENT", nextFundingRate: "1" } } });
    expect(m.get("ETH")).toBeCloseTo(0.0876, 6);
    expect(m.has("X")).toBe(false);
  });
  it("splits the Lighter aggregate and annualizes 8h rates", () => {
    const r = parseLighterAggregate({ funding_rates: [
      { exchange: "binance", symbol: "BTC", rate: 0.0001 },
      { exchange: "bybit", symbol: "BTC", rate: 0.0002 },
      { exchange: "hyperliquid", symbol: "BTC", rate: 9 },
    ] });
    expect(r.binance?.get("BTC")).toBeCloseTo(0.1095, 6);
    expect(r.bybit?.get("BTC")).toBeCloseTo(0.219, 6);
    expect(r.lighter).toBeUndefined();
  });
  it("throws on malformed venue bodies", () => {
    expect(() => parseHyperliquid({})).toThrow();
    expect(() => parseDydx(null)).toThrow();
    expect(() => parseLighterAggregate({ code: 500 })).toThrow();
  });
});

describe("snapshot", () => {
  it("joins venues by normalized base, skips swaps, reports failed venues", () => {
    const snap = buildSnapshot({
      t: 1,
      omniRaw: omni([listing({ ticker: "1000PEPE-PERP" }), listing({ ticker: "XAU-SWAP", contract_type: "swap" })]),
      venues: { hl: new Map([["PEPE", 0.2], ["XAU", 0.3]]), dydx: new Error("HTTP 451") },
    });
    const pepe = snap.markets.find((m) => m.tk === "1000PEPE-PERP")!;
    expect(pepe.v).toEqual({ hl: 0.2 });
    expect(snap.markets.find((m) => m.tk === "XAU-SWAP")!.v).toEqual({});
    expect(snap.sources.dydx).toMatchObject({ ok: false, error: "HTTP 451" });
    expect(snap.sources.binance.ok).toBe(false);
    expect(snap.sources.hl).toEqual({ ok: true, count: 2 });
  });
  it("takes the median of venues", () => {
    expect(venueMedian({})).toBeNull();
    expect(venueMedian({ hl: 1, dydx: 3, binance: 2 })).toBe(2);
    expect(venueMedian({ hl: 1, dydx: 4 })).toBe(2.5);
  });
});

describe("history", () => {
  const m = parseOmniStats(omni([listing()])).markets[0];
  it("round-trips a market row", () => {
    m.v = { hl: 0.05 };
    const csv = appendAndCompact("", MARKET_COLS, marketToCsvRow(1000, m), 1000);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ t: 1000, mark: 100, fo: 0.1, hl: 0.05, dydx: null });
  });
  it("replaces a repeated timestamp and keeps order", () => {
    let csv = appendAndCompact("", MARKET_COLS, marketToCsvRow(2000, m), 2000);
    csv = appendAndCompact(csv, MARKET_COLS, marketToCsvRow(1000, m), 2000);
    csv = appendAndCompact(csv, MARKET_COLS, marketToCsvRow(2000, { ...m, mark: 5 }), 2000);
    const rows = parseCsv(csv);
    expect(rows.map((r) => r.t)).toEqual([1000, 2000]);
    expect(rows[1].mark).toBe(5);
  });
  it("thins rows older than a week to one per hour", () => {
    const now = 100 * 86400;
    let csv = "";
    const old = now - FULL_RES_SECONDS - 7200; // two hours past the window
    for (let k = 0; k < 8; k++) csv = appendAndCompact(csv, MARKET_COLS, marketToCsvRow(old + k * 900, m), now);
    for (let k = 0; k < 4; k++) csv = appendAndCompact(csv, MARKET_COLS, marketToCsvRow(now - k * 900, m), now);
    const ts = parseCsv(csv).map((r) => r.t!);
    const oldKept = ts.filter((t) => now - t > FULL_RES_SECONDS);
    expect(new Set(oldKept.map((t) => Math.floor(t / 3600))).size).toBe(oldKept.length);
    expect(oldKept.length).toBeLessThanOrEqual(3);
    expect(ts.filter((t) => now - t <= FULL_RES_SECONDS)).toHaveLength(4);
  });
  it("thins rows older than a month to one per 4 hours", () => {
    const now = 400 * 86400;
    const start = Math.floor((now - HOURLY_SECONDS - 3 * 86400) / 14400) * 14400;
    let csv = "";
    for (let k = 0; k < 16; k++) csv = appendAndCompact(csv, MARKET_COLS, marketToCsvRow(start + k * 3600, m), now);
    expect(parseCsv(csv).map((r) => r.t)).toEqual([start, start + 14400, start + 28800, start + 43200]);
  });
  it("migrates rows written under an older header", () => {
    const old = "t,mark,fo\n5,1,0.2\n";
    const rows = parseCsv(appendAndCompact(old, MARKET_COLS, marketToCsvRow(6, m), 6));
    expect(rows[0]).toMatchObject({ t: 5, mark: 1, fo: 0.2, hl: null });
    expect(rows).toHaveLength(2);
  });
  it("makes safe file names", () => {
    expect(marketFile("BTC-PERP")).toBe("m/BTC-PERP.csv");
    expect(marketFile("A/B..C")).toBe("m/A_B__C.csv");
  });
});

import { bookCost, fillPrice, omniCost, parseHlBook, parseLighterBook } from "../src/lib/cost.ts";

describe("cost", () => {
  it("walks a book and returns the average fill price", () => {
    // $100 at 100 (1 unit), then $202 at 101 (2 units)
    expect(fillPrice([[100, 1], [101, 2]], 100)).toBe(100);
    expect(fillPrice([[100, 1], [101, 2]], 302)).toBeCloseTo(302 / 3, 9);
    expect(fillPrice([[100, 1]], 101)).toBeNull(); // too thin
  });
  it("averages buy and sell slippage and adds the fee", () => {
    const bids: [number, number][] = [[99, 10]];
    const asks: [number, number][] = [[101, 10]];
    expect(bookCost(bids, asks, 500, 0)).toBeCloseTo(100, 6); // 1% each way
    expect(bookCost(bids, asks, 500, 0.00045)).toBeCloseTo(104.5, 6);
    expect(bookCost(bids, asks, 5000, 0)).toBeNull();
    expect(bookCost([], asks, 1, 0)).toBeNull();
  });
  it("uses a supplied mid for aggregated books", () => {
    // aggregated levels rounded away from a true mid of 100
    expect(bookCost([[99, 10]], [[101, 10]], 100, 0, 100)).toBeCloseTo(100, 6);
    expect(bookCost([[99, 10]], [[102, 10]], 100, 0, 100)).toBeCloseTo(150, 6);
  });
  it("prices Omni's indicative quotes against the base mid, with no fee", () => {
    expect(omniCost({ bid: "99.9", ask: "100.1" }, { bid: "99", ask: "101" })).toBeCloseTo(100, 6);
    expect(omniCost({ bid: "99.9", ask: "100.1" }, undefined)).toBeNull();
    expect(omniCost({ bid: "101", ask: "100" }, { bid: "1", ask: "2" })).toBeNull(); // crossed
  });
  it("parses Hyperliquid and Lighter books", () => {
    const hl = parseHlBook({ levels: [[{ px: "99", sz: "1" }], [{ px: "101", sz: "2" }, { px: "0", sz: "1" }]] });
    expect(hl).toEqual({ bids: [[99, 1]], asks: [[101, 2]] });
    const lt = parseLighterBook({
      bids: [{ price: "98", remaining_base_amount: "1" }, { price: "99", remaining_base_amount: "1" }],
      asks: [{ price: "102", remaining_base_amount: "1" }, { price: "101", remaining_base_amount: "0" }, { price: "101.5", remaining_base_amount: "2" }],
    });
    expect(lt.bids.map((l) => l[0])).toEqual([99, 98]);
    expect(lt.asks.map((l) => l[0])).toEqual([101.5, 102]);
    expect(() => parseHlBook({})).toThrow();
    expect(() => parseLighterBook({ code: 429 })).toThrow();
  });
});
