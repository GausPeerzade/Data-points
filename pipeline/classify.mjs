// Classify pools by subject-token market cap, aggregate per chain-day, compute KPIs, write dashboard data.
import fs from 'node:fs';
import { readJson, writeJson, safeName } from './lib/http.mjs';
import { CHAINS, THRESHOLD_USD, BOUNDARY, NATIVE_IDS, UNDERLYING, MANUAL_ADDRESSES, BRIDGED_ID_PATTERN, SYMBOL_TO_MAJOR, NATIVE_PLACEHOLDERS, NATIVE_COIN } from './config.mjs';

export const methodologyNotes = (snapshotDate) => [
  'Total = DefiLlama reported DEX volume per closed UTC day. HyperEVM includes Dexs-category protocols on "Hyperliquid L1" excluding the HyperCore spot orderbook.',
  'The estimated split samples today\'s top-200 pools plus up to 10 pools per active non-quote token with market cap >= $100M. Current-volume thresholds apply, so some large-cap pools and historically active pools can be missed.',
  'Unknown market caps and unsampled volume are assigned to below $100M by assumption. When sampled volume exceeds the reference total, both buckets are scaled proportionally. Bucket sums matching the total do not validate the split.',
  'Coverage = sampled pool volume / DefiLlama total; it is not accuracy. Unknown share refers only to the sample. Boundary share is sampled volume with a subject cap between $50M and $200M.',
  `Classification uses the current market-cap snapshot (${snapshotDate}) for all historical rows, with wrapped/bridged assets mapped to their underlying. CoinGecko FDV is a fallback when circulating market cap is unavailable.`,
];

