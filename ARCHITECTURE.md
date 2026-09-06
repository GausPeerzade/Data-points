# Onchain Spot Volume by Market Cap — Architecture

Status: v1 (2026-09-05). Owner: Gaus. Reviewer: Jazear.
Deadline: all-hands Monday 2026-09-07.

## 1. What we are building

A small, self-refreshing dashboard that shows, for each of seven chains, the last 30 days of onchain **DEX spot trading volume** per UTC day, split into:

| Series | Definition |
|---|---|
| `above_100m` | volume of trades whose subject token has market cap ≥ $100M |
| `below_100m` | volume of trades whose subject token has market cap < $100M |
| `total` | `above_100m + below_100m` (exact by construction) |

plus the **30-day change** for each series, rendered as a stacked bar chart (one bar per day) per chain. Data refreshes every 24 hours.

Chains: Ethereum, Solana, Robinhood Chain, Base, BNB Chain, Arbitrum, HyperEVM.

Work is staged as the task suggests:

1. **Step 1 (this doc + data):** architecture, then a reproducible pipeline that produces the daily numbers for all seven chains.
2. **Step 2:** the dashboard front end on brand guidelines.
3. **Step 3:** scheduled 24-hour refresh and hosting.

## 2. Source research summary (verified 2026-09-04 with live calls)

Every candidate source was called live. The important results:

| Source | Gives | Auth | Verdict |
|---|---|---|---|
| **DefiLlama** `api.llama.fi/overview/dexs/{chain}` | Daily per-chain DEX volume, per-protocol breakdown, 60+ days, UTC day buckets | None | **Primary source for `total`.** Industry reference; anyone can cross-check on defillama.com. No per-token dimension. |
| **CoinGecko** `api.coingecko.com/api/v3` | Market cap per coin, contract addresses per chain, daily historical market caps | Keyless works but 429s after ~4 burst calls. Free Demo key (signup only, no card): 100 calls/min | **Primary source for market-cap classification.** ~274 coins are ≥ $100M today, so 3 pages cover the whole whitelist. |
| **GeckoTerminal** `api.geckoterminal.com/api/v2` | Per-pool daily OHLCV with USD volume (60+ days), top-200 pools per network, per-token pool lists, token market caps | None, ~30 calls/min, page cap 10 | **Keyless source for the split** (pool-level, sampled). Returns HTTP 429 with an empty body when throttled. |
| **Dune** `dex.trades` + `dex_solana.trades` | Trade-level volume for all 7 chains (`ethereum, solana, base, bnb, arbitrum, hyperevm, robinhood`) | API key. **No free tier any more**: 14-day trial (2,500 credits) then view-only; legacy free accounts go view-only on 2026-09-10. Analyst plan $75/mo | **Only exact source for the split.** No market-cap table on Dune; classification list must be uploaded (public CSV) or inlined. Dune Sim API is shut down. |
| DexScreener | Current pair stats | None | No historical daily volume. Not usable for a 30-day series. |
| Birdeye, Bitquery, Codex, Allium, Flipside | Trade-level | Keys / paid | Not needed if Dune is approved; Bitquery free dev plan is the fallback if Dune is rejected. |

Chain identifiers (all verified):

| Chain | DefiLlama slug | CoinGecko platform | GeckoTerminal network | Dune `blockchain` |
|---|---|---|---|---|
| Ethereum | `Ethereum` | `ethereum` | `eth` | `ethereum` |
| Solana | `Solana` | `solana` | `solana` | `solana` (table `dex_solana.trades`) |
| Base | `Base` | `base` | `base` | `base` |
| BNB Chain | `BSC` | `binance-smart-chain` | `bsc` | `bnb` |
| Arbitrum | `Arbitrum` | `arbitrum-one` | `arbitrum` | `arbitrum` |
| HyperEVM | `Hyperliquid L1` (shared with HyperCore, see §4.2) | `hyperevm` (chain id 999) | `hyperevm` | `hyperevm` |
| Robinhood Chain | `Robinhood Chain` | `robinhood` (chain id 4663) | `robinhood` | `robinhood` |

Robinhood Chain facts: mainnet live since 2026-07-01, chain id 4663, Arbitrum Orbit L2, permissionless. It is the 5th largest of the seven by 30-day DEX volume (~$21.7B trailing 30d on DefiLlama), dominated by Uniswap v4/v3; one USDG/WETH Uniswap v3 pool carries roughly 40 to 55% of daily volume, and a 90-day free-gas subsidy ends late September 2026. Counterfeit stock-token contracts exist, so any stock-token breakdown must use the official registry at `api.robinhood.com/rhj/assets`.

