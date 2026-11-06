import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { loadModelPreviews, saveModelPreview, removeModelPreview } from '../lib/model-preview-cache.ts';

test('preview cache round-trips snapshots by model id', async () => {
  const blob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
  await saveModelPreview('pack-a:model3.json', blob);
  await saveModelPreview('pack-b:model3.json', new Blob(['other'], { type: 'image/jpeg' }));
  const loaded = await loadModelPreviews();
  assert.equal(loaded.size, 2);
  assert.equal(await loaded.get('pack-a:model3.json')?.text(), 'jpeg-bytes');
  await removeModelPreview('pack-a:model3.json');
  const after = await loadModelPreviews();
  assert.equal(after.size, 1);
  assert.equal(after.has('pack-a:model3.json'), false);
  await removeModelPreview('pack-b:model3.json');
});

test('preview cache overwrites a stale snapshot for the same model', async () => {
  await saveModelPreview('pack-c:model3.json', new Blob(['old'], { type: 'image/jpeg' }));
  await saveModelPreview('pack-c:model3.json', new Blob(['new'], { type: 'image/jpeg' }));
  const loaded = await loadModelPreviews();
  assert.equal(await loaded.get('pack-c:model3.json')?.text(), 'new');
  await removeModelPreview('pack-c:model3.json');
});