export function main() {
  const snap = readJson('data/mcap_snapshot.json');
  const llama = readJson('data/defillama_totals.json');
  const stable = new Set(snap.stable_ids);
  const isQ = (id) => !!id && (stable.has(id) || NATIVE_IDS.has(id) || NATIVE_IDS.has(UNDERLYING[id]));
  const cgCap = (id) => { const c = snap.coins[UNDERLYING[id] || id]; if (!c) return [null, null]; return c.market_cap > 0 ? [c.market_cap, 'cg_mcap'] : c.fdv > 0 ? [c.fdv, 'cg_fdv'] : [null, null]; };

  const out = { generated_at: new Date().toISOString(), threshold_usd: THRESHOLD_USD, classified_with: `snapshot:${snap.snapshot_date}`, chains: {}, quality: { per_chain: {}, notes: [] } };
  const csv = ['chain,date,total,above_100m,below_100m,coverage,unknown_share,boundary_share,mode,classified_with'];

  for (const c of CHAINS) {
    const L = llama.chains[c.key];
    const idx = readJson(`data/raw/geckoterminal/${c.key}/pools_index.json`);
    const addrMap = { ...snap.addresses[c.key], ...(MANUAL_ADDRESSES[c.key] || {}) };
    const gtCaps = readJson(`data/raw/geckoterminal/${c.key}/token_caps.json`) || {};
    const norm = (addr) => (c.evm ? String(addr).toLowerCase() : addr);
    const lookup = (addr) => {
      if (c.evm && NATIVE_PLACEHOLDERS.includes(norm(addr))) return NATIVE_COIN[c.key];
      let id = addrMap[norm(addr)] || null;
      // chain-specific bridged/wrapped listing -> underlying major, by symbol
      if (id && !UNDERLYING[id] && !snap.coins[id]?.market_cap && BRIDGED_ID_PATTERN.test(id)) {
        const sym = (gtCaps[norm(addr)]?.symbol || snap.coins[id]?.symbol || '').toLowerCase();
        if (SYMBOL_TO_MAJOR[sym]) id = SYMBOL_TO_MAJOR[sym];
      }
      return id;
    };
    // market cap for a leg: CoinGecko (mcap, then FDV) -> GeckoTerminal (mcap, then FDV) -> null.
    // Upward classification requires a market cap with a verified circulating supply (CoinGecko, or GeckoTerminal's
    // market_cap_usd as used for tokenized stocks). A chain-local FDV (supply x price) can only prove "below".
    const capOf = (id, addr) => {
      const [v, src] = cgCap(id);
      if (v) return [v, src];
      const g = gtCaps[norm(addr)];
      if (g?.market_cap_usd > 0) return [g.market_cap_usd, 'gt_mcap'];           // verified circulating supply (e.g. tokenized stocks)
      if (g?.fdv_usd > 0) return g.fdv_usd < THRESHOLD_USD ? [g.fdv_usd, 'gt_fdv'] // FDV >= mcap, so a small FDV proves "below"
                                                            : [null, 'gt_fdv_only_above_threshold']; // FDV alone never proves "above"
      return [null, null];
    };
    // fallback: GeckoTerminal's own token->CoinGecko id link (from the OHLCV response meta)
    const gtMeta = (p) => {
      const m = readJson(`data/raw/geckoterminal/${c.key}/ohlcv/${safeName(p.address)}.json`)?.meta;
      const byAddr = {};
      for (const side of ['base', 'quote']) if (m?.[side]?.address && m[side].coingecko_coin_id) byAddr[c.evm ? m[side].address.toLowerCase() : m[side].address] = m[side].coingecko_coin_id;
      return byAddr;
    };
    let metaHits = 0;

    // classify each pool once
    const audit = ['pool,name,dex,base_id,quote_id,subject_id,subject_cap,bucket,reason,h24,vol_30d'];
    const perDay = {}; // date -> {above, below, unknown, sampled, boundary, pools}
    for (const p of idx?.pools || []) {
      if (!p.days) continue;
      let ids = [lookup(p.base), lookup(p.quote)];
      if (ids.includes(null)) {
        const m = gtMeta(p);
        ids = ids.map((id, i) => id || m[c.evm ? String(i ? p.quote : p.base).toLowerCase() : (i ? p.quote : p.base)] || null);
        if (!ids.includes(null)) metaHits++;
      }
      const legs = ids.map((id, i) => { const addr = i ? p.quote : p.base; const [cap, capSrc] = capOf(id, addr); return { id, q: isQ(id), cap, capSrc, addr }; });
      const nonQ = legs.filter((l) => !l.q);
      let bucket, reason, subject = null;
      if (nonQ.length === 0) { bucket = 'above'; reason = 'both_quote'; }
      else {
        // subject = lowest-cap non-quote leg (min-cap rule). A leg proven < $100M decides "below" even if the other
        // leg's cap is unknown; "unknown" only when no leg is proven below and at least one cap is missing.
        const known = nonQ.filter((l) => l.cap != null);
        const provenBelow = known.filter((l) => l.cap < THRESHOLD_USD).sort((a, b) => a.cap - b.cap)[0];
        if (provenBelow) { subject = provenBelow; bucket = 'below'; reason = (nonQ.length === 1 ? 'single_subject' : 'min_cap_of_two') + ':' + subject.capSrc; }
        else if (known.length < nonQ.length) { subject = nonQ.find((l) => l.cap == null); bucket = 'unknown'; reason = subject.capSrc || (subject.id ? 'cg_listed_no_cap' : 'not_on_coingecko'); }
        else { subject = known.sort((a, b) => a.cap - b.cap)[0]; bucket = 'above'; reason = (nonQ.length === 1 ? 'single_subject' : 'min_cap_of_two') + ':' + subject.capSrc; }
      }
      const inBoundary = subject?.cap != null && subject.cap >= BOUNDARY[0] && subject.cap < BOUNDARY[1];
      p.bucket = bucket;
      let v30 = 0; const dates = Object.keys(p.days).sort();
      for (const d of dates.slice(-30)) v30 += p.days[d];
      for (const [d, v] of Object.entries(p.days)) {
        const r = (perDay[d] ||= { above: 0, below: 0, unknown: 0, sampled: 0, boundary: 0, pools: 0 });
        r[bucket] += v; r.sampled += v; r.pools++; if (inBoundary) r.boundary += v;
      }
      audit.push([p.address, JSON.stringify(p.name), p.dex, ids[0], ids[1], subject?.id || (subject ? gtCaps[norm(subject.addr)]?.symbol : ''), subject?.cap == null ? '' : Math.round(subject.cap), bucket, reason, Math.round(p.h24), Math.round(v30)].join(','));
    }
    fs.mkdirSync('data/audit', { recursive: true });
    fs.writeFileSync(`data/audit/pools_${c.key}.csv`, audit.join('\n'));

    // per-day rows anchored to DefiLlama totals
    const mode = idx ? 'estimate' : 'totals_only';
    const days = [];
    const allDates = Object.keys(L.days).sort();
    const recent = new Set(allDates.slice(-3)); // only recent days can still be backfilled by DefiLlama adapters
    const gapNotes = [];
    for (const [date, t] of Object.entries(L.days).sort()) {
      const provisional = !!t.provisional && recent.has(date);
      if (t.provisional && !recent.has(date)) gapNotes.push({ date, missing_protocols: t.missing_protocols, missing_est: t.missing_est });
      const s = perDay[date];
      const total = t.total;
      let above = null, below = null, aboveAlt = null, coverage = null, unknownShare = null, boundaryShare = null;
      if (s && s.sampled > 0) {
        coverage = s.sampled / total;
        aboveAlt = total * (s.above / s.sampled);
        // residual (unsampled long tail) is assigned to below; if sampling exceeds the DefiLlama total, fall back to the proportional split
        above = coverage <= 1 ? Math.min(s.above, total) : aboveAlt;
        below = total - above;
        unknownShare = s.unknown / s.sampled;
        boundaryShare = s.boundary / s.sampled;
      }
      days.push({ date, total, above_100m: above, below_100m: below, above_100m_proportional: aboveAlt,
        coverage, unknown_share: unknownShare, boundary_share: boundaryShare, pools_sampled: s?.pools ?? 0,
        defillama_headline: t.headline, ...(t.extra ? { extra: t.extra } : {}), mode, classified_with: out.classified_with,
        ...(provisional ? { provisional: true, missing_protocols: t.missing_protocols, missing_est: t.missing_est } : {}) });
      csv.push([c.key, date, total, above ?? '', below ?? '', coverage?.toFixed(4) ?? '', unknownShare?.toFixed(4) ?? '', boundaryShare?.toFixed(4) ?? '', mode, out.classified_with].join(','));
    }
    const kpi = kpis(days);
    kpi.defillama_change_30dover30d = L.change_30dover30d == null ? null : L.change_30dover30d / 100;
    // cross-check on DefiLlama's own window (its figure includes the possibly-incomplete last day)
    const allClosed = days.filter((d) => d.total != null);
    const sumT = (arr) => arr.reduce((s, d) => s + d.total, 0);
    const same = allClosed.length >= 60 ? sumT(allClosed.slice(-30)) / sumT(allClosed.slice(-60, -30)) - 1 : null;
    kpi.crosscheck_same_window = { ours: same, defillama: kpi.defillama_change_30dover30d,
      match: same != null && kpi.defillama_change_30dover30d != null && Math.abs(same - kpi.defillama_change_30dover30d) < 0.0005,
      note: c.llamaFilter ? 'not comparable: chain total is filtered (see defillama_filter)' : null };
    out.chains[c.key] = { display: c.display, mode, defillama_slug: c.llama, defillama_filter: c.llamaFilter || null, days, kpi,
      last_complete_day: days.filter((d) => !d.provisional).at(-1)?.date ?? null, data_gaps: gapNotes };
    const complete = days.filter((d) => !d.provisional);
    const last30 = complete.slice(-30);
    const cov = last30.filter((d) => d.coverage != null).map((d) => d.coverage); // last 30 complete days
    // volume-weighted shares over the last 30 complete days (daily medians hide bursts in new pools)
    const sumBy = (f) => last30.reduce((a, d) => a + (f(perDay[d.date]) || 0), 0);
    const sampled30 = sumBy((s) => s?.sampled), total30 = last30.reduce((a, d) => a + d.total, 0);
    out.quality.per_chain[c.key] = { days: days.length, days_with_split: days.filter((d) => d.coverage != null).length,
      coverage_30d: total30 ? sampled30 / total30 : null,
      unknown_share_30d: sampled30 ? sumBy((s) => s?.unknown) / sampled30 : null,
      boundary_share_30d: sampled30 ? sumBy((s) => s?.boundary) / sampled30 : null,
      coverage_median_30d: median(cov), coverage_min_30d: cov.length ? Math.min(...cov) : null, coverage_max_30d: cov.length ? Math.max(...cov) : null,
      unknown_share_median_30d: median(complete.slice(-30).map((d) => d.unknown_share).filter((x) => x != null)),
      boundary_share_median_30d: median(complete.slice(-30).map((d) => d.boundary_share).filter((x) => x != null)),
      pools_classified: (idx?.pools || []).filter((p) => p.days).length, whitelist_tokens: idx?.whitelist_tokens ?? 0, gt_meta_id_fallbacks: metaHits };
    console.log(`${c.key.padEnd(10)} mode=${mode} days=${days.length} cov30=${fmtPct(out.quality.per_chain[c.key].coverage_30d)} unk30=${fmtPct(out.quality.per_chain[c.key].unknown_share_30d)} 30d total=${fmtUsd(kpi.total_30d)} above=${fmtPct(kpi.share_above_30d)} chg30d total=${fmtPct(kpi.change_30d.total)} (llama ${fmtPct(kpi.defillama_change_30dover30d)})`);
  }
  out.quality.notes = methodologyNotes(snap.snapshot_date);
  writeJson('data/latest.json', out);
  fs.writeFileSync('data/volume_daily.csv', csv.join('\n'));
  console.log('wrote data/latest.json, data/volume_daily.csv, data/audit/pools_*.csv');
}

