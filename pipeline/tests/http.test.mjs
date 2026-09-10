import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getJson, getHttpMetrics, readJson, writeJson } from '../lib/http.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function tempCache(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'batch_0.json');
}

function hostSnapshot(base) {
  return getHttpMetrics()[new URL(base).host] || {
    requests: 0, cache_hits: 0, successes: 0, statuses: {}, retries: 0, network_errors: 0, timeouts: 0,
  };
}

function metricsSince(base, before) {
  return Object.fromEntries(Object.entries(hostSnapshot(base)).map(([key, value]) => [key, key === 'statuses'
    ? Object.fromEntries(Object.entries(value).map(([status, count]) => [status, count - (before.statuses[status] || 0)]).filter(([, count]) => count))
    : value - before[key]]));
}

test('404 stays optional; strict 404, 401 and 400 fail once without exposing query secrets', async (t) => {
  const calls = new Map();
  const base = await fixture(t, (req, res) => {
    const code = Number(req.url.match(/^\/(\d+)/)[1]);
    calls.set(code, (calls.get(code) || 0) + 1);
    res.writeHead(code).end('not JSON');
  });
  const before = hostSnapshot(base);
  assert.equal(await getJson(`${base}/404`), null);
  for (const code of [404, 401, 400]) {
    await assert.rejects(getJson(`${base}/${code}?api_key=do-not-log`, {
      allow404: false, maxRetries: 3, retryBaseDelayMs: 1, label: 'test-provider',
    }), (error) => {
      assert.match(error.message, new RegExp(`test-provider.*HTTP ${code}.*1 attempt.*not retryable`));
      assert.ok(!error.message.includes('do-not-log'));
      return true;
    });
  }
  assert.deepEqual(Object.fromEntries(calls), { 400: 1, 401: 1, 404: 2 });
  assert.deepEqual(metricsSince(base, before), {
    requests: 4, cache_hits: 0, successes: 0, statuses: { 400: 1, 401: 1, 404: 2 }, retries: 0, network_errors: 0, timeouts: 0,
  });
});

test('custom 404 sentinel stays distinct from a successful JSON null response, including cache hits', async (t) => {
  const cacheFile = tempCache(t);
  const missing = Symbol('missing resource');
  let calls = 0;
  const base = await fixture(t, (req, res) => {
    ++calls;
    if (req.url === '/missing') res.writeHead(404).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end('null');
  });
  const before = hostSnapshot(base);
  const opts = { cacheFile, notFoundValue: missing };
  assert.equal(await getJson(`${base}/missing`, opts), missing);
  assert.ok(!fs.existsSync(cacheFile), '404 sentinels must never be serialized as successful cache entries');
  assert.equal(await getJson(`${base}/json-null`, opts), null, 'HTTP200 null must retain its JSON value');
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), 'null');
  assert.equal(await getJson(`${base}/json-null`, opts), null, 'cached HTTP200 null is not an unavailable resource');
  assert.equal(calls, 2);
  assert.deepEqual(metricsSince(base, before), {
    requests: 2, cache_hits: 1, successes: 1, statuses: { 200: 1, 404: 1 }, retries: 0, network_errors: 0, timeouts: 0,
  });
});

test('timeout also aborts a response whose headers arrived but JSON body stalls', async (t) => {
  let calls = 0;
  const base = await fixture(t, (_req, res) => {
    ++calls;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"incomplete":');
  });
  const before = hostSnapshot(base);
  const started = Date.now();
  await assert.rejects(getJson(`${base}/slow-body`, { timeoutMs: 60, maxRetries: 1, retryBaseDelayMs: 1 }),
    /timed out after 60ms.*headers or body.*2 attempt/);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1500, 'stalled body must not hang the pipeline');
  assert.deepEqual(metricsSince(base, before), {
    requests: 2, cache_hits: 0, successes: 0, statuses: { 200: 2 }, retries: 1, network_errors: 0, timeouts: 2,
  });
});

test('timeout aborts a request that never sends headers', async (t) => {
  let calls = 0;
  const base = await fixture(t, () => { ++calls; });
  const before = hostSnapshot(base);
  await assert.rejects(getJson(`${base}/slow-headers`, { timeoutMs: 50, maxRetries: 0 }),
    /timed out after 50ms.*1 attempt/);
  assert.equal(calls, 1);
  assert.deepEqual(metricsSince(base, before), {
    requests: 1, cache_hits: 0, successes: 0, statuses: {}, retries: 0, network_errors: 0, timeouts: 1,
  });
});

