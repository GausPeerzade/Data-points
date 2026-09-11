import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { refreshDue } from '../refresh_due.mjs';
import { CHAINS } from '../../pipeline/config.mjs';
const now = new Date('2026-09-11T18:17:00Z');
const fresh = () => ({ cutoff_utc: '2026-09-11', generated_at: '2026-09-11T14:30:00Z',
  chains: Object.fromEntries(CHAINS.map(({ key }) => [key, { days: [{ date: '2026-09-10', total: 123, provisional: true }] }])) });

test('catch-up skips a published daily refresh, including provisional reference days', () => {
  assert.equal(refreshDue(fresh(), { now }).due, false);
});
test('missing, stale, invalid and future metadata request another refresh', () => {
  for (const data of [undefined, {}, { ...fresh(), cutoff_utc: '2026-09-10' },
    { ...fresh(), generated_at: 'invalid' }, { ...fresh(), generated_at: '2026-09-10T23:00:00Z' },
    { ...fresh(), generated_at: '2026-09-12T00:00:00Z' }]) assert.equal(refreshDue(data, { now }).due, true);
});
test('one missing chain or missing latest-day total cannot suppress a refresh', () => {
  for (const { key } of CHAINS) {
    let data = fresh(); delete data.chains[key]; assert.equal(refreshDue(data, { now }).due, true);
    data = fresh(); data.chains[key].days[0].date = '2026-09-09'; assert.equal(refreshDue(data, { now }).due, true);
    data = fresh(); data.chains[key].days[0].total = null; assert.equal(refreshDue(data, { now }).due, true);
  }
});
test('manual force bypasses freshness and the next UTC date becomes due', () => {
  assert.equal(refreshDue(fresh(), { now, force: true }).due, true);
  assert.equal(refreshDue(fresh(), { now: new Date('2026-09-12T14:17:00Z') }).due, true);
});
test('CLI emits a usable Actions output even when exports are malformed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-due-'));
  try {
    fs.mkdirSync(path.join(dir, 'data')); fs.writeFileSync(path.join(dir, 'data/latest.json'), '{bad');
    const output = path.join(dir, 'output');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../refresh_due.mjs', import.meta.url))], {
      cwd: dir, env: { ...process.env, GITHUB_EVENT_NAME: 'schedule', GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(output, 'utf8'), 'due=true\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
