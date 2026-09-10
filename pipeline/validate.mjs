// Read-only publication gate. A successful crawl must not publish stale, partial or inconsistent exports.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHAINS, DAYS, THRESHOLD_USD } from './config.mjs';

const DAY = 86400000;
const CSV_HEADERS = 'chain,date,total,above_100m,below_100m,coverage,unknown_share,boundary_share,mode,classified_with';
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const number = (value, label) => assert(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${label}: expected a finite nonnegative number`);
const equalNumber = (actual, expected, label, tolerance = 0) => {
  if (expected == null) return assert(actual === null, `${label}: must be null when comparison history is unavailable`);
  assert(typeof actual === 'number' && Number.isFinite(actual), `${label}: expected a finite number`);
  assert(Math.abs(actual - expected) <= Math.max(tolerance, 1e-8, Math.abs(expected) * 1e-10), `${label}: ${actual} does not match ${expected}`);
};
const timestamp = (value, label) => {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), `${label}: missing or invalid ISO timestamp`);
  return Date.parse(value);
};
function cutoffDate(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, 'REFRESH_CUTOFF / cutoff_utc: expected a valid YYYY-MM-DD UTC date');
  return Date.parse(`${value}T00:00:00Z`);
}
const datesBefore = (cutoff) => Array.from({ length: DAYS }, (_, i) => new Date(cutoff - (DAYS - i) * DAY).toISOString().slice(0, 10));
const sameDates = (actual, expected, label) => assert(actual.length === expected.length && actual.every((d, i) => d === expected[i]), `${label}: expected exactly ${DAYS} UTC dates ${expected[0]}..${expected.at(-1)} without gaps, duplicates or extra dates`);

function validateKpis(chain, label) {
  const complete = chain.days.filter(d => !d.provisional), current = complete.slice(-30), prior = complete.slice(-60, -30);
  assert(current.length === 30, `${label}: fewer than 30 complete observations; a 30-day summary is unavailable`);
  const kpi = chain.kpi;
  assert(kpi?.window && kpi.change_30d && kpi.change_30d_point, `${label}: missing KPI groups`);
  for (const [field, expected] of Object.entries({ from: current[0].date, to: current.at(-1).date, prior_from: prior[0]?.date, prior_to: prior.at(-1)?.date })) {
    assert(kpi.window[field] === expected, `${label}.kpi.window.${field}: does not match the actual complete-observation period`);
  }
  assert(chain.last_complete_day === current.at(-1).date, `${label}.last_complete_day: does not match complete observations`);
  const sum = (rows, field) => rows.reduce((n, row) => n + row[field], 0);
  const ratio = (a, b) => b > 0 ? a / b - 1 : null;
  for (const [field, output] of [['total', 'total_30d'], ['above_100m', 'above_30d'], ['below_100m', 'below_30d']]) {
    equalNumber(kpi[output], sum(current, field), `${label}.kpi.${output}`);
    equalNumber(kpi.change_30d[field], prior.length === 30 ? ratio(sum(current, field), sum(prior, field)) : null, `${label}.kpi.change_30d.${field}`);
    equalNumber(kpi.change_30d_point[field], complete.length >= 31 ? ratio(complete.at(-1)[field], complete.at(-31)[field]) : null, `${label}.kpi.change_30d_point.${field}`);
  }
  assert(kpi.total_30d > 0, `${label}: no positive volume in the summary period`);
  equalNumber(kpi.share_above_30d, kpi.above_30d / kpi.total_30d, `${label}.kpi.share_above_30d`);
  return { complete_days: complete.length, current_days: current.length, prior_days: prior.length, provisional_days: chain.days.length - complete.length };
}

function validateCsv(csv, latest) {
  assert(typeof csv === 'string' && csv.length > 0, 'volume_daily.csv: missing or empty export');
  const lines = csv.trimEnd().split(/\r?\n/);
  assert(lines.shift() === CSV_HEADERS, 'volume_daily.csv: unexpected columns');
  assert(lines.length === CHAINS.length * DAYS, 'volume_daily.csv: incomplete or duplicate export rows');
  const seen = new Set();
  for (const [i, line] of lines.entries()) {
    const fields = line.split(','), label = `volume_daily.csv row ${i + 2}`;
    assert(fields.length === 10, `${label}: unexpected column count`);
    const [key, date] = fields, id = `${key}/${date}`;
    assert(!seen.has(id), `${label}: duplicate ${id}`); seen.add(id);
    const day = latest.chains[key]?.days.find(d => d.date === date);
    assert(day, `${label}: unknown chain/date ${id}`);
    for (const [offset, field] of ['total', 'above_100m', 'below_100m', 'coverage', 'unknown_share', 'boundary_share'].entries()) {
      const value = fields[offset + 2];
      if (day[field] == null) assert(value === '', `${label}.${field}: expected an empty unavailable value`);
      else {
        assert(value.trim() !== '', `${label}.${field}: missing number`);
        equalNumber(Number(value), day[field], `${label}.${field}`, offset >= 3 ? 0.000050001 : 0);
      }
    }
    assert(fields[8] === day.mode && fields[9] === day.classified_with, `${label}: mode or classification metadata differs from latest.json`);
  }
}

export function validateData({ latest, snapshot, reference, csv, indexes }, options = {}) {
  assert(latest && snapshot && reference, 'Missing latest.json, mcap_snapshot.json or defillama_totals.json');
  const cutoff = options.cutoff ?? latest.cutoff_utc, cutoffMs = cutoffDate(cutoff);
  assert(latest.cutoff_utc === cutoff, 'latest.cutoff_utc does not match REFRESH_CUTOFF');
  const startedAt = options.refreshStartedAt ?? latest.refresh_started_at, started = timestamp(startedAt, 'REFRESH_STARTED_AT / refresh_started_at');
  assert(timestamp(latest.refresh_started_at, 'latest.refresh_started_at') === started, 'latest.refresh_started_at does not match REFRESH_STARTED_AT');
  const generated = timestamp(latest.generated_at, 'latest.generated_at');
  assert(generated >= started, 'latest.generated_at predates this refresh');
  const fresh = (value, label) => {
    const t = timestamp(value, label);
    assert(t >= started, `${label}: stale source predates this refresh`);
    assert(t <= generated, `${label}: source was fetched after latest.json was generated`);
    return t;
  };
  const fetched = fresh(snapshot.fetched_at, 'mcap_snapshot.fetched_at');
  assert(snapshot.snapshot_date === new Date(fetched).toISOString().slice(0, 10), 'mcap_snapshot.snapshot_date must be the actual UTC fetch date, not the volume cutoff');
  assert(latest.classified_with === `snapshot:${snapshot.snapshot_date}`, 'latest.classified_with does not match the market-cap snapshot');
  assert(latest.threshold_usd === THRESHOLD_USD && snapshot.threshold_usd === THRESHOLD_USD, 'Market-cap threshold metadata does not match the configured threshold');
  fresh(reference.fetched_at, 'defillama_totals.fetched_at');
  assert(reference.cutoff_utc === cutoff, 'defillama_totals.cutoff_utc does not match this refresh');
  assert(snapshot.coins && Object.keys(snapshot.coins).length > 0, 'mcap_snapshot.coins: empty or missing market data');
  const expected = datesBefore(cutoffMs), result = {};
  for (const { key } of CHAINS) {
    const chain = latest.chains?.[key], label = `chains.${key}`;
    assert(chain && Array.isArray(chain.days), `${label}: missing chain or daily export`);
    sameDates(chain.days.map(d => d.date), expected, label);
    const totals = reference.chains?.[key]?.days;
    assert(totals && typeof totals === 'object', `defillama_totals.${key}: missing chain`);
    sameDates(Object.keys(totals).sort(), expected, `defillama_totals.${key}`);
    assert(snapshot.addresses?.[key] && Object.keys(snapshot.addresses[key]).length > 0, `mcap_snapshot.addresses.${key}: missing chain mapping`);
    assert(chain.mode === 'estimate', `${label}: no measured sample (mode is not estimate)`);
    for (const day of chain.days) {
      const row = `${label}.${day.date}`;
      for (const field of ['total', 'above_100m', 'below_100m']) number(day[field], `${row}.${field}`);
      number(totals[day.date].total, `defillama_totals.${key}.${day.date}.total`);
      equalNumber(day.total, totals[day.date].total, `${row}.reference_total`);
      equalNumber(day.above_100m + day.below_100m, day.total, `${row}.bucket_sum`);
      for (const field of ['sampled_total', 'sampled_above_100m']) number(day[field], `${row}.${field}`);
      assert(day.sampled_total > 0 && day.sampled_above_100m <= day.sampled_total, `${row}: missing or inconsistent sample totals`);
      if (day.total > 0) equalNumber(day.coverage, day.sampled_total / day.total, `${row}.coverage`);
      assert(day.mode === 'estimate' && day.classified_with === latest.classified_with, `${row}: inconsistent classification metadata`);
      assert(day.provisional == null || typeof day.provisional === 'boolean', `${row}.provisional: expected boolean`);
      const expectedProvisional = !!totals[day.date].provisional && expected.slice(-3).includes(day.date);
      assert(!!day.provisional === expectedProvisional, `${row}.provisional: does not match the recent reference-data status`);
      // Source ratios above one and unknown token caps are valid in this estimator.
      for (const field of ['coverage', 'unknown_share', 'boundary_share']) {
        if (day[field] != null) number(day[field], `${row}.${field}`);
        if (field !== 'coverage' && day[field] != null) assert(day[field] <= 1 + 1e-10, `${row}.${field}: share exceeds one`);
      }
    }
    result[key] = validateKpis(chain, label);
    const quality = latest.quality?.per_chain?.[key];
    assert(quality?.days === DAYS && quality.days_with_split === DAYS, `${label}: incomplete quality/split day counts`);
    if (!options.exportsOnly) {
      const idx = indexes?.[key];
      assert(idx && idx.chain === key, `${label}: missing or wrong-chain GeckoTerminal index`);
      fresh(idx.fetched_at, `${key}.pools_index.fetched_at`);
      assert(idx.cutoff_utc === cutoff, `${key}.pools_index.cutoff_utc: stale or mismatched volume window`);
      assert(Array.isArray(idx.pools) && idx.pools.length > 0, `${key}.pools_index: empty pool sample`);
      const sampled = idx.pools.filter(p => p.days && Object.keys(p.days).length > 0);
      assert(sampled.length > 0, `${key}.pools_index: no pool OHLCV history`);
      const byDay = Object.fromEntries(expected.map(d => [d, 0]));
      for (const pool of sampled) {
        for (const [date, volume] of Object.entries(pool.days)) {
          assert(Object.hasOwn(byDay, date), `${key}.pools_index: pool day ${date} lies outside the pinned cutoff window`);
          number(volume, `${key}.pools_index.${pool.address}.${date}`);
          byDay[date] += volume;
        }
      }
      for (const day of chain.days) {
        equalNumber(day.sampled_total, byDay[day.date], `${label}.${day.date}.sampled_total`);
        assert(byDay[day.date] > 0, `${label}.${day.date}: no sampled volume`);
        if (day.total > 0) equalNumber(day.coverage, byDay[day.date] / day.total, `${label}.${day.date}.coverage`);
      }
    }
  }
  validateCsv(csv, latest);
  return { cutoff_utc: cutoff, refresh_started_at: startedAt, generated_at: latest.generated_at, chains: result, rows: CHAINS.length * DAYS, exports_only: !!options.exportsOnly };
}

export function validateFiles({ directory = 'data', exportsOnly = false, cutoff = process.env.REFRESH_CUTOFF, refreshStartedAt = process.env.REFRESH_STARTED_AT } = {}) {
  const read = file => {
    const location = path.join(directory, file);
    assert(fs.existsSync(location), `Missing required data file: ${location}`);
    try { return JSON.parse(fs.readFileSync(location, 'utf8')); }
    catch (error) { throw new Error(`Invalid JSON in ${location}: ${error.message}`); }
  };
  const csvPath = path.join(directory, 'volume_daily.csv');
  assert(fs.existsSync(csvPath), `Missing required data file: ${csvPath}`);
  const bundle = { latest: read('latest.json'), snapshot: read('mcap_snapshot.json'), reference: read('defillama_totals.json'), csv: fs.readFileSync(csvPath, 'utf8') };
  if (!exportsOnly) bundle.indexes = Object.fromEntries(CHAINS.map(({ key }) => [key, read(`raw/geckoterminal/${key}/pools_index.json`)]));
  return validateData(bundle, { exportsOnly, cutoff, refreshStartedAt });
}

export function main(options = {}) {
  const result = validateFiles(options);
  console.log(`Validated ${result.rows} daily rows across ${Object.keys(result.chains).length} chains through ${new Date(Date.parse(`${result.cutoff_utc}T00:00:00Z`) - DAY).toISOString().slice(0, 10)} (${result.exports_only ? 'exports only' : 'exports and fresh pool indexes'}).`);
  for (const [key, counts] of Object.entries(result.chains)) if (counts.prior_days < 30) console.log(`${key}: ${counts.provisional_days} provisional days; prior comparison unavailable (${counts.prior_days}/30 observations).`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert(process.argv.slice(2).every(arg => arg === '--exports-only'), 'Usage: node pipeline/validate.mjs [--exports-only]');
    main({ exportsOnly: process.argv.includes('--exports-only') });
  } catch (error) {
    console.error(`Validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