## 3. Design

### 3.1 Two modes, one output schema

The split has an exact path and a keyless path. Both write the same output file so the dashboard does not care which produced a row.

```
                 ┌───────────────┐
  DefiLlama ───► │ total per day │──────────────────────────────┐
                 └───────────────┘                              │
                                                                ▼
  CoinGecko ───► whitelist of tokens ≥ $100M + addresses   ┌──────────────┐     ┌───────────┐
                        │                                  │  classify +  │────►│ data/     │────► dashboard
                        ▼                                  │  aggregate   │     │ latest.json│
  GeckoTerminal ─► pool daily volumes (keyless, sampled) ─►│              │     └───────────┘
        or                                                 │  mode =      │
  Dune dex.trades ─► trade daily volumes (exact, key) ────►│ estimate|exact│
                                                           └──────────────┘
```

- **Mode `exact` (Dune).** One DuneSQL query over `dex.trades` (6 EVM chains) and `dex_solana.trades`, joined to an uploaded market-cap table, grouped by chain and day. `total` is the sum of classified trades; the DefiLlama total is shown alongside as a reconciliation line. Requires `DUNE_API_KEY` and a paid plan or trial (§6).
- **Mode `estimate` (keyless).** `total` comes from DefiLlama. The split ratio comes from GeckoTerminal pool-level daily volumes for (a) the top 200 pools per chain by 24h volume and (b) every pool of every whitelist token on that chain. `above_100m` is measured directly from those pools, `below_100m = total − above_100m` (the unsampled long tail is assigned to below). If sampled volume exceeds the DefiLlama total for a day (GeckoTerminal counts some pools DefiLlama's adapters skip), the proportional split `total × sampled_above / sampled_total` is used instead. Coverage (`sampled_total / total`), the unknown-token share and a per-venue reconciliation against DefiLlama's protocol breakdown are stored and surfaced on the dashboard. This is an estimate and is labelled as such.

The pipeline runs `exact` when a Dune key is present and falls back to `estimate` otherwise. Rows record their `mode`.

### 3.2 Classification rule (the part that must be agreed)

Every swap has two legs, so per-token volume double counts. We classify at the **pair (pool) level** so each trade is counted once:

1. Define a per-chain **quote set Q**: stablecoins with global market cap ≥ $100M (USDC, USDT, USDT0, DAI, USDS, USDe, USD1, FDUSD, PYUSD, USDG, feUSD, USDH …) plus native and wrapped-native assets and their liquid-staking forms (ETH/WETH/stETH/wstETH/weETH/cbETH, SOL/wSOL/jitoSOL/mSOL, BNB/WBNB, HYPE/WHYPE/kHYPE/stHYPE, BTC wrappers WBTC/cbBTC/UBTC).
2. **Subject token** of a pool = the non-Q leg. Bucket = market cap of the subject token.
3. If **both legs are in Q** (WETH/USDC, USDC/USDT, wstETH/WETH): bucket = `above_100m`. Every Q member is ≥ $100M by construction.
4. If **neither leg is in Q** (PEPE/SHIB): bucket = the **lower** market cap of the two. Direction-independent, so a round trip lands in one bucket.
5. Market-cap source order: CoinGecko `market_cap` → CoinGecko `fully_diluted_valuation` if market cap is 0 → GeckoTerminal `market_cap_usd` (verified circulating supply; this is what classifies tokenized stocks, e.g. the NVDA token on Robinhood Chain at ~$15M) → GeckoTerminal `fdv_usd` **only to prove below** (FDV ≥ market cap, so a small FDV is conclusive; a large chain-local FDV is not evidence of ≥ $100M) → unknown. **Unknown = `below_100m`**, and the unknown volume share is reported as a data-quality metric. Any token ≥ $100M is listed on CoinGecko, so unknowns cannot leak upward. In a pair with two non-quote legs, one leg proven < $100M decides "below" even if the other is unknown.
6. Wrapped and bridged representations map to the underlying asset's market cap (WETH → ETH, UBTC → BTC, UETH → ETH, WHYPE → HYPE, wSOL → SOL, USDT0 → USDT). CoinGecko also gives chain-specific bridged listings their own ids without market data (WBTC on Arbitrum, USDC.e, Robinhood's WETH); these are mapped to the underlying by symbol, and native-asset placeholder addresses in Uniswap v4 pools map to the chain's gas token. Without this, UBTC ($49M standalone cap) and UETH ($18M) would be misclassified and ~40% of Arbitrum volume would be unknown.
7. Classification uses **global** market cap, never chain-local FDV. USDC on Solana shows a $7.9B chain-local FDV versus a $74B global market cap.

