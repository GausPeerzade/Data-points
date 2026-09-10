import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAINS } from '../config.mjs';
import { GENERATED_FILES, assertNewerData, publishData } from '../publish_data.mjs';

const data = (generated_at, lastDay) => ({ generated_at, chains: Object.fromEntries(CHAINS.map((c) => [c.key, { days: [{ date: lastDay }] }])) });
const fresh = () => data('2026-09-10T12:00:00Z', '2026-09-09');
const previous = () => data('2026-09-09T12:00:00Z', '2026-09-08');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-check-'));
  const cwd = path.join(root, 'source'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of GENERATED_FILES) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), file.endsWith('latest.json') ? JSON.stringify(fresh()) : `generated ${file}`);
  }
  fs.writeFileSync(path.join(cwd, 'index.html'), 'original source UI');
  fs.writeFileSync(path.join(cwd, 'data/README.md'), 'original source documentation');
  const calls = [], commits = [], heads = options.heads || ['ui-one', 'ui-two'];
  let fetched = -1, pushed = 0;
  // Every external command is simulated: tests do not call git, create commits, push, or use the network.
  const run = (program, args, commandOptions) => {
    const where = commandOptions.cwd;
    calls.push({ program, args, cwd: where });
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (program !== 'git') {
      if (args[0] === 'pipeline/validate.mjs') {
        if (options.failValidation && args.includes('--exports-only')) throw new Error('Invalid candidate export');
        return ok();
      }
      assert.equal(args[0], 'pipeline/snapshot.mjs');
      fs.writeFileSync(path.join(where, 'data/snapshot.html'), fs.readFileSync(path.join(where, 'index.html'), 'utf8'));
      return ok();
    }
    if (args[0] === 'rev-parse') return ok(args[1] === 'HEAD' ? 'source' : heads[Math.min(fetched, heads.length - 1)]);
    if (args[0] === 'fetch') { fetched++; return ok(); }
    if (args[0] === 'diff') return ok(options.changedPipelineAt === fetched ? 'pipeline/classify.mjs' : '');
    if (args[0] === 'worktree' && args[1] === 'add') {
      const target = args[3]; fs.mkdirSync(path.join(target, 'data'), { recursive: true });
      fs.writeFileSync(path.join(target, 'index.html'), `latest UI ${args[4]}`);
      fs.writeFileSync(path.join(target, 'data/README.md'), `latest docs ${args[4]}`);
      fs.writeFileSync(path.join(target, 'data/latest.json'), JSON.stringify(options.published || previous()));
      return ok();
    }
    if (args[0] === 'worktree' && args[1] === 'remove') { fs.rmSync(args[3], { recursive: true }); return ok(); }
    if (args[0] === 'add') {
      assert.deepEqual(args.slice(2), [...GENERATED_FILES, 'data/snapshot.html']);
      return ok();
    }
    if (args.includes('commit')) {
      const snapshot = fs.readFileSync(path.join(where, 'data/snapshot.html'), 'utf8');
      const readme = fs.readFileSync(path.join(where, 'data/README.md'), 'utf8');
      const last = calls.at(-3);
      assert.equal(last.args[0], 'pipeline/validate.mjs');
      assert.ok(last.args.includes('--exports-only'));
      commits.push({ snapshot, readme }); return ok();
    }
    if (args[0] === 'push') {
      assert.deepEqual(args, ['push', 'origin', 'HEAD:refs/heads/main']);
      const rejected = options.rejectAll || pushed++ < (options.rejectCount ?? 1);
      return rejected ? { status: 1, stdout: '', stderr: 'main advanced' } : ok();
    }
    throw new Error(`Unexpected simulated command: ${program} ${args.join(' ')}`);
  };
  return { cwd, calls, commits, root, run, env: { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', REFRESH_CUTOFF: '2026-09-10', RUNNER_TEMP: root } };
}

test('a rejected push rebuilds with the newest UI and preserves newer docs while publishing only generated files', (t) => {
  const f = fixture(t); publishData(f);
  assert.deepEqual(f.commits, [
    { snapshot: 'latest UI ui-one', readme: 'latest docs ui-one' },
    { snapshot: 'latest UI ui-two', readme: 'latest docs ui-two' },
  ]);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'index.html'), 'utf8'), 'original source UI');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'data/README.md'), 'utf8'), 'original source documentation');
  assert.deepEqual(fs.readdirSync(f.root), ['source']);
  const commitCalls = f.calls.filter((call) => call.program === 'git' && call.args.includes('commit'));
  assert.equal(commitCalls.length, 2);
  for (const call of commitCalls) {
    assert.deepEqual(call.args, [
      '-c', 'user.name=github-actions[bot]',
      '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', 'data: refresh 2026-09-10',
    ], 'each publication attempt must retain explicit GitHub Actions bot attribution');
  }
});

test('if pipeline code changes after a rejected push, no candidate is rebuilt or committed under that changed code', (t) => {
  const f = fixture(t, { changedPipelineAt: 1 });
  assert.throws(() => publishData(f), /Pipeline source changed/);
  assert.equal(f.commits.length, 1);
  assert.equal(f.calls.filter((c) => c.args[0] === 'push').length, 1);
  assert.deepEqual(fs.readdirSync(f.root), ['source']);
});

test('a newer published dataset stops publication before staging, even when the candidate source is compatible', (t) => {
  const f = fixture(t, { published: data('2026-09-10T13:00:00Z', '2026-09-09') });
  assert.throws(() => publishData(f), /equally recent or newer/);
  assert.equal(f.calls.filter((c) => c.args[0] === 'add' || c.args[0] === 'push').length, 0);
});

test('a late generated timestamp cannot hide a regressed date window on one chain', () => {
  const candidate = fresh(), published = previous();
  candidate.chains.solana.days = [{ date: '2026-09-07' }];
  assert.throws(() => assertNewerData(candidate, published), /solana.*backwards/);
});

test('export validation failure after rebuilding snapshot prevents staging and publication', (t) => {
  const f = fixture(t, { failValidation: true });
  assert.throws(() => publishData(f), /Invalid candidate export/);
  assert.equal(f.commits.length, 0);
  assert.equal(f.calls.filter((c) => c.args[0] === 'add' || c.args[0] === 'push').length, 0);
  assert.deepEqual(fs.readdirSync(f.root), ['source']);
});

test('continuous main advancement stops at three normal pushes; unchanged-head failures stop after one', (t) => {
  const moving = fixture(t, { heads: ['ui-one', 'ui-two', 'ui-three'], rejectAll: true });
  assert.throws(() => publishData(moving), /all three publication attempts/);
  assert.equal(moving.commits.length, 3);
  const stationary = fixture(t, { heads: ['ui-one'], rejectAll: true });
  assert.throws(() => publishData(stationary), /without main advancing/);
  assert.equal(stationary.commits.length, 1);
});

test('local and non-main invocations are rejected before any external command', () => {
  for (const env of [{}, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature' }]) {
    assert.throws(() => publishData({ env, run: () => assert.fail('must not run a command') }), /restricted/);
  }
});
