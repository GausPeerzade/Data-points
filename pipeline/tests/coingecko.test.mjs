import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { coinGeckoConfig } from '../lib/coingecko.mjs';
import { main as snapshot } from '../fetch_coingecko.mjs';
import { main as enrich } from '../enrich_mcap.mjs';
import { CHAINS } from '../config.mjs';
import { readJson, safeName, writeJson } from '../lib/http.mjs';

const PRO_KEY = 'test-only-paid-key';
const DEMO_KEY = 'test-only-demo-key';
let clockStart = Date.parse('2026-09-10T12:00:00Z');
const address = (index) => `0x${index.toString(16).padStart(40, '0')}`;

function workspace(t) {
  const previous = process.cwd();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-cg-'));
  process.chdir(temporary);
  t.after(() => { process.chdir(previous); fs.rmSync(temporary, { recursive: true, force: true }); });
  clockStart += 86400000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: clockStart });
  const logs = [];
  for (const method of ['log', 'error', 'warn']) t.mock.method(console, method, (...args) => logs.push(args.join(' ')));
  return { temporary, logs };
}

async function finish(t, pending) {
  let settled = false, result, failure;
  pending.then((value) => { result = value; settled = true; }, (error) => { failure = error; settled = true; });
  for (let tick = 0; tick < 500 && !settled; tick++) {
    await nextTurn();
    if (!settled) t.mock.timers.tick(1000);
  }
  assert.ok(settled, 'operation must finish using only mocked timers and requests');
  if (failure) throw failure;
  return result;
}

function persistedText(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? persistedText(file) : fs.readFileSync(file, 'utf8');
  }).join('\n');
}

function alignFileTimes(directory) {
  // Fake Date does not change filesystem timestamps. Keep newly written cache
  // files fresh at the mocked clock so these tests exercise URL identity.
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) alignFileTimes(file);
    else fs.utimesSync(file, new Date(Date.now()), new Date(Date.now()));
  }
}

function assertNoCredentials({ temporary, logs }) {
  const text = `${persistedText(temporary)}\n${logs.join('\n')}`;
  for (const secret of [PRO_KEY, DEMO_KEY, 'x-cg-pro-api-key', 'x-cg-demo-api-key']) assert.ok(!text.includes(secret), `${secret} must not enter logs or saved data`);
}

test('paid configuration wins over demo, trims surrounding whitespace and keeps request option objects independent', () => {
  const config = coinGeckoConfig({ COINGECKO_PRO_API_KEY: ` \n${PRO_KEY}\t`, COINGECKO_DEMO_KEY: DEMO_KEY });
  assert.equal(config.tier, 'pro');
  assert.equal(config.baseUrl, 'https://pro-api.coingecko.com/api/v3');
  assert.equal(config.onchainBaseUrl, `${config.baseUrl}/onchain`);
  assert.deepEqual(config.marketOptions, { headers: { 'x-cg-pro-api-key': PRO_KEY }, minIntervalMs: 250, adaptiveRateLimit: true });
  assert.deepEqual(config.onchainOptions, { ...config.marketOptions, ttlMs: 12 * 3600e3 });
  assert.equal(config.concurrency, 6);
  config.marketOptions.headers.extra = 'market-only';
  assert.equal(config.onchainOptions.headers.extra, undefined, 'adding market headers must not alter onchain credentials');
  assert.equal(coinGeckoConfig({}).marketOptions.headers.extra, undefined, 'configurations must not share mutable headers');
});

