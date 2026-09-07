# Onchain spot volume by market cap

Implementation review: 2026-09-07. This document describes the code that runs today. It replaces earlier design notes that incorrectly described an implemented Dune mode and historical market-cap freezing.

## Scope and confidence

The dashboard displays daily DEX spot volume for Ethereum, Solana, Robinhood Chain, Base, BNB Chain, Arbitrum and HyperEVM. The headline total is a provider-reported figure; the two market-cap buckets are estimates. Matching the total by construction does not validate the split.

The current approach is useful for exploratory comparisons. It does not establish an error margin or justify describing the split as verified or “mostly accurate.” In particular, absence from the sample does not prove that a trade involved a small-cap token.

## Sources and execution

The production path is:

```
DefiLlama daily protocol totals ───────────────────┐
CoinGecko current caps and address mappings ───────┤
GeckoTerminal sampled pool history ────────────────┤
CoinGecko enrichment for additional sampled IDs ──┤
                                                 ▼
                                      classify.mjs → latest.json / CSV / pool audits
                                                 ▼
                                      snapshot.mjs → standalone HTML
```

`pipeline/run.mjs` runs those stages sequentially and force-fetches DefiLlama totals again after the pool crawl, just before classification. This incorporates provider revisions arriving during the long crawl. `pipeline/reconcile.mjs` is a separate, manually invoked comparison of mapped venues; it is not currently called by the scheduled pipeline. Its timestamp must be checked before treating it as evidence for a new run.

`pipeline/reanchor.mjs` can apply later reference-total revisions to an already completed sample for the same date window. It writes a separate candidate directory for review and retains the pool/cap generation timestamp. It records `reference_refreshed_at` independently and rejects date-window changes; it cannot replace a full daily refresh. Its regression tests run with `node --test pipeline/tests/reanchor.test.mjs`.

`pipeline/dune/dex_volume_by_mcap.sql` is an unconnected SQL draft with a placeholder uploaded table. Setting `DUNE_API_KEY` does not select another execution path. A trade-level alternative requires an implemented query, cap data, API integration and coverage validation; paying for a provider alone does not make its results complete.

| Chain | DefiLlama slug | CoinGecko platform | GeckoTerminal network |
|---|---|---|---|
| Ethereum | Ethereum | ethereum | eth |
| Solana | Solana | solana | solana |
| Base | Base | base | base |
| BNB Chain | BSC | binance-smart-chain | bsc |
| Arbitrum | Arbitrum | arbitrum-one | arbitrum |
| HyperEVM | Hyperliquid L1 | hyperevm | hyperevm |
| Robinhood Chain | Robinhood Chain | robinhood | robinhood |

These are the registry identifiers used by `pipeline/config.mjs`, not a guarantee of complete provider coverage.

## Headline total

`fetch_defillama.mjs` sums the daily protocol breakdown from `api.llama.fi/overview/dexs/{chain}`. It keeps 61 closed UTC days and excludes the current partial day. It logs the difference between the summed breakdown and the provider's headline chart.

HyperEVM is explicitly filtered: only `Dexs` category protocols on `Hyperliquid L1`, excluding `Hyperliquid Spot Orderbook`. The HyperCore orderbook is stored separately for the optional overlay and is not added to the displayed total.

The provider may revise history or omit venues. A matching provider total is evidence of faithful aggregation, not an independent census of all onchain activity. The pipeline does not identify or filter wash trades.

## Pool selection

GeckoTerminal supplies today's top 200 pools per chain. CoinGecko supplies a whitelist of non-quote tokens with current market cap at least $100M. Quote assets, including native assets and large stablecoins, are excluded from this extra lookup, so their quote/quote pools rely on the top-pool sample. Only whitelist tokens with reported 24-hour volume at least $250,000 receive a pool lookup, limited to their top 10 pools.

The union is deduplicated by pool address. Daily history is fetched only for pools with current 24-hour volume of at least $50,000 when in the top-pool list, or $25,000 otherwise. This is **not all pools of all large-cap tokens**. Today's ranking can miss pools that were important earlier in the historical window.

## Classification

Each sampled pool is classified once, avoiding counting its volume again for the other token leg. This does not collapse a multi-hop swap into one user-level trade: each pool execution remains part of pool volume.

