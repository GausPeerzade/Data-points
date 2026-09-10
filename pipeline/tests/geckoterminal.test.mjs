import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { capsOnly, main, ohlcvCandles, UNAVAILABLE_POOL } from '../fetch_geckoterminal.mjs';
import { CHAINS } from '../config.mjs';
import { readJson, writeJson } from '../lib/http.mjs';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const stamp = (hoursAgo) => new Date(NOW - hoursAgo * 3600000).toISOString();
const evmAddress = (index) => `0x${index.toString(16).padStart(40, '0')}`;

function workspace(t, chain, pools, caps = {}, snapshot = {}) {
  const previous = process.cwd();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-gt-caps-'));
  process.chdir(temporary);
  t.after(() => { process.chdir(previous); fs.rmSync(temporary, { recursive: true, force: true }); });
  writeJson('data/mcap_snapshot.json', {
    stable_ids: [], coins: {}, addresses: Object.fromEntries(CHAINS.map((c) => [c.key, {}])), ...snapshot,
  });
  const directory = `data/raw/geckoterminal/${chain}`;
  writeJson(`${directory}/pools_index.json`, { chain, pools });
  writeJson(`${directory}/token_caps.json`, caps);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  return `${directory}/token_caps.json`;
}

// Drive only mocked timers: network responses are local Response objects, while
// the production host scheduler still exercises its real queue and backoff.
async function finish(t, pending) {
  let settled = false, result, failure;
  pending.then((value) => { result = value; settled = true; }, (error) => { failure = error; settled = true; });
  for (let tick = 0; tick < 200 && !settled; tick++) {
    await nextTurn();
    if (!settled) t.mock.timers.tick(5000);
  }
  assert.ok(settled, 'operation must finish without a real timer or external request');
  if (failure) throw failure;
  return result;
}

function token(address, cap = '125000000') {
  return { attributes: { address, symbol: 'TEST', name: 'Test token', market_cap_usd: cap, fdv_usd: '250000000', volume_usd: { h24: '90000' } } };
}

test('previous missing/legacy caps are rechecked, while fresh positive and fresh missing records are reused', async (t) => {
  const [legacyMissing, staleKnown, freshKnown, freshMissing, covered, noDays] = [1, 2, 3, 4, 5, 6].map(evmAddress);
  const originalFresh = { market_cap_usd: 110000000, fetched_at: stamp(1) };
  const originalMissing = { missing: true, fetched_at: stamp(1) };
  const cache = workspace(t, 'ethereum', [
    { base: legacyMissing, quote: freshKnown, days: { '2026-09-09': 1 } },
    { base: staleKnown, quote: freshMissing, days: {} },
    { base: covered, quote: legacyMissing, days: {} },
    { base: noDays, quote: null },
  ], {
    [legacyMissing]: { missing: true },
    [staleKnown]: { market_cap_usd: 80000000, fetched_at: stamp(13) },
    [freshKnown]: originalFresh,
    [freshMissing]: originalMissing,
  }, { coins: { listed: { market_cap: 200000000 } }, addresses: { ethereum: { [covered]: 'listed' } } });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return Response.json({ data: [token(legacyMissing), token(staleKnown, '85000000')] });
  });
  await finish(t, capsOnly(['ethereum']));
  assert.equal(requests.length, 1);
  assert.deepEqual(new Set(requests[0].split('/tokens/multi/')[1].split(',')), new Set([legacyMissing, staleKnown]));
  const updated = readJson(cache);
  assert.equal(updated[legacyMissing].market_cap_usd, 125000000);
  assert.equal(updated[legacyMissing].missing, undefined);
  assert.ok(Date.parse(updated[legacyMissing].fetched_at) >= NOW);
  assert.equal(updated[staleKnown].market_cap_usd, 85000000);
  assert.deepEqual(updated[freshKnown], originalFresh);
  assert.deepEqual(updated[freshMissing], originalMissing);
  assert.equal(updated[covered], undefined, 'CoinGecko-covered assets do not need fallback calls');
  assert.equal(updated[noDays], undefined, 'pools without sampled candles do not need fallback calls');
  await finish(t, capsOnly(['ethereum']));
  assert.equal(requests.length, 1, 'a second invocation within the TTL must reuse the refreshed records');
});