Day-of versus snapshot: the correct definition is each day classified with that day's market caps. v1 backfills the 60-day history with the current snapshot and flags those rows `classified_with = "snapshot:<date>"`. From then on each nightly run classifies the just-closed day with that day's snapshot and never restates closed days, so the series converges to day-of without extra API calls. A full day-of backfill via CoinGecko `market_chart` (~300 calls) is a one-line switch once a Demo key exists.

### 3.3 What counts as "total"

`total` = DefiLlama's chain DEX total, which is Σ of all protocols on the chain that DefiLlama does not flag `doublecounted` (router aggregators such as Jupiter, 1inch, CoW and bot front-ends such as Photon, GMGN, Axiom are already excluded by DefiLlama; RFQ fill venues Hashflow and 0x RFQ, and launchpad bonding curves such as pump.fun, are included). This is exactly the number on defillama.com, so anyone can verify it.

Two exceptions, both documented in the data:

- **HyperEVM**: DefiLlama has no HyperEVM slug. Chain `Hyperliquid L1` mixes HyperEVM AMMs with the HyperCore native spot orderbook and also includes `Unit` (category Bridge), which is a strict subset of orderbook volume and therefore double counted. We define **HyperEVM = protocols on `Hyperliquid L1` with category `Dexs`, excluding `Hyperliquid Spot Orderbook`**. The orderbook is stored as a separate optional series (`hypercore_spot_orderbook`) because the team may want to see it. On 2026-09-03 that is $166M (HyperEVM AMMs) vs $195M (orderbook).
- The current UTC day is always dropped (partial bucket). Some DefiLlama adapters publish once a day (Solana's PumpSwap, BisonFi, Jupiterz; Robinhood's Uniswap V3), so the most recent closed day can be incomplete at fetch time. The pipeline flags a day **provisional** when protocols that reported on each of the previous 7 days are missing and their 7-day average exceeds 1% of the prior day; provisional days are excluded from KPIs and re-pulled on the next run. The refresh is scheduled at 14:00 UTC for this reason.

### 3.4 30-day change

Computed on closed UTC days only, for `total`, `above_100m` and `below_100m`:

- **Headline:** `change_30d = Σ(last 30 days) / Σ(prior 30 days) − 1`. This matches DefiLlama's `change_30dover30d`, which we store as a cross-check for `total`.
- **Secondary:** `change_30d_point = V(D−1) / V(D−31) − 1` (last day vs the same day a month earlier). Noisier, shown as a small label.

Both require 60 closed days, so the pipeline keeps 61 days of history.

### 3.5 Output schema

`data/latest.json` (dashboard input) and `data/volume_daily.csv` (for anyone who wants a spreadsheet):

```
{
  "generated_at": "2026-09-05T04:10:00Z",
  "threshold_usd": 100000000,
  "chains": {
    "ethereum": {
      "display": "Ethereum",
      "mode": "estimate",
      "days": [
        { "date": "2026-08-05", "total": 1.02e9, "above_100m": 7.9e8, "below_100m": 2.3e8,
          "coverage": 0.91, "unknown_share": 0.03, "classified_with": "snapshot:2026-09-05",
          "defillama_total": 1.02e9 }
      ],
      "kpi": { "total_30d": ..., "change_30d": { "total": 0.237, "above_100m": ..., "below_100m": ... },
               "change_30d_point": {...}, "share_above_30d": 0.78, "defillama_change_30dover30d": 0.2372 }
    },
    "hyperevm": { ..., "extra_series": { "hypercore_spot_orderbook": [...] } }
  },
  "quality": { "per_chain": {...}, "notes": [...] }
}
```

`total` always equals `above_100m + below_100m` to the cent.

## 4. Pipeline (Step 1)

Zero-dependency Node 24 (native `fetch`), plain ESM. No framework, no database; JSON files in git are the store.

```
pipeline/
  config.mjs              chains, slugs, quote sets, wrapper→underlying map, threshold
  lib/http.mjs            fetch with per-host rate limit, retry/backoff on 429/5xx, disk cache
  fetch_defillama.mjs     → data/raw/defillama/<chain>.json   (totals + category breakdown, 61 days)
  fetch_coingecko.mjs     → data/raw/coingecko/mcap_<date>.json (whitelist ≥$100M + addresses per platform)
  fetch_geckoterminal.mjs → data/raw/geckoterminal/<chain>/pools_index.json, ohlcv/<pool>.json, token_caps.json
  enrich_mcap.mjs         caps for CoinGecko-listed tokens outside the ranked top-1000 (USDT0, WHYPE, bridged assets)
  classify.mjs            pool bucket assignment + daily aggregation + KPIs → data/latest.json, data/volume_daily.csv, data/audit/
  reconcile.mjs           per-venue GeckoTerminal vs DefiLlama check → data/reconciliation.json
  run.mjs                 runs the above in order; picks mode by presence of DUNE_API_KEY
  dune/dex_volume_by_mcap.sql   exact-mode query (Trino/DuneSQL)
```

