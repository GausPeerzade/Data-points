// Zero-dependency HTTP helper: per-host rate limiting, retry/backoff, disk cache.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const queues = new Map();
const metrics = new Map();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostMetrics(host) {
  if (!metrics.has(host)) {
    metrics.set(host, { requests: 0, cache_hits: 0, successes: 0, statuses: {}, retries: 0, network_errors: 0, timeouts: 0 });
  }
  return metrics.get(host);
}

// Cumulative process-local counters, detached so callers can compare snapshots.
// Only hosts and status codes are retained; request URLs and credentials are not.
// Successes count complete valid 2xx JSON responses, excluding cache hits/404s.
export function getHttpMetrics() {
  return Object.fromEntries([...metrics].map(([host, counts]) => [host, { ...counts, statuses: { ...counts.statuses } }]));
}

function hostQueue(host) {
  const q = queues.get(host) || { last: 0, chain: Promise.resolve(), cooldownUntil: 0, interval: 0, floor: 0, successes: 0 };
  queues.set(host, q);
  return q;
}

async function schedule(host, minIntervalMs, adaptiveRateLimit) {
  const q = hostQueue(host);
  if (adaptiveRateLimit) q.floor = Math.max(q.floor, minIntervalMs);
  const p = q.chain.then(async () => {
    // Recheck after sleeping: an in-flight request may have extended the host's
    // cooldown while this request was waiting for its slot.
    for (;;) {
      const wait = Math.max(q.last + Math.max(minIntervalMs, q.interval), q.cooldownUntil) - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
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
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj), { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export const utcMidnight = (ms) => Math.floor(ms / 86400000) * 86400; // seconds
export const dateStr = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
export const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

const digest = (value) => createHash('sha256').update(value).digest('hex');

function cachedJson(file, url, ttlMs) {
  if (ttlMs <= 0) return { hit: false };
  try {
    if (Date.now() - fs.statSync(file).mtimeMs >= ttlMs) return { hit: false };
    const metadata = readJson(`${file}.meta.json`);
    if (metadata?.version !== 1 || metadata.urlHash !== digest(url)) return { hit: false };
    const contents = fs.readFileSync(file, 'utf8');
    // Binding both files prevents a stale sidecar from validating new contents
    // after an interrupted write or two requests sharing a cache filename.
    if (metadata.bodyHash !== digest(contents)) return { hit: false };
    return { hit: true, value: JSON.parse(contents) };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { hit: false };
    throw error;
  }
}

function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
}

export async function getJson(url, opts = {}) {
  const {
    minIntervalMs = 0, headers = {}, cacheFile, ttlMs = Infinity, maxRetries = 6,
    allow404 = true, notFoundValue = null, label, timeoutMs = 45000, adaptiveRateLimit = false,
    retryBaseDelayMs = 3000,
  } = opts;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive finite number');
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error('minIntervalMs must be a non-negative finite number');
  if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0) throw new Error('retryBaseDelayMs must be a non-negative finite number');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('maxRetries must be a non-negative integer');
  url = String(url);
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const counts = hostMetrics(host);
  // Do not expose query parameters, which can contain credentials, in logs.
  const context = `[${label || host}] ${parsedUrl.origin}${parsedUrl.pathname}`;
  if (cacheFile) {
    const cached = cachedJson(cacheFile, url, ttlMs);
    if (cached.hit) {
      ++counts.cache_hits;
      return cached.value;
    }
  }
  let attempt = 0;
  for (;;) {
    await schedule(host, minIntervalMs, adaptiveRateLimit);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ++counts.timeouts; controller.abort(); }, timeoutMs);
    let res, json, failure;
    try {
      ++counts.requests;
      if (attempt > 0) ++counts.retries;
      res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: controller.signal });
      counts.statuses[res.status] = (counts.statuses[res.status] || 0) + 1;
      if (res.ok) {
        // Keep the deadline active until the complete body has been received.
        const body = await res.text();
        try { json = JSON.parse(body); } catch (cause) { failure = new Error('invalid JSON response', { cause }); }
      } else {
        await res.body?.cancel();
      }
    } catch (cause) {
      if (!timedOut) ++counts.network_errors;
      failure = new Error(timedOut ? `request timed out after ${timeoutMs}ms (headers or body)` : `network error: ${cause.message}`, { cause });
    } finally {
      clearTimeout(timer);
    }

    if (!failure && res.status === 404 && allow404) return notFoundValue;
    if (!failure && res.ok) {
      ++counts.successes;
      const q = hostQueue(host);
      if (adaptiveRateLimit && ++q.successes >= 20) {
        q.interval = Math.max(q.floor, q.interval * 0.9);
        q.successes = 0;
      }
      if (cacheFile) {
        writeJson(cacheFile, json);
        writeJson(`${cacheFile}.meta.json`, { version: 1, urlHash: digest(url), bodyHash: digest(JSON.stringify(json)) });
      }
      return json;
    }

    const status = res?.status;
    failure ||= new Error(`HTTP ${status}`);
    const retryable = !res || failure.message.startsWith('network error') || timedOut ||
      (res.ok && failure) || status === 408 || status === 429 || status >= 500;
    const backoff = retryBaseDelayMs * (attempt + 1) * (status === 429 ? 2 : res && !res.ok ? 4 / 3 : 1);
    const wait = Math.max(backoff, retryAfterMs(res?.headers.get('retry-after')));
    if (status === 429) {
      const q = hostQueue(host);
      q.cooldownUntil = Math.max(q.cooldownUntil, Date.now() + wait);
      q.successes = 0;
      if (adaptiveRateLimit) q.interval = Math.max(q.floor, Math.min(30000, Math.max(q.interval, q.floor, 1) * 1.5));
    }
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`${context}: ${failure.message}; failed after ${attempt + 1} attempt(s)${retryable ? '' : ' (not retryable)'}`, { cause: failure });
    }
    ++attempt;
    console.error(`  ${context}: ${failure.message}, retry ${attempt}/${maxRetries} in ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
  }
}
