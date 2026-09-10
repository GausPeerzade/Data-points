import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateData, validateFiles } from '../validate.mjs';
import { kpis } from '../classify.mjs';
import { CHAINS, DAYS, THRESHOLD_USD } from '../config.mjs';

const cutoff = '2026-09-10', started = '2026-09-10T20:00:00.000Z';
const date = i => new Date(Date.parse(`${cutoff}T00:00:00Z`) - (DAYS - i) * 86400000).toISOString().slice(0, 10);
function serializeCsv(latest) {
  const rows = ['chain,date,total,above_100m,below_100m,coverage,unknown_share,boundary_share,mode,classified_with'];
  for (const [key, chain] of Object.entries(latest.chains)) for (const d of chain.days) rows.push([
    key, d.date, d.total, d.above_100m ?? '', d.below_100m ?? '', d.coverage?.toFixed(4) ?? '',
    d.unknown_share?.toFixed(4) ?? '', d.boundary_share?.toFixed(4) ?? '', d.mode, d.classified_with,
  ].join(','));
  return rows.join('\n');
}
function fixture() {
  const classified = `snapshot:${cutoff}`;
  const data = {
    latest: { generated_at: '2026-09-10T21:00:00.000Z', cutoff_utc: cutoff, refresh_started_at: started, threshold_usd: THRESHOLD_USD, classified_with: classified, chains: {}, quality: { per_chain: {} } },
    snapshot: { fetched_at: '2026-09-10T20:05:00.000Z', snapshot_date: cutoff, threshold_usd: THRESHOLD_USD, coins: { known: { market_cap: 200_000_000 } }, addresses: {} },
    reference: { fetched_at: '2026-09-10T20:50:00.000Z', cutoff_utc: cutoff, chains: {} }, indexes: {},
  };
  for (const { key } of CHAINS) {
    const days = Array.from({ length: DAYS }, (_, i) => {
      const total = i < 31 ? 100 : 200;
      return { date: date(i), total, above_100m: total * 0.4, below_100m: total * 0.6, sampled_total: total * 0.8,
        sampled_above_100m: total * 0.4, coverage: 0.8, unknown_share: 0.2, boundary_share: 0.1,
        mode: 'estimate', classified_with: classified };
    });
    data.latest.chains[key] = { mode: 'estimate', days, kpi: kpis(days), last_complete_day: days.at(-1).date };
    data.latest.quality.per_chain[key] = { days: DAYS, days_with_split: DAYS };
    data.snapshot.addresses[key] = { token: 'known' };
    data.reference.chains[key] = { days: Object.fromEntries(days.map(d => [d.date, { total: d.total }])) };
    data.indexes[key] = { chain: key, cutoff_utc: cutoff, fetched_at: '2026-09-10T20:45:00.000Z', pools: [
      { address: 'pool-a', days: Object.fromEntries(days.map(d => [d.date, d.sampled_total * 0.7])) },
      { address: 'pool-b', days: Object.fromEntries(days.map(d => [d.date, d.sampled_total * 0.3])) },
    ] };
  }
  data.csv = serializeCsv(data.latest);
  return data;
}

test('accepts all 427 pinned UTC rows, verifies concrete 30/prior-30 sums, and never mutates input', () => {
  const data = fixture(), before = structuredClone(data);
  const result = validateData(data);
  assert.equal(result.rows, 427);
  assert.deepEqual(result.chains.ethereum, { complete_days: 61, current_days: 30, prior_days: 30, provisional_days: 0 });
  assert.equal(data.latest.chains.ethereum.kpi.total_30d, 6000);
  assert.equal(data.latest.chains.ethereum.kpi.above_30d, 2400);
  assert.equal(data.latest.chains.ethereum.kpi.change_30d.total, 1);
  assert.deepEqual(data, before);
});

test('rejects a fresh-looking export with a missing chain, missing day, duplicated day or shifted window', () => {
  for (const mutate of [
    d => { delete d.latest.chains.robinhood; },
    d => { d.latest.chains.solana.days.splice(15, 1); },
    d => { d.latest.chains.ethereum.days[15].date = d.latest.chains.ethereum.days[14].date; },
    d => { d.latest.chains.hyperevm.days.at(-1).date = cutoff; },
    d => { delete d.reference.chains.base.days[date(0)]; },
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => validateData(data), /missing chain|expected exactly 61 UTC dates/);
  }
});

