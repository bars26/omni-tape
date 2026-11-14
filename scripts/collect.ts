// Takes one snapshot of Variational Omni plus other venues' funding and writes it
// into a data directory (the checked-out `data` branch in CI).
//
//   node scripts/collect.ts <dataDir>
//
// Node >= 22.18 runs this TypeScript directly (type stripping).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OMNI_STATS_URL } from "../src/lib/omni.ts";
import { DYDX_URL, HL_URL, LIGHTER_URL, parseDydx, parseHyperliquid, parseLighterAggregate, type FundingMap } from "../src/lib/venues.ts";
import { buildSnapshot } from "../src/lib/snapshot.ts";
import { appendAndCompact, MARKET_COLS, marketFile, marketToCsvRow, PLATFORM_COLS, platformToCsvRow } from "../src/lib/history.ts";
import type { Venue } from "../src/lib/types.ts";

const UA = { "user-agent": "omni-tape/0.1 (+https://github.com/bars26/omni-tape)" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string, init: RequestInit = {}, tries = 4): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status >= 500) {
        // Omni answers a busy service with 429 + retry_after_seconds.
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        const wait = Number((body as Record<string, unknown>).retry_after_seconds ?? res.headers.get("retry-after") ?? 2);
        last = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        await sleep(Math.min(30, Math.max(1, wait)) * 1000 + i * 2000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(2000 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function venue<T>(p: Promise<T>): Promise<T | Error> {
  try {
    return await p;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node scripts/collect.ts <dataDir>");
  const t = Math.floor(Date.now() / 1000);

  const [omniRaw, hl, dydx, agg] = await Promise.all([
    fetchJson(OMNI_STATS_URL, {}, 8),
    venue(fetchJson(HL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) }).then(parseHyperliquid)),
    venue(fetchJson(DYDX_URL).then(parseDydx)),
    venue(fetchJson(LIGHTER_URL).then(parseLighterAggregate)),
  ]);

  const venues: Partial<Record<Venue, FundingMap | Error>> = { hl, dydx };
  for (const v of ["binance", "bybit", "lighter"] as const) {
    venues[v] = agg instanceof Error ? agg : (agg[v] ?? new Error(`no ${v} rows in Lighter aggregate`));
  }

  const snap = buildSnapshot({ t, omniRaw, venues });

  await write(join(dir, "latest.json"), JSON.stringify(snap));
  for (const m of snap.markets) {
    const path = join(dir, marketFile(m.tk));
    await write(path, appendAndCompact(await readText(path), MARKET_COLS, marketToCsvRow(t, m), t));
  }
  const pPath = join(dir, "platform.csv");
  await write(pPath, appendAndCompact(await readText(pPath), PLATFORM_COLS, platformToCsvRow(t, snap.platform), t));

  const metaPath = join(dir, "meta.json");
  const prev = JSON.parse((await readText(metaPath)) || "{}");
  await write(metaPath, JSON.stringify({ first: prev.first ?? t, last: t, snapshots: (prev.snapshots ?? 0) + 1 }, null, 1) + "\n");

  const summary = Object.entries(snap.sources).map(([k, s]) => `${k}=${s.ok ? s.count : "FAIL(" + s.error + ")"}`).join(" ");
  console.log(`snapshot ${new Date(t * 1000).toISOString()} markets=${snap.markets.length} ${summary}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
