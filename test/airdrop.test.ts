import { describe, expect, it } from "vitest";
import {
  BENCHMARKS,
  breakEvenFdv,
  ceil4,
  coreError,
  costPerPoint,
  DEFAULT_FDV,
  DEFAULT_POINTS,
  DEFAULT_SHARE,
  DEFAULT_TOTAL_POINTS,
  decimalsOf,
  dropErrors,
  effectiveBps,
  FDV_MAX,
  FDV_MIN,
  fdvFromSlider,
  fdvLabel,
  MIN_POINTS,
  parseNum,
  perPoint,
  pinAuto,
  pointsLabel,
  readDrop,
  roundFdv,
  sharePctLabel,
  shareLabel,
  sliderFromFdv,
  targetNeed,
  totalLabel,
  writeDrop,
  type DropState,
} from "../src/lib/airdrop.ts";

const base = (over: Partial<DropState> = {}): DropState => ({ ...readDrop(""), ...over });
/** What a reader sees after opening a link in a new tab. */
const reopen = (st: DropState) => readDrop(writeDrop(st));

describe("airdrop arithmetic", () => {
  it("values a point as share of FDV over total points", () => {
    expect(perPoint(1e9, 10e6, 0.32)).toBeCloseTo(32);
    expect(perPoint(1e9, 0)).toBeNaN();
  });
  it("prices points from spread and finds break-even FDV; 0 bps is free, not missing", () => {
    const cpp = costPerPoint(1_000_000, 3, 100);
    expect(cpp).toBeCloseTo(3);
    expect(breakEvenFdv(cpp, 10e6, 0.32)).toBeCloseTo(93.75e6);
    expect(costPerPoint(1e5, 0, 10)).toBe(0);
    expect(breakEvenFdv(0, 10e6, 0.32)).toBe(0);
    expect(costPerPoint(0, 3, 100)).toBeNaN();
  });
  it("maps the slider on a log scale with round values", () => {
    expect(fdvFromSlider(0)).toBe(FDV_MIN);
    expect(fdvFromSlider(1000)).toBe(FDV_MAX);
    expect(fdvFromSlider(500)).toBe(1e9);
    expect(sliderFromFdv(97.2e9)).toBe(1000);
    expect(roundFdv(1234e6)).toBe(1.2e9);
  });
});

describe("3. points needed for a target", () => {
  it("is exact to 4 decimals instead of a whole number", () => {
    // 11.1M total, 32%, $1B: one point is $28.83, so $40 needs 1.3875 points.
    expect(targetNeed(40, 1e9, 11.1e6, 0.32)).toEqual({ reachable: true, points: 1.3875 });
    expect(ceil4(1.38750000001)).toBe(1.3875);
    expect(ceil4(1.38751)).toBe(1.3876);
  });
  it("applies the 1-point claim minimum", () => {
    expect(targetNeed(1, 1e9, 11.1e6, 0.32)).toEqual({ reachable: true, points: MIN_POINTS });
  });
  it("says a target above the whole pool is not reachable", () => {
    // 100 points in total, $1B x 32% = $320M pool.
    expect(targetNeed(400e6, 1e9, 100, 0.32)).toEqual({ reachable: false, pool: 320e6 });
    expect(targetNeed(160e6, 1e9, 100, 0.32)).toEqual({ reachable: true, points: 50 });
  });
  it("never asks for more points than exist", () => {
    expect(targetNeed(320e6, 1e9, 100, 0.32)).toEqual({ reachable: true, points: 100 });
  });
});

describe("6. labels match the numbers used", () => {
  it("keeps point decimals near the claim minimum", () => {
    expect(pointsLabel(0.99999)).toBe("0.99999");
    expect(pointsLabel(1.5)).toBe("1.5");
    expect(pointsLabel(0.5)).toBe("0.5");
    expect(pointsLabel(1234.25)).toBe("1,234.25");
  });
  it("writes the airdrop share as typed", () => {
    expect(sharePctLabel(0.325)).toBe("32.5%");
    expect(sharePctLabel(0.00004)).toBe("0.004%");
    expect(sharePctLabel(0.32)).toBe("32%");
  });
  it("does not turn a small total into 0.0M", () => {
    expect(totalLabel(100)).toBe("100");
    expect(totalLabel(11.1e6)).toBe("11.1M");
    expect(totalLabel(11_123_456)).toBe("11.1235M");
  });
  it("formats the share of the drop without scientific notation", () => {
    expect(shareLabel(800, 11.1e6)).toBe("0.0072%");
    expect(shareLabel(11.1e6, 11.1e6)).toBe("100%");
  });
  it("writes break-even FDVs under $1K in dollars", () => {
    expect(fdvLabel(250)).toBe("$250");
    expect(fdvLabel(0)).toBe("$0");
    expect(fdvLabel(1500)).toBe("$1.5K");
    expect(fdvLabel(129e6)).toBe("$129M");
    expect(fdvLabel(97.2e9)).toBe("$97.2B");
  });
});

