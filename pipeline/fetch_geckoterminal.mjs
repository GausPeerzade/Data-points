// GeckoTerminal pool data via the public API or authenticated CoinGecko Onchain API.
//   1. top 200 pools by 24h volume (10 pages)
//   2. whitelist tokens (>= $100M cap, non-quote) pre-screened by 24h volume via tokens/multi (30 per call);
//      active ones get their top-10 pools
//   3. daily OHLCV (USD volume) for every sampled pool with meaningful 24h volume
//   4. market cap / FDV for pool tokens that have no CoinGecko cap (tokens/multi, 30 per call)
import { getJson, writeJson, readJson, safeName, dateStr } from './lib/http.mjs';
import { refreshCutoff } from './lib/run_context.mjs';
import { coinGeckoConfig } from './lib/coingecko.mjs';
import { mapLimit } from './lib/concurrency.mjs';
import { CHAINS, DAYS, THRESHOLD_USD, NATIVE_IDS, UNDERLYING, MIN_POOL_VOL_TOP, MIN_POOL_VOL_WHITELIST, TOP_POOL_PAGES, MAX_POOLS_PER_TOKEN, MIN_TOKEN_VOL_WHITELIST } from './config.mjs';

const tokenAddr = (id) => (id ? id.slice(id.indexOf('_') + 1) : null);
export const UNAVAILABLE_POOL = Symbol('GeckoTerminal pool returned HTTP 404');

export function ohlcvCandles(response, label) {
  // A 404 explicitly identifies an unavailable pool; malformed successful data
  // must not silently erase sampled volume and inflate the residual bucket.
  if (response === UNAVAILABLE_POOL) return null;
  const list = response?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || list.some((candle) => !Array.isArray(candle) || candle.length < 6 ||
    !Number.isFinite(candle[0]) || !Number.isFinite(candle[5]) || candle[5] < 0)) {
    throw new Error(`Invalid OHLCV response for ${label}`);
  }
  return list;
}

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
  const config = coinGeckoConfig();
  const GT = config.onchainBaseUrl, o = { ...config.onchainOptions, label: 'gt' };
  const norm = (a) => (c.evm ? a.toLowerCase() : a);
  const has = (addr) => { const id = snap.addresses[c.key][norm(addr)]; const coin = id && snap.coins[UNDERLYING[id] || id]; return !!(coin && (coin.market_cap > 0 || coin.fdv > 0)); };
  const need = [...new Set(pools.flatMap((p) => [p.base, p.quote]).filter((a) => a && !has(a)))];
  const caps = readJson(`${dir}/token_caps.json`) || {};
  const todo = need.filter((a) => {
    const cached = caps[norm(a)];
    const fetchedAt = Date.parse(cached?.fetched_at);
    return !Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= o.ttlMs;
  });
  for (let i = 0; i < todo.length; i += 30) {
    const batch = todo.slice(i, i + 30);
    const r = await getJson(`${GT}/networks/${c.gt}/tokens/multi/${batch.join(',')}`, { ...o, label: 'gt-caps' });
    if (!Array.isArray(r?.data) || r.data.some((d) => typeof d?.attributes?.address !== 'string' || !d.attributes.address)) {
      throw new Error(`Invalid token-cap response for ${c.key}; preserving the previous cache`);
    }
    const fetchedAt = new Date().toISOString();
    const returned = new Set();
    for (const d of r?.data || []) {
      const a = d.attributes;
      returned.add(norm(a.address));
      caps[norm(a.address)] = { symbol: a.symbol, name: a.name, coingecko_coin_id: a.coingecko_coin_id || null,
        market_cap_usd: a.market_cap_usd == null ? null : Number(a.market_cap_usd), fdv_usd: a.fdv_usd == null ? null : Number(a.fdv_usd), h24: Number(a.volume_usd?.h24 || 0), fetched_at: fetchedAt };
    }
    for (const a of batch) if (!returned.has(norm(a))) caps[norm(a)] = { missing: true, fetched_at: fetchedAt };
    writeJson(`${dir}/token_caps.json`, caps);
  }
  writeJson(`${dir}/token_caps.json`, caps);
  console.log(`gt ${c.key}: caps fetched for ${todo.length} tokens without a CoinGecko cap (${Math.ceil(todo.length / 30)} calls); ${Object.keys(caps).length} cached`);
}

