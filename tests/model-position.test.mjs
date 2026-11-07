import test from "node:test";
import assert from "node:assert/strict";
import {
  clampModelTransform,
  loadModelTransform,
  saveModelTransform,
  clearModelTransform,
  parseModelTransform,
  resolveModelPlacement,
} from "../lib/model-position.ts";

// Minimal localStorage stub for Node test environment.
function installStorage() {
  const store = new Map();
  const stub = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });
  return { store, stub };
}

test("parseModelTransform falls back safely", () => {
  assert.deepEqual(parseModelTransform(null), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(parseModelTransform("not json"), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(parseModelTransform('{"x":12,"y":-8,"scale":1.5}'), { x: 12, y: -8, scale: 1.5 });
  assert.deepEqual(parseModelTransform('{"x":"nope","scale":null}'), { x: 0, y: 0, scale: 1 });
});

test("clampModelTransform keeps the model reachable and scale bounded", () => {
  const clamped = clampModelTransform({ x: 5000, y: -5000, scale: 99 }, 400, 800);
  assert.equal(clamped.x, 300);
  assert.equal(clamped.y, -600);
  assert.equal(clamped.scale, 2.5);
  const small = clampModelTransform({ x: 10, y: 20, scale: 0.01 }, 400, 800);
  assert.equal(small.scale, 0.35);
  const unknownStage = clampModelTransform({ x: 100, y: 100, scale: 1 }, 0, 0);
  assert.deepEqual(unknownStage, { x: 0, y: 0, scale: 1 });
});

test("resolveModelPlacement centers by default and applies offsets", () => {
  const base = resolveModelPlacement(800, 600, 0.5, { x: 0, y: 0, scale: 1 });
  assert.deepEqual(base, { x: 400, y: 594, scale: 0.5 });
  const moved = resolveModelPlacement(800, 600, 0.5, { x: 40, y: -30, scale: 2 });
  assert.deepEqual(moved, { x: 440, y: 564, scale: 1 });
});

test("save and load round-trip per model id", () => {
  installStorage();
  assert.deepEqual(loadModelTransform("model-a"), { x: 0, y: 0, scale: 1 });
  saveModelTransform("model-a", { x: 25, y: -15, scale: 1.4 });
  saveModelTransform("model-b", { x: 0, y: 0, scale: 10 });
  assert.deepEqual(loadModelTransform("model-a"), { x: 25, y: -15, scale: 1.4 });
  // Out-of-range scale is clamped on save.
  assert.deepEqual(loadModelTransform("model-b"), { x: 0, y: 0, scale: 2.5 });
  clearModelTransform("model-a");
  assert.deepEqual(loadModelTransform("model-a"), { x: 0, y: 0, scale: 1 });
});

test("empty model id never touches storage", () => {
  installStorage();
  saveModelTransform("", { x: 99, y: 99, scale: 2 });
  assert.deepEqual(loadModelTransform(""), { x: 0, y: 0, scale: 1 });
});
