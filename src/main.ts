import "./style.css";
import { renderChart, type Series } from "./chart.ts";
import { ago, apr, bps, chg, esc, pct, price, pts, usd, when, DASH } from "./format.ts";
import { marketFile, parseCsv, type HistRow } from "./lib/history.ts";
import { bookCost, midOf, parseHlBook, parseLighterBook, TAKER_FEE, type Level } from "./lib/cost.ts";
import { normalizeSymbol } from "./lib/venues.ts";
import { isoWeek, WEEK, type Digest, type DigestRow } from "./lib/summary.ts";
import { byHour, legEstimate, omniCostAt, pairEstimate, trailingMean, type Side } from "./lib/calc.ts";
import { BENCH_AIRDROP, BENCHMARKS, breakEvenFdv, costPerPoint, DEFAULT_TOTAL_POINTS, dropErrors, FDV_MAX, MIN_POINTS, pointsLabel, shareLabel, fdvFromSlider, perPoint, pointsFor, readDrop, SCENARIOS, sliderFromFdv, writeDrop, type DropState } from "./lib/airdrop.ts";
import { venueMedian } from "./lib/snapshot.ts";
import { VENUE_LABEL, VENUES, type MarketRow, type Snapshot, type Venue } from "./lib/types.ts";

const REPO = "bars26/omni-tape";
const BRANCH_BASE = `https://raw.githubusercontent.com/${REPO}/data`;
const LOCAL_BASE = import.meta.env.VITE_DATA_BASE as string | undefined;
// Public, documented URLs (About page). The site itself reads from a pinned commit, below.
const DATA = LOCAL_BASE ?? BRANCH_BASE;
let base = DATA;

/**
 * raw.githubusercontent.com can keep serving an old copy of a branch for a long time
 * at some CDN edges, and the data branch is force-pushed every 15 minutes. Files read
 * by commit SHA are never stale, so resolve the branch head first (GitHub API, 60
 * unauthenticated calls per hour per visitor IP; cached for 2 minutes) and fall back
 * to the branch URL if that fails.
 */
async function resolveBase(): Promise<string> {
  if (LOCAL_BASE) return LOCAL_BASE;
  const KEY = "omnitape:sha";
  try {
    const hit = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { sha: string; at: number } | null;
    if (hit && Date.now() - hit.at < 120_000) return `https://raw.githubusercontent.com/${REPO}/${hit.sha}`;
  } catch {
    /* storage unavailable */
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/data`, { headers: { accept: "application/vnd.github.sha" } });
    const sha = (await res.text()).trim();
    if (!res.ok || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub API HTTP ${res.status}`);
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ sha, at: Date.now() }));
    } catch {
      /* ignore */
    }
    return `https://raw.githubusercontent.com/${REPO}/${sha}`;
  } catch {
    return BRANCH_BASE;
  }
}

const COLOR: Record<"omni" | Venue, string> = {
  omni: "var(--omni)",
  hl: "var(--c1)",
  dydx: "var(--c2)",
  binance: "var(--c3)",
  bybit: "var(--c4)",
  lighter: "var(--c5)",
};

const app = document.getElementById("app")!;
let snap: Snapshot | null = null;
let meta: { first: number; last: number; snapshots: number } | null = null;

// ---------- state kept in the URL hash so views are linkable ----------

