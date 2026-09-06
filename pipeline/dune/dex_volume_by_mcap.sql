-- Exact mode (requires a Dune API key / paid plan). DuneSQL (Trino).
-- DEX spot volume per chain and UTC day, split by the market cap of the trade's subject token.
-- Rule (ARCHITECTURE.md §3.2): quote set Q = stablecoins >= $100M + native/wrapped/LST assets.
--   both legs in Q            -> above_100m
--   exactly one non-Q leg     -> bucket of that leg's market cap
--   two non-Q legs            -> bucket of the LOWER market cap
--   non-Q leg with no cap     -> unknown (reported separately; dashboard folds it into below)
-- Requires an uploaded table dune.<team>.dataset_token_mcap(blockchain, token_address, market_cap_usd, is_quote)
-- generated from data/mcap_snapshot.json (one row per chain address; Solana mints as base58, EVM as 0x-hex lowercase).
WITH mcap AS (
  SELECT blockchain,
         CASE WHEN blockchain <> 'solana' THEN from_hex(regexp_replace(lower(token_address), '^0x', '')) END AS evm_addr,
         CASE WHEN blockchain = 'solana' THEN token_address END AS sol_mint,
         CAST(market_cap_usd AS double) AS market_cap_usd,
         CAST(is_quote AS boolean) AS is_quote
  FROM dune.<team>.dataset_token_mcap
),
evm AS (
  SELECT t.blockchain, t.block_date, t.amount_usd,
         mb.is_quote AS bq, ms.is_quote AS sq, mb.market_cap_usd AS bcap, ms.market_cap_usd AS scap
  FROM dex.trades t
  LEFT JOIN mcap mb ON mb.blockchain = t.blockchain AND mb.evm_addr = t.token_bought_address
  LEFT JOIN mcap ms ON ms.blockchain = t.blockchain AND ms.evm_addr = t.token_sold_address
  WHERE t.blockchain IN ('ethereum','base','bnb','arbitrum','hyperevm','robinhood')
    AND t.block_month >= date_trunc('month', date_add('day', -61, current_date))
    AND t.block_date >= date_add('day', -61, current_date) AND t.block_date < current_date
),
sol AS (
  SELECT 'solana' AS blockchain, t.block_date, t.amount_usd,
         mb.is_quote AS bq, ms.is_quote AS sq, mb.market_cap_usd AS bcap, ms.market_cap_usd AS scap
  FROM dex_solana.trades t
  LEFT JOIN mcap mb ON mb.blockchain = 'solana' AND mb.sol_mint = t.token_bought_mint_address
  LEFT JOIN mcap ms ON ms.blockchain = 'solana' AND ms.sol_mint = t.token_sold_mint_address
  WHERE t.block_month >= date_trunc('month', date_add('day', -61, current_date))
    AND t.block_date >= date_add('day', -61, current_date) AND t.block_date < current_date
),
classified AS (
  SELECT blockchain, block_date, amount_usd,
    CASE
      WHEN coalesce(bq,false) AND coalesce(sq,false) THEN 'above_100m'
      WHEN coalesce(bq,false) THEN CASE WHEN scap IS NULL THEN 'unknown' WHEN scap >= 1e8 THEN 'above_100m' ELSE 'below_100m' END
      WHEN coalesce(sq,false) THEN CASE WHEN bcap IS NULL THEN 'unknown' WHEN bcap >= 1e8 THEN 'above_100m' ELSE 'below_100m' END
      WHEN bcap IS NULL OR scap IS NULL THEN 'unknown'
      WHEN least(bcap, scap) >= 1e8 THEN 'above_100m' ELSE 'below_100m'
    END AS bucket
  FROM (SELECT * FROM evm UNION ALL SELECT * FROM sol)
)
SELECT blockchain, block_date,
       sum(CASE WHEN bucket = 'above_100m' THEN amount_usd END) AS above_100m,
       sum(CASE WHEN bucket = 'below_100m' THEN amount_usd END) AS below_100m,
       sum(CASE WHEN bucket = 'unknown'    THEN amount_usd END) AS unknown_mcap,
       sum(amount_usd)                                          AS total,
       count(*)                                                 AS trades,
       count_if(amount_usd IS NULL)                             AS trades_unpriced
FROM classified
GROUP BY 1, 2
ORDER BY 1, 2;