function kpis(days) {
  const closed = days.filter((d) => d.total != null && !d.provisional);
  const last30 = closed.slice(-30), prev30 = closed.slice(-60, -30);
  const sum = (arr, k) => arr.reduce((s, d) => s + (d[k] ?? 0), 0);
  const ch = (a, b) => (b > 0 ? a / b - 1 : null);
  const hasSplit = last30.every((d) => d.above_100m != null) && prev30.every((d) => d.above_100m != null);
  const dLast = closed.at(-1), dPrev = closed.at(-31);
  return {
    window: { from: last30[0]?.date, to: last30.at(-1)?.date, prior_from: prev30[0]?.date, prior_to: prev30.at(-1)?.date },
    total_30d: sum(last30, 'total'), above_30d: hasSplit ? sum(last30, 'above_100m') : null, below_30d: hasSplit ? sum(last30, 'below_100m') : null,
    share_above_30d: hasSplit ? sum(last30, 'above_100m') / sum(last30, 'total') : null,
    change_30d: { total: prev30.length === 30 ? ch(sum(last30, 'total'), sum(prev30, 'total')) : null,
      above_100m: hasSplit && prev30.length === 30 ? ch(sum(last30, 'above_100m'), sum(prev30, 'above_100m')) : null,
      below_100m: hasSplit && prev30.length === 30 ? ch(sum(last30, 'below_100m'), sum(prev30, 'below_100m')) : null },
    change_30d_point: { total: dLast && dPrev ? ch(dLast.total, dPrev.total) : null,
      above_100m: dLast?.above_100m != null && dPrev?.above_100m != null ? ch(dLast.above_100m, dPrev.above_100m) : null,
      below_100m: dLast?.below_100m != null && dPrev?.below_100m != null ? ch(dLast.below_100m, dPrev.below_100m) : null },
  };
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fmtPct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const fmtUsd = (x) => (x == null ? 'n/a' : '$' + (x / 1e9).toFixed(2) + 'B');
if (import.meta.url === `file://${process.argv[1]}`) main();
