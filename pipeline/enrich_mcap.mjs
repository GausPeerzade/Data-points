// After the GeckoTerminal crawl: fetch market caps for CoinGecko-listed tokens seen in pools that fell outside
// the ranked top-1000 pull (e.g. bridged assets such as USDT0 that CoinGecko does not rank). Batches of 250 ids.
import fs from 'node:fs';
import { getJson, readJson, writeJson, safeName } from './lib/http.mjs';
import { CHAINS, MANUAL_ADDRESSES } from './config.mjs';

export async function main() {
  const snap = readJson('data/mcap_snapshot.json');
  const KEY = process.env.COINGECKO_DEMO_KEY;
  const o = { headers: KEY ? { 'x-cg-demo-api-key': KEY } : {}, minIntervalMs: KEY ? 700 : 21000, label: 'coingecko' };
  const need = new Set();
  for (const c of CHAINS) {
    const idx = readJson(`data/raw/geckoterminal/${c.key}/pools_index.json`);
    if (!idx) continue;
    const addrMap = { ...snap.addresses[c.key], ...(MANUAL_ADDRESSES[c.key] || {}) };
    for (const p of idx.pools) {
      if (!p.days) continue;
      const m = readJson(`data/raw/geckoterminal/${c.key}/ohlcv/${safeName(p.address)}.json`)?.meta;
      for (const a of [p.base, p.quote]) {
        const k = c.evm ? String(a).toLowerCase() : a;
        let id = addrMap[k];
        if (!id && m) for (const side of ['base', 'quote']) if (m[side]?.address && (c.evm ? m[side].address.toLowerCase() : m[side].address) === k) id = m[side].coingecko_coin_id;
        if (id && !snap.coins[id]) need.add(id);
      }
    }
  }
  const ids = [...need];
  console.log(`enrich: ${ids.length} CoinGecko ids seen in pools but missing from the ranked snapshot`);
  const dir = `data/raw/coingecko/${snap.snapshot_date}`;
  let added = 0;
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const rows = await getJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(batch.join(','))}&per_page=250&page=1&sparkline=false`,
      { ...o, cacheFile: `${dir}/ids_batch_${i / 250}.json`, ttlMs: 20 * 3600e3 });
    for (const r of rows || []) {
      snap.coins[r.id] = { symbol: r.symbol, name: r.name, market_cap: r.market_cap ?? 0, fdv: r.fully_diluted_valuation ?? null, rank: r.market_cap_rank ?? null, source: 'ids_lookup' };
      added++;
    }
  }
  snap.counts.enriched = (snap.counts.enriched || 0) + added;
  writeJson('data/mcap_snapshot.json', snap);
  console.log(`enrich: added caps for ${added} coins (e.g. ${ids.slice(0, 8).join(', ')})`);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
