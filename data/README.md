# Data outputs

All numbers are per **closed UTC day** (the current day is never included). Volumes are USD.

| File | What it is | Committed |
|---|---|---|
| `latest.json` | Dashboard input: per chain, 61 days of `total / above_100m / below_100m` plus KPIs and data-quality fields | yes |
| `volume_daily.csv` | Same daily rows as a flat table (`chain,date,total,above_100m,below_100m,coverage,unknown_share,boundary_share,mode,classified_with`) | yes |
| `defillama_totals.json` | Per chain-day totals from DefiLlama, category breakdown, provisional-day flags, DefiLlama's own 30d change for cross-checking | yes |
| `mcap_snapshot.json` | CoinGecko market-cap snapshot used for classification (coins with caps, stablecoin ids, address→coin map for the 7 chains) | yes |
| `audit/pools_<chain>.csv` | Every sampled pool with both legs' CoinGecko ids, the subject token, its cap, the bucket and the reason. This is the evidence trail for the split. | yes |
| `snapshot.html` | The dashboard with `latest.json` inlined (self-contained, opens from a file) | yes |
| `raw/` | Cached API responses (DefiLlama, CoinGecko, GeckoTerminal). Reproducible, so not committed. | no |

## Row fields (`latest.json` → `chains.<key>.days[]`)

- `total` — DefiLlama chain DEX volume for the day (headline definition). HyperEVM = `Dexs`-category protocols on DefiLlama's "Hyperliquid L1" excluding the HyperCore spot orderbook; the orderbook is kept in `extra.hypercore_spot_orderbook`.
- `above_100m` / `below_100m` — the split. Always sums to `total`.
- `mode` — `estimate` (GeckoTerminal pool sampling, see below) or `exact` (Dune trade-level, when a key is configured).
- `coverage` — sampled pool volume ÷ DefiLlama total. Below 1.0 means the long tail was not sampled; the residual is assigned to `below_100m`.
- `unknown_share` — share of sampled volume whose subject token has no CoinGecko market cap (counted as below).
- `boundary_share` — share of sampled volume whose subject token has a cap between $50M and $200M (sensitivity to the threshold).
- `above_100m_proportional` — alternative estimator (`total × sampled_above / sampled_total`), for comparison only.
- `provisional` — true when DefiLlama adapters that report daily had not yet published this day at fetch time (`missing_protocols`, `missing_est`). Provisional days are excluded from KPIs and re-pulled on the next run.
- `classified_with` — which market-cap snapshot classified the row.

KPIs (`chains.<key>.kpi`): `total_30d`, `share_above_30d`, `change_30d` (trailing 30 complete days vs the prior 30, for each series), `change_30d_point` (last complete day vs 30 days earlier), `crosscheck_same_window` (our 30d-over-30d change on DefiLlama's own window vs DefiLlama's published figure; `match` should be true for unfiltered chains).

## Classification rule (short form)

Pool-level, so each trade is counted once. Quote set Q = stablecoins ≥ $100M + native/wrapped/LST assets. Subject token = the non-Q leg; bucket by its market cap. Both legs in Q → above. Neither leg in Q → lower cap of the two. No cap → below (reported in `unknown_share`). Wrapped/bridged tokens use the underlying's cap. Full rationale in `../ARCHITECTURE.md` §3.2.

## Running

```
node pipeline/run.mjs              # full refresh (≈2 h, GeckoTerminal is rate-limited to ~18 calls/min)
node pipeline/run.mjs --skip-gt    # totals + caps only, reuse cached pool history
node pipeline/classify.mjs         # re-aggregate from cache without any network calls
```

Optional env: `COINGECKO_DEMO_KEY` (free; lifts CoinGecko to 100 calls/min), `DUNE_API_KEY` (exact mode, see `pipeline/dune/`).
