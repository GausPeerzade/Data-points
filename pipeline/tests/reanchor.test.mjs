import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reanchor, dailyCsv } from '../reanchor.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../../data/latest.json', import.meta.url)));
const reference = JSON.parse(fs.readFileSync(new URL('../../data/defillama_totals.json', import.meta.url)));
const close = (actual, expected) => assert(Math.abs(actual - expected) <= Math.max(1e-10, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
const numericTree = (actual, expected) => {
  if (typeof expected === 'number') close(actual, expected);
  else if (expected && typeof expected === 'object') for (const key of Object.keys(expected)) numericTree(actual[key], expected[key]);
  else assert.deepEqual(actual, expected);
};
function scenario(sample, above, total) {
  const date = '2026-09-06';
  return [{ generated_at: '2026-09-07T12:00:00Z', classified_with: 'snapshot:2026-09-07',
    chains: { chain: { days: [{ date, total: 100, sampled_total: sample, sampled_above_100m: above,
      unknown_share: 0.2, boundary_share: 0.1, mode: 'estimate' }] } }, quality: { per_chain: { chain: {} } } },
  { fetched_at: '2026-09-07T18:00:00Z', chains: { chain: { days: { [date]: { total, headline: total } } } } }];
}

test('unchanged totals preserve every published row, KPI and quality metric; timestamp and input stay intact', () => {
  const before = structuredClone(data);
  const result = reanchor(data, reference);
  for (const key of Object.keys(data.chains)) {
    numericTree(result.chains[key], data.chains[key]);
    numericTree(result.quality.per_chain[key], data.quality.per_chain[key]);
  }
  assert.deepEqual(data, before);
  assert.equal(result.generated_at, data.generated_at);
  assert.equal(result.classified_with, data.classified_with);
  assert.equal(result.reference_refreshed_at, reference.fetched_at);
});

test('late total revisions cross both estimator branches without inventing additional sampled volume', () => {
  for (const [sample, above, total, expectedAbove, expectedBelow] of [
    [80, 50, 60, 37.5, 22.5], [80, 50, 200, 50, 150],
    [120, 60, 200, 60, 140], [120, 60, 100, 50, 50], [80, 50, 80, 50, 30],
  ]) {
    const [input, ref] = scenario(sample, above, total);
    const result = reanchor(input, ref), day = result.chains.chain.days[0];
    close(day.above_100m, expectedAbove); close(day.below_100m, expectedBelow);
    close(day.coverage, sample / total);
    close(result.quality.per_chain.chain.unknown_share_30d, 0.2);
    close(result.quality.per_chain.chain.boundary_share_30d, 0.1);
    const again = reanchor(result, ref);
    assert.deepEqual(again, result);
  }
});

test('unavailable sample stays unavailable instead of turning all volume into small caps', () => {
  const result = reanchor(...scenario(null, null, 200));
  const day = result.chains.chain.days[0];
  assert.equal(day.above_100m, null); assert.equal(day.below_100m, null);
  assert.equal(day.coverage, null); assert.equal(result.chains.chain.kpi.above_30d, null);
});

test('new provisional last day moves KPI dates back and uses the matching volume-weighted sample window', () => {
  const ref = structuredClone(reference), key = Object.keys(data.chains)[0];
  const dates = Object.keys(ref.chains[key].days).sort(), last = dates.at(-1);
  Object.assign(ref.chains[key].days[last], { provisional: true, missing_protocols: ['test venue'], missing_est: 100 });
  const result = reanchor(data, ref), chain = result.chains[key];
  assert.equal(chain.days.at(-1).provisional, true);
  const complete = chain.days.filter(d => !d.provisional), window = complete.slice(-30);
  assert.equal(chain.kpi.window.to, window.at(-1).date);
  assert.equal(chain.last_complete_day, window.at(-1).date);
  close(chain.kpi.total_30d, window.reduce((s, d) => s + d.total, 0));
  close(result.quality.per_chain[key].coverage_30d,
    window.reduce((s, d) => s + d.sampled_total, 0) / window.reduce((s, d) => s + d.total, 0));
  delete ref.chains[key].days[last].provisional;
  const restored = reanchor(result, ref);
  assert.equal(restored.chains[key].days.at(-1).provisional, undefined);
  assert.equal(restored.chains[key].last_complete_day, last);
});

test('rejects UTC rollover, missing chain, invalid totals and corrupt samples before producing a candidate', () => {
  let [input, ref] = scenario(80, 50, 100);
  ref.chains.chain.days['2026-09-07'] = { total: 100 };
  assert.throws(() => reanchor(input, ref), /date window changed/);
  assert.throws(() => reanchor(input, { chains: {} }), /Missing reference chain/);
  for (const bad of [0, -1, NaN, Infinity]) {
    [input, ref] = scenario(80, 50, bad);
    assert.throws(() => reanchor(input, ref), /invalid reference total/);
  }
  for (const [sample, above] of [[-1, 0], [Infinity, 0], [80, 81], [80, null]]) {
    [input, ref] = scenario(sample, above, 100);
    assert.throws(() => reanchor(input, ref), /invalid sample/);
  }
});

test('CSV contains exactly the candidate rows, including blank unmeasured buckets', () => {
  const result = reanchor(data, reference), lines = dailyCsv(result).split('\n');
  const days = Object.entries(result.chains).flatMap(([key, chain]) => chain.days.map(d => [key, d]));
  assert.equal(lines.length, days.length + 1);
  days.forEach(([key, d], i) => {
    const fields = lines[i + 1].split(',');
    assert.equal(fields.length, 10); assert.equal(fields[0], key); assert.equal(fields[1], d.date);
    close(Number(fields[2]), d.total);
    if (d.above_100m != null) close(Number(fields[3]), d.above_100m);
  });
  assert.equal(dailyCsv(reanchor(...scenario(null, null, 100))).split('\n')[1].split(',')[3], '');
});