describe("1. share survives the link", () => {
  for (const pct of [0.004, 32.5]) {
    it(`keeps ${pct}% and the dollar estimate`, () => {
      const st = base({ share: pct / 100, points: 800 });
      const back = reopen(st);
      expect(back.share).toBeCloseTo(st.share, 15);
      expect(sharePctLabel(back.share)).toBe(`${pct}%`);
      expect(perPoint(back.fdv, back.total, back.share) * back.points).toBeCloseTo(perPoint(st.fdv, st.total, st.share) * st.points, 9);
    });
  }
});

describe("2. one validation rule for the form and the link", () => {
  const cases: [string, number | null, boolean][] = [
    ["", null, true], // blank: automatic cost
    ["0", 0, true], // explicit zero: free
    ["-2", -2, false],
    ["1000", 1000, true],
    ["1001", 1001, false],
  ];
  for (const [raw, typed, valid] of cases) {
    it(`cost per fill "${raw}"`, () => {
      const fromForm = base({ vol: 1e5, cbps: parseNum(raw) });
      expect(fromForm.cbps).toBe(typed);
      const fromLink = readDrop(`pts=800&vol=100000${raw === "" ? "" : `&cbps=${raw}`}`);
      expect(fromLink.cbps).toBe(typed);
      expect(Boolean(dropErrors(fromForm).cbps)).toBe(!valid);
      expect(Boolean(dropErrors(fromLink).cbps)).toBe(!valid);
    });
  }
  it("flags negative target and volume instead of ignoring them", () => {
    expect(dropErrors(base({ target: -5 })).target).toBe("Target cannot be negative");
    expect(dropErrors(base({ vol: -5 })).vol).toBe("Volume cannot be negative");
    expect(dropErrors(readDrop("target=-5&vol=-1"))).toMatchObject({ target: expect.any(String), vol: expect.any(String) });
    expect(coreError(dropErrors(base({ target: -5 })))).toBe(false); // only its own section stops
  });
  it("blocks points above the total and shares outside 0-100%", () => {
    expect(dropErrors(base({ points: 22.2e6 })).pts).toBe("Your points cannot exceed total points");
    expect(dropErrors(base({ share: 2 })).share).toMatch(/at most 100%/);
    expect(dropErrors(base({ share: 0 })).share).toBeTruthy();
  });
});

describe("4. missing spread is not a free spread", () => {
  it("uses typed, then pinned, then live, and reports none when there is none", () => {
    expect(effectiveBps(base({ cbps: null, abps: null }), null)).toBeNull();
    expect(effectiveBps(base({ cbps: 0 }), 0.7)).toBe(0);
    expect(effectiveBps(base({ cbps: null, abps: 0.9 }), 0.7)).toBe(0.9);
    expect(effectiveBps(base({ cbps: null, abps: null }), 0.7)).toBe(0.7);
  });
});

describe("5. links: defaults only for missing parameters", () => {
  it("keeps a wrong point balance so the page can explain it", () => {
    for (const q of ["pts=0", "pts=-4", "pts=abc"]) {
      const st = readDrop(q);
      expect(st.points === DEFAULT_POINTS).toBe(false);
      expect(dropErrors(st).pts).toBeTruthy();
    }
  });
  it("uses the example only when nothing is given", () => {
    expect(readDrop("")).toMatchObject({ points: DEFAULT_POINTS, total: DEFAULT_TOTAL_POINTS, share: DEFAULT_SHARE, fdv: DEFAULT_FDV, cbps: null, abps: null });
    expect(dropErrors(readDrop(""))).toEqual({});
  });
  it("pins the live automatic cost once, so every link carries the same scenario", () => {
    const st = pinAuto(base({ vol: 1e5 }), 0.7429616017405822);
    expect(st.abps).toBe(0.7429616017405822);
    expect(writeDrop(st)).toContain("abps=0.7429616017405822");
    expect(effectiveBps(reopen(st), 5)).toBe(0.7429616017405822); // a later live value does not change it
    expect(pinAuto(base({ vol: 1e5, cbps: 3 }), 0.7).abps).toBeNull(); // the user's own value wins
    expect(pinAuto(base({ vol: 0 }), 0.7).abps).toBeNull();
  });
});

