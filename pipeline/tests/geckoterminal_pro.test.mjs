import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { main } from '../fetch_geckoterminal.mjs';
import { DAYS, TOP_POOL_PAGES } from '../config.mjs';
import { readJson, writeJson } from '../lib/http.mjs';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const CUTOFF = Date.parse('2026-09-10T00:00:00Z') / 1000;
const FAKE_KEY = 'test-only-paid-key-never-persist';
const directory = 'data/raw/geckoterminal/ethereum';
const address = (id) => `0x${id.toString(16).padStart(40, '0')}`;
const date = (daysAgo) => new Date((CUTOFF - daysAgo * 86400) * 1000).toISOString().slice(0, 10);
const candle = (daysAgo, volume, offset = 0) => [CUTOFF - daysAgo * 86400 + offset, 1, 1, 1, 1, volume];
const deferred = () => Promise.withResolvers();

function workspace(t, snapshot) {
  const previous = process.cwd();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-gt-pro-'));
  const names = ['COINGECKO_PRO_API_KEY', 'COINGECKO_DEMO_KEY', 'REFRESH_CUTOFF'];
  const previousEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.COINGECKO_PRO_API_KEY = FAKE_KEY;
  process.env.COINGECKO_DEMO_KEY = 'unused-demo-test-key';
  process.env.REFRESH_CUTOFF = '2026-09-10';
  process.chdir(temporary);
  t.after(() => {
    process.chdir(previous);
    for (const name of names) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  writeJson('data/mcap_snapshot.json', { stable_ids: [], ...snapshot });
  const messages = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => messages.push(args.join(' ')));
  return { temporary, messages };
}

function tracked(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then((value) => { state.value = value; state.settled = true; },
    (error) => { state.error = error; state.settled = true; });
  return state;
}

// Advance the production request scheduler without sleeping or permitting a live
// request. Explicit request gates control response order, independently of time.
async function until(t, condition, label) {
  for (let tick = 0; tick < 1000; tick++) {
    await nextTurn();
    if (condition()) return;
    t.mock.timers.tick(250);
  }
  assert.fail(`Timed out driving mocked crawl: ${label}`);
}

function pool(id, base, quote, volume, name = `Pool ${id}`) {
  return {
    id: `eth_${address(id)}`, type: 'pool',
    attributes: { address: address(id), name, volume_usd: { h24: String(volume) }, reserve_in_usd: '800000', market_cap_usd: null, fdv_usd: '120000000' },
    relationships: {
      base_token: { data: { id: `eth_${base}`, type: 'token' } },
      quote_token: { data: { id: `eth_${quote}`, type: 'token' } },
      dex: { data: { id: 'test_dex', type: 'dex' } },
    },
  };
}

function assertPaidRequest(rawUrl, options) {
  const url = new URL(rawUrl);
  assert.equal(url.origin, 'https://pro-api.coingecko.com');
  assert.ok(url.pathname.startsWith('/api/v3/onchain/networks/eth/'));
  const headers = new Headers(options.headers);
  assert.equal(headers.get('x-cg-pro-api-key'), FAKE_KEY);
  assert.equal(headers.get('x-cg-demo-api-key'), null);
  assert.ok(!url.href.includes(FAKE_KEY), 'the credential must remain in a header');
  return url;
}

test('paid crawl keeps page and whitelist precedence while concurrent OHLCV completes in reverse order', async (t) => {
  const quote = address(900), firstToken = address(901), secondToken = address(902), unlisted = address(903);
  const { temporary, messages } = workspace(t, {
    coins: { ethereum: { market_cap: 1000000000 }, first: { market_cap: 200000000 }, second: { market_cap: 150000000 } },
    addresses: { ethereum: { [quote]: 'weth', [firstToken]: 'first', [secondToken]: 'second' } },
  });
  const topFirst = deferred(), whitelistFirst = deferred();
  const pendingCandles = new Map(), completion = [], requests = [];
  const A = address(1), skippedTop = address(2), B = address(3), C = address(4), skippedWhitelist = address(5), missingPool = address(6);
  t.mock.method(globalThis, 'fetch', async (rawUrl, options) => {
    const url = assertPaidRequest(rawUrl, options);
    requests.push(url);
    const route = url.pathname.slice('/api/v3/onchain/networks/eth'.length);
    if (route === '/pools') {
      assert.equal(url.searchParams.get('sort'), 'h24_volume_usd_desc');
      const page = Number(url.searchParams.get('page'));
      if (page === 1) {
        await topFirst.promise;
        completion.push('top:1');
        return Response.json({ data: [pool(1, unlisted, quote, 50000), pool(2, firstToken, quote, 49999)] });
      }
      if (page === 2) {
        completion.push('top:2');
        topFirst.resolve();
        return Response.json({ data: [pool(3, firstToken, quote, 60000), pool(1, unlisted, quote, 999999, 'Later duplicate')] });
      }
      return Response.json({ data: [] });
    }
    if (route.startsWith('/tokens/multi/')) {
      const batch = route.slice('/tokens/multi/'.length).split(',');
      if (batch.includes(firstToken)) {
        assert.deepEqual(batch, [firstToken, secondToken]);
        return Response.json({ data: [secondToken, firstToken].map((tokenAddress) => ({ attributes: { address: tokenAddress, volume_usd: { h24: '300000' } } })) });
      }
      assert.deepEqual(batch, [unlisted], 'only the unlisted sampled token needs a fallback cap');
      return Response.json({ data: [{ attributes: { address: unlisted, symbol: 'TEST', name: 'Unlisted token', market_cap_usd: null, fdv_usd: '50000000', volume_usd: { h24: '100000' } } }] });
    }
    if (route === `/tokens/${firstToken}/pools`) {
      await whitelistFirst.promise;
      completion.push('whitelist:1');
      return Response.json({ data: [pool(3, firstToken, quote, 999999, 'Whitelist duplicate'), pool(4, firstToken, quote, 25000), pool(5, firstToken, quote, 24999)] });
    }
    if (route === `/tokens/${secondToken}/pools`) {
      completion.push('whitelist:2');
      whitelistFirst.resolve();
      return Response.json({ data: [pool(4, firstToken, quote, 999999, 'Second whitelist duplicate'), pool(6, secondToken, quote, 75000)] });
    }
    const match = route.match(/^\/pools\/(0x[0-9a-f]+)\/ohlcv\/day$/);
    assert.ok(match, `unexpected mocked request path: ${route}`);
    assert.equal(url.searchParams.get('aggregate'), '1');
    assert.equal(url.searchParams.get('limit'), String(DAYS + 2));
    assert.equal(url.searchParams.get('currency'), 'usd');
    assert.equal(url.searchParams.get('before_timestamp'), String(CUTOFF));
    const gate = deferred();
    pendingCandles.set(match[1], gate);
    const response = await gate.promise;
    completion.push(`ohlcv:${match[1]}`);
    return response;
  });

  const run = tracked(main(['ethereum']));
  await until(t, () => pendingCandles.size === 4 || run.settled, 'four concurrent pool histories');
  assert.equal(run.error, undefined);
  assert.deepEqual([...pendingCandles.keys()], [A, B, C, missingPool]);
  assert.equal(run.settled, false, 'the crawl must await every started history request');
  const histories = new Map([
    [A, [candle(1, 11.25), candle(1, 2.75, 3600), candle(2, 7), candle(0, 999), candle(DAYS + 1, 888), candle(DAYS, 3)]],
    [B, [candle(2, 17), candle(1, 22), candle(DAYS, 5)]],
    [C, [candle(1, 33), candle(2, 27), candle(DAYS, 0)]],
  ]);
  pendingCandles.get(missingPool).resolve(new Response('Not found', { status: 404 }));
  await nextTurn();
  for (const id of [C, B, A]) {
    pendingCandles.get(id).resolve(Response.json({ data: { attributes: { ohlcv_list: histories.get(id) } }, meta: { base: { address: firstToken, coingecko_coin_id: 'first' }, quote: { address: quote, coingecko_coin_id: 'weth' } } }));
    await nextTurn();
  }
  await until(t, () => run.settled, 'complete paid crawl');
  assert.equal(run.error, undefined);
  assert.deepEqual(completion.filter((item) => item.startsWith('top:')), ['top:2', 'top:1']);
  assert.deepEqual(completion.filter((item) => item.startsWith('whitelist:')), ['whitelist:2', 'whitelist:1']);
  assert.deepEqual(completion.filter((item) => item.startsWith('ohlcv:')), [missingPool, C, B, A].map((id) => `ohlcv:${id}`));
  assert.equal(requests.filter((url) => url.pathname.endsWith('/eth/pools')).length, TOP_POOL_PAGES);

  const index = readJson(`${directory}/pools_index.json`);
  assert.equal(index.provider_tier, 'pro');
  assert.equal(index.cutoff_utc, '2026-09-10');
  assert.ok(Date.parse(index.fetched_at) >= NOW);
  assert.equal(index.top_pools, 3);
  assert.equal(index.whitelist_tokens, 2);
  assert.equal(index.whitelist_active, 2);
  assert.equal(index.misaligned_candles, 1);
  assert.deepEqual(index.pools.map((item) => item.address), [A, skippedTop, B, C, skippedWhitelist, missingPool]);
  const byAddress = Object.fromEntries(index.pools.map((item) => [item.address, item]));
  assert.equal(byAddress[A].h24, 50000, 'earlier top page owns duplicate attributes despite finishing later');
  assert.equal(byAddress[B].h24, 60000, 'a whitelist result must not overwrite the top-pool snapshot');
  assert.equal(byAddress[C].h24, 25000, 'first whitelist owns duplicate attributes despite finishing later');
  assert.deepEqual(byAddress[B].source, ['top', 'wl:first']);
  assert.deepEqual(byAddress[C].source, ['wl:first', 'wl:second']);
  assert.deepEqual(byAddress[A].days, { [date(1)]: 14, [date(2)]: 7, [date(DAYS)]: 3 });
  assert.deepEqual(byAddress[B].days, { [date(2)]: 17, [date(1)]: 22, [date(DAYS)]: 5 });
  assert.deepEqual(byAddress[C].days, { [date(1)]: 33, [date(2)]: 27, [date(DAYS)]: 0 });
  assert.equal(byAddress[skippedTop].days, undefined);
  assert.equal(byAddress[skippedWhitelist].days, undefined);
  assert.equal(byAddress[missingPool].unavailable, true);
  assert.deepEqual(byAddress[missingPool].days, {});
  assert.equal(readJson(`${directory}/token_caps.json`)[unlisted].fdv_usd, 50000000);
  for (const file of fs.readdirSync(path.join(temporary, 'data'), { recursive: true }).filter((file) => file.endsWith('.json'))) {
    const body = fs.readFileSync(path.join(temporary, 'data', file), 'utf8');
    assert.ok(!body.includes(FAKE_KEY), `${file} must not contain the paid API key`);
    assert.ok(!body.includes('unused-demo-test-key'), `${file} must not contain the unused demo key`);
  }
  assert.ok(messages.every((message) => !message.includes(FAKE_KEY)), 'crawl logging must not contain the paid API key');
});

test('failed concurrent history drains started requests and preserves the prior pool index without launching queued pools', async (t) => {
  const quote = address(990);
  workspace(t, { coins: { ethereum: { market_cap: 1000000000 } }, addresses: { ethereum: { [quote]: 'weth' } } });
  const prior = { chain: 'ethereum', provider_tier: 'public', pools: [{ address: 'previous', days: { '2026-09-01': 123 } }] };
  writeJson(`${directory}/pools_index.json`, prior);
  const original = fs.readFileSync(`${directory}/pools_index.json`, 'utf8');
  const gates = new Map();
  let capRequests = 0;
  t.mock.method(globalThis, 'fetch', async (rawUrl, options) => {
    const url = assertPaidRequest(rawUrl, options);
    if (url.pathname.endsWith('/eth/pools')) return Response.json({ data: url.searchParams.get('page') === '1' ? Array.from({ length: 8 }, (_, i) => pool(100 + i, quote, quote, 100000)) : [] });
    if (url.pathname.includes('/tokens/multi/')) { capRequests++; assert.fail('failed history must not continue to cap enrichment'); }
    const match = url.pathname.match(/\/pools\/(0x[0-9a-f]+)\/ohlcv\/day$/);
    assert.ok(match);
    const gate = deferred();
    gates.set(match[1], gate);
    return await gate.promise;
  });
  const run = tracked(main(['ethereum']));
  await until(t, () => gates.size === 6 || run.settled, 'six active histories before failure');
  assert.equal(run.error, undefined);
  const ids = [...gates.keys()];
  gates.get(ids[1]).resolve(new Response('Unauthorized', { status: 401 }));
  await nextTurn();
  await nextTurn();
  assert.equal(run.settled, false, 'first rejection must await outstanding requests before reporting failure');
  for (const id of ids.filter((id) => id !== ids[1]).slice(0, -1)) {
    gates.get(id).resolve(Response.json({ data: { attributes: { ohlcv_list: [candle(1, 42)] } } }));
  }
  await nextTurn();
  await nextTurn();
  assert.equal(run.settled, false, 'the final in-flight response must drain as well');
  assert.equal(gates.size, 6, 'failure prevents queued seventh and eighth pool requests');
  gates.get(ids.at(-1)).resolve(Response.json({ data: { attributes: { ohlcv_list: [candle(1, 17)] } } }));
  await until(t, () => run.settled, 'drained failed crawl');
  assert.match(run.error?.message || '', /HTTP 401/);
  assert.equal(capRequests, 0);
  assert.equal(fs.readFileSync(`${directory}/pools_index.json`, 'utf8'), original);
  const filesAtFailure = fs.readdirSync(directory, { recursive: true }).sort();
  t.mock.timers.tick(60000);
  await nextTurn();
  assert.deepEqual(fs.readdirSync(directory, { recursive: true }).sort(), filesAtFailure, 'no late writes after failure is reported');
  assert.equal(fs.readFileSync(`${directory}/pools_index.json`, 'utf8'), original);
});
