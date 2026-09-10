// DefiLlama: daily per-chain DEX volume totals (closed UTC days only) + category breakdown.
import { getJson, writeJson, dateStr } from './lib/http.mjs';
import { CHAINS, DAYS } from './config.mjs';
import { refreshCutoff } from './lib/run_context.mjs';

export async function main({ force = false, writeOutput = true } = {}) {
  const today = refreshCutoff();
  const out = { fetched_at: new Date().toISOString(), cutoff_utc: dateStr(today), source: 'https://api.llama.fi/overview/dexs/{chain}', chains: {} };
  for (const c of CHAINS) {
    const url = `https://api.llama.fi/overview/dexs/${encodeURIComponent(c.llama)}?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=false&dataType=dailyVolume`;
    const raw = await getJson(url, { cacheFile: `data/raw/defillama/${c.key}.json`, ttlMs: force ? 0 : 6 * 3600e3, label: 'llama' });
    const cat = new Map();
    for (const p of raw.protocols || []) { cat.set(p.displayName || p.name, p.category); cat.set(p.name, p.category); }
    const chart = new Map(raw.totalDataChart.map(([ts, v]) => [ts, v]));
    const days = {};
    let maxDiff = 0;
    // Provisional-day detection: once-a-day adapters (Allium/Dune based) publish D-1 hours after UTC midnight.
    // A day is provisional if protocols that reported volume on each of the previous 7 days report 0 on it
    // and their 7-day average exceeds 1% of the previous day's total.
    const byTs = new Map(raw.totalDataChartBreakdown.map(([ts, bd]) => [ts, bd]));
    const provisionalInfo = (ts) => {
      const prev = [1, 2, 3, 4, 5, 6, 7].map((i) => byTs.get(ts - i * 86400)).filter(Boolean);
      if (prev.length < 7) return { provisional: false, missing: [], missing_est: 0 };
      const bd = byTs.get(ts) || {};
      const missing = [], est = {};
      for (const name of Object.keys(prev[0])) {
        if (prev.every((p) => (p[name] || 0) > 0) && !(bd[name] > 0)) { missing.push(name); est[name] = prev.reduce((s, p) => s + p[name], 0) / 7; }
      }
      const missingEst = Object.values(est).reduce((s, v) => s + v, 0);
      const prevTotal = Object.values(prev[0]).reduce((s, v) => s + v, 0);
      return { provisional: missingEst > 0.01 * prevTotal, missing, missing_est: missingEst };
    };
    for (const [ts, bd] of raw.totalDataChartBreakdown) {
      if (ts >= today || ts < today - DAYS * 86400) continue;
      let headline = 0, total = 0; const extra = {}, byCat = {};
      for (const [name, v] of Object.entries(bd)) {
        headline += v;
        const category = cat.get(name) || 'Unknown';
        byCat[category] = (byCat[category] || 0) + v;
        const f = c.llamaFilter;
        const included = !f || ((!f.category || f.category.includes(category)) && !(f.excludeProtocols || []).includes(name));
        if (included) total += v;
        for (const [sname, names] of Object.entries(c.extraSeries || {})) if (names.includes(name)) extra[sname] = (extra[sname] || 0) + v;
      }
      maxDiff = Math.max(maxDiff, Math.abs(headline - (chart.get(ts) ?? headline)));
      const pi = provisionalInfo(ts);
      days[dateStr(ts)] = { total, headline, by_category: byCat, ...(Object.keys(extra).length ? { extra } : {}),
        ...(pi.provisional ? { provisional: true, missing_protocols: pi.missing, missing_est: pi.missing_est } : {}) };
    }
    out.chains[c.key] = { slug: c.llama, filter: c.llamaFilter || null, days,
      change_30dover30d: raw.change_30dover30d, total30d: raw.total30d, total24h: raw.total24h };
    const dates = Object.keys(days).sort();
    const prov = dates.filter((d) => days[d].provisional);
    console.log(`defillama ${c.key.padEnd(10)} ${dates.length} days ${dates[0]}..${dates.at(-1)}  last total=${Math.round(days[dates.at(-1)].total).toLocaleString()}  headline/chart max diff=${maxDiff.toFixed(2)}  provisional=${prov.join(',') || 'none'}`);
  }
  if (writeOutput) writeJson('data/defillama_totals.json', out, true);
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