test('429 Retry-After seconds delays the retry before accepting and caching JSON', async (t) => {
  const arrivals = [];
  const cacheFile = tempCache(t);
  const base = await fixture(t, (_req, res) => {
    arrivals.push(Date.now());
    if (arrivals.length === 1) res.writeHead(429, { 'retry-after': '1' }).end();
    else res.end(JSON.stringify({ volume: 123 }));
  });
  const before = hostSnapshot(base);
  assert.deepEqual(await getJson(`${base}/limited`, { maxRetries: 1, retryBaseDelayMs: 1, cacheFile }), { volume: 123 });
  assert.equal(arrivals.length, 2);
  assert.ok(arrivals[1] - arrivals[0] >= 980);
  assert.deepEqual(readJson(cacheFile), { volume: 123 });
  assert.deepEqual(metricsSince(base, before), {
    requests: 2, cache_hits: 0, successes: 1, statuses: { 200: 1, 429: 1 }, retries: 1, network_errors: 0, timeouts: 0,
  });
});

test('HTTP-date Retry-After is honored instead of being parsed as zero', async (t) => {
  const arrivals = [];
  let resumeAt;
  const base = await fixture(t, (_req, res) => {
    arrivals.push(Date.now());
    if (arrivals.length === 1) {
      resumeAt = Math.ceil(Date.now() / 1000) * 1000 + 1000;
      res.writeHead(429, { 'retry-after': new Date(resumeAt).toUTCString() }).end();
    } else res.end('{}');
  });
  await getJson(`${base}/date-limit`, { maxRetries: 1, retryBaseDelayMs: 1 });
  assert.equal(arrivals.length, 2);
  assert.ok(arrivals[1] >= resumeAt - 15, 'must wait until the server-provided date');
});

test('a queued parallel request respects a new host cooldown even when the 429 caller gives up', async (t) => {
  const arrivals = [];
  const base = await fixture(t, (_req, res) => {
    arrivals.push(Date.now());
    if (arrivals.length === 1) res.writeHead(429, { 'retry-after': '0.15' }).end();
    else res.end('{"next":true}');
  });
  const failed = getJson(`${base}/first`, { minIntervalMs: 40, maxRetries: 0, retryBaseDelayMs: 1 }).catch((error) => error);
  const next = getJson(`${base}/second`, { minIntervalMs: 40 });
  assert.match((await failed).message, /HTTP 429/);
  assert.deepEqual(await next, { next: true });
  assert.ok(arrivals[1] - arrivals[0] >= 135, 'the already queued request must recheck the cooldown');
});

test('adaptive spacing learned from 429 is retained for subsequent successful requests', async (t) => {
  const arrivals = [];
  const base = await fixture(t, (_req, res) => {
    arrivals.push(Date.now());
    if (arrivals.length === 1) res.writeHead(429).end();
    else res.end('{}');
  });
  const opts = { adaptiveRateLimit: true, minIntervalMs: 80, retryBaseDelayMs: 1, maxRetries: 1 };
  await getJson(`${base}/first`, opts);
  await getJson(`${base}/next`, opts);
  assert.equal(arrivals.length, 3);
  assert.ok(arrivals[1] - arrivals[0] >= 105, '429 should increase the 80ms floor to 120ms');
  assert.ok(arrivals[2] - arrivals[1] >= 105, 'success must not immediately reset the learned interval');
});

test('408, 503 and invalid JSON retry, but only a complete valid payload enters the cache', async (t) => {
  const cacheFile = tempCache(t);
  let calls = 0;
  const base = await fixture(t, (_req, res) => {
    ++calls;
    if (calls === 1) res.writeHead(408).end();
    else if (calls === 2) res.writeHead(503).end();
    else if (calls === 3) res.end('{broken');
    else res.end('{"complete":true}');
  });
  const before = hostSnapshot(base);
  assert.deepEqual(await getJson(`${base}/transient`, { cacheFile, maxRetries: 3, retryBaseDelayMs: 1 }), { complete: true });
  assert.equal(calls, 4);
  assert.deepEqual(await getJson(`${base}/transient`, { cacheFile }), { complete: true });
  assert.equal(calls, 4, 'matching cache should bypass the network');
  assert.deepEqual(metricsSince(base, before), {
    requests: 4, cache_hits: 1, successes: 1, statuses: { 200: 2, 408: 1, 503: 1 }, retries: 3, network_errors: 0, timeouts: 0,
  });
});

test('network failures count attempted retries without fabricating HTTP statuses or timeouts', async (t) => {
  let calls = 0;
  const base = await fixture(t, (req, res) => {
    ++calls;
    if (req.url === '/always-fails' || calls === 1) req.socket.destroy();
    else res.end('{"recovered":true}');
  });
  const before = hostSnapshot(base);
  assert.deepEqual(await getJson(`${base}/recover`, { maxRetries: 1, retryBaseDelayMs: 1 }), { recovered: true });
  assert.deepEqual(metricsSince(base, before), {
    requests: 2, cache_hits: 0, successes: 1, statuses: { 200: 1 }, retries: 1, network_errors: 1, timeouts: 0,
  });
  const recovered = hostSnapshot(base);
  await assert.rejects(getJson(`${base}/always-fails`, { maxRetries: 1, retryBaseDelayMs: 1 }), /network error.*2 attempt/);
  assert.deepEqual(metricsSince(base, recovered), {
    requests: 2, cache_hits: 0, successes: 0, statuses: {}, retries: 1, network_errors: 2, timeouts: 0,
  });
  assert.equal(calls, 4);
});

