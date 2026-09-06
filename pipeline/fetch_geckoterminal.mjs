// GeckoTerminal (keyless, ~18 calls/min sustained): per chain
//   1. top 200 pools by 24h volume (10 pages)
//   2. whitelist tokens (>= $100M cap, non-quote) pre-screened by 24h volume via tokens/multi (30 per call);
//      active ones get their top-10 pools
//   3. daily OHLCV (USD volume) for every sampled pool with meaningful 24h volume
//   4. market cap / FDV for pool tokens that have no CoinGecko cap (tokens/multi, 30 per call)
import { getJson, writeJson, readJson, safeName, utcMidnight } from './lib/http.mjs';
import { CHAINS, DAYS, THRESHOLD_USD, NATIVE_IDS, UNDERLYING, MIN_POOL_VOL_TOP, MIN_POOL_VOL_WHITELIST, TOP_POOL_PAGES, MAX_POOLS_PER_TOKEN, MIN_TOKEN_VOL_WHITELIST } from './config.mjs';

const GT = 'https://api.geckoterminal.com/api/v2';
const o = { minIntervalMs: 3300, ttlMs: 12 * 3600e3, label: 'gt' }; // the documented 30/min triggers 429s in practice
const tokenAddr = (id) => (id ? id.slice(id.indexOf('_') + 1) : null);

function addPool(pools, d, source) {
  const a = d.attributes, r = d.relationships;
  const cur = pools.get(a.address);
  if (cur) { if (!cur.source.includes(source)) cur.source.push(source); return; }
  pools.set(a.address, {
    address: a.address, name: a.name, dex: r?.dex?.data?.id || null,
    base: tokenAddr(r?.base_token?.data?.id), quote: tokenAddr(r?.quote_token?.data?.id),
    h24: Number(a.volume_usd?.h24 || 0), reserve_usd: Number(a.reserve_in_usd || 0),
    gt_market_cap_usd: a.market_cap_usd == null ? null : Number(a.market_cap_usd),
    gt_fdv_usd: a.fdv_usd == null ? null : Number(a.fdv_usd),
    source: [source],
  });
}

async function fetchCaps(c, dir, pools, snap) {
  const norm = (a) => (c.evm ? a.toLowerCase() : a);
  const has = (addr) => { const id = snap.addresses[c.key][norm(addr)]; const coin = id && snap.coins[UNDERLYING[id] || id]; return !!(coin && (coin.market_cap > 0 || coin.fdv > 0)); };
  const need = [...new Set(pools.flatMap((p) => [p.base, p.quote]).filter((a) => a && !has(a)))];
  const caps = readJson(`${dir}/token_caps.json`) || {};
  const todo = need.filter((a) => !caps[norm(a)]);
  for (let i = 0; i < todo.length; i += 30) {
    const batch = todo.slice(i, i + 30);
    const r = await getJson(`${GT}/networks/${c.gt}/tokens/multi/${batch.join(',')}`, { ...o, label: 'gt-caps' });
    for (const d of r?.data || []) {
      const a = d.attributes;
      caps[norm(a.address)] = { symbol: a.symbol, name: a.name, coingecko_coin_id: a.coingecko_coin_id || null,
        market_cap_usd: a.market_cap_usd == null ? null : Number(a.market_cap_usd), fdv_usd: a.fdv_usd == null ? null : Number(a.fdv_usd), h24: Number(a.volume_usd?.h24 || 0) };
    }
    for (const a of batch) if (!caps[norm(a)]) caps[norm(a)] = { missing: true };
  }
  writeJson(`${dir}/token_caps.json`, caps);
  console.log(`gt ${c.key}: caps fetched for ${todo.length} tokens without a CoinGecko cap (${Math.ceil(todo.length / 30)} calls); ${Object.keys(caps).length} cached`);
}

