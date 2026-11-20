# Omni Tape

A public history of [Variational Omni](https://omni.variational.io) markets, with each market's funding on other venues side by side.

**Live:** https://omni-tape.vercel.app

Omni publishes one read-only endpoint, `GET /metadata/v2/stats`, with the current state of every market (mark price, 24h volume, long/short open interest, funding, quotes at three sizes). It keeps no history. Omni Tape does:

- A GitHub Actions job ([`collect.yml`](.github/workflows/collect.yml)) takes a snapshot every 15 minutes.
- Each snapshot also records the same market's funding on **Hyperliquid** and **dYdX** (their public APIs) and on **Binance**, **Bybit** and **Lighter** (Lighter's public funding feed, which reports 8-hour rates). Every rate is annualized so they compare directly.
- History is stored as plain CSV on the [`data`](../../tree/data) branch, one file per market: every snapshot for the last 7 days, hourly to 30 days, every 4 hours after that.
- The site is static (Vite + TypeScript, no framework, no backend) and reads the `data` branch directly.
- Pages: markets (with 24 h price/OI change, new listings, platform charts), funding gaps (with how long each gap has held over 24 h), trade cost, a dollar **calculator** (one position, or long one venue and short another, with funding at the current rate and the 24 h average), a **weekly digest**, a browser-only **watchlist**, and per-market history with cost by hour of day.

## Data

No key needed:

| File | What |
| --- | --- |
| `https://raw.githubusercontent.com/bars26/omni-tape/data/latest.json` | Newest snapshot: platform totals, every market, every venue's funding, per-source status |
| `https://raw.githubusercontent.com/bars26/omni-tape/data/m/BTC-PERP.csv` | One market's history |
| `https://raw.githubusercontent.com/bars26/omni-tape/data/platform.csv` | Platform volume, TVL, open interest |
| `https://raw.githubusercontent.com/bars26/omni-tape/data/listings.json` | First and last snapshot each market appeared in |
| `https://raw.githubusercontent.com/bars26/omni-tape/data/digest/latest.json` | Rolling 7-day digest (also `digest/<ISO week>.json`, e.g. `2026-W47.json`) |

CSV columns: `t` (unix seconds), `mark`, `vol` (24h, USD), `oiL`/`oiS` (long/short open interest, USD), `fo` (Omni next funding, annualized), `hl`, `dydx`, `binance`, `bybit`, `lighter` (annualized funding), `spread` (bps), `imp100k` (cost of buying $100K vs mid, bps). An empty cell means the source did not report it; nothing is filled with zero.

Notes: small coins listed in multiples (`kPEPE`, `1000PEPE`) are matched by base symbol, since a funding rate does not depend on the multiple. Omni swaps (indices, commodities) are not compared with other venues.

## Run it

```bash
npm install
npm test
npm run collect          # one snapshot into ./local-data
VITE_DATA_BASE=/local-data npm run dev
```

Node 22.18+ (the collector is TypeScript run directly by Node).

Unofficial and not affiliated with Variational. Not trading advice. MIT licensed.
