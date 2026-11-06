import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotTargetSize, snapshotToBlob, SNAPSHOT_PREVIEW_PATH } from '../lib/model-snapshot.ts';

test('snapshot keeps small sources and scales large sources to the target width', () => {
  assert.deepEqual(snapshotTargetSize(300, 200, 360), { width: 300, height: 200 });
  assert.deepEqual(snapshotTargetSize(800, 400, 360), { width: 360, height: 180 });
  assert.deepEqual(snapshotTargetSize(1080, 1080), { width: 360, height: 360 });
});

test('snapshot rejects invalid sizes', () => {
  assert.throws(() => snapshotTargetSize(0, 100), /Invalid snapshot source size/);
  assert.throws(() => snapshotTargetSize(100, 100, 16), /Invalid snapshot target size/);
});

test('snapshotToBlob returns null without a browser canvas instead of throwing', async () => {
  assert.equal(SNAPSHOT_PREVIEW_PATH, '__snapshot__');
  const fake = { width: 800, height: 400 };
  assert.equal(await snapshotToBlob(fake), null);
});