interface ListState {
  q: string;
  type: "all" | "perp" | "swap";
  minVol: number;
  sort: string;
  dir: 1 | -1;
  steady?: boolean; // funding page: only gaps that held one way through most of the last 24 h
}
const list: ListState = { q: "", type: "all", minVol: 0, sort: "vol", dir: -1 };
const gaps: ListState = { q: "", type: "perp", minVol: 100_000, sort: "gapAbs", dir: -1, steady: false };
const costs: ListState = { q: "", type: "perp", minVol: 0, sort: "vol", dir: -1 };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
async function getCsv(path: string): Promise<HistRow[]> {
  const res = await fetch(`${base}/${path}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return parseCsv(await res.text());
}

function longShare(m: MarketRow): number | null {
  if (m.oiL === null || m.oiS === null || m.oiL + m.oiS <= 0) return null;
  return m.oiL / (m.oiL + m.oiS);
}
function oi(m: MarketRow): number | null {
  return m.oiL === null || m.oiS === null ? null : m.oiL + m.oiS;
}
/** Hyperliquid cost minus Omni cost: positive means Omni is cheaper. */
function diff(h: number | null | undefined, o: number | null | undefined): number | null {
  return h === null || h === undefined || o === null || o === undefined ? null : h - o;
}

function gap(m: MarketRow): number | null {
  const med = venueMedian(m.v);
  return med === null || m.fNext === null ? null : m.fNext - med;
}

// ---------- watchlist (this browser only) ----------

const WATCH_KEY = "omnitape:watch";
const SUGGESTED = ["BTC-PERP", "ETH-PERP", "HYPE-PERP", "SOL-PERP", "NVDA-PERP", "XAU-SWAP"];
let watch = new Set<string>();

function loadWatch() {
  try {
    const xs = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "[]");
    if (Array.isArray(xs)) watch = new Set(xs.filter((x): x is string => typeof x === "string").slice(0, 100));
  } catch {
    /* storage unavailable: the list just won't persist */
  }
}
function saveWatch() {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify([...watch]));
  } catch {
    /* ignore */
  }
}
function star(tk: string): string {
  const on = watch.has(tk);
  return `<button class="star${on ? " on" : ""}" data-star="${esc(tk)}" aria-pressed="${on}" title="${on ? "Remove from" : "Add to"} watchlist" aria-label="${on ? "Remove" : "Add"} ${esc(tk)} ${on ? "from" : "to"} watchlist">${on ? "★" : "☆"}</button>`;
}

// ---------- 24 h funding persistence ----------

/** Snapshots needed before the 24 h figure is shown (about 6 hours of data). */
const MIN_PERSIST = 24;

function steadiness(m: MarketRow): number | null {
  const p = m.p24;
  return p && p.n >= MIN_PERSIST ? Math.max(p.above, p.below) / p.n : null;
}

function persCell(m: MarketRow): string {
  const p = m.p24;
  if (!p || p.n < MIN_PERSIST) return `<td class="num muted" title="Not enough history in the last 24 h yet">${DASH}</td>`;
  const hi = p.above >= p.below;
  const k = hi ? p.above : p.below;
  const share = k / p.n;
  const tip = `Over the last 24 h Omni's funding was above the other venues' median in ${p.above} of ${p.n} snapshots and below it in ${p.below}. Average gap ${apr(p.avg)}.`;
  if (share < 0.6) return `<td class="num pers" title="${tip}"><span class="muted">mixed</span> ${p.above}↑ ${p.below}↓<div class="nm">avg ${apr(p.avg)}</div></td>`;
  return `<td class="num pers" title="${tip}"><span class="${hi ? "pos" : "neg"}">${hi ? "higher" : "lower"}</span> ${k}/${p.n}<div class="nm">avg ${apr(p.avg)}</div></td>`;
}

const SORTERS: Record<string, (m: MarketRow) => number | string | null> = {
  tk: (m) => m.tk,
  mark: (m) => m.mark,
  vol: (m) => m.vol,
  oi,
  long: longShare,
  f: (m) => m.fNext,
  med: (m) => venueMedian(m.v),
  gap,
  gapAbs: (m) => {
    const g = gap(m);
    return g === null ? null : Math.abs(g);
  },
  spread: (m) => m.spread,
  o1k: (m) => m.o1k,
  o100k: (m) => m.o100k,
  h1k: (m) => m.h1k ?? null,
  h100k: (m) => m.h100k ?? null,
  d1k: (m) => diff(m.h1k, m.o1k),
  d100k: (m) => diff(m.h100k, m.o100k),
  imp: (m) => m.imp100k,
  pers: steadiness,
  chg24: (m) => m.d24?.mark ?? null,
  oi24: (m) => m.d24?.oi ?? null,
  listed: (m) => m.listed ?? null,
  ...Object.fromEntries(VENUES.map((v) => [v, (m: MarketRow) => m.v[v] ?? null])),
};

function filtered(st: ListState, keep: (m: MarketRow) => boolean = () => true): MarketRow[] {
  if (!snap) return [];
  const q = st.q.trim().toUpperCase();
  const key = SORTERS[st.sort] ?? SORTERS.vol;
  return snap.markets
    .filter((m) => (st.type === "all" || m.type === st.type) && (m.vol ?? 0) >= st.minVol)
    .filter((m) => !q || m.tk.toUpperCase().includes(q) || m.name.toUpperCase().includes(q))
    .filter((m) => !st.steady || (steadiness(m) ?? 0) >= 0.8)
    .filter(keep)
    .sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === null && y === null) return a.tk.localeCompare(b.tk);
      if (x === null) return 1; // unknowns always last
      if (y === null) return -1;
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * st.dir;
      return (x - y) * st.dir;
    });
}

// ---------- shell ----------

function shell(active: string, body: string): string {
  const p = snap?.platform;
  const fresh = snap ? `<span title="${when(snap.t)}">updated ${ago(snap.t)}</span>` : "";
  const failed = snap ? Object.entries(snap.sources).filter(([, s]) => !s.ok).map(([k]) => (k === "omni" ? "Omni" : VENUE_LABEL[k as Venue])) : [];
  return `
<header class="top">
  <a class="brand" href="#/"><img src="/logo.svg" alt="" width="26" height="26"><span>Omni Tape</span></a>
  <nav>
    <a href="#/" class="${active === "markets" ? "on" : ""}">Markets</a>
    <a href="#/funding" class="${active === "funding" ? "on" : ""}">Funding gaps</a>
    <a href="#/cost" class="${active === "cost" ? "on" : ""}">Trade cost</a>
    <a href="#/calc" class="${active === "calc" ? "on" : ""}">Calculator</a>
    <a href="#/var" class="${active === "var" ? "on" : ""}">VAR points</a>
    <a href="#/week" class="${active === "week" ? "on" : ""}">Weekly</a>
    <a href="#/watch" class="${active === "watch" ? "on" : ""}" id="nav-watch">★ Watchlist${watch.size ? ` <span class="badge">${watch.size}</span>` : ""}</a>
    <a href="#/about" class="${active === "about" ? "on" : ""}">About</a>
  </nav>
  <button class="theme" id="theme" aria-label="Toggle light or dark theme" title="Light / dark">◐</button>
</header>
${p ? `<section class="kpis">
  <div><span>24h volume</span><b>${usd(p.vol24)}</b></div>
  <div><span>Open interest</span><b>${usd(p.oi)}</b></div>
  <div><span>TVL</span><b>${usd(p.tvl)}</b></div>
  <div><span>Markets</span><b>${p.markets}</b></div>
  <div><span>History</span><b>${meta ? `${meta.snapshots.toLocaleString()} snapshots` : DASH}</b><small>${meta ? `since ${when(meta.first).slice(0, 10)}` : ""}</small></div>
</section>
<p class="fresh">${fresh}${failed.length ? ` · <span class="warn">no data this round from ${failed.join(", ")}</span>` : ""}</p>` : ""}
<main>${body}</main>
<footer>Unofficial. Not affiliated with Variational. Data comes from public APIs (Variational Omni, Hyperliquid, dYdX, and Lighter's funding feed for Binance, Bybit and Lighter) every 15 minutes. Nothing here is trading advice. <a href="https://github.com/bars26/omni-tape">Source</a></footer>`;
}

function controls(st: ListState, id: string): string {
  const vols = [
    [0, "any volume"],
    [10_000, "≥ $10K / 24h"],
    [100_000, "≥ $100K / 24h"],
    [1_000_000, "≥ $1M / 24h"],
  ] as const;
  return `<div class="controls" data-for="${id}">
  <input type="search" placeholder="Search ticker or name" value="${esc(st.q)}" data-k="q" aria-label="Search">
  <select data-k="type" aria-label="Contract type">
    ${(["all", "perp", "swap"] as const).map((t) => `<option value="${t}" ${st.type === t ? "selected" : ""}>${t === "all" ? "Perps + swaps" : t === "perp" ? "Perps" : "Swaps"}</option>`).join("")}
  </select>
  <select data-k="minVol" aria-label="Minimum volume">
    ${vols.map(([v, l]) => `<option value="${v}" ${st.minVol === v ? "selected" : ""}>${l}</option>`).join("")}
  </select>
  ${st.steady === undefined ? "" : `<select data-k="steady" aria-label="Gap persistence">
    <option value="0" ${st.steady ? "" : "selected"}>Any gap</option>
    <option value="1" ${st.steady ? "selected" : ""}>Steady: one way in ≥ 80% of the last 24 h</option>
  </select>`}
</div>`;
}

function th(st: ListState, key: string, label: string, title = "", cls = "num"): string {
  const on = st.sort === key;
  return `<th class="${cls}" ${title ? `title="${esc(title)}"` : ""}><button data-sort="${key}" class="${on ? "on" : ""}">${label}${on ? (st.dir < 0 ? " ↓" : " ↑") : ""}</button></th>`;
}

function chgCell(x: number | null | undefined, fmt: (v: number | null | undefined) => string = chg): string {
  if (x === null || x === undefined) return `<td class="num muted">${DASH}</td>`;
  return `<td class="num ${x > 0 ? "pos" : x < 0 ? "neg" : ""}">${fmt(x)}</td>`;
}

function newTag(m: MarketRow): string {
  return m.listed ? ` <span class="tag new" title="Listed on Omni ${when(m.listed)}">NEW</span>` : "";
}

function fcell(x: number | null | undefined): string {
  if (x === null || x === undefined) return `<td class="num muted">${DASH}</td>`;
  return `<td class="num ${x > 0 ? "pos" : x < 0 ? "neg" : ""}">${apr(x)}</td>`;
}

// ---------- views ----------

function viewMarkets(): string {
  const rows = filtered(list);
  const body = rows
    .slice(0, 400)
    .map((m) => {
      const ls = longShare(m);
      return `<tr>
  <td class="mk">${star(m.tk)}<a href="#/m/${encodeURIComponent(m.tk)}" class="tk">${esc(m.tk)}</a>${newTag(m)}<div class="nm">${esc(m.name)}</div></td>
  <td class="num">${price(m.mark)}</td>
  ${chgCell(m.d24?.mark)}
  <td class="num">${usd(m.vol)}</td>
  <td class="num">${usd(oi(m))}</td>
  ${chgCell(m.d24?.oi, (v) => chg(v, 1))}
  <td class="num"><span class="skew" style="--l:${ls === null ? 0.5 : ls}" title="long ${pct(ls)} / short ${ls === null ? DASH : pct(1 - ls)}"></span>${pct(ls)}</td>
  ${fcell(m.fNext)}
  ${fcell(venueMedian(m.v))}
  <td class="num">${bps(m.spread)}</td>
  <td class="num">${bps(m.imp100k)}</td>
</tr>`;
    })
    .join("");
  const fresh = (snap?.markets ?? []).filter((m) => m.listed).sort((a, b) => b.listed! - a.listed!);
  return `<section class="platform" id="platform"></section>
${fresh.length ? `<div class="newbar"><span class="muted">New on Omni this week:</span> ${fresh.map((m) => `<a href="#/m/${encodeURIComponent(m.tk)}" class="chip-link" title="${esc(m.name)} · listed ${when(m.listed!)}">${esc(m.tk)}</a>`).join("")}</div>` : ""}
${controls(list, "list")}
<p class="count">${rows.length} markets${rows.length > 400 ? " (first 400 shown)" : ""}</p>
<div class="table-wrap"><table>
<thead><tr>
  ${th(list, "tk", "Market", "", "")}
  ${th(list, "mark", "Mark")}
  ${th(list, "chg24", "24 h", "Mark price change over the last 24 hours")}
  ${th(list, "vol", "24h vol")}
  ${th(list, "oi", "Open int.")}
  ${th(list, "oi24", "OI 24 h", "Change in total open interest over the last 24 hours")}
  ${th(list, "long", "Long share", "Share of open interest that is long")}
  ${th(list, "f", "Funding", "Omni's next funding rate, annualized")}
  ${th(list, "med", "Elsewhere", "Median annualized funding on Hyperliquid, dYdX, Binance, Bybit and Lighter")}
  ${th(list, "spread", "Spread", "Base bid/ask spread in basis points")}
  ${th(list, "imp", "$100K cost", "Cost of buying $100K versus mid, in basis points, from Omni's quote for that size")}
</tr></thead><tbody>${body}</tbody></table></div>`;
}

function viewFunding(): string {
  const rows = filtered(gaps, (m) => m.fNext !== null && Object.keys(m.v).length > 0);
  const body = rows
    .slice(0, 300)
    .map(
      (m) => `<tr>
  <td class="mk">${star(m.tk)}<a href="#/m/${encodeURIComponent(m.tk)}" class="tk">${esc(m.tk)}</a><div class="nm">${usd(m.vol)} / 24h</div></td>
  ${fcell(m.fNext)}
  ${VENUES.map((v) => fcell(m.v[v])).join("")}
  ${fcell(gap(m))}
  ${persCell(m)}
</tr>`,
    )
    .join("");
  return `<div class="lede"><h1>Funding gaps</h1><p>Omni's next funding rate next to the same market on other venues, all annualized. <b>Gap</b> is Omni minus the median of the others. Rates move every interval, venues pay on different schedules (Omni: 1–8 h), and a gap says nothing about fees, spread or the cost of holding both sides. <b>Last 24 h</b> tells a one-off spike from a gap that has held for hours: "higher 89/96" means Omni was above the others in 89 of the last 96 snapshots.</p></div>
${controls(gaps, "gaps")}
<p class="count">${rows.length} markets listed on Omni and at least one other venue${gaps.steady ? ", with a gap that held one way in at least 80% of the last 24 h" : ""}</p>
<div class="table-wrap"><table>
<thead><tr>
  ${th(gaps, "tk", "Market", "", "")}
  ${th(gaps, "f", "Omni")}
  ${VENUES.map((v) => th(gaps, v, VENUE_LABEL[v])).join("")}
  ${th(gaps, "gapAbs", "Gap", "Omni minus the median of the other venues; sorted by size")}
  ${th(gaps, "pers", "Last 24 h", "How often Omni's funding sat above (or below) the other venues' median over the last 24 h of 15-minute snapshots; sorted by how one-sided it was")}
</tr></thead><tbody>${body}</tbody></table></div>`;
}

function costCell(x: number | null | undefined, thin = false): string {
  if (x === null || x === undefined) return `<td class="num muted">${thin ? '<span title="Hyperliquid\'s visible book cannot fill this size">thin</span>' : DASH}</td>`;
  return `<td class="num">${bps(x)}</td>`;
}

function winner(d: number | null, h: number | null | undefined, o: number | null | undefined): string {
  if (d === null) {
    if ((h === null || h === undefined) && o !== null && o !== undefined) return `<td><span class="tag omni">Omni</span> <span class="muted">only quote</span></td>`;
    return `<td class="muted">${DASH}</td>`;
  }
  if (Math.abs(d) < 0.5) return `<td class="muted">about even</td>`;
  return d > 0
    ? `<td><span class="tag omni">Omni</span> by ${bps(d)} bps</td>`
    : `<td><span class="tag hl">Hyperliquid</span> by ${bps(-d)} bps</td>`;
}

function viewCost(): string {
  const rows = filtered(costs, (m) => m.o1k !== null && m.h1k !== undefined && m.h1k !== null);
  const omniWins = rows.filter((m) => (diff(m.h100k, m.o100k) ?? 0) > 0).length;
  const compared = rows.filter((m) => diff(m.h100k, m.o100k) !== null).length;
  const body = rows
    .slice(0, 300)
    .map(
      (m) => `<tr>
  <td class="mk">${star(m.tk)}<a href="#/m/${encodeURIComponent(m.tk)}" class="tk">${esc(m.tk)}</a><div class="nm">${usd(m.vol)} / 24h on Omni</div></td>
  ${costCell(m.o1k)}${costCell(m.h1k)}${winner(diff(m.h1k, m.o1k), m.h1k, m.o1k)}
  ${costCell(m.o100k)}${costCell(m.h100k, true)}${winner(diff(m.h100k, m.o100k), m.h100k, m.o100k)}
</tr>`,
    )
    .join("");
  return `<div class="lede"><h1>Trade cost</h1><p>What a market order costs, in basis points of each venue's own mid price, averaged over buying and selling, fees included. Omni charges no trading fee and earns on the spread; Hyperliquid's base-tier taker fee is 4.5 bps. Omni's numbers are its <b>indicative</b> quotes: the firm quote you get on submit can be better or worse. Hyperliquid's come from its order book at the same moment. Each market's page also checks Lighter's book live.</p></div>
${controls(costs, "costs")}
<p class="count">${rows.length} markets on both venues${compared ? ` · at $100K Omni is cheaper on ${omniWins} of ${compared} where both can fill` : ""}</p>
<div class="table-wrap"><table>
<thead><tr>
  ${th(costs, "tk", "Market", "", "")}
  ${th(costs, "o1k", "Omni $1K", "Omni one-way cost for $1K, bps")}
  ${th(costs, "h1k", "Hyperliquid $1K", "Hyperliquid one-way cost for $1K incl. 4.5 bps taker fee, bps")}
  ${th(costs, "d1k", "Cheaper at $1K", "Sorted by Hyperliquid minus Omni", "")}
  ${th(costs, "o100k", "Omni $100K", "Omni one-way cost for $100K, bps")}
  ${th(costs, "h100k", "Hyperliquid $100K", "Hyperliquid one-way cost for $100K incl. fee, bps")}
  ${th(costs, "d100k", "Cheaper at $100K", "Sorted by Hyperliquid minus Omni", "")}
</tr></thead><tbody>${body}</tbody></table></div>`;
}

function viewAbout(): string {
  return `<article class="prose">
<h1>About Omni Tape</h1>
<p><a href="https://omni.variational.io">Variational Omni</a> publishes one read-only endpoint, <code>/metadata/v2/stats</code>, with the current state of every market: mark price, 24h volume, long and short open interest, funding, and quotes at three sizes. It has no history.</p>
<p>Omni Tape keeps one. A GitHub Actions job takes a snapshot every 15 minutes and stores it as plain CSV on the <a href="https://github.com/bars26/omni-tape/tree/data"><code>data</code> branch</a>, one file per market. The last 7 days keep every snapshot, the last 30 days keep one per hour, and older history one per 4 hours.</p>
<p>Each snapshot also records the same market's funding on Hyperliquid and dYdX (from their public APIs) and on Binance, Bybit and Lighter (from Lighter's public funding feed, which reports 8-hour rates). Every rate is converted to an annual percentage so they compare directly. Small coins listed in multiples (kPEPE, 1000PEPE) are matched to their base symbol: a funding rate does not depend on the multiple.</p>
<h2>Use the data</h2>
<p>Everything is public and needs no key:</p>
<ul>
<li><code>${DATA}/latest.json</code>: the newest snapshot</li>
<li><code>${DATA}/m/BTC-PERP.csv</code>: one market's history</li>
<li><code>${DATA}/platform.csv</code>: platform totals</li>
</ul>
<h2>Limits</h2>
<ul>
<li>A missing value means the source did not report it; it is never filled with zero.</li>
<li>Omni swaps (indices, commodities) are not compared with other venues.</li>
<li>Trade cost: Omni's quotes are indicative, not firm. Hyperliquid shows only 20 price levels at full precision; when that cannot fill $100K the cost is read from its grouped book, whose prices are rounded away from mid, so it can overstate the cost slightly but never understate it. "Thin" means even the grouped book could not fill the size. Fees are base tier (Hyperliquid 4.5 bps taker) and standard account (Lighter 0).</li>
<li>Unofficial and unaffiliated. Not trading advice.</li>
</ul>
</article>`;
}

async function viewMarket(tk: string): Promise<void> {
  const m = snap?.markets.find((x) => x.tk === tk);
  app.innerHTML = shell(
    "",
    `<div class="lede"><a href="#/" class="back">← Markets</a><h1>${m ? star(tk) : ""}${esc(tk)}</h1><p class="muted">${m ? esc(m.name) : "Not in the latest snapshot."}</p></div>
${m ? `<section class="kpis small">
  <div><span>Mark</span><b>${price(m.mark)}</b></div>
  <div><span>24h volume</span><b>${usd(m.vol)}</b></div>
  <div><span>Open interest</span><b>${usd(oi(m))}</b><small>${pct(longShare(m))} long</small></div>
  <div><span>Funding (ann.)</span><b>${apr(m.fNext)}</b><small>${m.intS ? `every ${m.intS / 3600} h` : ""}</small></div>
  <div><span>Spread · $100K</span><b>${bps(m.spread)} · ${bps(m.imp100k)} bps</b></div>
</section>
${m.p24 && m.p24.n >= MIN_PERSIST ? `<p class="fresh">Last 24 h: Omni's funding was above the other venues' median in <b>${m.p24.above}</b> of ${m.p24.n} snapshots and below it in <b>${m.p24.below}</b> (average gap ${apr(m.p24.avg)}).</p>` : ""}` : ""}
${m ? `<p class="fresh"><a href="#/calc?m=${encodeURIComponent(tk)}">Estimate a trade on ${esc(tk)} in dollars →</a></p>` : ""}
<div class="range" role="group" aria-label="Range">${["1D", "3D", "7D", "30D", "All"].map((r) => `<button data-range="${r}">${r}</button>`).join("")}</div>
<div id="c-f"></div><section class="chart" id="live-cost"><div class="chart-head"><h3>Cost to trade now</h3><button class="link" id="live-refresh">Refresh</button></div><p class="muted empty">Loading order books…</p></section><div id="c-c"></div><div id="c-hour"></div><div id="c-oi"></div><div id="c-p"></div><div id="c-v"></div>`,
  );
  bindShell();
  if (m) liveCost(m);
  let rows: HistRow[] = [];
  try {
    rows = await getCsv(marketFile(tk));
  } catch (e) {
    document.getElementById("c-f")!.innerHTML = `<p class="warn">Could not load history: ${esc(String(e))}</p>`;
    return;
  }
  renderHours(document.getElementById("c-hour")!, rows);
  const draw = (range: string) => {
    document.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === range));
    const last = rows.length ? rows[rows.length - 1].t! : 0;
    const from = range === "1D" ? last - 86400 : range === "3D" ? last - 3 * 86400 : range === "7D" ? last - 7 * 86400 : range === "30D" ? last - 30 * 86400 : -Infinity;
    const r = rows.filter((x) => x.t! >= from);
    const s = (k: string): [number, number | null][] => r.map((x) => [x.t!, x[k] ?? null]);
    const fund: Series[] = [{ label: "Omni", color: COLOR.omni, points: s("fo"), width: 2.4 }, ...VENUES.map((v) => ({ label: VENUE_LABEL[v], color: COLOR[v], points: s(v) }))];
    renderChart(document.getElementById("c-f")!, { title: "Funding, annualized", series: fund, fmt: apr, zeroLine: true });
    renderChart(document.getElementById("c-oi")!, {
      title: "Open interest",
      series: [
        { label: "Long", color: "var(--pos)", points: s("oiL") },
        { label: "Short", color: "var(--neg)", points: s("oiS") },
      ],
      fmt: usd,
    });
    renderChart(document.getElementById("c-p")!, { title: "Mark price", series: [{ label: "Mark", color: COLOR.omni, points: s("mark") }], fmt: price });
    renderChart(document.getElementById("c-c")!, {
      title: "Cost of a $100K market order (bps, one way)",
      series: [
        { label: "Omni (indicative)", color: COLOR.omni, points: s("o100k"), width: 2.4 },
        { label: "Hyperliquid", color: COLOR.hl, points: s("h100k") },
      ],
      fmt: (v) => `${bps(v)} bps`,
    });
    renderChart(document.getElementById("c-v")!, { title: "24h volume (rolling)", series: [{ label: "Volume", color: "var(--c1)", points: s("vol") }], fmt: usd });
  };
  document.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((b) => b.addEventListener("click", () => draw(b.dataset.range!)));
  const span = rows.length ? rows[rows.length - 1].t! - rows[0].t! : 0;
  draw(span > 7 * 86400 ? "7D" : span > 3 * 86400 ? "3D" : "All");
}