1. Quote set Q consists of stablecoins with current global market cap at least $100M and a configured list of native, wrapped-native, BTC-wrapper and liquid-staking assets.
2. One non-quote leg: classify using that token's cap.
3. Both legs in Q: assign above $100M by convention. Native/LST membership is configured, not individually verified against the threshold on every run.
4. Two non-quote legs: a known below-threshold leg decides “below”; otherwise any missing cap decides “unknown”; otherwise use the smaller cap.
5. Cap lookup uses CoinGecko market cap, then its FDV if market cap is unavailable, then GeckoTerminal market cap. GeckoTerminal FDV can establish “below” only when FDV itself is below $100M. CoinGecko FDV can currently establish “above,” which is a limitation: FDV is not circulating market cap.
6. Wrapped and bridged assets map to their underlying where configured. Restricted symbol fallbacks handle certain bridged CoinGecko listings; unlisted tokens are not indiscriminately matched by symbol.

All historical rows use the current market-cap snapshot. Every full refresh reclassifies history. A token crossing $100M today can move its earlier volume between buckets. The code does not store or join each trading day's cap, and historical-cap backfilling is not implemented.

## Daily bucket calculation

Let `T` be the DefiLlama total, `S` all sampled pool volume, and `A` sampled volume classified above $100M.

- When `0 < S <= T`: `above = A`, `below = T - A`.
- When `S > T`: `above = T × A / S`, `below = T - above`.
- When no sampled volume is available: the split is null.

Thus all unknown sampled volume and the unsampled residual go into “below.” This is an assumption, not a measurement. A source mismatch can also cause residuals, and coverage above 100% demonstrates disagreement. Since the source universes differ, the reported buckets should not be presented as mathematically proven lower/upper bounds on the true market-cap split.

Quality fields:

- `coverage = S / T`: sampling volume relative to the reference total; not an accuracy percentage.
- `unknown_share`: share of the sample whose subject cap could not be determined; separate from unsampled volume.
- `boundary_share`: share of sampled volume with a subject cap between $50M and $200M.
- `above_100m_proportional`: alternative assumption `T × A / S`, stored for sensitivity comparisons. It is not independently validated either.

## Windows and provisional data

The provider fetch flags a day when protocols positive on each of the preceding seven days disappear and their average volume exceeds 1% of the preceding day's breakdown total. Classification retains this provisional flag only for the latest three dates. Older flagged gaps remain in `data_gaps` but enter the summary. This is a completeness limitation.

KPIs use the last 30 non-provisional observations and the 30 before them. The main change is `sum(last 30) / sum(previous 30) - 1`; the secondary daily change compares the last observation to the observation 30 positions earlier. These can differ from strict calendar windows when dates are excluded. The chart's 30/60-day control changes the plotted observations, while the KPI summary remains 30 observations. Each chain displays its actual summary dates.

## Refresh and deployment

`.github/workflows/refresh.yml` schedules GitHub Actions daily at 14:00 UTC (19:30 IST), with manual dispatch available. A successful run commits `data/`; the connected Vercel project then redeploys the static site. Vercel does not itself fetch market data.

The GeckoTerminal rate limit makes a cold run roughly 2–3 hours. The workflow timeout is five hours. Scheduling and provider delays can push publication later than the scheduled start; a cron declaration is not proof that a run succeeded. Verify the Actions result, data commit, Vercel deployment, and the live `generated_at` value.

The browser fetches `data/latest.json` on page load. An already-open tab does not poll automatically. The standalone snapshot never refreshes itself.

## Frontend and brand

One static `index.html`, custom SVG chart, seven chain tabs, 30/60-day controls, daily table, CSV download, comparison table, light/dark themes and a collapsible methodology section. The separate “Estimated split” box was removed at the owner's request; the estimated-methodology badge and disclosures remain.

The logo, Cerebri Sans Pro and core palette come from nemesis.trade. See `assets/brand/README.md` for provenance. Snapshot generation embeds data, CSV, fonts and the inline logo so `data/snapshot.html` works independently of the repository.

## Accuracy improvements that require new work

Use indexed swap executions and historical circulating caps from a common, defined venue universe. Keep unmatched caps and uncovered volume separately identifiable, validate address mappings, and reconcile by venue/day before aggregating. State whether volume counts each pool execution or each user-level swap. Store source timestamps and completeness checks per chain. A new provider must be audited for chain/venue coverage; “trade-level” alone does not mean complete.
