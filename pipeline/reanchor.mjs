// Refresh reference totals without claiming to refresh the existing pool/cap sample.
// The normal full pipeline re-fetches totals before classification; this also repairs
// late provider revisions after an already-completed run.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { kpis, methodologyNotes } from './classify.mjs';
import { main as fetchTotals } from './fetch_defillama.mjs';

const median = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;

export function reanchor(input, reference) {
  const out = structuredClone(input);
  for (const [key, chain] of Object.entries(out.chains)) {
    const L = reference.chains[key];
    assert(L, `Missing reference chain: ${key}`);
    // A new UTC day needs new pool history, not an extrapolated or zero-filled split.
    assert.deepEqual(Object.keys(L.days).sort(), chain.days.map((d) => d.date), `${key}: date window changed; run a full refresh`);
    const recent = new Set(chain.days.slice(-3).map((d) => d.date));
    const samples = new Map();
    chain.data_gaps = [];
    chain.days = chain.days.map((old) => {
      const t = L.days[old.date];
      assert(Number.isFinite(t.total) && t.total > 0, `${key}/${old.date}: invalid reference total`);
      // Older outputs retained these sufficient statistics as coverage and the
      // proportional estimate. Recover once; persist explicit amounts thereafter.
      const sampled = old.sampled_total ?? (old.coverage == null ? null : old.coverage * old.total);
      const sampledAbove = old.sampled_above_100m ?? (old.coverage == null || old.above_100m_proportional == null ? null : old.above_100m_proportional * old.coverage);
      assert(sampled == null || (Number.isFinite(sampled) && sampled >= 0), `${key}/${old.date}: invalid sample volume`);
      const d = { ...old, total: t.total, defillama_headline: t.headline,
        sampled_total: sampled, sampled_above_100m: sampledAbove,
        above_100m: null, below_100m: null, above_100m_proportional: null, coverage: null };
      for (const field of ['extra', 'provisional', 'missing_protocols', 'missing_est']) delete d[field];
      if (t.extra) d.extra = structuredClone(t.extra);
      if (t.provisional && recent.has(old.date)) Object.assign(d, { provisional: true, missing_protocols: t.missing_protocols, missing_est: t.missing_est });
      if (t.provisional && !recent.has(old.date)) chain.data_gaps.push({ date: old.date, missing_protocols: t.missing_protocols, missing_est: t.missing_est });
      if (sampled != null && sampled > 0) {
        assert(Number.isFinite(sampled) && Number.isFinite(sampledAbove) && sampledAbove >= 0 && sampledAbove <= sampled * (1 + 1e-12), `${key}/${old.date}: invalid sample`);
        d.coverage = sampled / t.total;
        d.above_100m_proportional = t.total * sampledAbove / sampled;
        d.above_100m = sampled <= t.total ? Math.min(sampledAbove, t.total) : d.above_100m_proportional;
        d.below_100m = t.total - d.above_100m;
        samples.set(old.date, { sampled, unknown: sampled * (old.unknown_share ?? 0), boundary: sampled * (old.boundary_share ?? 0) });
      }
      return d;
    });
    chain.kpi = kpis(chain.days);
    chain.kpi.defillama_change_30dover30d = L.change_30dover30d == null ? null : L.change_30dover30d / 100;
    const sum = (days, get) => days.reduce((s, d) => s + get(d), 0);
    const days = chain.days.filter((d) => d.total != null);
    const same = days.length >= 60 ? sum(days.slice(-30), (d) => d.total) / sum(days.slice(-60, -30), (d) => d.total) - 1 : null;
    const llamaChange = chain.kpi.defillama_change_30dover30d;
    chain.kpi.crosscheck_same_window = { ours: same, defillama: llamaChange,
      match: same != null && llamaChange != null && Math.abs(same - llamaChange) < 0.0005,
      note: chain.defillama_filter ? 'not comparable: chain total is filtered (see defillama_filter)' : null };
    const complete = chain.days.filter((d) => !d.provisional), last30 = complete.slice(-30);
    chain.last_complete_day = complete.at(-1)?.date ?? null;
    const sampled30 = sum(last30, (d) => samples.get(d.date)?.sampled ?? 0);
    const total30 = sum(last30, (d) => d.total);
    const coverage = last30.map((d) => d.coverage).filter((n) => n != null);
    Object.assign(out.quality.per_chain[key], {
      days: chain.days.length, days_with_split: chain.days.filter((d) => d.coverage != null).length,
      coverage_30d: total30 ? sampled30 / total30 : null,
      unknown_share_30d: sampled30 ? sum(last30, (d) => samples.get(d.date)?.unknown ?? 0) / sampled30 : null,
      boundary_share_30d: sampled30 ? sum(last30, (d) => samples.get(d.date)?.boundary ?? 0) / sampled30 : null,
      coverage_median_30d: median(coverage), coverage_min_30d: coverage.length ? Math.min(...coverage) : null,
      coverage_max_30d: coverage.length ? Math.max(...coverage) : null,
      unknown_share_median_30d: median(last30.map((d) => d.unknown_share).filter((n) => n != null)),
      boundary_share_median_30d: median(last30.map((d) => d.boundary_share).filter((n) => n != null)),
    });
  }
  // Keep generated_at and classified_with: this did not fetch new pools or caps.
  out.reference_refreshed_at = reference.fetched_at;
  out.quality.notes = methodologyNotes(out.classified_with.replace('snapshot:', ''));
  return out;
}

export function dailyCsv(data) {
  const rows = ['chain,date,total,above_100m,below_100m,coverage,unknown_share,boundary_share,mode,classified_with'];
  for (const [key, chain] of Object.entries(data.chains)) for (const d of chain.days) {
    rows.push([key, d.date, d.total, d.above_100m ?? '', d.below_100m ?? '', d.coverage?.toFixed(4) ?? '',
      d.unknown_share?.toFixed(4) ?? '', d.boundary_share?.toFixed(4) ?? '', d.mode, d.classified_with].join(','));
  }
  return rows.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Write a reviewable candidate in a NEW directory. Never partly replace the
  // published dataset if a provider response, validation, or snapshot fails.
  assert(process.argv[2], 'Usage: node pipeline/reanchor.mjs /path/to/new-candidate-directory');
  const destination = path.resolve(process.argv[2]);
  fs.mkdirSync(destination);
  const previous = JSON.parse(fs.readFileSync('data/latest.json', 'utf8'));
  const reference = await fetchTotals({ force: true, writeOutput: false });
  const updated = reanchor(previous, reference);
  fs.mkdirSync(path.join(destination, 'data'));
  fs.writeFileSync(path.join(destination, 'data/latest.json'), JSON.stringify(updated));
  fs.writeFileSync(path.join(destination, 'data/defillama_totals.json'), JSON.stringify(reference, null, 1));
  fs.writeFileSync(path.join(destination, 'data/volume_daily.csv'), dailyCsv(updated));
  fs.copyFileSync('data/mcap_snapshot.json', path.join(destination, 'data/mcap_snapshot.json'));
  fs.copyFileSync('index.html', path.join(destination, 'index.html'));
  fs.cpSync('assets', path.join(destination, 'assets'), { recursive: true });
  execFileSync(process.execPath, [path.resolve('pipeline/snapshot.mjs')], { cwd: destination, stdio: 'inherit' });
  console.log(`Candidate written to ${destination}; published files were not replaced.`);
  console.log(`Updated reference totals at ${updated.reference_refreshed_at}; pool/cap generation remains ${updated.generated_at}.`);
}
