// Per-venue reconciliation: GeckoTerminal sampled pool volume vs DefiLlama per-protocol volume, last 7 complete days.
// Only explicitly mapped venues are compared. Feeds the dashboard's data-quality panel.
import { readJson, writeJson } from './lib/http.mjs';
import { CHAINS } from './config.mjs';

// GeckoTerminal dex id -> DefiLlama protocol display name
export const VENUE_MAP = {
  ethereum:  { 'uniswap_v3': 'Uniswap V3', 'uniswap-v4-ethereum': 'Uniswap V4', 'uniswap_v2': 'Uniswap V2', 'curve': 'Curve DEX', 'fluid-ethereum': 'Fluid DEX', 'pancakeswap-v3-ethereum': 'PancakeSwap AMM V3', 'ekubo-v3-ethereum': 'Ekubo', 'ekubo-v2-ethereum': 'Ekubo', 'maverick-v2-eth': 'Maverick V2', 'balancer-v3-ethereum': 'Balancer V3', 'sushiswap-v3-ethereum': 'SushiSwap V3', 'dodo-pmm-ethereum': 'DODO AMM' },
  solana:    { 'pumpswap': 'PumpSwap', 'orca': 'Orca DEX', 'manifest': 'Manifest Trade', 'meteora': 'Meteora DLMM', 'meteora-damm-v2': 'Meteora DAMM V2', 'raydium': 'Raydium AMM', 'raydium-clmm': 'Raydium AMM', 'raydium-cpmm': 'Raydium AMM', 'zerofi': 'ZeroFi', 'byreal': 'Byreal', 'humidifi': 'HumidiFi', 'pancakeswap-v3-solana': 'PancakeSwap AMM V3' },
  base:      { 'uniswap-v3-base': 'Uniswap V3', 'uniswap-v4-base': 'Uniswap V4', 'uniswap-v2-base': 'Uniswap V2', 'aerodrome-slipstream': 'Aerodrome Slipstream', 'aerodrome-slipstream-2': 'Aerodrome Slipstream', 'aerodrome-slipstream-3': 'Aerodrome Slipstream', 'aerodrome-base': 'Aerodrome V1', 'pancakeswap-v3-base': 'PancakeSwap AMM V3', 'quickswap-v4-base': 'Quickswap V4', 'fluid-base': 'Fluid DEX' },
  bnb:       { 'pancakeswap-v3-bsc': 'PancakeSwap AMM V3', 'pancakeswap-infinity-clmm': 'PancakeSwap Infinity', 'pancakeswap_v2': 'PancakeSwap AMM', 'uniswap-v4-bsc': 'Uniswap V4', 'uniswap-bsc': 'Uniswap V3', 'topaz': 'Topaz CL' },
  arbitrum:  { 'uniswap_v3_arbitrum': 'Uniswap V3', 'uniswap-v4-arbitrum': 'Uniswap V4', 'pancakeswap-v3-arbitrum': 'PancakeSwap AMM V3', 'camelot-v3': 'Camelot V3', 'camelot': 'Camelot V2', 'fluid-arbitrum': 'Fluid DEX', 'curve_arbitrum': 'Curve DEX', 'sushiswap-v3-arbitrum': 'SushiSwap V3', 'maverick-v2-arbitrum': 'Maverick V2' },
  hyperevm:  { 'project-x': 'Project X', 'nest': 'nest CL', 'ramses-v3-hyperevm': 'Ramses CL V2', 'kittenswap-algebra': 'Kittenswap Algebra', 'hyperswap-v3': 'HyperSwap V3', 'hyperswap-v2': 'HyperSwap V2', 'hybra-finance-v4': 'Hybra V4', 'hybra-finance-v3': 'Hybra V3', 'ring-exchange-hyperevm': 'Ring Swap', 'curve-hyperevm': 'Curve DEX' },
  robinhood: { 'uniswap-v3-robinhood': 'Uniswap V3', 'uniswap-v4-robinhood': 'Uniswap V4', 'uniswap-v2-robinhood': 'Uniswap V2', 'pons-v2-dex': 'Pons V2', 'up-v3': 'up v3', 'giga-v3': 'GIGA V3', 'alandale-cl': 'Alandale V3', 'ramses-v3-robinhood': 'Ramses CL V2' },
};

export function main() {
  const llama = readJson('data/defillama_totals.json');
  const out = { generated_at: new Date().toISOString(), window_days: 7, chains: {} };
  for (const c of CHAINS) {
    const idx = readJson(`data/raw/geckoterminal/${c.key}/pools_index.json`);
    const L = llama.chains[c.key];
    if (!idx || !L) continue;
    const raw = readJson(`data/raw/defillama/${c.key}.json`);
    const bd = new Map(raw.totalDataChartBreakdown.map(([ts, d]) => [new Date(ts * 1000).toISOString().slice(0, 10), d]));
    const dates = Object.keys(L.days).filter((d) => !L.days[d].provisional).sort().slice(-7);
    const map = VENUE_MAP[c.key] || {};
    const gt = {}, ll = {};
    for (const p of idx.pools) { const name = map[p.dex]; if (!name || !p.days) continue; for (const d of dates) gt[name] = (gt[name] || 0) + (p.days[d] || 0); }
    for (const name of new Set(Object.values(map))) for (const d of dates) ll[name] = (ll[name] || 0) + (bd.get(d)?.[name] || 0);
    const venues = [...new Set(Object.values(map))].filter((n) => ll[n] > 0).sort((a, b) => ll[b] - ll[a])
      .map((n) => ({ venue: n, gt_sampled: gt[n] || 0, defillama: ll[n], ratio: (gt[n] || 0) / ll[n] }));
    const covered = venues.reduce((s, v) => s + v.defillama, 0), chainTotal = dates.reduce((s, d) => s + L.days[d].total, 0);
    out.chains[c.key] = { dates: [dates[0], dates.at(-1)], venues, mapped_share_of_total: chainTotal ? covered / chainTotal : null,
      unmapped_gt_dexes: [...new Set(idx.pools.filter((p) => p.days && !map[p.dex]).map((p) => p.dex))].slice(0, 15) };
    console.log(`${c.key.padEnd(10)} ${dates[0]}..${dates.at(-1)}  mapped venues cover ${(100 * covered / chainTotal).toFixed(0)}% of DefiLlama total`);
    for (const v of venues) console.log(`    ${v.venue.padEnd(22)} GT $${(v.gt_sampled / 1e6).toFixed(0).padStart(6)}M  Llama $${(v.defillama / 1e6).toFixed(0).padStart(6)}M  ratio ${v.ratio.toFixed(2)}`);
  }
  writeJson('data/reconciliation.json', out, true);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
