# Onchain spot volume by token market cap

Daily DEX spot volume for Ethereum, Solana, Robinhood Chain, Base, BNB Chain, Arbitrum and HyperEVM, with an estimated market-cap split and the 30-day change. GitHub Actions schedules a refresh daily at 14:00 UTC (19:30 IST); publication depends on successful fetching and validation.

- `index.html` — the dashboard (single static page, no build step). Reads `data/latest.json`.
- `data/` — outputs published after a successful refresh. See `data/README.md`. `data/snapshot.html` is the same dashboard with the data inlined: it opens from a file or an email attachment, no hosting needed.
- `pipeline/` — zero-dependency Node 24 scripts that produce the data. See `ARCHITECTURE.md`.
- `.github/workflows/refresh.yml` — the daily refresh workflow, also available through manual dispatch with an optional delayed start.

## Run locally

```bash
node pipeline/run.mjs          # full refresh using the current environment
node pipeline/validate.mjs     # check generated data and source freshness before accepting it
python3 -m http.server 8787    # then open http://127.0.0.1:8787/
```

For paid CoinGecko access, use Node 24 and keep `COINGECKO_PRO_API_KEY` in a private environment file **outside the served repository root**:

```bash
node --env-file=/path/outside-webroot/coingecko.env pipeline/run.mjs
```

`COINGECKO_PRO_API_KEY` takes priority over the optional `COINGECKO_DEMO_KEY`. Paid market requests use `https://pro-api.coingecko.com/api/v3`; pool, token and OHLCV requests use its `/onchain` endpoints. They share a starting pace of 240 requests/minute per host, with up to six concurrent pool requests and slower pacing after rate-limit responses. With no paid key, market requests use the demo key when supplied or public access otherwise, and pool requests use public GeckoTerminal with no CoinGecko credentials. The public pool crawl can take several hours; the September 10 paid benchmark completed in 7 minutes 57 seconds with empty local API caches; see [the benchmark report](docs/paid-refresh-benchmark-2026-09-10.md).

`logs/refresh-metrics.json` records stage durations, run status and provider tier, plus HTTP counts by host: requests, cache hits, response statuses, retries, network errors and timeouts. Its HTTP counters contain no credentials or request headers. `node pipeline/classify.mjs` re-aggregates from cache without network calls. The Dune SQL is a draft and `DUNE_API_KEY` is not used by the pipeline.

## Deploy and test the refresh

1. Merge the pipeline and workflow to `main`. Keep the existing generated dataset when testing that the workflow itself produces and publishes fresh data.
2. Add `COINGECKO_PRO_API_KEY` under repository Settings → Secrets and variables → Actions. `refresh-volume-data` runs on `main` daily at 14:00 UTC (19:30 IST), and can also be dispatched manually. For manual dispatch only, the optional `not_before_utc` input sets an earliest refresh time in ISO UTC, at most 20 minutes ahead; a late runner starts immediately. Scheduled runs have no added delay. The workflow requires the paid secret and fails before fetching if it is missing. It pins one UTC date window, restores compatible raw responses, fetches and validates all chains, then publishes only generated data.
3. Host the static site from the repo root so every data commit redeploys it:
   - **Vercel**: import the GitHub repo, framework "Other", no build command, output directory `.`.
   - **GitHub Pages**: Settings → Pages → Deploy from branch `main`, folder `/`.
4. Check the Actions result, generated data commit, Vercel deployment and live `data/latest.json` timestamp. A scheduled trigger alone does not mean the dashboard updated. An open browser tab reloads data only on page load.

A CoinGecko key configured only in Vercel does not reach GitHub Actions. Vercel hosts the static dashboard; the collector runs on the GitHub runner. Daily scheduling was restored after the [September 10 end-to-end test](https://github.com/Nemesisdottrade/onchain-analytics/actions/runs/34492452948) successfully refreshed and published data to Vercel; its pipeline took 7 minutes 26 seconds.

The pipeline step has a 325-minute limit inside a 360-minute job, leaving time for recovery files and publication. Raw responses are cached under a pipeline-source hash and a unique run key, including after a failed crawl. Cache expiry and source checks still apply when reusing them. Every attempted run uploads a seven-day `volume-refresh-<run id>-<attempt>` artifact containing `data/` and its log, when the runner remains available. A failed-run artifact may contain old exports beside partial new raw data; validate it before use. A runner loss or exhausted job timeout can still prevent upload.

If `main` changes during a crawl, publication rebuilds from the latest head, preserves its UI and documentation, and regenerates the snapshot with its current assets. It retries a normal push at most three times. Pipeline-source changes, newer published data, invalid exports, or an unchanged-head push rejection stop publication for review. The helper is restricted to the main-branch GitHub Actions workflow; local refresh commands do not commit or publish anything.

## Brand

The dashboard uses Nemesis's official logo, Cerebri Sans Pro and the ivory, orange and navy colors from [nemesis.trade](https://nemesis.trade/). Tokens live in the first `<style>` block of `index.html`; asset sources are documented in `assets/brand/README.md`. The secondary chart colors are dashboard adaptations. Run `node pipeline/snapshot.mjs` after a frontend change to update the standalone snapshot, including its embedded fonts.