test('metrics snapshots remain detached and exclude request, response and credential details', async (t) => {
  const cacheFile = tempCache(t);
  const secret = 'metrics-must-not-retain-this';
  const base = await fixture(t, (_req, res) => res.end(JSON.stringify({ secret })));
  const host = new URL(base).host;
  const before = hostSnapshot(base);
  const url = `${base}/${secret}?api_key=${secret}`;
  const opts = { cacheFile, headers: { authorization: secret }, label: secret };
  await getJson(url, opts);
  const snapshot = getHttpMetrics();
  const preserved = structuredClone(snapshot);
  await getJson(url, opts);
  assert.deepEqual(snapshot, preserved, 'later cache hits must not change earlier snapshots used for deltas');
  snapshot[host].requests = -100;
  snapshot[host].statuses[200] = -100;
  snapshot[host].statuses.fake = secret;
  snapshot.fake = { secret };
  assert.deepEqual(metricsSince(base, before), {
    requests: 1, cache_hits: 1, successes: 1, statuses: { 200: 1 }, retries: 0, network_errors: 0, timeouts: 0,
  });
  const serialized = JSON.stringify(getHttpMetrics());
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('api_key'));
  assert.ok(!serialized.includes('authorization'));
  assert.ok(!serialized.includes('http://'));
});

test('same batch filename cannot serve a different URL, legacy entry or mismatched sidecar', async (t) => {
  const cacheFile = tempCache(t);
  let calls = 0;
  const base = await fixture(t, (req, res) => {
    ++calls;
    res.end(JSON.stringify({ requested: req.url }));
  });
  writeJson(cacheFile, { legacy: true });
  assert.deepEqual(await getJson(`${base}/tokens?ids=A`, { cacheFile }), { requested: '/tokens?ids=A' });
  assert.equal(calls, 1, 'legacy cache must be refetched once to establish request identity');
  await getJson(`${base}/tokens?ids=A`, { cacheFile });
  assert.equal(calls, 1);
  assert.deepEqual(await getJson(`${base}/tokens?ids=B`, { cacheFile }), { requested: '/tokens?ids=B' });
  assert.equal(calls, 2, 'a changed token batch must not reuse the previous response');
  writeJson(cacheFile, { interruptedReplacement: true });
  assert.deepEqual(await getJson(`${base}/tokens?ids=B`, { cacheFile }), { requested: '/tokens?ids=B' });
  assert.equal(calls, 3, 'a sidecar must also match its payload');
  const futureMtime = new Date(Date.now() + 10000);
  fs.utimesSync(cacheFile, futureMtime, futureMtime);
  await getJson(`${base}/tokens?ids=B`, { cacheFile, ttlMs: 0 });
  assert.equal(calls, 4, 'force refresh must bypass a valid cache even when file timestamp precision or clock skew puts its mtime in the future');
  const metadata = readJson(`${cacheFile}.meta.json`);
  assert.ok(!JSON.stringify(metadata).includes('ids='), 'sidecar must not store URL credentials');
});

test('failed fetch keeps previous cache intact, and malformed cached JSON can be recovered', async (t) => {
  const cacheFile = tempCache(t);
  let mode = 'success';
  const base = await fixture(t, (_req, res) => {
    if (mode === 'error') res.writeHead(500).end();
    else res.end('{"value":7}');
  });
  await getJson(`${base}/data`, { cacheFile });
  const previous = fs.readFileSync(cacheFile, 'utf8');
  const metadata = fs.readFileSync(`${cacheFile}.meta.json`, 'utf8');
  mode = 'error';
  await assert.rejects(getJson(`${base}/data`, { cacheFile, ttlMs: 0, maxRetries: 0 }), /HTTP 500/);
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), previous);
  assert.equal(fs.readFileSync(`${cacheFile}.meta.json`, 'utf8'), metadata);
  mode = 'success';
  fs.writeFileSync(`${cacheFile}.meta.json`, '{corrupt');
  assert.deepEqual(await getJson(`${base}/data`, { cacheFile }), { value: 7 });
  assert.deepEqual(fs.readdirSync(path.dirname(cacheFile)).sort(), ['batch_0.json', 'batch_0.json.meta.json']);
});

test('atomic JSON replacement preserves original data if serialization fails', (t) => {
  const cacheFile = tempCache(t);
  writeJson(cacheFile, { stable: true });
  const circular = {}; circular.self = circular;
  assert.throws(() => writeJson(cacheFile, circular), /circular/i);
  assert.deepEqual(readJson(cacheFile), { stable: true });
  assert.deepEqual(fs.readdirSync(path.dirname(cacheFile)), ['batch_0.json']);
});
