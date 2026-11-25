import { describe, expect, it } from "vitest";
import { BENCHMARKS, breakEvenFdv, costPerPoint, DEFAULT_TOTAL_POINTS, dropErrors, FDV_LINK_MAX, MIN_POINTS, pointsLabel, shareLabel, FDV_MAX, FDV_MIN, fdvFromSlider, perPoint, pointsFor, readDrop, roundFdv, sliderFromFdv, writeDrop } from "../src/lib/airdrop.ts";

describe("airdrop", () => {
  it("values a point as share of FDV over total points", () => {
    expect(perPoint(1e9, 10e6, 0.32)).toBeCloseTo(32);
    expect(perPoint(1e9, 0)).toBeNaN();
    expect(pointsFor(3200, 1e9, 10e6, 0.32)).toBeCloseTo(100);
    expect(pointsFor(0, 1e9, 10e6)).toBeNaN();
  });
  it("prices points from spread paid and finds break-even FDV", () => {
    const cpp = costPerPoint(1_000_000, 3, 100); // $300 spread / 100 points
    expect(cpp).toBeCloseTo(3);
    expect(breakEvenFdv(cpp, 10e6, 0.32)).toBeCloseTo(93.75e6);
    expect(perPoint(breakEvenFdv(cpp, 10e6, 0.32), 10e6, 0.32)).toBeCloseTo(cpp);
    expect(costPerPoint(0, 3, 100)).toBeNaN();
  });
  it("maps the slider on a log scale with round values", () => {
    expect(fdvFromSlider(0)).toBe(FDV_MIN);
    expect(fdvFromSlider(1000)).toBe(FDV_MAX);
    expect(fdvFromSlider(500)).toBe(1e9);
    expect(sliderFromFdv(1e9)).toBe(500);
    expect(sliderFromFdv(97e9)).toBe(1000);
    expect(roundFdv(1234e6)).toBe(1.2e9);
  });
  it("round-trips state through the link and rejects junk", () => {
    const st = { points: 2500, total: 12e6, share: 0.3, fdv: 2e9, target: 5000, vol: 1e5, cbps: 2.5 };
    expect(readDrop(writeDrop(st))).toEqual(st);
    const d = readDrop("pts=-4&fdv=1e15&share=200&total=abc");
    expect(d).toMatchObject({ points: 1000, fdv: FDV_LINK_MAX, share: 0.32, total: DEFAULT_TOTAL_POINTS, target: 0, vol: 0 });
  });
  it("always pins total and share in the link, even at the defaults", () => {
    expect(writeDrop(readDrop(""))).toBe(`pts=1000&fdv=1000000000&total=${DEFAULT_TOTAL_POINTS}&share=32`);
  });
  it("keeps an FDV above the slider when it comes from a benchmark row", () => {
    const peak = BENCHMARKS.find((b) => b.fdv > FDV_MAX)!;
    expect(readDrop(writeDrop({ ...readDrop(""), fdv: peak.fdv })).fdv).toBe(peak.fdv);
    expect(sliderFromFdv(peak.fdv)).toBe(1000);
  });
  it("keeps benchmarks consistent", () => {
    for (const b of BENCHMARKS) expect(b.fdv).toBeCloseTo(b.price * 1e9);
    expect(BENCHMARKS.filter((b) => b.token === "HYPE")).toHaveLength(3);
    expect(BENCHMARKS.slice(0, 2).map((b) => b.label)).toEqual(["Launch day close", "Launch day close"]);
  });
  it("writes point balances as typed, decimals included", () => {
    expect(pointsLabel(1.5)).toBe("1.5");
    expect(pointsLabel(0.5)).toBe("0.5");
    expect(pointsLabel(1)).toBe("1");
    expect(pointsLabel(1234.25)).toBe("1,234.25");
    expect(pointsLabel(2500)).toBe("2,500");
    expect(readDrop(writeDrop({ ...readDrop(""), points: 1.5 })).points).toBe(1.5);
  });
  it("knows the 1-point claim minimum", () => {
    expect(MIN_POINTS).toBe(1);
    expect(0.5 >= MIN_POINTS).toBe(false);
    expect(1.5 >= MIN_POINTS).toBe(true);
    expect(dropErrors({ points: 0.5, total: 11e6, share: 0.32 })).toEqual({}); // valid input, just not eligible
  });
  it("formats the share of the drop without scientific notation", () => {
    expect(shareLabel(800, 11.1e6)).toBe("0.0072%");
    expect(shareLabel(222e3, 11.1e6)).toBe("2%");
    expect(shareLabel(11.1e6, 11.1e6)).toBe("100%");
    expect(shareLabel(0, 11.1e6)).toBe("0%");
  });
  it("flags inputs that would make a misleading estimate", () => {
    expect(dropErrors({ points: 800, total: 11.1e6, share: 0.32 })).toEqual({});
    expect(dropErrors({ points: 22.2e6, total: 11.1e6, share: 0.32 }).pts).toBe("Your points cannot exceed total points");
    expect(dropErrors({ points: 800, total: 11.1e6, share: 2 }).share).toMatch(/between 0 and 100/);
    expect(dropErrors({ points: NaN, total: 11.1e6, share: 0.32 }).pts).toBeTruthy();
    expect(dropErrors({ points: 800, total: NaN, share: 0.32 }).total).toBeTruthy();
  });
  it("derives the default total from 10.2M plus six Fridays", () => {
    expect(DEFAULT_TOTAL_POINTS).toBe(10.2e6 + 6 * 150_000);
  });
});