describe("acceptance: every valid scenario reopens the same", () => {
  const scenarios: Partial<DropState>[] = [
    {},
    { points: 0.5, fdv: 97.2e9 },
    { points: 0.99999 },
    { points: 1.5, fdv: 2.58e9, target: 40 },
    { points: 800, share: 0.00004 },
    { points: 80, share: 0.325, total: 100 },
    { points: 50, total: 100, target: 400e6 },
    { points: 2, vol: 1e5, cbps: 0 },
    { points: 2, vol: 1e5, cbps: 1000 },
    { points: 2, vol: 1e5, abps: 0.7429616017405822 },
  ];
  for (const over of scenarios) {
    it(JSON.stringify(over), () => {
      const st = base(over);
      expect(dropErrors(st)).toEqual({});
      const back = reopen(st);
      expect(back.points).toBe(st.points);
      expect(back.share).toBeCloseTo(st.share, 15);
      expect(back.fdv).toBe(st.fdv);
      expect(back.total).toBe(st.total);
      expect(back.points >= MIN_POINTS).toBe(st.points >= MIN_POINTS);
      expect(perPoint(back.fdv, back.total, back.share) * back.points).toBeCloseTo(perPoint(st.fdv, st.total, st.share) * st.points, 9);
      expect(targetNeed(back.target, back.fdv, back.total, back.share)).toEqual(targetNeed(st.target, st.fdv, st.total, st.share));
      expect(effectiveBps(back, 99)).toBe(effectiveBps(st, 99));
      expect(writeDrop(back)).toBe(writeDrop(st));
    });
  }
});

describe("benchmarks", () => {
  it("are consistent and put launch days first", () => {
    for (const b of BENCHMARKS) expect(b.fdv).toBeCloseTo(b.price * 1e9);
    expect(BENCHMARKS.slice(0, 2).map((b) => b.label)).toEqual(["Launch day close", "Launch day close"]);
    expect(DEFAULT_TOTAL_POINTS).toBe(10.2e6 + 6 * 150_000);
  });
});

describe("follow-up: blank params, total minimum, precision", () => {
  it("1. a blank parameter is an error, a missing one is the example", () => {
    expect(dropErrors(readDrop(""))).toEqual({});
    expect(dropErrors(readDrop("pts=")).pts).toBeTruthy();
    expect(dropErrors(readDrop("total=")).total).toBeTruthy();
    expect(dropErrors(readDrop("share=")).share).toBeTruthy();
    expect(readDrop("pts=").points).toBeNaN();
    expect(readDrop("target=&vol=")).toMatchObject({ target: 0, vol: 0 }); // optional fields stay optional
  });
  it("2. total points start at the 1-point claim minimum", () => {
    const st = base({ points: 0.5, total: 0.5, target: 1 });
    expect(dropErrors(st).total).toBe("Total points must be at least 1");
    expect(coreError(dropErrors(st))).toBe(true); // target and estimate stop
    const fixed = base({ points: 0.5, total: 11.1e6 });
    expect(dropErrors(fixed)).toEqual({});
    expect(fixed.points >= MIN_POINTS).toBe(false); // shown as Not eligible
  });
  it("3. points and share accept 8 decimals and refuse more", () => {
    expect(decimalsOf(0.999999999)).toBe(9);
    expect(decimalsOf(1e-8)).toBe(8);
    expect(decimalsOf(32.12345678)).toBe(8);
    expect(dropErrors(base({ points: 0.999999999 })).pts).toBe("Use at most 8 decimal places");
    expect(dropErrors(base({ points: 0.99999999 }))).toEqual({});
    expect(pointsLabel(0.99999999)).toBe("0.99999999"); // never shown as 1
    expect(dropErrors(base({ share: 32.12345678901234 / 100 })).share).toBe("Use at most 8 decimal places");
    const ok = base({ share: 32.12345678 / 100 });
    expect(dropErrors(ok)).toEqual({});
    expect(sharePctLabel(reopen(ok).share)).toBe("32.12345678%");
    expect(perPoint(1e9, 11.1e6, reopen(ok).share)).toBeCloseTo(perPoint(1e9, 11.1e6, ok.share), 9);
  });
});