Run budget in `estimate` mode: DefiLlama 7 calls; CoinGecko ~8 calls (spaced 21s keyless, or fast with a Demo key); GeckoTerminal ≈ 250 to 350 calls per chain: 10 pool pages, whitelist tokens pre-screened by 24h volume in batches of 30 (only tokens trading ≥ $250k/day get a pool lookup, top 10 pools each), one OHLCV call per pool with 24h volume ≥ $50k (top pools) or ≥ $25k (whitelist pools), plus batched cap lookups. GeckoTerminal's documented 30 calls/min returns HTTP 429 in practice above ~18/min, so a full seven-chain run takes about 2 to 3 hours; the 12-hour raw cache makes same-day re-runs free.

Run budget in `exact` mode: 1 Dune execution per day (incremental, last 3 days only, partition-pruned on `block_month`) plus one result fetch. The 60-day backfill is a single heavier execution.

Data-quality outputs per chain-day: `coverage`, `unknown_share`, `pools_sampled`, `defillama_total`, `boundary_share` (volume of tokens with cap between $50M and $200M, i.e. sensitivity to the threshold), and for Dune mode `trades_unpriced`.

## 5. Dashboard (Step 2) and refresh (Step 3)

- **Front end:** one static `index.html` at the repo root (hand-rolled SVG, no framework, no build), reading `data/latest.json`. Chain tabs, 30/60-day range, stacked columns (`below_100m` on top of `above_100m`, 2px surface gap, rounded data-end), selective direct label on the last complete day, per-bar hover tooltip, legend, table view, KPI tiles (30d total, ≥ and < $100M volume with change vs prior 30d, point-to-point change, split confidence), a data-quality strip, an all-chains overview table and a methodology note. Provisional days render faded. HyperEVM has a toggle overlaying the HyperCore orderbook as a line on the same axis. Chart colours are the validated categorical pair (blue ≥ $100M, orange < $100M) in selected light and dark steps; brand font, accent, wordmark and radius are CSS variables in the first style block.
- **Hosting:** static, from the repo root. The repo is private on the Nemesisdottrade org, so GitHub Pages needs the repo to be public; Vercel's free tier serves a private repo with no build step. Either redeploys on every data commit. No server.
- **Refresh:** GitHub Actions cron at 14:00 UTC daily (`.github/workflows/refresh.yml`): run `node pipeline/run.mjs`, commit `data/`, the host redeploys. 14:00 UTC is after DefiLlama's once-a-day adapters publish the closed day; provisional-day detection covers the rest. Scheduled workflows only run on the default branch, so the work must be merged to `main`. Secrets (`COINGECKO_DEMO_KEY`, optionally `DUNE_API_KEY`) live in repo secrets. A run is ~2 hours, ~60 hours a month, above the 2,000 free minutes of a private repo: make the repo public, accept the overage, or run the same command from cron on any machine.

## 6. Decisions needed from the team

1. **Exact split requires Dune (paid).** Free execution ends 2026-09-10; the Analyst plan is $75/month, or the 14-day trial can cover Monday. Without it the split is a labelled estimate (§3.1). Recommendation: approve Analyst for the duration of this dashboard.
2. **HyperEVM definition.** Default is HyperEVM AMMs only, with the HyperCore spot orderbook as an optional overlay (§3.3). Confirm or flip.
3. **Classification rule.** Confirm §3.2 (min-cap of non-quote legs; stable/native pairs count as ≥ $100M; unknown counts as < $100M).
4. **CoinGecko Demo key.** Free signup, no card, 2 minutes. Needed for a reliable nightly job and for day-of classification backfill. Keyless works for the first pull with 20-second spacing.
5. **Brand guidelines.** Not on disk anywhere in the Nemesis folders. Need the file or Figma link from Jazear for Step 2.

## 7. Known limitations (to state on the dashboard)