export async function main(only) {
  const config = coinGeckoConfig();
  const GT = config.onchainBaseUrl, o = { ...config.onchainOptions, label: 'gt' };
  const snap = readJson('data/mcap_snapshot.json');
  if (!snap) throw new Error('run fetch_coingecko first');
  const stable = new Set(snap.stable_ids);
  const isQ = (id) => stable.has(id) || NATIVE_IDS.has(id) || NATIVE_IDS.has(UNDERLYING[id]);
  const today = refreshCutoff();
  const order = only ? only.map((k) => {
    const c = CHAINS.find((c) => c.key === k);
    if (!c) throw new Error(`Unknown chain: ${k}`);
    return c;
  }) : CHAINS;
  console.log(`Pool API: ${config.tier === 'pro' ? 'CoinGecko Pro' : 'GeckoTerminal public'}; up to ${config.concurrency} concurrent requests, ${Math.floor(60000 / o.minIntervalMs)}/min pacing`);

  for (const c of order) {
    const dir = `data/raw/geckoterminal/${c.key}`;
    const t0 = Date.now();
    const pools = new Map();
    const topPages = await mapLimit(Array.from({ length: TOP_POOL_PAGES }, (_, i) => i + 1), config.concurrency,
      (p) => getJson(`${GT}/networks/${c.gt}/pools?page=${p}&sort=h24_volume_usd_desc`, { ...o, cacheFile: `${dir}/top_p${p}.json` }));
    for (const r of topPages) {
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
    const tokenBatches = Array.from({ length: Math.ceil(wl.length / 30) }, (_, i) => wl.slice(i * 30, i * 30 + 30).map(([a]) => a));
    const tokenResponses = await mapLimit(tokenBatches, config.concurrency,
      (batch, i) => getJson(`${GT}/networks/${c.gt}/tokens/multi/${batch.join(',')}`, { ...o, cacheFile: `${dir}/wl_multi_${i}.json` }));
    for (const r of tokenResponses) {
      for (const d of r?.data || []) tokVol[c.evm ? d.attributes.address.toLowerCase() : d.attributes.address] = Number(d.attributes.volume_usd?.h24 || 0);
    }
    const wlActive = wl.filter(([a]) => (tokVol[a] || 0) >= MIN_TOKEN_VOL_WHITELIST);
    console.log(`gt ${c.key}: top pools ${nTop}; whitelist ${wl.length} tokens, ${wlActive.length} with 24h volume >= $${MIN_TOKEN_VOL_WHITELIST / 1000}k`);
    const tokenPools = await mapLimit(wlActive, config.concurrency, async ([addr, id]) => ({ id,
      response: await getJson(`${GT}/networks/${c.gt}/tokens/${addr}/pools?page=1&sort=h24_volume_usd_desc`, { ...o, cacheFile: `${dir}/token_${safeName(addr)}.json` }),
    }));
    // Merge in whitelist order so response timing cannot change pool precedence.
    for (const { id, response: r } of tokenPools) {
      for (const d of (r?.data || []).slice(0, MAX_POOLS_PER_TOKEN)) addPool(pools, d, `wl:${id}`);
    }

    const toFetch = [...pools.values()].filter((p) => p.h24 >= (p.source.includes('top') ? MIN_POOL_VOL_TOP : MIN_POOL_VOL_WHITELIST));
    console.log(`gt ${c.key}: union pools ${pools.size}, fetching ohlcv for ${toFetch.length}`);
    let misaligned = 0, done = 0;
    await mapLimit(toFetch, config.concurrency, async (p) => {
      const r = await getJson(`${GT}/networks/${c.gt}/pools/${p.address}/ohlcv/day?aggregate=1&limit=${DAYS + 2}&currency=usd&before_timestamp=${today}`, { ...o, cacheFile: `${dir}/ohlcv/${safeName(p.address)}.json`, notFoundValue: UNAVAILABLE_POOL });
      const list = ohlcvCandles(r, `${c.key}/${p.address}`);
      if (list === null) {
        p.unavailable = true;
        console.warn(`  ${c.key}: pool ${p.address} returned HTTP 404; its history is unavailable, not measured as zero`);
      }
      p.days = {};
      for (const [ts, , , , , v] of list || []) {
        if (ts % 86400 !== 0) misaligned++;
        const day = ts - (ts % 86400);
        if (day >= today || day < today - DAYS * 86400) continue;
        const key = new Date(day * 1000).toISOString().slice(0, 10);
        p.days[key] = (p.days[key] || 0) + Number(v || 0);
      }
      if (++done % 50 === 0) console.log(`  ${c.key}: ${done}/${toFetch.length} ohlcv (${Math.round((Date.now() - t0) / 60000)} min)`);
    });
    writeJson(`${dir}/pools_index.json`, { chain: c.key, provider_tier: config.tier, cutoff_utc: dateStr(today), fetched_at: new Date().toISOString(), top_pools: nTop, whitelist_tokens: wl.length, whitelist_active: wlActive.length, misaligned_candles: misaligned, pools: [...pools.values()] });
    console.log(`gt ${c.key}: done in ${Math.round((Date.now() - t0) / 60000)} min, misaligned candles ${misaligned}`);
    await fetchCaps(c, dir, [...pools.values()].filter((p) => p.days), snap);
  }
}

export async function capsOnly(only) {
  const snap = readJson('data/mcap_snapshot.json');
  if (!snap) throw new Error('run fetch_coingecko first');
  for (const key of only || []) if (!CHAINS.some((c) => c.key === key)) throw new Error(`Unknown chain: ${key}`);
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