test('source freshness is checked independently of the newly generated dashboard timestamp', () => {
  for (const [mutate, expected] of [
    [d => { d.snapshot.fetched_at = '2026-09-09T23:00:00Z'; }, /mcap_snapshot.fetched_at: stale/],
    [d => { d.reference.fetched_at = '2026-09-10T19:59:59Z'; }, /defillama_totals.fetched_at: stale/],
    [d => { d.indexes.solana.fetched_at = '2026-09-10T19:59:59Z'; }, /solana.pools_index.fetched_at: stale/],
    [d => { d.indexes.arbitrum.cutoff_utc = '2026-09-09'; }, /arbitrum.pools_index.cutoff_utc/],
    [d => { d.latest.generated_at = '2026-09-10T19:59:59Z'; }, /generated_at predates/],
    [d => { d.snapshot.fetched_at = '2026-09-10T22:00:00Z'; }, /source was fetched after/],
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => validateData(data), expected);
  }
  assert.throws(() => validateData(fixture(), { cutoff: '2026-09-11' }), /cutoff_utc does not match/);
  assert.throws(() => validateData(fixture(), { refreshStartedAt: '2026-09-10T19:00:00Z' }), /refresh_started_at does not match/);
});

test('a crawl crossing midnight retains its volume cutoff while recording the real next-day cap snapshot', () => {
  const data = fixture();
  data.latest.generated_at = '2026-09-11T01:00:00Z';
  data.latest.refresh_started_at = '2026-09-10T23:50:00Z';
  data.snapshot.fetched_at = '2026-09-11T00:05:00Z';
  data.snapshot.snapshot_date = '2026-09-11';
  data.reference.fetched_at = '2026-09-11T00:55:00Z';
  data.latest.classified_with = 'snapshot:2026-09-11';
  for (const { key } of CHAINS) {
    data.indexes[key].fetched_at = '2026-09-11T00:45:00Z';
    for (const row of data.latest.chains[key].days) row.classified_with = data.latest.classified_with;
  }
  data.csv = serializeCsv(data.latest);
  assert.equal(validateData(data).cutoff_utc, '2026-09-10');
  data.snapshot.snapshot_date = cutoff;
  assert.throws(() => validateData(data), /actual UTC fetch date/);
});

test('rejects invalid exported numbers and a plausible two-bucket sum that disagrees with reference totals', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, null, '200']) {
    const data = fixture(); data.latest.chains.bnb.days[32].total = value;
    assert.throws(() => validateData(data), /finite nonnegative number/);
  }
  for (const field of ['above_100m', 'below_100m']) {
    const data = fixture(); data.latest.chains.solana.days[33][field] = null;
    assert.throws(() => validateData(data), /finite nonnegative number/);
  }
  let data = fixture(); data.latest.chains.ethereum.days[32].below_100m += 1;
  assert.throws(() => validateData(data), /bucket_sum/);
  data = fixture(); data.reference.chains.ethereum.days[date(32)].total += 1;
  assert.throws(() => validateData(data), /reference_total/);
  data = fixture(); data.latest.chains.ethereum.days[32].below_100m += 1e-9;
  assert.equal(validateData(data).rows, 427, 'sub-cent floating-point noise is not rejected');
});

test('two recent provisional days are valid, with 29 prior observations and unavailable period change', () => {
  const data = fixture(), chain = data.latest.chains.robinhood;
  for (const row of chain.days.slice(-2)) {
    row.provisional = true; data.reference.chains.robinhood.days[row.date].provisional = true;
  }
  chain.kpi = kpis(chain.days); chain.last_complete_day = chain.days.at(-3).date;
  const result = validateData(data);
  assert.equal(result.chains.robinhood.prior_days, 29);
  assert.equal(chain.kpi.total_30d, 5800);
  assert.equal(chain.kpi.change_30d.total, null);
  assert.equal(chain.kpi.change_30d_point.total, 1);
  chain.kpi.change_30d.total = 1;
  assert.throws(() => validateData(data), /must be null when comparison history is unavailable/);
});

