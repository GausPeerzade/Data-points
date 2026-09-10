# Data outputs

All numbers are per **closed UTC day** (the current day is never included). Volumes are USD.

| File | What it is | Committed |
|---|---|---|
| `latest.json` | Dashboard input: per chain, 61 days of `total / above_100m / below_100m` plus KPIs and data-quality fields | yes |
| `volume_daily.csv` | Same daily rows as a flat table (`chain,date,total,above_100m,below_100m,coverage,unknown_share,boundary_share,mode,classified_with`) | yes |
| `defillama_totals.json` | Per chain-day totals from DefiLlama, category breakdown, provisional-day flags, DefiLlama's own 30d change for cross-checking | yes |
| `mcap_snapshot.json` | CoinGecko market-cap snapshot used for classification (coins with caps, stablecoin ids, address→coin map for the 7 chains); `provider_tier` records `pro`, `demo` or `public` access | yes |
| `audit/pools_<chain>.csv` | Every sampled pool with both legs' CoinGecko ids, the subject token, its cap, the bucket and the reason. This is the evidence trail for the split. | yes |
| `snapshot.html` | The dashboard with `latest.json` inlined (self-contained, opens from a file) | yes |
| `raw/` | Cached API responses (DefiLlama, CoinGecko market data, CoinGecko Pro onchain or public GeckoTerminal pool data), not committed. Pool caches retain the `raw/geckoterminal/` path for either provider. Exact reproduction of an older run requires retaining its raw responses because APIs and pool rankings can change. | no |

## Row fields (`latest.json` → `chains.<key>.days[]`)

- `total` — DefiLlama chain DEX volume for the day (headline definition). HyperEVM = `Dexs`-category protocols on DefiLlama's "Hyperliquid L1" excluding the HyperCore spot orderbook; the orderbook is kept in `extra.hypercore_spot_orderbook`.
- `above_100m` — **Estimated ≥ $100M**, based on sampled pools.
- `below_100m` — **Below $100M + unclassified**. Includes unknown caps and unsampled volume assigned by assumption. When sampled volume exceeds the reported total, the split is scaled proportionally. The two buckets sum to `total` when available; both can be null without sampled history. CSV column names remain `above_100m` and `below_100m`.
- `mode` — `estimate` (GeckoTerminal pool sampling) or `totals_only` when no pool index exists. The Dune draft is not integrated; configuring its key does not enable a different mode.
- `coverage` — sampled pool volume ÷ DefiLlama total. Below 1.0 indicates a gap relative to the reference total; sampling omissions and source differences can both contribute. The residual is assigned to `below_100m` by assumption. Coverage is not accuracy.
- `unknown_share` — share of sampled volume whose subject token has no CoinGecko market cap (counted as below).
- `boundary_share` — share of sampled volume whose subject token has a cap between $50M and $200M (sensitivity to the threshold).
- `above_100m_proportional` — alternative estimator (`total × sampled_above / sampled_total`), for comparison only.
- `sampled_total` / `sampled_above_100m` — explicit sample amounts, retained so revised reference totals can be applied without changing the sample.
- `provisional` — true when DefiLlama adapters that report daily had not yet published this day at fetch time (`missing_protocols`, `missing_est`). Provisional days are excluded from KPIs and re-pulled on the next run.
- `classified_with` — which market-cap snapshot classified the row. Every refresh reclassifies all historical rows using the current snapshot, rather than each trading day’s cap.

KPIs (`chains.<key>.kpi`): `total_30d`, `share_above_30d`, `change_30d` (trailing 30 complete days vs the prior 30, for each series), `change_30d_point` (last complete day vs 30 days earlier), `crosscheck_same_window` (our 30d-over-30d change on DefiLlama's own window vs DefiLlama's published figure; `match` should be true for unfiltered chains).

## Classification rule (short form)

Pool-level, so each pool execution is counted once rather than once per token leg. Quote set Q = stablecoins ≥ $100M + native/wrapped/LST assets. Subject token = the non-Q leg; bucket by its market cap. Both legs in Q → above. Neither leg in Q → lower cap of the two. No cap → below (reported in `unknown_share`). Wrapped/bridged tokens use the underlying's cap. Full rationale in `../ARCHITECTURE.md` §3.2.

## Running

```bash
node pipeline/run.mjs              # full refresh using the current environment
node pipeline/classify.mjs         # re-aggregate from cache without any network calls
node pipeline/validate.mjs         # validate source freshness and exports before accepting a refresh
```

For paid access with Node 24, store `COINGECKO_PRO_API_KEY` in a private environment file outside the served repository root and run:

```bash
node --env-file=/path/outside-webroot/coingecko.env pipeline/run.mjs
```

The paid key takes priority over `COINGECKO_DEMO_KEY` and routes market and pool calls through `pro-api.coingecko.com` (`/api/v3` and `/api/v3/onchain`). Both share a starting pace of 240 requests/minute; pool requests have concurrency six. Rate-limit responses slow the shared host queue. Without a paid key, the optional demo key applies only to market requests; pool requests use public GeckoTerminal without CoinGecko headers, at 3.3-second intervals and concurrency one. The public crawl can take several hours; the September 10 paid cold-cache benchmark completed in 7 minutes 57 seconds.

The run writes `logs/refresh-metrics.json` at the repository root, outside this `data/` directory. It contains stage durations, run status, provider tier and host-level HTTP counts, including cache hits, retries and response statuses; HTTP counters contain no credentials or headers. This report is included in the workflow's recovery artifact and is not a published dashboard data file.

Partial refresh flags are rejected before fetching: mixing fresh totals/caps with old chain history is not a validated refresh. Use individual modules for maintenance in an isolated data directory. `DUNE_API_KEY` is currently unused. See `../ARCHITECTURE.md` for the implemented methodology and limitations. The GitHub workflow requires the `COINGECKO_PRO_API_KEY` Actions repository secret; a Vercel environment variable alone is insufficient.

GitHub Actions schedules a refresh daily at 14:00 UTC (19:30 IST), restored after the successful [September 10 end-to-end test](https://github.com/Nemesisdottrade/onchain-analytics/actions/runs/34492452948), whose pipeline took 7 minutes 26 seconds. Manual dispatch remains available with an optional `not_before_utc` start time; this delay does not apply to scheduled runs. Successful publication triggers the connected Vercel deployment.

The refresh workflow saves compatible raw-response caches and a seven-day recovery artifact containing `data/` and logs. An unsuccessful run can leave old exports next to partial fresh raw data; its artifact is evidence for investigation, not an accepted refresh. Reuse cached responses only through the pipeline's expiry/source checks, then run the validator before accepting regenerated output. `node pipeline/validate.mjs --exports-only` checks an exported bundle without requiring raw responses. Local commands do not publish or change Git history.

For late revisions within the same date window, `node pipeline/reanchor.mjs /path/to/new-candidate-directory` fetches fresh DefiLlama totals and builds a separate candidate with updated buckets, KPIs, CSV and snapshot. It preserves the original `generated_at` and `classified_with`, and records `reference_refreshed_at` separately. It does not fetch new pool history or caps, rejects a changed date window, and never replaces the published dataset automatically. Validate the candidate before copying its generated files into `data/`; use the full pipeline for a new trading day.
