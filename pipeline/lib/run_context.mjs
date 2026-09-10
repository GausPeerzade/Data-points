import { utcMidnight, dateStr } from './http.mjs';

// One run keeps one closed-day window even if its API crawl crosses UTC midnight.
export function refreshCutoff() {
  const value = process.env.REFRESH_CUTOFF;
  if (!value) return utcMidnight(Date.now());
  const parsed = Date.parse(value + 'T00:00:00.000Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || dateStr(parsed / 1000) !== value) {
    throw new Error('REFRESH_CUTOFF must be a valid UTC date (YYYY-MM-DD)');
  }
  if (parsed / 1000 > utcMidnight(Date.now())) throw new Error('REFRESH_CUTOFF cannot be in the future');
  return parsed / 1000;
}
