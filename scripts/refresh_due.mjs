// Catch-up schedules check published main before spending API credits.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CHAINS } from '../pipeline/config.mjs';

export function refreshDue(data, { now = new Date(), force = false } = {}) {
  if (force) return { due: true, reason: 'Manual refresh requested.' };
  const cutoff = now.toISOString().slice(0, 10);
  const previousDay = new Date(Date.parse(cutoff) - 86400000).toISOString().slice(0, 10);
  const generated = Date.parse(data?.generated_at);
  if (data?.cutoff_utc !== cutoff || !Number.isFinite(generated) || generated < Date.parse(cutoff) || generated > now.getTime()) {
    return { due: true, reason: `No published refresh for UTC cutoff ${cutoff}.` };
  }
  for (const { key } of CHAINS) {
    const days = data?.chains?.[key]?.days;
    if (!Array.isArray(days) || !days.some((d) => d.date === previousDay && Number.isFinite(d.total))) {
      return { due: true, reason: `${key} is missing the latest closed UTC day.` };
    }
  }
  return { due: false, reason: `UTC cutoff ${cutoff} already published; skipping the API crawl.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let data;
  try { data = JSON.parse(fs.readFileSync('data/latest.json', 'utf8')); }
  catch { /* Missing/broken exports need a refresh, not a skipped job. */ }
  const force = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.SKIP_IF_FRESH !== 'true';
  const result = refreshDue(data, { force });
  console.log(result.reason);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${result.due}\n`);
}