// ---------- platform history (markets page) ----------

async function fillPlatform() {
  const host = document.getElementById("platform");
  if (!host) return;
  let rows: HistRow[] = [];
  try {
    rows = await getCsv("platform.csv");
  } catch {
    host.remove();
    return;
  }
  if (rows.length < 4) return host.remove();
  host.innerHTML = `<div class="pcharts"><div id="pc-tvl"></div><div id="pc-oi"></div><div id="pc-vol"></div></div>`;
  const s = (k: string): [number, number | null][] => rows.map((r) => [r.t!, r[k] ?? null]);
  renderChart(document.getElementById("pc-tvl")!, { title: "Omni TVL", series: [{ label: "TVL", color: COLOR.omni, points: s("tvl") }], fmt: usd, height: 110 });
  renderChart(document.getElementById("pc-oi")!, { title: "Open interest", series: [{ label: "OI", color: "var(--c1)", points: s("oi") }], fmt: usd, height: 110 });
  renderChart(document.getElementById("pc-vol")!, { title: "24h volume (rolling)", series: [{ label: "Volume", color: "var(--c4)", points: s("vol24") }], fmt: usd, height: 110 });
}

// ---------- weekly digest ----------

let digestCache = new Map<string, Digest | null>();

async function loadDigest(name: string): Promise<Digest | null> {
  if (!digestCache.has(name)) digestCache.set(name, await getJson<Digest>(`digest/${name}.json`).catch(() => null));
  return digestCache.get(name)!;
}