test('returned EVM addresses use normalized keys; an address casing difference does not become a missing token', async (t) => {
  const requested = '0xAbCDEF0000000000000000000000000000000001';
  const cache = workspace(t, 'base', [{ base: requested, quote: null, days: {} }]);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [token(requested.toLowerCase())] }));
  await finish(t, capsOnly(['base']));
  const updated = readJson(cache);
  assert.deepEqual(Object.keys(updated), [requested.toLowerCase()]);
  assert.equal(updated[requested.toLowerCase()].market_cap_usd, 125000000);
  assert.equal(updated[requested.toLowerCase()].missing, undefined);
});

test('case-distinct Solana token addresses stay distinct, and omitted tokens receive their own missing marker', async (t) => {
  const upper = 'AbCdEfTokenMint111111111111111111111111111';
  const lower = 'abCdEfTokenMint111111111111111111111111111';
  const cache = workspace(t, 'solana', [{ base: upper, quote: lower, days: {} }]);
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).endsWith(`${upper},${lower}`));
    return Response.json({ data: [token(upper)] });
  });
  await finish(t, capsOnly(['solana']));
  const updated = readJson(cache);
  assert.equal(updated[upper].market_cap_usd, 125000000);
  assert.equal(updated[upper].missing, undefined);
  assert.equal(updated[lower].missing, true);
  assert.equal(updated[lower].market_cap_usd, undefined);
  assert.ok(Date.parse(updated[lower].fetched_at) >= NOW);
});

test('a failed cap lookup preserves the previous cache and propagates the provider error', async (t) => {
  const address = evmAddress(10);
  const cache = workspace(t, 'ethereum', [{ base: address, quote: null, days: {} }], {
    [address]: { market_cap_usd: 150000000, fetched_at: stamp(20) },
  });
  const before = fs.readFileSync(cache, 'utf8');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { ++calls; return new Response('Unauthorized', { status: 401 }); });
  await assert.rejects(finish(t, capsOnly(['ethereum'])), /gt-caps.*HTTP 401/);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(cache, 'utf8'), before, 'failed request must not overwrite valid historical caps');
});

test('completed batches survive a later batch failure, while failed-batch records retain their old values', async (t) => {
  const addresses = Array.from({ length: 31 }, (_, i) => evmAddress(i + 100));
  const pools = addresses.map((base) => ({ base, quote: null, days: {} }));
  const initial = Object.fromEntries(addresses.map((address) => [address, { market_cap_usd: 1000000, fetched_at: stamp(20) }]));
  const cache = workspace(t, 'arbitrum', pools, initial);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    ++calls;
    if (calls === 2) return new Response('Unauthorized', { status: 401 });
    const batch = String(url).split('/tokens/multi/')[1].split(',');
    assert.equal(batch.length, 30);
    return Response.json({ data: batch.map((address) => token(address)) });
  });
  await assert.rejects(finish(t, capsOnly(['arbitrum'])), /HTTP 401/);
  assert.equal(calls, 2);
  const updated = readJson(cache);
  for (const address of addresses.slice(0, 30)) assert.equal(updated[address].market_cap_usd, 125000000);
  assert.deepEqual(updated[addresses[30]], initial[addresses[30]]);
});

test('main rejects an unknown chain before making a network request', async (t) => {
  workspace(t, 'ethereum', []);
  t.mock.method(globalThis, 'fetch', () => { assert.fail('invalid chain must fail before any network request'); });
  await assert.rejects(main(['etheruem']), /Unknown chain: etheruem/);
});