export async function main(only) {
  const snap = readJson('data/mcap_snapshot.json');
  if (!snap) throw new Error('run fetch_coingecko first');
  const stable = new Set(snap.stable_ids);
  const isQ = (id) => stable.has(id) || NATIVE_IDS.has(id) || NATIVE_IDS.has(UNDERLYING[id]);
  const today = utcMidnight(Date.now());
  const order = only ? only.map((k) => CHAINS.find((c) => c.key === k)).filter(Boolean) : CHAINS;

  for (const c of order) {
    const dir = `data/raw/geckoterminal/${c.key}`;
    const t0 = Date.now();
    const pools = new Map();
    for (let p = 1; p <= TOP_POOL_PAGES; p++) {
      const r = await getJson(`${GT}/networks/${c.gt}/pools?page=${p}&sort=h24_volume_usd_desc`, { ...o, cacheFile: `${dir}/top_p${p}.json` });
      if (!r?.data?.length) break;
      for (const d of r.data) addPool(pools, d, 'top');
    }
    const nTop = pools.size;

    const wl = [];
    for (const [addr, id] of Object.entries(snap.addresses[c.key])) {
      const coin = snap.coins[UNDERLYING[id] || id];
      if (coin && coin.market_cap >= THRESHOLD_USD && !isQ(id)) wl.push([addr, id]);
    }
    const tokVol = {};
    for (let i = 0; i < wl.length; i += 30) {
      const batch = wl.slice(i, i + 30).map(([a]) => a);
      const r = await getJson(`${GT}/networks/${c.gt}/tokens/multi/${batch.join(',')}`, { ...o, cacheFile: `${dir}/wl_multi_${i / 30}.json` });
      for (const d of r?.data || []) tokVol[c.evm ? d.attributes.address.toLowerCase() : d.attributes.address] = Number(d.attributes.volume_usd?.h24 || 0);
    }
    const wlActive = wl.filter(([a]) => (tokVol[a] || 0) >= MIN_TOKEN_VOL_WHITELIST);
    console.log(`gt ${c.key}: top pools ${nTop}; whitelist ${wl.length} tokens, ${wlActive.length} with 24h volume >= $${MIN_TOKEN_VOL_WHITELIST / 1000}k`);
    for (const [addr, id] of wlActive) {
      const r = await getJson(`${GT}/networks/${c.gt}/tokens/${addr}/pools?page=1&sort=h24_volume_usd_desc`, { ...o, cacheFile: `${dir}/token_${safeName(addr)}.json` });
      for (const d of (r?.data || []).slice(0, MAX_POOLS_PER_TOKEN)) addPool(pools, d, `wl:${id}`);
    }

    const toFetch = [...pools.values()].filter((p) => p.h24 >= (p.source.includes('top') ? MIN_POOL_VOL_TOP : MIN_POOL_VOL_WHITELIST));
    console.log(`gt ${c.key}: union pools ${pools.size}, fetching ohlcv for ${toFetch.length}`);
    let misaligned = 0, done = 0;
    for (const p of toFetch) {
      const r = await getJson(`${GT}/networks/${c.gt}/pools/${p.address}/ohlcv/day?aggregate=1&limit=${DAYS + 2}&currency=usd`, { ...o, cacheFile: `${dir}/ohlcv/${safeName(p.address)}.json` });
      const list = r?.data?.attributes?.ohlcv_list || [];
      p.days = {};
      for (const [ts, , , , , v] of list) {
        if (ts % 86400 !== 0) misaligned++;
        const day = ts - (ts % 86400);
        if (day >= today || day < today - DAYS * 86400) continue;
        const key = new Date(day * 1000).toISOString().slice(0, 10);
        p.days[key] = (p.days[key] || 0) + Number(v || 0);
      }
      if (++done % 50 === 0) console.log(`  ${c.key}: ${done}/${toFetch.length} ohlcv (${Math.round((Date.now() - t0) / 60000)} min)`);
    }
    writeJson(`${dir}/pools_index.json`, { chain: c.key, fetched_at: new Date().toISOString(), top_pools: nTop, whitelist_tokens: wl.length, whitelist_active: wlActive.length, misaligned_candles: misaligned, pools: [...pools.values()] });
    console.log(`gt ${c.key}: done in ${Math.round((Date.now() - t0) / 60000)} min, misaligned candles ${misaligned}`);
    await fetchCaps(c, dir, [...pools.values()].filter((p) => p.days), snap);
  }
}

export async function capsOnly(only) {
  const snap = readJson('data/mcap_snapshot.json');
  for (const c of CHAINS) {
    if (only && !only.includes(c.key)) continue;
    const dir = `data/raw/geckoterminal/${c.key}`;
    const idx = readJson(`${dir}/pools_index.json`);
    if (idx) await fetchCaps(c, dir, idx.pools.filter((p) => p.days), snap);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const list = args.find((a) => !a.startsWith('--'));
  if (args.includes('--caps-only')) await capsOnly(list ? list.split(',') : null); else await main(list ? list.split(',') : null);
}
