import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { refreshCutoff } from '../lib/run_context.mjs';

const withCutoff = (t, value) => {
  const original = process.env.REFRESH_CUTOFF;
  if (value == null) delete process.env.REFRESH_CUTOFF;
  else process.env.REFRESH_CUTOFF = value;
  t.after(() => { if (original == null) delete process.env.REFRESH_CUTOFF; else process.env.REFRESH_CUTOFF = original; });
};

test('a crawl crossing UTC midnight retains the same reference and candle cutoff', (t) => {
  withCutoff(t, '2026-09-10');
  let now = Date.parse('2026-09-10T23:59:00Z');
  t.mock.method(Date, 'now', () => now);
  const initial = refreshCutoff();
  now = Date.parse('2026-09-11T03:20:00Z');
  assert.equal(refreshCutoff(), initial);
  assert.equal(initial, Date.parse('2026-09-10T00:00:00Z') / 1000);
});

test('an unpinned standalone fetch uses UTC midnight rather than local timezone', (t) => {
  withCutoff(t, null);
  t.mock.method(Date, 'now', () => Date.parse('2026-09-10T00:15:00+05:30'));
  assert.equal(refreshCutoff(), Date.parse('2026-09-09T00:00:00Z') / 1000);
});

test('invalid dates, normalized impossible dates and future windows fail before fetching', (t) => {
  withCutoff(t, null);
  t.mock.method(Date, 'now', () => Date.parse('2026-09-10T12:00:00Z'));
  for (const value of ['2026-02-30', '2026-13-01', '2026-9-1', '2026-09-10T12:00:00Z', 'garbage', '2026-09-11']) {
    process.env.REFRESH_CUTOFF = value;
    assert.throws(() => refreshCutoff(), /REFRESH_CUTOFF/, value);
  }
});

test('the complete-refresh CLI rejects skip/only flags before creating data or making provider requests', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-run-flags-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const guard = path.join(temporary, 'forbid-network.mjs');
  fs.writeFileSync(guard, `import fs from 'node:fs';
globalThis.fetch = async () => {
  fs.writeFileSync('unexpected-provider-request', 'fetch was called');
  throw new Error('Network requests are forbidden in this test');
};
`);
  const runner = fileURLToPath(new URL('../run.mjs', import.meta.url));
  for (const args of [['--skip-gt'], ['--only', 'ethereum']]) {
    const child = spawnSync(process.execPath, ['--import', guard, runner, ...args], {
      cwd: temporary, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(child.error, undefined, `CLI process should exit promptly for ${args.join(' ')}`);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /A validated refresh requires every chain\. Run without flags/);
    assert.ok(!child.stdout.includes('== defillama =='), 'the first pipeline stage must not start');
    assert.deepEqual(fs.readdirSync(temporary), ['forbid-network.mjs'], 'no data or provider-request marker should be created');
  }
});
