# Onchain spot volume by token market cap

Daily DEX spot volume for Ethereum, Solana, Robinhood Chain, Base, BNB Chain, Arbitrum and HyperEVM, split by whether the traded token's market cap is above or below $100M, with the 30-day change. Refreshes once a day.

- `index.html` — the dashboard (single static page, no build step). Reads `data/latest.json`.
- `data/` — outputs of the pipeline, committed daily. See `data/README.md`. `data/snapshot.html` is the same dashboard with the data inlined: it opens from a file or an email attachment, no hosting needed.
- `pipeline/` — zero-dependency Node 24 scripts that produce the data. See `ARCHITECTURE.md`.
- `.github/workflows/refresh.yml` — the 24-hour refresh (14:00 UTC).

## Run locally

```bash
node pipeline/run.mjs          # full refresh, ~2 h (GeckoTerminal is rate-limited)
python3 -m http.server 8787    # then open http://127.0.0.1:8787/
```

`node pipeline/classify.mjs` re-aggregates from cache without network calls. Optional env: `COINGECKO_DEMO_KEY`. The Dune SQL is a draft and `DUNE_API_KEY` is not used by the pipeline.

## Deploy and refresh (24 h)

1. Merge to `main`. Scheduled GitHub Actions workflows only run on the default branch.
2. The workflow runs the pipeline daily at 14:00 UTC and commits `data/`. Add `COINGECKO_DEMO_KEY` as a repository secret for a more reliable run (optional).
3. Host the static site from the repo root so every data commit redeploys it:
   - **Vercel** (works for this private repo): import the GitHub repo, framework "Other", no build command, output directory `.`.
   - **GitHub Pages** (repo must be public on the org's free plan): Settings → Pages → Deploy from branch `main`, folder `/`.
4. Actions minutes: a full run takes about 2 hours, ~60 hours a month. On a private repo that exceeds the free 2,000 minutes; either make the repo public (the data is public anyway), accept the small overage, or run the same command from a cron box:

```bash
0 14 * * * cd /path/to/nemesis-analytics && node pipeline/run.mjs && git add data && git commit -m "data: refresh" && git push
```

## Brand

The dashboard uses Nemesis's official logo, Cerebri Sans Pro and the ivory, orange and navy colors from [nemesis.trade](https://nemesis.trade/). Tokens live in the first `<style>` block of `index.html`; asset sources are documented in `assets/brand/README.md`. The secondary chart colors are dashboard adaptations. Run `node pipeline/snapshot.mjs` after a frontend change to update the standalone snapshot, including its embedded fonts.
