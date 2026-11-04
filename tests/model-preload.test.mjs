import assert from 'node:assert/strict';
import { test } from 'node:test';
import { singleFlightModel, preloadModelPackages } from '../lib/model-preload.ts';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('startup and rendering share one package hydration flight', async () => {
  const gate = deferred(); let calls = 0;
  const load = signal => singleFlightModel('package-a', async () => { calls++; await gate.promise; return signal.aborted ? 'aborted' : 'ready'; });
  const first = load(new AbortController().signal);
  const second = load(new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['ready', 'ready']);
});

test('cancelling one waiter leaves a shared preload alive for the remaining waiter', async () => {
  const gate = deferred(); let workSignal;
  const abort = new AbortController();
  const work = signal => { workSignal = signal; return gate.promise; };
  const first = singleFlightModel('package-b', work, abort.signal);
  const second = singleFlightModel('package-b', work);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(workSignal.aborted, false);
  gate.resolve('cached');
  assert.equal(await second, 'cached');
});

test('preload queue prioritizes the selected model then works newest-first and continues after failures', async () => {
  const packages = ['older', 'newest', 'selected'].map(id => ({ id, assets: [], models: [{ id: `${id}:m` }] }));
  const order = [];
  await preloadModelPackages(packages, 'selected:m', async pack => { order.push(pack.id); if (pack.id === 'newest') throw new Error('offline'); }, new AbortController().signal);
  assert.deepEqual(order, ['selected', 'newest', 'older']);
});
