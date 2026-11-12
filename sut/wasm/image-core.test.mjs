import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const binary = await readFile(new URL('./dist/image-core.wasm', import.meta.url));
async function core() {
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports;
}
function put(wasm, bytes) {
  const pointer = wasm.alloc(bytes.length);
  new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
  return pointer;
}
function get(wasm, pointer, length) {
  return [...new Uint8Array(wasm.memory.buffer, pointer, length)];
}
const pixels = [10, 20, 30, 255, 250, 100, 0, 128];

test('grayscale averages RGB with integer rounding and preserves alpha', async () => {
  const w = await core(), p = put(w, pixels);
  w.grayscale(p, pixels.length);
  assert.deepEqual(get(w, p, 8), [20, 20, 20, 255, 116, 116, 116, 128]);
});

test('inversion preserves alpha and two inversions restore the input', async () => {
  const w = await core(), p = put(w, pixels);
  w.invert(p, pixels.length);
  assert.deepEqual(get(w, p, 8), [245, 235, 225, 255, 5, 155, 255, 128]);
  w.invert(p, pixels.length);
  assert.deepEqual(get(w, p, 8), pixels);
});

test('brightness clips channels at both boundaries', async () => {
  for (const [delta, expected] of [
    [20, [30, 40, 50, 255, 255, 120, 20, 128]],
    [-25, [0, 0, 5, 255, 225, 75, 0, 128]]
  ]) {
    const w = await core(), p = put(w, pixels);
    w.brightness(p, pixels.length, delta);
    assert.deepEqual(get(w, p, 8), expected);
  }
});

test('contrast factor 1000 is identity and zero produces neutral RGB', async () => {
  const w = await core(), p = put(w, pixels);
  w.contrast(p, pixels.length, 1000);
  assert.deepEqual(get(w, p, 8), pixels);
  w.contrast(p, pixels.length, 0);
  assert.deepEqual(get(w, p, 8), [128, 128, 128, 255, 128, 128, 128, 128]);
});

const grid = [1, 2, 3, 4, 5, 6].flatMap(value => [value, value, value, 255]);
const rgba = values => values.flatMap(value => [value, value, value, 255]);

test('nearest-neighbor resize handles a non-square image', async () => {
  const w = await core(), p = put(w, grid), out = w.alloc(16);
  w.resize_nearest(p, 3, 2, out, 2, 2);
  assert.deepEqual(get(w, out, 16), rgba([1, 2, 4, 5]));
});

test('horizontal flip preserves the middle column of an odd-width image', async () => {
  const w = await core(), p = put(w, grid);
  w.flip_horizontal(p, 3, 2);
  assert.deepEqual(get(w, p, 24), rgba([3, 2, 1, 6, 5, 4]));
});

test('vertical flip swaps complete rows', async () => {
  const w = await core(), p = put(w, grid);
  w.flip_vertical(p, 3, 2);
  assert.deepEqual(get(w, p, 24), rgba([4, 5, 6, 1, 2, 3]));
});

test('clockwise rotation maps a 3 by 2 image to a 2 by 3 image', async () => {
  const w = await core(), p = put(w, grid), out = w.alloc(24);
  w.rotate90(p, 3, 2, out);
  assert.deepEqual(get(w, out, 24), rgba([4, 1, 5, 2, 6, 3]));
});

test('analysis returns RGB sums, extrema, pixel count and FNV-1a checksum', async () => {
  const w = await core(), p = put(w, pixels), out = w.alloc(40);
  w.analyze(p, pixels.length, out);
  const view = new DataView(w.memory.buffer, out, 40);
  assert.deepEqual([0, 8, 16].map(offset => view.getBigUint64(offset, true)), [260n, 120n, 30n]);
  assert.equal(view.getUint32(24, true), 0);
  assert.equal(view.getUint32(28, true), 250);
  assert.equal(view.getUint32(36, true), 2);
  let hash = 2166136261;
  for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  assert.equal(view.getUint32(32, true), hash);
});

test('allocation grows memory for 640 by 420 input and reset reuses addresses', async () => {
  const w = await core(), initialBytes = w.memory.buffer.byteLength;
  const size = 640 * 420 * 4, p = w.alloc(size);
  assert.equal(p % 8, 0);
  assert.ok(w.memory.buffer.byteLength >= p + size);
  assert.ok(w.memory.buffer.byteLength > initialBytes);
  new Uint8Array(w.memory.buffer, p, size).fill(42);
  const grownBytes = w.memory.buffer.byteLength;
  w.reset_allocator();
  assert.equal(w.alloc(size), p);
  assert.equal(w.memory.buffer.byteLength, grownBytes);
});

test('sequential grayscale and resize matches an independent pixel reference', async () => {
  const w = await core();
  const width = 640, height = 420, tw = 320, th = 210;
  const input = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + 11) % 256);
  const p = put(w, input), out = w.alloc(tw * th * 4);
  w.grayscale(p, input.length);
  w.resize_nearest(p, width, height, out, tw, th);
  const expected = [];
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = (Math.floor(y * height / th) * width + Math.floor(x * width / tw)) * 4;
    const gray = Math.floor((input[i] + input[i + 1] + input[i + 2]) / 3);
    expected.push(gray, gray, gray, input[i + 3]);
  }
  assert.deepEqual(get(w, out, expected.length), expected);
});

test('manifest identifies the actual compiled binary', async () => {
  const manifest = JSON.parse(await readFile(new URL('./dist/manifest.json', import.meta.url)));
  assert.equal(manifest.bytes, binary.length);
  assert.equal(manifest.sha256, createHash('sha256').update(binary).digest('hex'));
});
