import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faceCrop, snapshotTargetSize, snapshotToBlob, SNAPSHOT_PREVIEW_PATH } from '../lib/model-snapshot.ts';

test('face crop keeps full model width and matches the card aspect at the top', () => {
  const crop = faceCrop({ x: 400, y: 80, width: 480, height: 520 }, 1280, 720);
  assert.ok(crop);
  assert.equal(crop.x, 400);
  assert.equal(crop.y, 80);
  assert.equal(crop.width, 480);
  assert.equal(Math.round(crop.width / crop.height * 1000), Math.round(280 / 220 * 1000));
  assert.ok(crop.y + crop.height <= 80 + 520, 'crop stays within the model box height');
});

test('face crop clamps to the canvas and never mutates invalid input', () => {
  const nearEdge = faceCrop({ x: -50, y: 600, width: 600, height: 400 }, 1280, 720);
  assert.ok(nearEdge);
  assert.ok(nearEdge.x >= 0 && nearEdge.x + nearEdge.width <= 1280);
  assert.ok(nearEdge.y >= 0 && nearEdge.y + nearEdge.height <= 720);
  assert.equal(faceCrop(null, 1280, 720), null);
  assert.equal(faceCrop({ x: 0, y: 0, width: 0, height: 100 }, 1280, 720), null);
  assert.equal(faceCrop({ x: 0, y: 0, width: 100, height: 100 }, 0, 0), null);
});

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