test('demo and public configurations retain their market pacing and never send credentials to GeckoTerminal', () => {
  for (const [env, tier, interval, headers] of [
    [{ COINGECKO_PRO_API_KEY: ' \t\n', COINGECKO_DEMO_KEY: ` ${DEMO_KEY} ` }, 'demo', 700, { 'x-cg-demo-api-key': DEMO_KEY }],
    [{}, 'public', 21000, {}],
    [{ COINGECKO_PRO_API_KEY: '', COINGECKO_DEMO_KEY: ' \n' }, 'public', 21000, {}],
  ]) {
    const config = coinGeckoConfig(env);
    assert.equal(config.tier, tier);
    assert.equal(config.baseUrl, 'https://api.coingecko.com/api/v3');
    assert.deepEqual(config.marketOptions, { headers, minIntervalMs: interval, adaptiveRateLimit: false });
    assert.equal(config.onchainBaseUrl, 'https://api.geckoterminal.com/api/v2');
    assert.deepEqual(config.onchainOptions, { headers: {}, minIntervalMs: 3300, adaptiveRateLimit: true, ttlMs: 12 * 3600e3 });
    assert.equal(config.concurrency, 1);
  }
});

test('malformed active keys fail without including their value, while unused demo settings cannot block paid mode', () => {
  for (const name of ['COINGECKO_PRO_API_KEY', 'COINGECKO_DEMO_KEY']) {
    for (const key of ['first\nsecond', 'first second', 1234]) {
      assert.throws(() => coinGeckoConfig({ [name]: key }), (error) => {
        assert.match(error.message, new RegExp(name));
        assert.ok(!error.message.includes(String(key)), 'validation error must not print credentials');
        return true;
      });
    }
  }
  assert.equal(coinGeckoConfig({ COINGECKO_PRO_API_KEY: PRO_KEY, COINGECKO_DEMO_KEY: 'ignored\ninvalid' }).tier, 'pro');
});

for (const [tier, env, host, credential, interval] of [
  ['public', {}, 'api.coingecko.com', {}, 21000],
  ['demo', { COINGECKO_DEMO_KEY: DEMO_KEY }, 'api.coingecko.com', { 'x-cg-demo-api-key': DEMO_KEY }, 700],
  ['pro', { COINGECKO_PRO_API_KEY: PRO_KEY, COINGECKO_DEMO_KEY: DEMO_KEY }, 'pro-api.coingecko.com', { 'x-cg-pro-api-key': PRO_KEY }, 250],
]) {
  test(`${tier} snapshot routes every market/list request correctly and preserves cap, stablecoin and address semantics`, async (t) => {
    const context = workspace(t);
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      const url = new URL(input);
      assert.equal(url.hostname, host);
      assert.deepEqual(options.headers, { accept: 'application/json', ...credential });
      assert.ok(!url.search.includes('key'), 'credentials belong in headers only');
      requests.push({ url, at: Date.now() });
      if (url.pathname.endsWith('/coins/list')) return Response.json([
        { id: 'ranked-1', platforms: { ethereum: '0xABCDEF', solana: 'CaseSensitiveMint' } },
        { id: 'stable-extra', platforms: { ethereum: '0xFfF' } },
      ]);
      if (url.searchParams.has('category')) return Response.json([
        { id: 'ranked-1', market_cap: 999000000 },
        { id: 'stable-extra', symbol: 'STBL', name: 'Extra stablecoin', market_cap: 100000000 },
        { id: 'small-stable', symbol: 'SMALL', market_cap: 99000000 },
      ]);
      const page = Number(url.searchParams.get('page'));
      assert.equal(url.searchParams.get('per_page'), '250');
      return Response.json([{ id: `ranked-${page}`, symbol: `R${page}`, market_cap: page === 1 ? 150000000 : null, fully_diluted_valuation: 200000000, market_cap_rank: page }]);
    });
    await finish(t, snapshot(env));
    assert.equal(requests.length, 6);
    for (let i = 1; i < requests.length; i++) assert.ok(requests[i].at - requests[i - 1].at >= interval, 'provider pacing must reach the real host scheduler');
    const result = readJson('data/mcap_snapshot.json');
    assert.equal(result.keyed, tier !== 'public');
    assert.equal(result.provider_tier, tier);
    assert.equal(result.coins['ranked-1'].market_cap, 150000000, 'ranked caps retain precedence over stablecoin duplicates');
    assert.equal(result.coins['ranked-2'].market_cap, 0);
    assert.equal(result.coins['ranked-2'].fdv, 200000000);
    assert.deepEqual(result.stable_ids, ['ranked-1', 'stable-extra']);
    assert.equal(result.addresses.ethereum['0xabcdef'], 'ranked-1');
    assert.equal(result.addresses.solana.CaseSensitiveMint, 'ranked-1');
    assert.equal(result.counts.coins_with_cap, 6);
    alignFileTimes(context.temporary);
    await finish(t, snapshot(env));
    assert.equal(requests.length, 6, 'matching provider URLs must still reuse the disk cache');
    assertNoCredentials(context);
  });
}

