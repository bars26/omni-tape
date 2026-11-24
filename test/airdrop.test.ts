import { describe, expect, it } from "vitest";
import { BENCHMARKS, breakEvenFdv, costPerPoint, DEFAULT_TOTAL_POINTS, FDV_MAX, FDV_MIN, fdvFromSlider, perPoint, pointsFor, readDrop, roundFdv, sliderFromFdv, writeDrop } from "../src/lib/airdrop.ts";

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
    expect(d).toMatchObject({ points: 1000, fdv: FDV_MAX, share: 0.32, total: DEFAULT_TOTAL_POINTS, target: 0, vol: 0 });
    expect(writeDrop(readDrop(""))).toBe("pts=1000&fdv=1000000000");
  });
  it("keeps benchmarks consistent", () => {
    for (const b of BENCHMARKS) expect(b.fdv).toBeCloseTo(b.price * 1e9);
    expect(BENCHMARKS.filter((b) => b.token === "HYPE")).toHaveLength(3);
  });
});
