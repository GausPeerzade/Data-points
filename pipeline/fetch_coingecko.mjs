// CoinGecko: market-cap snapshot (top ~1000 coins + all stablecoins) and contract addresses per chain.
import { getJson, writeJson, utcMidnight, dateStr } from './lib/http.mjs';
import { coinGeckoConfig } from './lib/coingecko.mjs';
import { CHAINS, THRESHOLD_USD, normAddr } from './config.mjs';

export async function main(env = process.env) {
  const provider = coinGeckoConfig(env);
  const base = provider.baseUrl;
  const today = dateStr(utcMidnight(Date.now()));
  const dir = `data/raw/coingecko/${today}`;
  const o = { ...provider.marketOptions, ttlMs: 20 * 3600e3, label: 'coingecko' };

  const markets = [];
  for (let p = 1; p <= 4; p++) {
    const rows = await getJson(`${base}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&sparkline=false`, { ...o, cacheFile: `${dir}/markets_p${p}.json` });
    markets.push(...rows);
    console.log(`coingecko markets page ${p}: ${rows.length} rows, last mcap ${rows.at(-1)?.market_cap}`);
  }
  const stables = await getJson(`${base}/coins/markets?vs_currency=usd&category=stablecoins&order=market_cap_desc&per_page=250&page=1&sparkline=false`, { ...o, cacheFile: `${dir}/stablecoins.json` });
  const list = await getJson(`${base}/coins/list?include_platform=true`, { ...o, cacheFile: `${dir}/coins_list.json` });

  const coins = {};
  const add = (r) => { coins[r.id] = { symbol: r.symbol, name: r.name, market_cap: r.market_cap ?? 0, fdv: r.fully_diluted_valuation ?? null, rank: r.market_cap_rank ?? null }; };
  for (const r of markets) add(r);
  for (const r of stables) if (!coins[r.id]) add(r);
  const stableIds = stables.filter((s) => (s.market_cap || 0) >= THRESHOLD_USD).map((s) => s.id);

  const addresses = Object.fromEntries(CHAINS.map((c) => [c.key, {}]));
  let n = 0;
  for (const coin of list) {
    for (const c of CHAINS) {
      const a = coin.platforms?.[c.cg];
      if (a) { addresses[c.key][normAddr(c, a)] = coin.id; n++; }
    }
  }
  const above = Object.values(coins).filter((x) => x.market_cap >= THRESHOLD_USD).length;
  const fetchedAt = new Date().toISOString();
  const snap = { snapshot_date: fetchedAt.slice(0, 10), fetched_at: fetchedAt, threshold_usd: THRESHOLD_USD, keyed: provider.tier !== 'public', provider_tier: provider.tier,
    counts: { coins_with_cap: Object.keys(coins).length, coins_above_threshold: above, stables_above_threshold: stableIds.length, listed_coins: list.length, addresses_mapped: n },
    stable_ids: stableIds, coins, addresses };
  writeJson('data/mcap_snapshot.json', snap);
  console.log(`coingecko snapshot ${today}: ${Object.keys(coins).length} coins with caps, ${above} >= $100M, ${stableIds.length} stables >= $100M, ${n} addresses across 7 chains`);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