- Estimate mode: `above_100m` is a lower bound and `below_100m` an upper bound where coverage < 100%. GeckoTerminal and DefiLlama use different indexers, so pool-level sums may not reconcile exactly to DefiLlama's total; the coverage metric makes this visible per day.
- Neither DefiLlama nor Dune filter wash trading. Solana memecoin volume includes it. We do not filter either, so `total` stays reconcilable with the public reference.
- Market caps near $100M flip day to day; the `boundary_share` metric quantifies how much volume sits within 2x of the threshold.
- Dune under-decodes HyperEVM (no Kittenswap, Gliquid, Laminar, LiquidCore) and Robinhood Chain (no Pons, Fables, Ekubo, Curve): roughly 10 to 18% of those chains' DefiLlama volume. In exact mode this appears as a gap versus the DefiLlama line.
- Robinhood Chain volume is subsidy-era (free gas until late September 2026) and concentrated in one USDG/WETH pool. Its estimate is the weakest: GeckoTerminal does not index the Pons launchpad bonding curve (~$85M/day) and labels Uniswap v3/v4 pools differently from DefiLlama, so 30-day coverage is ~56% and the residual is assigned to below.
- DefiLlama's Uniswap adapters (subgraph-based) skip pools whose tokens are not price-tracked, e.g. a $100M/day BSW/USAD pool on Uniswap v4 Base. GeckoTerminal counts them, which is why GeckoTerminal can exceed DefiLlama on those venues; those pools are unlisted small caps and land in below/unknown either way.
- GeckoTerminal's top-200 pool list reflects today's ranking, so coverage decays for days further back (pools that were active a month ago and have since died are not sampled). Coverage is reported per day.

## 8. Step 1 results (run of 2026-09-05, estimate mode, window 2026-08-06 to 2026-09-04)

| Chain | 30d volume | Share ≥ $100M | 30d change total | ≥ $100M | < $100M | Coverage | Unknown | DefiLlama match | Last complete day |
|---|---|---|---|---|---|---|---|---|---|
| Ethereum | $36.45B | 73% | +26.4% | +19.3% | +51.1% | 78% | 3.4% | yes | 2026-09-04 |
| Solana | $65.12B | 26% | +35.1% | +56.6% | +28.8% | 33% | 0.0% | yes | 2026-09-04 |
| Base | $24.41B | 68% | +12.7% | +7.7% | +25.4% | 96% | 1.2% | yes | 2026-09-04 |
| BNB Chain | $33.11B | 42% | +29.0% | +30.4% | +28.0% | 101% | 3.8% | yes | 2026-09-04 |
| Arbitrum | $5.53B | 83% | +24.1% | +29.9% | +1.7% | 86% | 0.1% | yes | 2026-09-04 |
| HyperEVM | $4.35B | 84% | +73.0% | +70.0% | +91.1% | 87% | 0.0% | n/a (filtered) | 2026-09-04 |
| Robinhood Chain | $21.72B | 43% | +41.1% | +109.1% | +13.3% | 56% | 0.0% | yes | 2026-09-03 |

- "30d change" is trailing 30 complete days vs the prior 30 (§3.4). "DefiLlama match" = our 30d-over-30d total change equals DefiLlama's published `change_30dover30d` to 4 decimals when computed on its window (HyperEVM is filtered, so not comparable).
- "Coverage" = GeckoTerminal-sampled pool volume ÷ DefiLlama total over the last 30 complete days. "Unknown" = sampled volume whose subject token has no verifiable market cap (counted as < $100M).
- Per-venue reconciliation (`data/reconciliation.json`, last 7 days): the main venues agree within ~10% on Ethereum (Uniswap V3 0.97, V4 0.93, Fluid 0.98, Ekubo 0.99), Arbitrum (0.88–1.11), HyperEVM (Project X 0.99, nest 0.96) and Base (Uniswap V3 1.12, PancakeSwap 0.96). Known divergences: DefiLlama's subgraph-based Uniswap/PancakeSwap adapters skip pools of untracked tokens (Uniswap v4 Base, PancakeSwap on BNB run 1.4–4× higher on GeckoTerminal because of unlisted-token pools, which land in below/unknown either way); GeckoTerminal does not index Solana's long tail (PumpSwap 0.63, Raydium 0.50) or Robinhood's Pons launchpad (0.08).
- Confidence by chain: **high** for Base, BNB, Arbitrum, HyperEVM (coverage ≥ 86%); **medium** for Ethereum (78%); **low** for Solana (33%) and Robinhood Chain (56%), where the unsampled residual is assigned to < $100M by assumption. Those two are the chains where exact mode (Dune) changes the picture most.
- Provisional days at 14:25 UTC on 2026-09-05: Robinhood Chain 2026-09-04 (Uniswap V3 not yet published by DefiLlama). Historical gaps flagged as `data_gaps` (e.g. Solana 2026-08-22, HumidiFi and Ready Cards missing on DefiLlama) are DefiLlama's own and are left as published.