function digestText(d: Digest): string {
  const p = d.platform;
  const tvl = p.then?.tvl && p.now.tvl ? ` TVL ${usd(p.now.tvl)} (${chg(p.now.tvl / p.then.tvl - 1, 1)})` : "";
  const parts = [`Omni this week (${d.week}):${tvl}`];
  if (d.newListings.length) parts.push(`New: ${d.newListings.slice(0, 5).map((x) => x.tk.replace(/-PERP$/, "")).join(", ")}${d.newListings.length > 5 ? ` +${d.newListings.length - 5}` : ""}`);
  const g = d.steadyGaps.slice(0, 3).map((x) => `${x.tk.replace(/-PERP$/, "")} ${x.detail!.above! >= x.detail!.below! ? "↑" : "↓"}${Math.round(x.value * 100)}%`);
  if (g.length) parts.push(`Steadiest funding gaps vs other venues: ${g.join(", ")}`);
  const up = d.oiUp[0];
  if (up) parts.push(`Biggest OI jump: ${up.tk.replace(/-PERP$/, "")} ${chg(up.value, 0)}`);
  parts.push("omni-tape.vercel.app/#/week");
  return parts.join("\n");
}

function digestList(title: string, note: string, rows: DigestRow[], cell: (r: DigestRow) => string, head: string): string {
  return `<section class="chart"><div class="chart-head"><h3>${title}</h3></div><p class="note">${note}</p>${
    rows.length
      ? `<div class="table-wrap flat"><table><thead><tr><th>Market</th>${head}</tr></thead><tbody>${rows
          .map((r) => `<tr><td class="mk">${star(r.tk)}<a class="tk" href="#/m/${encodeURIComponent(r.tk)}">${esc(r.tk)}</a><div class="nm">${esc(r.name)}</div></td>${cell(r)}</tr>`)
          .join("")}</tbody></table></div>`
      : `<p class="muted empty">Nothing this week.</p>`
  }</section>`;
}

async function viewWeek(which: string) {
  app.innerHTML = shell("week", `<p class="loading">Loading the weekly digest…</p>`);
  bindShell();
  const d = await loadDigest(which === "latest" ? "latest" : which);
  if (!d) {
    app.innerHTML = shell("week", `<div class="lede"><h1>Weekly digest</h1><p class="warn">No digest for ${esc(which)} yet.</p></div>`);
    bindShell();
    return;
  }
  const prevWeek = isoWeek(d.t - WEEK);
  const hasPrev = which === "latest" || which === d.week ? !!(await loadDigest(prevWeek)) : false;
  const p = d.platform;
  const pc = (k: "tvl" | "oi" | "vol24") => (p.then && p.then[k] && p.now[k] ? chg(p.now[k]! / p.then[k]! - 1, 1) : DASH);
  const days = Math.max(1, Math.round((d.t - d.from) / 86400));
  const steadyCell = (r: DigestRow) => {
    const x = r.detail!;
    const hi = x.above! >= x.below!;
    return `<td class="num"><span class="${hi ? "pos" : "neg"}">${hi ? "higher" : "lower"}</span> ${Math.round(r.value * 100)}% of the time</td><td class="num">${apr(x.avg)}</td>`;
  };
  const body = `<div class="lede"><h1>Weekly digest · ${esc(d.week)}</h1><p>What changed on Variational Omni over the ${days === 7 ? "last 7 days" : `last ${days} days (history starts ${when(d.from).slice(0, 10)})`}, from the 15-minute snapshots. Updated with every snapshot; the page for a week stays as it was when the week ended. ${when(d.t)}.</p>
<div class="week-nav">${hasPrev && which !== prevWeek ? `<a href="#/week/${prevWeek}">← ${prevWeek}</a>` : ""}${which !== "latest" ? `<a href="#/week">This week →</a>` : ""}<button class="link" id="copy-x">Copy summary for X</button><span class="muted" id="copied"></span></div></div>
<section class="kpis small four">
  <div><span>TVL</span><b>${usd(p.now.tvl)}</b><small>${pc("tvl")} vs start</small></div>
  <div><span>Open interest</span><b>${usd(p.now.oi)}</b><small>${pc("oi")} vs start</small></div>
  <div><span>24h volume</span><b>${usd(p.now.vol24)}</b><small>${pc("vol24")} vs start</small></div>
  <div><span>Markets</span><b>${p.now.markets}</b><small>${d.newListings.length} new · ${d.gone.length} gone</small></div>
</section>
${
  d.newListings.length || d.gone.length
    ? `<section class="chart"><div class="chart-head"><h3>Listings</h3></div><div class="newbar">${d.newListings
        .map((x) => `<a href="#/m/${encodeURIComponent(x.tk)}" class="chip-link" title="${esc(x.name)}">+ ${esc(x.tk)} <span class="muted">${when(x.first).slice(5, 10)}</span></a>`)
        .join("")}${d.gone.map((x) => `<span class="chip-link gone" title="last seen ${when(x.last)}">− ${esc(x.tk)}</span>`).join("")}</div></section>`
    : ""
}
${digestList("Steadiest funding gaps", "Markets with $100K+ daily volume where Omni's funding stayed on one side of the other venues' median for most of the week.", d.steadyGaps, steadyCell, `<th class="num">Omni vs others</th><th class="num">Avg gap</th>`)}
<div class="two">
${digestList("Open interest up", "Markets with $1M+ open interest, change over the window.", d.oiUp, (r) => `<td class="num pos">${chg(r.value, 0)}</td><td class="num">${usd(r.detail!.oiNow)}</td>`, `<th class="num">Change</th><th class="num">OI now</th>`)}
${digestList("Open interest down", "Same, largest falls.", d.oiDown, (r) => `<td class="num neg">${chg(r.value, 0)}</td><td class="num">${usd(r.detail!.oiNow)}</td>`, `<th class="num">Change</th><th class="num">OI now</th>`)}
</div>
${digestList("Biggest shifts in positioning", "Change in the share of open interest that is long.", d.longShift, (r) => `<td class="num ${r.value > 0 ? "pos" : "neg"}">${pts(r.value)}</td><td class="num">${pct(r.detail!.longNow)}</td>`, `<th class="num">Long share change</th><th class="num">Long now</th>`)}
<div class="two">
${digestList("Omni cheaper to trade", "Median one-way cost of a $100K market order over the week, Omni's indicative quote vs Hyperliquid's book + fee. Busiest markets first.", d.omniCheaper, (r) => `<td class="num">${bps(r.detail!.omni)}</td><td class="num">${bps(r.detail!.hl)}</td>`, `<th class="num">Omni bps</th><th class="num">HL bps</th>`)}
${digestList("Hyperliquid cheaper to trade", "Same comparison, the other way round.", d.omniDearer, (r) => `<td class="num">${bps(r.detail!.omni)}</td><td class="num">${bps(r.detail!.hl)}</td>`, `<th class="num">Omni bps</th><th class="num">HL bps</th>`)}
</div>`;
  app.innerHTML = shell("week", body);
  bindShell();
  document.getElementById("copy-x")?.addEventListener("click", async () => {
    const out = document.getElementById("copied")!;
    try {
      await navigator.clipboard.writeText(digestText(d));
      out.textContent = "copied";
    } catch {
      out.textContent = digestText(d);
    }
  });
}

// ---------- watchlist view ----------

