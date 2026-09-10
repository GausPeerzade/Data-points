# Paid CoinGecko refresh benchmark — September 10, 2026

The complete local refresh succeeded in **7 minutes 57 seconds** (476.93 seconds wall time), starting with **empty local API caches**. It fetched, classified, validated and exported all seven chains. This is a measured result from one run, not a guarantee for every future run.

The local dashboard now uses the resulting dataset: generated **September 10, 2026 at 14:43:20 UTC**, with **61 daily rows per chain through September 9**. Both 30-day and 60-day chart views were checked in the browser. BNB's September 9 row remains provisional and its summary ends September 8; the other chains' latest complete day is September 9.

## Measured requests

| Provider | Requests | Successful HTTP 200 | Cache hits | Retries / 429s / timeouts |
|---|---:|---:|---:|---:|
| CoinGecko Pro | 1,715 | 1,715 | 0 | 0 |
| DefiLlama | 14 | 14 | 0 | 0 |

The account endpoint confirmed the **Basic** plan, **300 requests/minute** and **100,000 monthly credits**. The client used a shared 240/minute pacing limit with up to six requests in flight. At the same workload once daily, 1,715 CoinGecko requests × 30 runs is approximately **51,450 requests/month**; pool growth, extra runs and other account usage would add to that. This is a request-budget projection, not a billing reconciliation.

## Stage durations

| Stage | Duration |
|---|---:|
| defillama | 11.939 s |
| coingecko | 4.765 s |
| geckoterminal | 447.494 s |
| enrich | 0.949 s |
| final defillama totals | 11.346 s |
| classify | 0.111 s |
| validate | 0.054 s |
| snapshot | 0.009 s |

## Implementation and validation

- Shared paid configuration routes market, pool, token and history requests to CoinGecko Pro with header authentication. Demo/public access remains available when no paid key is configured.
- Pool lookups run concurrently under one host pacing queue. Results merge in input order; errors stop new work and drain active requests before reporting failure.
- Existing market-cap classification rules are unchanged. Paid access improves collection performance; it does not make the sampled market-cap split exact.
- Validation passed for all **427 daily rows**: source/date consistency, reference totals, bucket arithmetic, raw sample totals, CSV parity and KPI periods.
- All **67 automated tests** passed, including paid authentication, concurrency ordering, failure draining, cache recovery, date windows and publication-race simulations.
- Fresh staging was used, and every chain index plus the cap snapshot records the Pro provider. The HTTP report contains only Pro CoinGecko and DefiLlama hosts.
- Candidate data and logs passed a scan for the real credential before acceptance. The key is stored in private local configuration outside the served site directory.
- Previous local exports were backed up before replacement. Nothing was committed, pushed, configured as a remote secret, or deployed to Vercel.

## Evidence

- [Run metrics](../logs/refresh-metrics.json)
- [Timed run status](../logs/benchmark-status.json)
- [Collection log](../logs/paid-refresh.log)
- [Accepted local dataset status and backup location](../logs/local-paid-refresh.json)
- [Generated dataset](../data/latest.json)
- [Daily CSV](../data/volume_daily.csv)

To enable the deployed daily refresh later, configure `COINGECKO_PRO_API_KEY` as a GitHub Actions repository secret and deploy the locally prepared workflow/code changes. A successful local benchmark does not verify the remote scheduler or Vercel publication path.
