// Zero-dependency HTTP helper: per-host rate limiting, retry/backoff, disk cache.
import fs from 'node:fs';
import path from 'node:path';

const queues = new Map();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function schedule(host, minIntervalMs) {
  const q = queues.get(host) || { last: 0, chain: Promise.resolve() };
  queues.set(host, q);
  const p = q.chain.then(async () => {
    const wait = q.last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    q.last = Date.now();
  });
  q.chain = p.catch(() => {});
  return p;
}

export function readJson(file, fallback = undefined) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function writeJson(file, obj, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj));
}
export const utcMidnight = (ms) => Math.floor(ms / 86400000) * 86400; // seconds
export const dateStr = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
export const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

export async function getJson(url, opts = {}) {
  const { minIntervalMs = 0, headers = {}, cacheFile, ttlMs = Infinity, maxRetries = 6, allow404 = true, label } = opts;
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < ttlMs) return readJson(cacheFile);
  }
  const host = new URL(url).host;
  let attempt = 0;
  for (;;) {
    await schedule(host, minIntervalMs);
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
    } catch (e) {
      if (++attempt > maxRetries) throw e;
      console.error(`  [${label || host}] network error (${e.message}), retry ${attempt}`);
      await sleep(3000 * attempt);
      continue;
    }
    if (res.status === 404 && allow404) return null;
    if (res.ok) {
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        if (++attempt > maxRetries) throw new Error(`bad json from ${url}`);
        await sleep(3000 * attempt);
        continue;
      }
      if (cacheFile) writeJson(cacheFile, json);
      return json;
    }
    if (++attempt > maxRetries) throw new Error(`HTTP ${res.status} for ${url}`);
    const ra = Number(res.headers.get('retry-after')) || 0;
    const wait = res.status === 429 ? Math.max(ra * 1000, 6000 * attempt) : 4000 * attempt;
    console.error(`  [${label || host}] HTTP ${res.status}, retry ${attempt}/${maxRetries} in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}