test('null, 404 and malformed token responses cannot replace old caps with fresh missing records', async (t) => {
  const first = evmAddress(200), second = evmAddress(201);
  const cache = workspace(t, 'ethereum', [{ base: first, quote: second, days: {} }], {
    [first]: { market_cap_usd: 130000000, fetched_at: stamp(20) },
    [second]: { market_cap_usd: 90000000, fetched_at: stamp(20) },
  });
  const original = fs.readFileSync(cache, 'utf8');
  const responses = [
    { name: '404', make: () => new Response('Not found', { status: 404 }) },
    { name: 'JSON null', make: () => Response.json(null) },
    { name: 'missing data property', make: () => Response.json({ error: 'service unavailable' }) },
    { name: 'non-array data property', make: () => Response.json({ data: { unexpected: true } }) },
    { name: 'missing token attributes after a valid row', make: () => Response.json({ data: [token(first), {}] }) },
    { name: 'null token row after a valid row', make: () => Response.json({ data: [token(first), null] }) },
    { name: 'empty address after a valid row', make: () => Response.json({ data: [token(first), token('')] }) },
    { name: 'numeric address after a valid row', make: () => Response.json({ data: [token(first), token(123)] }) },
  ];
  let calls = 0, active;
  t.mock.method(globalThis, 'fetch', async () => { ++calls; return active.make(); });
  for (active of responses) {
    await assert.rejects(finish(t, capsOnly(['ethereum'])), /Invalid token-cap response for ethereum; preserving the previous cache/, active.name);
    assert.equal(fs.readFileSync(cache, 'utf8'), original, `${active.name}: existing cache must remain byte-for-byte intact`);
  }
  assert.equal(calls, responses.length, 'each malformed response must fail directly without retrying a valid HTTP/JSON response');
});

test('capsOnly rejects unknown chain names before touching a valid chain in the same request', async (t) => {
  const address = evmAddress(300);
  const cache = workspace(t, 'ethereum', [{ base: address, quote: null, days: {} }], {
    [address]: { missing: true, fetched_at: stamp(20) },
  });
  const original = fs.readFileSync(cache, 'utf8');
  t.mock.method(globalThis, 'fetch', () => { assert.fail('validate the complete chain selection before fetching any caps'); });
  await assert.rejects(capsOnly(['ethereum', 'etheruem']), /Unknown chain: etheruem/);
  assert.equal(fs.readFileSync(cache, 'utf8'), original);
});

test('capsOnly explains a missing market-cap snapshot without attempting a lookup', async (t) => {
  workspace(t, 'ethereum', [{ base: evmAddress(301), quote: null, days: {} }]);
  fs.unlinkSync('data/mcap_snapshot.json');
  t.mock.method(globalThis, 'fetch', () => { assert.fail('a snapshot is required before any provider request'); });
  await assert.rejects(capsOnly(['ethereum']), /run fetch_coingecko first/);
});

test('OHLCV validation distinguishes missing pools, empty history and valid zero-volume candles', () => {
  assert.equal(ohlcvCandles(UNAVAILABLE_POOL, 'ethereum/missing-pool'), null);
  assert.deepEqual(ohlcvCandles({ data: { attributes: { ohlcv_list: [] } } }, 'ethereum/new-pool'), []);
  const candles = [
    [1788912000, 1.1, 1.3, 1, 1.2, 123456.75],
    [1788825600, 1, 1, 1, 1, 0],
  ];
  assert.deepEqual(ohlcvCandles({ data: { attributes: { ohlcv_list: candles } } }, 'ethereum/active-pool'), candles);
});

test('OHLCV validation rejects malformed envelopes and later invalid candles rather than returning a partial history', () => {
  const valid = [1788912000, 1, 1, 1, 1, 100];
  const badCandles = [
    [1788825600, 1, 1, 1, 1],
    [1788825600, 1, 1, 1, 1, -1],
    [1788825600, 1, 1, 1, 1, '100'],
    [1788825600, 1, 1, 1, 1, NaN],
    [1788825600, 1, 1, 1, 1, Infinity],
    ['1788825600', 1, 1, 1, 1, 100],
    [NaN, 1, 1, 1, 1, 100],
    [Infinity, 1, 1, 1, 1, 100],
    [null, 1, 1, 1, 1, 100],
    null,
    { timestamp: 1788825600, volume: 100 },
  ];
  const badResponses = [null, undefined, {}, { data: null }, { data: { attributes: {} } },
    { data: { attributes: { ohlcv_list: {} } } },
    ...badCandles.map((bad) => ({ data: { attributes: { ohlcv_list: [valid, bad] } } })),
  ];
  for (const response of badResponses) {
    assert.throws(() => ohlcvCandles(response, 'solana/affected-pool'), /Invalid OHLCV response for solana\/affected-pool/);
  }
});