function spark(points: [number, number][]): string {
  if (points.length < 2) return "";
  const W = 84, H = 22;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const d = points
    .map(([t, v], i) => `${i ? "L" : "M"}${(((t - t0) / Math.max(1, t1 - t0)) * W).toFixed(1)},${(H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`)
    .join("");
  const up = vs[vs.length - 1] >= vs[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(${up ? "--pos" : "--neg"})" stroke-width="1.5"/></svg>`;
}

function viewWatch(): string {
  const tks = [...watch];
  if (!tks.length) {
    const sugg = SUGGESTED.filter((tk) => snap?.markets.some((m) => m.tk === tk));
    return `<div class="lede"><h1>Watchlist</h1><p>Star markets (☆) in any table or on a market's page and they collect here: price over the last 24 h, funding against other venues, how long the gap has held, and what $100K costs to trade. The list is kept in this browser only; there is no account.</p></div>
<p class="count">Start with a few:</p><div class="suggest">${sugg.map((tk) => `<button class="chip-btn" data-star="${tk}">☆ ${tk}</button>`).join("")}</div>`;
  }
  const rows = tks.map((tk) => {
    const m = snap?.markets.find((x) => x.tk === tk);
    if (!m) return `<tr><td class="mk">${star(tk)}<span class="tk">${esc(tk)}</span></td><td colspan="8" class="muted">Not in the latest snapshot</td></tr>`;
    const ls = longShare(m);
    return `<tr data-tk="${esc(tk)}">
  <td class="mk">${star(tk)}<a href="#/m/${encodeURIComponent(tk)}" class="tk">${esc(tk)}</a><div class="nm">${esc(m.name)}</div></td>
  <td class="num">${price(m.mark)}<div class="nm" data-chg>${DASH}</div></td>
  <td class="num" data-spark></td>
  <td class="num">${usd(m.vol)}</td>
  <td class="num"><span class="skew" style="--l:${ls === null ? 0.5 : ls}"></span>${pct(ls)}</td>
  ${fcell(m.fNext)}
  ${fcell(venueMedian(m.v))}
  ${persCell(m)}
  <td class="num">${bps(m.o100k)}</td>
</tr>`;
  });
  return `<div class="lede"><h1>Watchlist</h1><p>Kept in this browser only. Click ★ to remove a market.</p></div>
<div class="table-wrap"><table>
<thead><tr><th>Market</th><th class="num">Mark · 24 h</th><th class="num">24 h</th><th class="num">24h vol</th><th class="num">Long share</th><th class="num" title="Omni's next funding, annualized">Funding</th><th class="num" title="Median funding on the other venues">Elsewhere</th><th class="num" title="How the funding gap behaved over the last 24 h">Last 24 h</th><th class="num" title="Omni one-way cost of a $100K market order, bps">$100K cost</th></tr></thead>
<tbody>${rows.join("")}</tbody></table></div>`;
}

/** Fill 24 h price change and sparklines from each watched market's history. */
async function fillWatch() {
  const now = snap?.t ?? Date.now() / 1000;
  await Promise.all(
    [...document.querySelectorAll<HTMLTableRowElement>("tr[data-tk]")].map(async (tr) => {
      const tk = tr.dataset.tk!;
      try {
        const rows = (await getCsv(marketFile(tk))).filter((r) => r.t !== null && now - r.t! <= 86400 && r.mark !== null);
        const pts = rows.map((r) => [r.t!, r.mark!] as [number, number]);
        tr.querySelector("[data-spark]")!.innerHTML = spark(pts);
        if (pts.length >= 2 && pts[0][1] > 0) {
          const chg = pts[pts.length - 1][1] / pts[0][1] - 1;
          const el = tr.querySelector<HTMLElement>("[data-chg]")!;
          el.textContent = `${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%`;
          el.className = `nm ${chg > 0 ? "pos" : chg < 0 ? "neg" : ""}`;
        }
      } catch {
        /* leave the dash */
      }
    }),
  );
}

// ---------- cost by hour of day (market page) ----------

function renderHours(host: HTMLElement, rows: HistRow[]) {
  const now = rows.length ? rows[rows.length - 1].t! : 0;
  const span = rows.length ? now - rows[0].t! : 0;
  const series: [string, string, (number | null)[]][] = [
    ["Omni", "o100k", byHour(rows, "o100k", now)],
    ["Hyperliquid", "h100k", byHour(rows, "h100k", now)],
  ];
  const have = series.filter(([, , xs]) => xs.filter((x) => x !== null).length >= 12);
  const title = `<div class="chart-head"><h3>$100K market order by hour of day (UTC), median of the last 7 days</h3></div>`;
  if (span < 2 * 86400 || !have.length) {
    host.innerHTML = `<section class="chart">${title}<p class="muted empty">Needs at least two days of history.</p></section>`;
    return;
  }
  const cells = (xs: (number | null)[]) => {
    const vals = xs.filter((x): x is number => x !== null);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const best = xs.indexOf(lo);
    return xs
      .map((x, i) => {
        if (x === null) return `<td class="hcell muted">·</td>`;
        const k = hi > lo ? (x - lo) / (hi - lo) : 0; // 0 = cheapest
        return `<td class="hcell${i === best ? " hbest" : ""}" style="--k:${k.toFixed(2)}" title="${String(i).padStart(2, "0")}:00 UTC: ${bps(x)} bps">${bps(x)}</td>`;
      })
      .join("");
  };
  const summary = have
    .map(([name, , xs]) => {
      const vals = xs.filter((x): x is number => x !== null);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      return `${name} is cheapest around <b>${String(xs.indexOf(lo)).padStart(2, "0")}:00 UTC</b> (${bps(lo)} bps) and dearest around ${String(xs.indexOf(hi)).padStart(2, "0")}:00 (${bps(hi)} bps)`;
    })
    .join("; ");
  host.innerHTML = `<section class="chart">${title}<p class="note">${summary}.</p><div class="table-wrap flat hours"><table>
<thead><tr><th></th>${Array.from({ length: 24 }, (_, i) => `<th class="num">${String(i).padStart(2, "0")}</th>`).join("")}</tr></thead>
<tbody>${have.map(([name, , xs]) => `<tr><td><b>${name}</b></td>${cells(xs)}</tr>`).join("")}</tbody></table></div>
<p class="note">One-way cost in bps, fees included; greener is cheaper within each row. Hours with fewer than 3 snapshots are left blank.</p></section>`;
}

// ---------- calculator ----------

type CalcVenue = "omni" | "hl" | "lighter";
const CALC_VENUES: CalcVenue[] = ["omni", "hl", "lighter"];
const CALC_LABEL: Record<CalcVenue, string> = { omni: "Omni", hl: "Hyperliquid", lighter: "Lighter" };

interface CalcState {
  mode: "one" | "pair";
  m: string;
  side: Side;
  size: number;
  hold: number;
  unit: "h" | "d";
  longOn: CalcVenue;
  shortOn: CalcVenue;
}

function readCalc(): CalcState {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const pick = <T extends string>(v: string | null, ok: readonly T[], d: T): T => (v && (ok as readonly string[]).includes(v) ? (v as T) : d);
  const num = (v: string | null, d: number) => (v !== null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    mode: pick(q.get("mode"), ["one", "pair"] as const, "one"),
    m: q.get("m") ?? "BTC-PERP",
    side: pick(q.get("side"), ["long", "short"] as const, "long"),
    size: num(q.get("size"), 10_000),
    hold: num(q.get("hold"), 3),
    unit: pick(q.get("unit"), ["h", "d"] as const, "d"),
    longOn: pick(q.get("long"), CALC_VENUES, "omni"),
    shortOn: pick(q.get("short"), CALC_VENUES, "hl"),
  };
}

function writeCalc(st: CalcState) {
  const q = new URLSearchParams({ mode: st.mode, m: st.m, size: String(st.size), hold: String(st.hold), unit: st.unit });
  if (st.mode === "one") q.set("side", st.side);
  else {
    q.set("long", st.longOn);
    q.set("short", st.shortOn);
  }
  history.replaceState(null, "", `#/calc?${q}`);
}

function money(x: number | null | undefined, signed = false): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  const a = Math.abs(x);
  const s = a >= 1000 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 }) : a.toFixed(2);
  return `${x < 0 ? "−" : signed && x > 0 ? "+" : ""}$${s}`;
}
function moneyCell(x: number | null | undefined, cls = ""): string {
  return `<td class="num ${cls} ${x !== null && x !== undefined && x < 0 ? "pos" : ""}">${money(x)}</td>`;
}
function hoursText(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return "never at this rate";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

function viewCalc(): string {
  const st = readCalc();
  const opts = (snap?.markets ?? []).map((m) => `<option value="${esc(m.tk)}">${esc(m.name)}</option>`).join("");
  const venueSel = (k: string, v: CalcVenue) => `<select data-c="${k}">${CALC_VENUES.map((x) => `<option value="${x}" ${x === v ? "selected" : ""}>${CALC_LABEL[x]}</option>`).join("")}</select>`;
  return `<div class="lede"><h1>Trade calculator</h1><p>What a position costs in dollars: opening and closing it (spread, slippage and taker fee) plus funding over the time you hold it, on Omni, Hyperliquid and Lighter. Funding is shown at the current rate and at the average of the last 24 hours, since it changes every interval. Price moves are not included. An estimate, not a quote and not advice.</p></div>
<div class="calc-tabs" role="tablist">
  <button data-mode="one" class="${st.mode === "one" ? "on" : ""}">One position</button>
  <button data-mode="pair" class="${st.mode === "pair" ? "on" : ""}">Long one venue, short another</button>
</div>
<form class="calc" id="calc-form">
  <label>Market<input list="calc-markets" data-c="m" value="${esc(st.m)}" autocomplete="off" spellcheck="false"><datalist id="calc-markets">${opts}</datalist></label>
  ${st.mode === "one" ? `<label>Side<select data-c="side"><option value="long" ${st.side === "long" ? "selected" : ""}>Long</option><option value="short" ${st.side === "short" ? "selected" : ""}>Short</option></select></label>` : `<label>Long on${venueSel("long", st.longOn)}</label><label>Short on${venueSel("short", st.shortOn)}</label>`}
  <label>Size (USD)<input type="number" min="10" step="any" data-c="size" value="${st.size}"></label>
  <label>Hold<span class="pair"><input type="number" min="0.1" step="any" data-c="hold" value="${st.hold}"><select data-c="unit"><option value="h" ${st.unit === "h" ? "selected" : ""}>hours</option><option value="d" ${st.unit === "d" ? "selected" : ""}>days</option></select></span></label>
  <button type="submit" class="go">Calculate</button>
</form>
<div id="calc-out"></div>`;
}

function bindCalc() {
  const form = document.getElementById("calc-form") as HTMLFormElement | null;
  if (!form) return;
  const collect = (): CalcState => {
    const st = readCalc();
    const get = (k: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-c="${k}"]`)?.value ?? "";
    st.m = get("m").trim().toUpperCase() || st.m;
    st.size = Number(get("size")) > 0 ? Number(get("size")) : st.size;
    st.hold = Number(get("hold")) > 0 ? Number(get("hold")) : st.hold;
    st.unit = get("unit") === "h" ? "h" : "d";
    if (st.mode === "one") st.side = get("side") === "short" ? "short" : "long";
    else {
      st.longOn = (get("long") as CalcVenue) || st.longOn;
      st.shortOn = (get("short") as CalcVenue) || st.shortOn;
    }
    return st;
  };
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      const st = collect();
      st.mode = b.dataset.mode === "pair" ? "pair" : "one";
      writeCalc(st);
      route();
    }),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const st = collect();
    writeCalc(st);
    runCalc(st);
  });
  runCalc(readCalc());
}

let calcRun = 0;
async function runCalc(st: CalcState) {
  const out = document.getElementById("calc-out")!;
  const run = ++calcRun;
  const m = snap?.markets.find((x) => x.tk === st.m);
  if (!m) {
    out.innerHTML = `<p class="warn">No market called ${esc(st.m)} in the latest snapshot. Pick one from the list.</p>`;
    return;
  }
  if (st.mode === "pair" && st.longOn === st.shortOn) {
    out.innerHTML = `<p class="warn">Pick two different venues for the long and the short.</p>`;
    return;
  }
  out.innerHTML = `<p class="muted">Reading order books and the last 24 hours of funding…</p>`;
  const hours = st.unit === "d" ? st.hold * 24 : st.hold;
  const perp = m.type === "perp";
  const settle = (p: Promise<(number | null)[] | string>) => p.catch(() => "unavailable" as const);
  const [rows, hl, lt] = await Promise.all([
    getCsv(marketFile(m.tk)).catch(() => []),
    perp ? settle(hlCosts(m.base, [st.size])) : Promise.resolve("not compared" as const),
    perp ? settle(lighterCosts(m.base, [st.size])) : Promise.resolve("not compared" as const),
  ]);
  if (run !== calcRun) return; // a newer calculation started
  const now = snap?.t ?? Date.now() / 1000;
  const cost: Record<CalcVenue, number | null> = {
    omni: omniCostAt(st.size, m.o1k, m.o100k),
    hl: typeof hl === "string" ? null : hl[0],
    lighter: typeof lt === "string" ? null : lt[0],
  };
  const why: Record<CalcVenue, string> = {
    omni: st.size > 100_000 ? "Omni quotes up to $100K" : cost.omni === null ? "no quote" : st.size === 1_000 || st.size === 100_000 ? "indicative quote, no fee" : "between its $1K and $100K quotes, no fee",
    hl: typeof hl === "string" ? hl : cost.hl === null ? "book too thin for this size" : "live book + 4.5 bps fee",
    lighter: typeof lt === "string" ? lt : cost.lighter === null ? "book too thin for this size" : "live book, no fee",
  };
  const rateNow: Record<CalcVenue, number | null> = { omni: m.fNext, hl: m.v.hl ?? null, lighter: m.v.lighter ?? null };
  const rateAvg: Record<CalcVenue, number | null> = {
    omni: trailingMean(rows, "fo", now),
    hl: trailingMean(rows, "hl", now),
    lighter: trailingMean(rows, "lighter", now),
  };
  const head = `<p class="count">${esc(m.tk)} · ${usd(st.size)} · held ${st.hold} ${st.unit === "d" ? (st.hold === 1 ? "day" : "days") : st.hold === 1 ? "hour" : "hours"} · negative amounts (green) are money you receive</p>`;
  const foot = `<p class="note">Entry and exit each use the one-way cost of a market order of this size (buy and sell averaged), so the exit is assumed to cost what the entry did. Funding assumes the rate holds for the whole hold; positive rates mean longs pay shorts on all three venues. Omni's numbers come from its indicative quotes ${ago(m ? (snap?.t ?? now) : now)}; its firm quote on submit can differ.</p>`;

  if (st.mode === "one") {
    const est = CALC_VENUES.map((v) => ({ v, e: legEstimate(st.size, hours, st.side, cost[v], rateNow[v], rateAvg[v]) }));
    const best = est.filter((x) => x.e.totalNow !== null).sort((a, b) => a.e.totalNow! - b.e.totalNow!)[0]?.v;
    out.innerHTML = `${head}<div class="table-wrap"><table class="calc-table">
<thead><tr><th>Venue</th><th class="num">Open</th><th class="num">Close</th><th class="num">Funding now</th><th class="num">Funding 24 h avg</th><th class="num">Total now</th><th class="num">Total 24 h avg</th></tr></thead>
<tbody>${est
      .map(
        ({ v, e }) => `<tr class="${v === best ? "best" : ""}"><td><b>${CALC_LABEL[v]}</b>${v === best ? ' <span class="tag omni">lowest</span>' : ""}<div class="nm">${esc(why[v])}</div></td>
${moneyCell(e.entry)}${moneyCell(e.exit)}${moneyCell(e.fundingNow)}${moneyCell(e.fundingAvg)}${moneyCell(e.totalNow, "strong")}${moneyCell(e.totalAvg, "strong")}</tr>`,
      )
      .join("")}</tbody></table></div>${foot}`;
    return;
  }

  const leg = (v: CalcVenue) => ({ bps: cost[v], rateNow: rateNow[v], rateAvg: rateAvg[v] });
  const p = pairEstimate(st.size, hours, leg(st.longOn), leg(st.shortOn));
  const line = (label: string, a: string, b: string) => `<tr><td>${label}</td><td class="num">${a}</td><td class="num">${b}</td></tr>`;
  out.innerHTML = `${head}<div class="table-wrap"><table class="calc-table">
<thead><tr><th>Long ${CALC_LABEL[st.longOn]} · short ${CALC_LABEL[st.shortOn]}</th><th class="num">At current funding</th><th class="num">At 24 h average</th></tr></thead>
<tbody>
${line(`Funding rate, long leg (${CALC_LABEL[st.longOn]})`, apr(rateNow[st.longOn]), apr(rateAvg[st.longOn]))}
${line(`Funding rate, short leg (${CALC_LABEL[st.shortOn]})`, apr(rateNow[st.shortOn]), apr(rateAvg[st.shortOn]))}
${line("Trading cost, 4 fills", money(p.trading), money(p.trading))}
${line("Net funding per day", `<span class="${(p.fundingPerDayNow ?? 0) < 0 ? "pos" : ""}">${money(p.fundingPerDayNow)}</span>`, `<span class="${(p.fundingPerDayAvg ?? 0) < 0 ? "pos" : ""}">${money(p.fundingPerDayAvg)}</span>`)}
${line("<b>Total over the hold</b>", `<b class="${(p.totalNow ?? 0) < 0 ? "pos" : ""}">${money(p.totalNow)}</b>`, `<b class="${(p.totalAvg ?? 0) < 0 ? "pos" : ""}">${money(p.totalAvg)}</b>`)}
${line("Hold needed to cover trading cost", hoursText(p.breakEvenHoursNow), hoursText(p.breakEvenHoursAvg))}
</tbody></table></div>
<p class="note">Cost notes: ${CALC_LABEL[st.longOn]}: ${esc(why[st.longOn])}; ${CALC_LABEL[st.shortOn]}: ${esc(why[st.shortOn])}. The two legs offset price moves only while both stay open; each venue margins its leg separately, and venues settle funding on different schedules (Omni 1–8 h, Hyperliquid and Lighter hourly).</p>${foot}`;
}

// ---------- live order books (market page) ----------

const LIVE_SIZES = [1_000, 10_000, 100_000];
const LIGHTER = "https://mainnet.zklighter.elliot.ai/api/v1";
let lighterMarkets: Promise<Map<string, number>> | null = null;

async function hlBook(coin: string, nSigFigs?: number): Promise<{ bids: Level[]; asks: Level[] }> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nSigFigs ? { type: "l2Book", coin, nSigFigs } : { type: "l2Book", coin }),
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return parseHlBook(await res.json());
}