test('switching a cached demo snapshot to paid fetches paid URLs instead of reusing public-host cache entries', async (t) => {
  const context = workspace(t);
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    hosts.push(new URL(input).hostname);
    return Response.json([]);
  });
  await finish(t, snapshot({ COINGECKO_DEMO_KEY: DEMO_KEY }));
  alignFileTimes(context.temporary);
  await finish(t, snapshot({ COINGECKO_PRO_API_KEY: PRO_KEY }));
  assert.deepEqual(hosts, [...Array(6).fill('api.coingecko.com'), ...Array(6).fill('pro-api.coingecko.com')]);
  assert.equal(readJson('data/mcap_snapshot.json').provider_tier, 'pro');
  assertNoCredentials(context);
});

test('paid enrichment crosses the 250-ID boundary, deduplicates pool tokens and resolves metadata-only IDs without losing existing caps', async (t) => {
  const context = workspace(t);
  const addresses = Object.fromEntries(CHAINS.map((chain) => [chain.key, {}]));
  const pools = [];
  for (let index = 0; index < 250; index++) {
    addresses.ethereum[address(index)] = `missing-${index}`;
    pools.push({ address: `pool-${index}`, base: address(index), quote: address(index), days: {} });
  }
  addresses.ethereum[address(800)] = 'unsampled';
  addresses.ethereum[address(801)] = 'already-known';
  pools.push({ address: 'ignored', base: address(800), quote: null });
  pools.push({ address: 'known', base: address(801), quote: null, days: {} });
  pools.push({ address: 'metadata-pool', base: address(802), quote: null, days: {} });
  writeJson(`data/raw/geckoterminal/ethereum/ohlcv/${safeName('metadata-pool')}.json`, {
    meta: { base: { address: address(802), coingecko_coin_id: 'metadata-only' } },
  });
  const known = { market_cap: 999000000, fdv: 1200000000, source: 'existing' };
  writeJson('data/mcap_snapshot.json', { snapshot_date: '2026-09-10', counts: { enriched: 4 }, addresses, coins: { 'already-known': known } });
  writeJson('data/raw/geckoterminal/ethereum/pools_index.json', { pools });
  const batches = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://pro-api.coingecko.com/api/v3/coins/markets');
    assert.deepEqual(options.headers, { accept: 'application/json', 'x-cg-pro-api-key': PRO_KEY });
    const ids = url.searchParams.get('ids').split(',');
    batches.push(ids);
    return Response.json(ids.map((id) => ({ id, market_cap: id === 'metadata-only' ? null : 123000000, fully_diluted_valuation: 456000000 })));
  });
  await finish(t, enrich({ COINGECKO_PRO_API_KEY: PRO_KEY, COINGECKO_DEMO_KEY: DEMO_KEY }));
  assert.deepEqual(batches.map((batch) => batch.length), [250, 1]);
  assert.equal(new Set(batches.flat()).size, 251);
  assert.deepEqual(batches[1], ['metadata-only']);
  const result = readJson('data/mcap_snapshot.json');
  assert.deepEqual(result.coins['already-known'], known);
  assert.equal(result.coins.unsampled, undefined);
  assert.equal(result.coins['metadata-only'].market_cap, 0);
  assert.equal(result.coins['metadata-only'].fdv, 456000000);
  assert.equal(result.coins['metadata-only'].source, 'ids_lookup');
  assert.equal(result.counts.enriched, 255);
  await finish(t, enrich({ COINGECKO_PRO_API_KEY: PRO_KEY }));
  assert.equal(batches.length, 2, 'the second enrichment has no unresolved IDs to fetch');
  assertNoCredentials(context);
});
