import "./style.css";
import { renderChart, type Series } from "./chart.ts";
import { ago, apr, bps, esc, pct, price, usd, when, DASH } from "./format.ts";
import { marketFile, parseCsv, type HistRow } from "./lib/history.ts";
import { bookCost, midOf, parseHlBook, parseLighterBook, TAKER_FEE, type Level } from "./lib/cost.ts";
import { normalizeSymbol } from "./lib/venues.ts";
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
}
const list: ListState = { q: "", type: "all", minVol: 0, sort: "vol", dir: -1 };
const gaps: ListState = { q: "", type: "perp", minVol: 100_000, sort: "gapAbs", dir: -1 };
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
  ...Object.fromEntries(VENUES.map((v) => [v, (m: MarketRow) => m.v[v] ?? null])),
};

function filtered(st: ListState, keep: (m: MarketRow) => boolean = () => true): MarketRow[] {
  if (!snap) return [];
  const q = st.q.trim().toUpperCase();
  const key = SORTERS[st.sort] ?? SORTERS.vol;
  return snap.markets
    .filter((m) => (st.type === "all" || m.type === st.type) && (m.vol ?? 0) >= st.minVol)
    .filter((m) => !q || m.tk.toUpperCase().includes(q) || m.name.toUpperCase().includes(q))
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
</div>`;
}

function th(st: ListState, key: string, label: string, title = "", cls = "num"): string {
  const on = st.sort === key;
  return `<th class="${cls}" ${title ? `title="${esc(title)}"` : ""}><button data-sort="${key}" class="${on ? "on" : ""}">${label}${on ? (st.dir < 0 ? " ↓" : " ↑") : ""}</button></th>`;
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
  <td><a href="#/m/${encodeURIComponent(m.tk)}" class="tk">${esc(m.tk)}</a><div class="nm">${esc(m.name)}</div></td>
  <td class="num">${price(m.mark)}</td>
  <td class="num">${usd(m.vol)}</td>
  <td class="num">${usd(oi(m))}</td>
  <td class="num"><span class="skew" style="--l:${ls === null ? 0.5 : ls}" title="long ${pct(ls)} / short ${ls === null ? DASH : pct(1 - ls)}"></span>${pct(ls)}</td>
  ${fcell(m.fNext)}
  ${fcell(venueMedian(m.v))}
  <td class="num">${bps(m.spread)}</td>
  <td class="num">${bps(m.imp100k)}</td>
</tr>`;
    })
    .join("");
  return `${controls(list, "list")}
<p class="count">${rows.length} markets${rows.length > 400 ? " (first 400 shown)" : ""}</p>
<div class="table-wrap"><table>
<thead><tr>
  ${th(list, "tk", "Market", "", "")}
  ${th(list, "mark", "Mark")}
  ${th(list, "vol", "24h vol")}
  ${th(list, "oi", "Open int.")}
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
  <td><a href="#/m/${encodeURIComponent(m.tk)}" class="tk">${esc(m.tk)}</a><div class="nm">${usd(m.vol)} / 24h</div></td>
  ${fcell(m.fNext)}
  ${VENUES.map((v) => fcell(m.v[v])).join("")}
  ${fcell(gap(m))}
</tr>`,
    )
    .join("");
  return `<div class="lede"><h1>Funding gaps</h1><p>Omni's next funding rate next to the same market on other venues, all annualized. <b>Gap</b> is Omni minus the median of the others. Rates move every interval, venues pay on different schedules (Omni: 1–8 h), and a gap says nothing about fees, spread or the cost of holding both sides.</p></div>
${controls(gaps, "gaps")}
<p class="count">${rows.length} markets listed on Omni and at least one other venue</p>
<div class="table-wrap"><table>
<thead><tr>
  ${th(gaps, "tk", "Market", "", "")}
  ${th(gaps, "f", "Omni")}
  ${VENUES.map((v) => th(gaps, v, VENUE_LABEL[v])).join("")}
  ${th(gaps, "gapAbs", "Gap", "Omni minus the median of the other venues; sorted by size")}
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
  <td><a href="#/m/${encodeURIComponent(m.tk)}" class="tk">${esc(m.tk)}</a><div class="nm">${usd(m.vol)} / 24h on Omni</div></td>
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
    `<div class="lede"><a href="#/" class="back">← Markets</a><h1>${esc(tk)}</h1><p class="muted">${m ? esc(m.name) : "Not in the latest snapshot."}</p></div>
${m ? `<section class="kpis small">
  <div><span>Mark</span><b>${price(m.mark)}</b></div>
  <div><span>24h volume</span><b>${usd(m.vol)}</b></div>
  <div><span>Open interest</span><b>${usd(oi(m))}</b><small>${pct(longShare(m))} long</small></div>
  <div><span>Funding (ann.)</span><b>${apr(m.fNext)}</b><small>${m.intS ? `every ${m.intS / 3600} h` : ""}</small></div>
  <div><span>Spread · $100K</span><b>${bps(m.spread)} · ${bps(m.imp100k)} bps</b></div>
</section>` : ""}
<div class="range" role="group" aria-label="Range">${["1D", "7D", "30D", "All"].map((r) => `<button data-range="${r}">${r}</button>`).join("")}</div>
<div id="c-f"></div><section class="chart" id="live-cost"><div class="chart-head"><h3>Cost to trade now</h3><button class="link" id="live-refresh">Refresh</button></div><p class="muted empty">Loading order books…</p></section><div id="c-c"></div><div id="c-oi"></div><div id="c-p"></div><div id="c-v"></div>`,
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
  const draw = (range: string) => {
    document.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === range));
    const last = rows.length ? rows[rows.length - 1].t! : 0;
    const from = range === "1D" ? last - 86400 : range === "7D" ? last - 7 * 86400 : range === "30D" ? last - 30 * 86400 : -Infinity;
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
  draw(rows.length && rows[rows.length - 1].t! - rows[0].t! > 7 * 86400 ? "7D" : "All");
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

async function hlCosts(base: string): Promise<(number | null)[] | string> {
  const coin = await hlCoin(base);
  if (!coin) return "not listed";
  const full = await hlBook(coin);
  const mid = midOf(full.bids, full.asks) ?? undefined;
  const out: (number | null)[] = [];
  for (const size of LIVE_SIZES) {
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

async function lighterCosts(base: string): Promise<(number | null)[] | string> {
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
  return LIVE_SIZES.map((size) => bookCost(bids, asks, size, TAKER_FEE.lighter));
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
    const k = el.dataset.k as "q" | "type" | "minVol";
    el.addEventListener(k === "q" ? "input" : "change", () => {
      const v = (el as HTMLInputElement).value;
      if (k === "minVol") st.minVol = Number(v);
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

async function route() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("m/")) return viewMarket(decodeURIComponent(h.slice(2)));
  const which = h === "funding" ? "funding" : h === "cost" ? "cost" : h === "about" ? "about" : "markets";
  const render = () => {
    app.innerHTML = shell(which, which === "funding" ? viewFunding() : which === "cost" ? viewCost() : which === "about" ? viewAbout() : viewMarkets());
    bindShell();
    if (which !== "about") bindList(which === "funding" ? gaps : which === "cost" ? costs : list, render);
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
  await route();
}

boot();