async function hlCoin(base: string): Promise<string | null> {
  const res = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "meta" }) });
  if (!res.ok) return null;
  const meta = await res.json();
  const want = normalizeSymbol(base);
  const names: string[] = (meta?.universe ?? []).filter((u: { isDelisted?: boolean }) => !u.isDelisted).map((u: { name: string }) => u.name);
  return names.find((n) => n.toUpperCase() === want) ?? names.find((n) => normalizeSymbol(n) === want) ?? null;
}

async function hlCosts(base: string, sizes: number[] = LIVE_SIZES): Promise<(number | null)[] | string> {
  const coin = await hlCoin(base);
  if (!coin) return "not listed";
  const full = await hlBook(coin);
  const mid = midOf(full.bids, full.asks) ?? undefined;
  const out: (number | null)[] = [];
  for (const size of sizes) {
    let c = bookCost(full.bids, full.asks, size, TAKER_FEE.hl);
    for (const n of [5, 4, 3]) {
      if (c !== null) break;
      const agg = await hlBook(coin, n);
      c = bookCost(agg.bids, agg.asks, size, TAKER_FEE.hl, mid);
    }
    out.push(c);
  }
  return out;
}

async function lighterCosts(base: string, sizes: number[] = LIVE_SIZES): Promise<(number | null)[] | string> {
  lighterMarkets ??= fetch(`${LIGHTER}/orderBooks`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Lighter HTTP ${r.status}`))))
    .then((d) => {
      const map = new Map<string, number>();
      for (const o of d?.order_books ?? []) if (o?.market_type === "perp" && o?.status === "active") map.set(normalizeSymbol(String(o.symbol)), Number(o.market_id));
      return map;
    });
  const id = (await lighterMarkets).get(normalizeSymbol(base));
  if (id === undefined) return "not listed";
  const res = await fetch(`${LIGHTER}/orderBookOrders?market_id=${id}&limit=250`);
  if (!res.ok) throw new Error(`Lighter HTTP ${res.status}`);
  const { bids, asks } = parseLighterBook(await res.json());
  return sizes.map((size) => bookCost(bids, asks, size, TAKER_FEE.lighter));
}

async function liveCost(m: MarketRow) {
  const host = document.getElementById("live-cost");
  if (!host) return;
  const head = host.querySelector(".chart-head")!.outerHTML;
  const row = (name: string, note: string, vals: (number | null)[] | string) => {
    const cells =
      typeof vals === "string"
        ? `<td class="num muted" colspan="${LIVE_SIZES.length}">${esc(vals)}</td>`
        : vals.map((v) => (v === null ? `<td class="num muted" title="Visible book cannot fill this size">thin</td>` : `<td class="num">${bps(v)}</td>`)).join("");
    return `<tr><td><b>${name}</b><div class="nm">${note}</div></td>${cells}</tr>`;
  };
  const settle = async (p: Promise<(number | null)[] | string>) => p.catch((e: unknown) => `unavailable (${e instanceof Error ? e.message : String(e)})`);
  host.innerHTML = `${head}<p class="muted empty">Loading order books…</p>`;
  const [hl, lt] = m.type === "perp" ? await Promise.all([settle(hlCosts(m.base)), settle(lighterCosts(m.base))]) : ["swap: not compared", "swap: not compared"];
  const omni = LIVE_SIZES.map((s) => (s === 1_000 ? m.o1k : s === 100_000 ? m.o100k : undefined));
  host.innerHTML = `${head}<div class="table-wrap flat"><table>
<thead><tr><th>Venue</th>${LIVE_SIZES.map((s) => `<th class="num">${usd(s)}</th>`).join("")}</tr></thead>
<tbody>
${`<tr><td><b>Omni</b><div class="nm">indicative quote, ${snap ? ago(snap.t) : ""} · no fee</div></td>${omni.map((v) => (v === undefined ? `<td class="num muted" title="Omni quotes only $1K and $100K">${DASH}</td>` : v === null ? `<td class="num muted">${DASH}</td>` : `<td class="num">${bps(v)}</td>`)).join("")}</tr>`}
${row("Hyperliquid", "live order book · 4.5 bps taker fee", hl)}
${row("Lighter", "live order book · standard account, no fee", lt)}
</tbody></table></div><p class="note">Basis points of each venue's own mid, one way (buy and sell averaged), fee included. Omni's firm quote on submit can differ from its indicative quote.</p>`;
  document.getElementById("live-refresh")?.addEventListener("click", () => liveCost(m));
}

// ---------- wiring ----------

function bindShell() {
  document.getElementById("theme")?.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("omnitape:theme", next);
    } catch {
      /* private mode: theme just won't persist */
    }
  });
}

function bindList(st: ListState, rerender: () => void) {
  document.querySelectorAll<HTMLElement>(".controls [data-k]").forEach((el) => {
    const k = el.dataset.k as "q" | "type" | "minVol" | "steady";
    el.addEventListener(k === "q" ? "input" : "change", () => {
      const v = (el as HTMLInputElement).value;
      if (k === "minVol") st.minVol = Number(v);
      else if (k === "steady") st.steady = v === "1";
      else if (k === "type") st.type = v as ListState["type"];
      else st.q = v;
      rerender();
      if (k === "q") {
        const inp = document.querySelector<HTMLInputElement>('.controls [data-k="q"]')!;
        inp.focus();
        inp.setSelectionRange(v.length, v.length);
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach((b) =>
    b.addEventListener("click", () => {
      const key = b.dataset.sort!;
      if (st.sort === key) st.dir = st.dir === 1 ? -1 : 1;
      else {
        st.sort = key;
        st.dir = key === "tk" ? 1 : -1;
      }
      rerender();
    }),
  );
}

// ---------- VAR points -> airdrop ----------

const fdvText = (x: number) => (x >= 1e9 ? `$${+(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${Math.round(x / 1e6)}M` : `$${Math.max(1, Math.round(x / 1e3))}K`);
/** Points someone would need: rounded up, since a fraction short is not enough. */
const ptsText = (x: number) => (Number.isFinite(x) ? Math.ceil(x).toLocaleString("en-US") : DASH);
const perPtText = (x: number) =>
  !Number.isFinite(x) ? DASH : x >= 1000 ? `$${Math.round(x).toLocaleString("en-US")}` : x >= 10 ? `$${x.toFixed(1)}` : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toPrecision(2)}`;
const timesText = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(1));

/** Volume-weighted typical Omni one-way cost at $1K across liquid markets, in bps. */
function typicalOmniBps(): number | null {
  const ms = (snap?.markets ?? []).filter((m) => m.o1k !== null && (m.vol ?? 0) >= 1_000_000);
  const w = ms.reduce((a, m) => a + m.vol!, 0);
  return w > 0 ? ms.reduce((a, m) => a + m.o1k! * m.vol!, 0) / w : null;
}

function viewDrop(): string {
  const st = readDrop(location.hash.split("?")[1] ?? "");
  const typical = typicalOmniBps();
  const num = (k: string, v: number | string, extra = "") => `<input type="number" min="0" step="any" data-d="${k}" value="${v}" ${extra}>`;
  const err = (k: string) => `<small class="field-err" data-err="${k}" role="alert"></small>`;
  return `<div class="lede"><h1>VAR points → airdrop estimate</h1><p>Type your Variational points and pick an FDV to see what they might be worth at TGE, next to where HYPE and LIT traded at launch, at their lows and at their peaks. Arithmetic on public numbers, not a prediction and not advice.</p></div>
<form class="calc" id="drop-form" onsubmit="return false">
  <label>Your points${num("pts", st.points)}${err("pts")}</label>
  <label>Target (USD, optional)${num("target", st.target || "", 'placeholder="e.g. 5000"')}</label>
  <label>Estimated total points at TGE${num("total", st.total)}${err("total")}</label>
  <label>Airdrop share (%)${num("share", +(st.share * 100).toFixed(2), 'max="100"')}${err("share")}</label>
</form>
<section class="drop-fdv">
  <div class="drop-fdv-head"><span>FDV <small class="muted" id="drop-fdv-hint"></small></span><b id="drop-fdv-val">${fdvText(st.fdv)}</b></div>
  <input type="range" id="drop-slider" min="0" max="1000" step="1" value="${sliderFromFdv(st.fdv)}" aria-label="FDV">
  <div class="drop-chips">${SCENARIOS.map((f) => `<button type="button" data-fdv="${f}">${fdvText(f)}</button>`).join("")}</div>
</section>
<div id="drop-out"></div>
<section class="chart"><div class="chart-head"><h3>What did your points cost?</h3></div>
<p class="note">Omni charges no fees; you pay the spread. Enter the volume you traded and the cost per fill to get a price per point and the FDV where the drop pays it back. The default is today's volume-weighted Omni cost for a $1K order across markets with $1M+ daily volume${typical !== null ? ` (${bps(typical)} bps)` : ""}; larger orders cost more (see Trade cost). Funding and price moves are not included.</p>
<form class="calc" id="cost-form" onsubmit="return false">
  <label>Your Omni volume (USD)${num("vol", st.vol || "", 'placeholder="e.g. 250000"')}</label>
  <label>Cost per fill (bps)${num("cbps", st.cbps || "", `placeholder="${typical !== null ? bps(typical) : "e.g. 3"}"`)}</label>
</form>
<div id="cost-out"></div>
</section>
<section class="drop-share"><button type="button" class="go" id="drop-copy">Copy link to my scenario</button><a class="go" id="drop-x" target="_blank" rel="noopener">Share on X</a><span class="muted" id="drop-copied"></span></section>
<section class="chart"><div class="chart-head"><h3>Assumptions</h3></div><ul class="note drop-notes">
<li><b>Airdrop share 32%:</b> the genesis distribution in Variational's docs, proportional to points and fully unlocked at TGE. Total supply is not public, so the math uses FDV directly.</li>
<li><b>Weekly points (official):</b> Variational's 24 September 2026 update says 150,000 points are distributed each week until TGE, which is set for Q4 2026.</li>
<li><b>Estimated total ${ptsText(DEFAULT_TOTAL_POINTS)} (our estimate, not official):</b> starts from "at least 10.2 million points" after the 13 November 2026 distribution, as counted by <a href="https://www.kucoin.com/news/flash/variational-airdrop-point-valuation-estimated-at-47-after-1-5b-valuation-raise" target="_blank" rel="noopener">BeInCrypto (19 Nov 2026)</a> from the 3M retroactive points plus 150K each Friday. Adding the official 150K for the six Fridays left in 2026 (20 Nov – 25 Dec) gives ~11.1M. An earlier TGE means fewer points and more per point. Change it if you have a better number.</li>
<li><b>Minimum balance:</b> Variational's update says you need at least ${MIN_POINTS} point to claim the genesis airdrop; below that the page shows no personal estimate.</li>
<li><b>Benchmarks:</b> daily closes from Hyperliquid's HYPE/USDC and Lighter's LIT/USDC spot markets. CoinGecko lists intraday extremes outside these (HYPE $3.81 low on launch day, LIT $7.86 in its first minutes), which were thin.</li>
<li>Referral points, boosts and any sybil filtering change the real numbers. This page keeps nothing: your inputs live only in the link.</li>
</ul></section>`;
}

function dropOut(st: DropState): string {
  const errs = dropErrors(st);
  if (Object.keys(errs).length) {
    return `<p class="warn drop-blocked">${Object.values(errs).map(esc).join(". ")}. The estimate and sharing are paused until this is fixed.</p>`;
  }
  const per = perPoint(st.fdv, st.total, st.share);
  const eligible = st.points >= MIN_POINTS;
  const yours = per * st.points;
  const tgt = st.target > 0;
  const mine = (x: number) => (eligible ? money(x) : DASH);
  const cards = `<section class="kpis drop-kpis">
  <div><span>One point at ${fdvText(st.fdv)}</span><b>${perPtText(per)}</b></div>
  <div><span>Your ${pointsLabel(st.points)} ${st.points === 1 ? "point" : "points"}</span>${eligible ? `<b>${money(yours)}</b>` : `<b class="neg">Not eligible</b><small>Variational's minimum to claim is ${MIN_POINTS} point</small>`}</div>
  <div><span>${tgt ? `Points for ${money(st.target)}` : "Your share of the drop"}</span><b>${tgt ? ptsText(Math.max(MIN_POINTS, pointsFor(st.target, st.fdv, st.total, st.share))) : shareLabel(st.points, st.total)}</b></div>
</section>`;

  const row = (fdv: number, lead: string, cls = "") => {
    const p = perPoint(fdv, st.total, st.share);
    return `<tr class="${cls}">${lead}<td class="num">${fdvText(fdv)}</td><td class="num">${perPtText(p)}</td><td class="num strong">${mine(p * st.points)}</td>${tgt ? `<td class="num">${ptsText(Math.max(MIN_POINTS, pointsFor(st.target, fdv, st.total, st.share)))}</td>` : ""}</tr>`;
  };
  const tgtTh = tgt ? `<th class="num">Points for ${money(st.target)}</th>` : "";
  const scen = `<section class="chart"><div class="chart-head"><h3>FDV scenarios</h3></div><div class="table-wrap flat"><table class="calc-table">
<thead><tr><th class="num">FDV</th><th class="num">Per point</th><th class="num">Your drop</th>${tgtTh}</tr></thead>
<tbody>${[...new Set([...SCENARIOS, st.fdv])].sort((a, b) => a - b).map((f) => row(f, "", f === st.fdv ? "best" : "")).join("")}</tbody></table></div></section>`;

  const bench = `<section class="chart"><div class="chart-head"><h3>If VAR traded where HYPE and LIT did</h3></div>
<p class="note">VAR's FDV set equal to each token's FDV on that day (price × 1B max supply, daily close on the token's own spot market). The ${(st.share * 100).toFixed(0)}% VAR share is applied, not HYPE's ${BENCH_AIRDROP.HYPE * 100}% or LIT's ${BENCH_AIRDROP.LIT * 100}%. Launch days come first; lows are the lowest daily close after launch day. Click a row to use its FDV above; rows past $10B apply in full while the slider rests at its end.</p>
<div class="table-wrap flat"><table class="calc-table">
<thead><tr><th>Token</th><th>Moment</th><th>Date</th><th class="num">Price</th><th class="num">FDV</th><th class="num">Per point</th><th class="num">Your drop</th>${tgtTh}</tr></thead>
<tbody>${BENCHMARKS.map((x) => row(x.fdv, `<td><b>${x.token}</b></td><td class="nm" ${x.note ? `title="${esc(x.note)}"` : ""}>${x.label}</td><td>${x.date}</td><td class="num">$${x.price}</td>`, `bench pick ${x.fdv === st.fdv ? "best" : ""}" data-bfdv="${x.fdv}`)).join("")}</tbody></table></div></section>`;

  return cards + scen + bench;
}

/** Results of the points-cost section only; its inputs stay put so typing is never interrupted. */
function costOut(st: DropState): string {
  const per = perPoint(st.fdv, st.total, st.share);
  const typical = typicalOmniBps();
  const cbps = st.cbps > 0 ? st.cbps : typical ?? 0;
  const cpp = costPerPoint(st.vol, cbps, st.points);
  const be = breakEvenFdv(cpp, st.total, st.share);
  if (Object.keys(dropErrors(st)).length) return `<p class="muted">Fix the inputs above to see this.</p>`;
  if (!(st.vol > 0) || !Number.isFinite(cpp)) return `<p class="muted">Enter your volume to see it.</p>`;
  return `<section class="kpis drop-kpis">
  <div><span>Spread paid</span><b>${money((st.vol * cbps) / 1e4)}</b></div>
  <div><span>Cost per point</span><b>${perPtText(cpp)}</b></div>
  <div><span>Break-even FDV</span><b>${Number.isFinite(be) ? fdvText(be) : DASH}</b></div>
</section><p class="note">At ${fdvText(st.fdv)} a point is worth ${perPtText(per)}, ${per >= cpp ? `<b class="pos">${timesText(per / cpp)}×</b> what it cost` : `<b class="neg">less than</b> it cost`}.</p>`;
}

function bindDrop() {
  const out = document.getElementById("drop-out");
  const slider = document.getElementById("drop-slider") as HTMLInputElement | null;
  if (!out || !slider) return;
  let st = readDrop(location.hash.split("?")[1] ?? "");
  const shareUrl = () => `${location.origin}/#/var?${writeDrop(st)}`;
  const paint = () => {
    const errs = dropErrors(st);
    const ok = !Object.keys(errs).length;
    document.querySelectorAll<HTMLElement>("[data-err]").forEach((el) => (el.textContent = errs[el.dataset.err as keyof typeof errs] ?? ""));
    // A wrong input must not end up in a shared link: keep the last good URL and hide sharing.
    document.querySelector<HTMLElement>(".drop-share")!.hidden = !ok;
    if (ok) history.replaceState(null, "", `#/var?${writeDrop(st)}`);
    document.getElementById("drop-fdv-val")!.textContent = fdvText(st.fdv);
    document.getElementById("drop-fdv-hint")!.textContent = st.fdv > FDV_MAX ? "from the table, above the slider's range" : "";
    document.querySelectorAll<HTMLButtonElement>("[data-fdv]").forEach((b) => b.classList.toggle("on", Number(b.dataset.fdv) === st.fdv));
    out.innerHTML = dropOut(st);
    document.getElementById("cost-out")!.innerHTML = costOut(st);
    const per = perPoint(st.fdv, st.total, st.share);
    const value = st.points >= MIN_POINTS ? `≈ ${money(per * st.points)}` : `= not eligible (minimum ${MIN_POINTS} point)`;
    const text = `${pointsLabel(st.points)} Variational ${st.points === 1 ? "point" : "points"} at a ${fdvText(st.fdv)} VAR FDV ${value} (${perPtText(per)}/pt, ${(st.share * 100).toFixed(0)}% airdrop, ${(st.total / 1e6).toFixed(1)}M total points). My scenario on Omni Tape:`;
    (document.getElementById("drop-x") as HTMLAnchorElement).href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl())}`;
  };
  const read = (ev: Event) => {
    const el = ev.target as HTMLInputElement;
    const k = el.dataset.d;
    if (!k) return;
    const v = Number(el.value);
    const ok = el.value.trim() !== "" && Number.isFinite(v) && v >= 0;
    // Keep what was typed, even when wrong, so the page can say what is wrong with it.
    if (k === "pts") st.points = ok ? v : NaN;
    else if (k === "total") st.total = ok ? v : NaN;
    else if (k === "share") st.share = ok ? v / 100 : NaN;
    else if (k === "target") st.target = ok ? v : 0;
    else if (k === "vol") st.vol = ok ? v : 0;
    else if (k === "cbps") st.cbps = ok ? v : 0;
    else return;
    paint();
  };
  document.getElementById("drop-form")!.addEventListener("input", read);
  document.getElementById("cost-form")!.addEventListener("input", read);
  slider.addEventListener("input", () => {
    st.fdv = fdvFromSlider(Number(slider.value));
    paint();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-fdv]").forEach((b) =>
    b.addEventListener("click", () => {
      st.fdv = Number(b.dataset.fdv);
      slider.value = String(sliderFromFdv(st.fdv));
      paint();
    }),
  );
  out.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const r = t.closest<HTMLElement>("tr.pick[data-bfdv]");
    if (r) {
      st.fdv = Number(r.dataset.bfdv);
      slider.value = String(sliderFromFdv(st.fdv));
      paint();
      document.querySelector(".drop-fdv")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  document.getElementById("drop-copy")!.addEventListener("click", () => {
    navigator.clipboard?.writeText(shareUrl()).then(
      () => (document.getElementById("drop-copied")!.textContent = "Link copied"),
      () => (document.getElementById("drop-copied")!.textContent = shareUrl()),
    );
  });
  st = { ...st };
  paint();
}

async function route() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("m/")) return viewMarket(decodeURIComponent(h.slice(2)));
  if (h === "week" || h.startsWith("week/")) {
    window.scrollTo(0, 0);
    return viewWeek(h === "week" ? "latest" : decodeURIComponent(h.slice(5)));
  }
  if (h === "var" || h.startsWith("var?")) {
    app.innerHTML = shell("var", viewDrop());
    bindShell();
    bindDrop();
    window.scrollTo(0, 0);
    return;
  }
  if (h === "calc" || h.startsWith("calc?")) {
    app.innerHTML = shell("calc", viewCalc());
    bindShell();
    bindCalc();
    window.scrollTo(0, 0);
    return;
  }
  const which = h === "funding" ? "funding" : h === "cost" ? "cost" : h === "about" ? "about" : h === "watch" ? "watch" : "markets";
  const render = () => {
    if (which === "watch") {
      app.innerHTML = shell(which, viewWatch());
      bindShell();
      fillWatch();
      return;
    }
    app.innerHTML = shell(which, which === "funding" ? viewFunding() : which === "cost" ? viewCost() : which === "about" ? viewAbout() : viewMarkets());
    bindShell();
    if (which !== "about") bindList(which === "funding" ? gaps : which === "cost" ? costs : list, render);
    if (which === "markets") fillPlatform();
  };
  render();
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    const saved = localStorage.getItem("omnitape:theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch {
    /* ignore */
  }
  loadWatch();
  app.innerHTML = `<p class="loading">Loading the latest snapshot…</p>`;
  base = await resolveBase();
  try {
    [snap, meta] = await Promise.all([getJson<Snapshot>("latest.json"), getJson<typeof meta>("meta.json").catch(() => null)]);
  } catch (e) {
    app.innerHTML = shell("", `<p class="warn">Could not load data: ${esc(String(e))}</p>`);
    bindShell();
    return;
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-star]");
    if (!b) return;
    ev.preventDefault();
    const tk = b.dataset.star!;
    if (watch.has(tk)) watch.delete(tk);
    else watch.add(tk);
    saveWatch();
    if (location.hash.replace(/^#\/?/, "") === "watch") return void route();
    // Elsewhere, update the stars and the nav count in place so scroll and filters stay put.
    document.querySelectorAll<HTMLElement>(`[data-star="${CSS.escape(tk)}"]`).forEach((el) => (el.outerHTML = star(tk)));
    const nav = document.getElementById("nav-watch");
    if (nav) nav.innerHTML = `★ Watchlist${watch.size ? ` <span class="badge">${watch.size}</span>` : ""}`;
  });
  await route();
}

boot();
