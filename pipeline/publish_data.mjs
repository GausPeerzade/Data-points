// Used only by the scheduled workflow, after source/export validation has succeeded.
// Build each publication attempt from the latest main so concurrent UI changes survive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHAINS } from './config.mjs';

export const GENERATED_FILES = [
  'data/latest.json', 'data/defillama_totals.json', 'data/mcap_snapshot.json', 'data/volume_daily.csv',
  ...CHAINS.map((c) => `data/audit/pools_${c.key}.csv`),
];

export function assertNewerData(candidate, published) {
  const next = Date.parse(candidate.generated_at), current = Date.parse(published.generated_at);
  if (!Number.isFinite(next) || !Number.isFinite(current)) throw new Error('Invalid dataset generation timestamp');
  if (next <= current) throw new Error('Main already contains equally recent or newer generated data; refusing to replace it');
  for (const c of CHAINS) {
    const dates = (data) => (data.chains?.[c.key]?.days || []).map((d) => d.date).sort();
    const nextDay = dates(candidate).at(-1), currentDay = dates(published).at(-1);
    if (!nextDay || (currentDay && nextDay < currentDay)) throw new Error(`${c.key}: candidate would move the published date window backwards`);
  }
}

function command(program, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${program} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// Command injection supports deterministic orchestration tests without any real git writes or network calls.
export function publishData({ cwd = process.cwd(), env = process.env, run = command } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Publication is restricted to the GitHub Actions main-branch workflow');
  }
  const git = (args, options = {}) => run('git', args, { cwd, ...options });
  run(process.execPath, ['pipeline/validate.mjs'], { cwd });
  const source = git(['rev-parse', 'HEAD']).stdout;
  const candidate = JSON.parse(fs.readFileSync(path.join(cwd, 'data/latest.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'volume-publication-'));
  let rejectedHead = null;
  try {
    for (const file of GENERATED_FILES) {
      const destination = path.join(temp, 'generated', file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(cwd, file), destination);
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      git(['fetch', '--no-tags', 'origin', 'main']);
      const head = git(['rev-parse', 'FETCH_HEAD']).stdout;
      if (head === rejectedHead) throw new Error('Push failed without main advancing; check repository permissions or branch protection');
      const changed = git(['diff', '--name-only', source, head, '--', 'pipeline/']).stdout;
      if (changed) throw new Error(`Pipeline source changed while data was being fetched; rerun with current main before publishing:\n${changed}`);
      const checkout = path.join(temp, `attempt-${attempt}`);
      git(['worktree', 'add', '--detach', checkout, head]);
      try {
        const published = JSON.parse(fs.readFileSync(path.join(checkout, 'data/latest.json'), 'utf8'));
        assertNewerData(candidate, published);
        for (const file of GENERATED_FILES) {
          const destination = path.join(checkout, file);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(path.join(temp, 'generated', file), destination);
        }
        // The current checkout supplies index.html, assets and the snapshot encoder.
        run(process.execPath, ['pipeline/snapshot.mjs'], { cwd: checkout });
        run(process.execPath, ['pipeline/validate.mjs', '--exports-only'], { cwd: checkout });
        git(['add', '--', ...GENERATED_FILES, 'data/snapshot.html'], { cwd: checkout });
        git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
          'commit', '-m', `data: refresh ${env.REFRESH_CUTOFF || candidate.generated_at.slice(0, 10)}`], { cwd: checkout });
        const push = git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: checkout, allowFailure: true });
        if (push.status === 0) { console.log(`Published validated data on attempt ${attempt}`); return; }
        rejectedHead = head;
        console.error(`Publication attempt ${attempt} rejected; checking whether main advanced. ${push.stderr}`);
      } finally {
        git(['worktree', 'remove', '--force', checkout]);
      }
    }
    throw new Error('Main advanced during all three publication attempts; generated data is retained in the workflow artifact');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.argv.includes('--publish')) throw new Error('Pass --publish only from the authorized workflow');
  publishData();
}
