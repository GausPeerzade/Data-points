import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../lib/concurrency.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('out-of-order completion fills only available slots and preserves input/result indices', async () => {
  const inputs = ['a', 'b', 'c', 'd', 'e'];
  const gates = inputs.map(deferred);
  const started = [];
  const finished = [];
  let active = 0;
  let peak = 0;
  const run = mapLimit(inputs, 2, async (value, index) => {
    started.push(index);
    peak = Math.max(peak, ++active);
    await gates[index].promise;
    --active;
    finished.push(index);
    return `${index}:${value}`;
  });
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2], 'one completion must free exactly one slot');
  gates[2].resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[4].resolve();
  gates[3].resolve();
  assert.deepEqual(await run, ['0:a', '1:b', '2:c', '3:d', '4:e']);
  assert.deepEqual(finished, [1, 2, 0, 4, 3]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('first rejection stops scheduling and drains every started mapper before rejecting to the caller', async () => {
  const gates = Array.from({ length: 7 }, deferred);
  const started = [];
  const writes = [];
  const firstFailure = new Error('first provider failed');
  const laterFailure = new Error('second provider failed while draining');
  let observed = false;
  const run = mapLimit(gates, 3, async (gate, index) => {
    started.push(index);
    try {
      await gate.promise;
    } finally {
      writes.push(index);
    }
    return index;
  }).then(() => assert.fail('a mapper failed'), (error) => {
    observed = true;
    assert.equal(error, firstFailure, 'drain errors must not replace the first failure');
    writes.push('caller failure');
  });
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[1].reject(firstFailure);
  await nextTurn();
  assert.equal(observed, false, 'two started mappers are still pending');
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].reject(laterFailure);
  await nextTurn();
  assert.equal(observed, false, 'the final started mapper must also settle');
  gates[3].resolve();
  await run;
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2, 3], 'no queued item starts after failure, including during drain');
  assert.deepEqual(writes, [0, 1, 2, 3, 'caller failure'], 'all task writes finish before caller observes rejection');
});

test('a synchronous falsy failure stops initial scheduling and still drains prior work', async () => {
  const gate = deferred();
  const started = [];
  let settled = false;
  let written = false;
  const run = mapLimit([0, 1, 2, 3], 3, (value) => {
    started.push(value);
    if (value === 1) throw undefined;
    return gate.promise.then(() => { written = true; return value; });
  }).then(() => assert.fail('undefined is still a rejection reason'), (reason) => {
    assert.equal(reason, undefined);
    assert.equal(written, true);
    settled = true;
  });
  await nextTurn();
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false);
  gate.resolve();
  await run;
  assert.equal(settled, true);
});

test('serial, excess-capacity and empty runs work without bypassing invalid concurrency settings', async () => {
  const order = [];
  assert.deepEqual(await mapLimit([3, 2, 1], 1, async (item) => { order.push(item); return item * 2; }), [6, 4, 2]);
  assert.deepEqual(order, [3, 2, 1]);
  assert.deepEqual(await mapLimit([3], 100, (item) => item * 2), [6]);
  assert.deepEqual(await mapLimit([], 2, () => assert.fail('empty input must not invoke mapper')), []);
  for (const limit of [0, -1, 1.5, Infinity, NaN, '2']) {
    await assert.rejects(mapLimit([], limit, () => {}), /limit must be a positive integer/);
  }
  await assert.rejects(mapLimit(null, 1, () => {}), /items must be an array/);
  await assert.rejects(mapLimit([], 1, null), /mapper must be a function/);
});