test('a third provisional day is accepted, but including provisional volume or wrong KPI dates fails', () => {
  const data = fixture(), chain = data.latest.chains.base;
  for (const row of chain.days.slice(-3)) {
    row.provisional = true; data.reference.chains.base.days[row.date].provisional = true;
  }
  chain.kpi = kpis(chain.days); chain.last_complete_day = chain.days.at(-4).date;
  assert.equal(validateData(data).chains.base.prior_days, 28);
  chain.kpi.window.to = chain.days.at(-1).date;
  assert.throws(() => validateData(data), /window.to/);
  chain.kpi = kpis(chain.days); chain.kpi.total_30d = 6000;
  assert.throws(() => validateData(data), /total_30d/);
});

test('coverage greater than 100% and unknown caps remain valid source-quality conditions', () => {
  const data = fixture(), chain = data.latest.chains.bnb;
  for (const row of chain.days) {
    row.sampled_total = row.total * 1.25; row.sampled_above_100m = row.total * 0.5;
    row.coverage = 1.25; row.unknown_share = 0.4;
    for (const pool of data.indexes.bnb.pools) pool.days[row.date] = row.sampled_total / 2;
  }
  data.csv = serializeCsv(data.latest);
  assert.equal(validateData(data).rows, 427);
});

test('a fresh index with empty, truncated or invalid OHLCV cannot masquerade as a completed crawl', () => {
  for (const [mutate, expected] of [
    [d => { d.indexes.hyperevm.pools = []; }, /empty pool sample/],
    [d => { d.indexes.hyperevm.pools = [{ address: 'no-data' }]; }, /no pool OHLCV history/],
    [d => { delete d.indexes.solana.pools[0].days[date(55)]; }, /sampled_total/],
    [d => { d.indexes.solana.pools[0].days[date(55)] = NaN; }, /finite nonnegative number/],
    [d => { d.indexes.solana.pools[0].days[cutoff] = 50; }, /outside the pinned cutoff window/],
  ]) {
    const data = fixture(); mutate(data);
    assert.throws(() => validateData(data), expected);
  }
});

test('CSV checks reject partial, duplicated, mixed-generation and blank numeric rows; rounded ratios are accepted', () => {
  for (const mutate of [
    rows => rows.pop(),
    rows => { rows[2] = rows[1]; },
    rows => { const cols = rows[1].split(','); cols[2] = ''; rows[1] = cols.join(','); },
    rows => { rows[1] = rows[1].replace('snapshot:2026-09-10', 'snapshot:2026-09-09'); },
  ]) {
    const data = fixture(), rows = data.csv.split('\n'); mutate(rows); data.csv = rows.join('\n');
    assert.throws(() => validateData(data), /volume_daily.csv/);
  }
  const data = fixture();
  for (const row of data.latest.chains.ethereum.days) row.unknown_share = 1 / 3;
  data.csv = serializeCsv(data.latest).replaceAll('\n', '\r\n') + '\r\n';
  assert.equal(validateData(data).rows, 427);
});

test('exports-only CLI validates metadata and data without raw files; full gate refuses the same directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-validator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'data'); fs.mkdirSync(directory);
  const data = fixture();
  for (const [name, value] of [['latest.json', data.latest], ['mcap_snapshot.json', data.snapshot], ['defillama_totals.json', data.reference]]) fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  fs.writeFileSync(path.join(directory, 'volume_daily.csv'), data.csv);
  assert.equal(validateFiles({ directory, exportsOnly: true, cutoff, refreshStartedAt: started }).rows, 427);
  assert.throws(() => validateFiles({ directory, cutoff, refreshStartedAt: started }), /Missing required data file.*pools_index/);
  const env = { ...process.env }; delete env.REFRESH_CUTOFF; delete env.REFRESH_STARTED_AT;
  const script = fileURLToPath(new URL('../validate.mjs', import.meta.url));
  const good = spawnSync(process.execPath, [script, '--exports-only'], { cwd: root, encoding: 'utf8', env });
  assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /Validated 427 daily rows/);
  const bad = spawnSync(process.execPath, [script, '--exports-only'], { cwd: root, encoding: 'utf8', env: { ...env, REFRESH_CUTOFF: '2026-09-11' } });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /cutoff_utc does not match/);
});
