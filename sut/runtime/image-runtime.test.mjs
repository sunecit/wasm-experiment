import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createImageRuntime } from './image-runtime.ts';

const binary = await readFile(new URL('../wasm/dist/image-core.wasm', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../wasm/dist/manifest.json', import.meta.url)));
const image = () => ({ width: 2, height: 1, data: new Uint8Array([10, 20, 30, 255, 250, 100, 0, 128]) });
function fixture({ meta = manifest, failOnce = false, corrupt = false } = {}) {
  const requests = [];
  const request = async url => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path.endsWith('manifest.json')) return Response.json(meta);
    if (failOnce) { failOnce = false; return new Response('', { status: 503 }); }
    const bytes = new Uint8Array(binary);
    if (corrupt) bytes[0] ^= 1;
    return new Response(bytes);
  };
  return { runtime: createImageRuntime('https://stand.test/assets/manifest.json', { fetch: request }), requests };
}

test('runtime initializes lazily and produces grayscale without modifying input', async () => {
  const { runtime, requests } = fixture();
  assert.equal(requests.length, 0);
  const input = image(), before = [...input.data];
  const output = await runtime.filter(input, 'grayscale');
  assert.deepEqual([...output.data], [20, 20, 20, 255, 116, 116, 116, 128]);
  assert.deepEqual([...input.data], before);
  assert.deepEqual(requests, ['/assets/manifest.json', '/assets/image-core.wasm']);
  assert.equal(runtime.diagnostics().operationCount, 1);
});

test('ten simultaneous first calls share one initialization and isolate outputs', async () => {
  const { runtime } = fixture();
  const outputs = await Promise.all(Array.from({ length: 10 }, (_, i) => runtime.filter(image(), i % 2 ? 'invert' : 'grayscale')));
  outputs.forEach((out, i) => assert.deepEqual([...out.data], i % 2 ? [245, 235, 225, 255, 5, 155, 255, 128] : [20, 20, 20, 255, 116, 116, 116, 128]));
  const d = runtime.diagnostics();
  assert.equal(d.initializationAttemptCount, 1);
  assert.equal(d.successfulInitializationCount, 1);
  assert.equal(d.wasmFetchCount, 1);
  assert.equal(d.wasmInstanceCount, 1);
  assert.equal(d.operationCount, 10);
});

test('separate runtimes create separate instances even with the same WASM URL', async () => {
  const runtimes = Array.from({ length: 3 }, () => fixture().runtime);
  await Promise.all(runtimes.map(r => r.initialize()));
  assert.equal(runtimes.reduce((sum, r) => sum + r.diagnostics().wasmInstanceCount, 0), 3);
  assert.equal(runtimes.reduce((sum, r) => sum + r.diagnostics().wasmLinearMemoryBytes, 0), 3 * 4 * 65536);
});

test('invalid image dimensions and data are rejected before initialization', async () => {
  const { runtime, requests } = fixture();
  for (const input of [null, { ...image(), width: 0 }, { ...image(), height: 1.5 },
    { ...image(), width: 16385 }, { ...image(), width: 16384, height: 16384 },
    { ...image(), data: new Uint8Array(7) }, { ...image(), data: [1, 2, 3, 4] }]) {
    await assert.rejects(runtime.filter(input, 'invert'), { name: 'RuntimeError' });
  }
  assert.equal(requests.length, 0);
});

test('invalid filters, directions, dimensions and arithmetic parameters are rejected', async () => {
  const { runtime, requests } = fixture();
  await assert.rejects(runtime.filter(image(), 'unknown'), { code: 'INVALID_FILTER' });
  for (const value of [undefined, NaN, Infinity, 1.5, 256, -256]) {
    await assert.rejects(runtime.filter(image(), 'brightness', value), { code: 'INVALID_PARAMETER' });
  }
  await assert.rejects(runtime.filter(image(), 'contrast', 10001), { code: 'INVALID_PARAMETER' });
  await assert.rejects(runtime.resize(image(), 0, 1), { code: 'INVALID_IMAGE_SIZE' });
  await assert.rejects(runtime.flip(image(), 'unknown'), { code: 'INVALID_DIRECTION' });
  assert.equal(requests.length, 0);
});

test('incompatible API version prevents WASM loading', async () => {
  const { runtime, requests } = fixture({ meta: { ...manifest, apiVersion: '2' } });
  await assert.rejects(runtime.initialize(), { code: 'INCOMPATIBLE_API_VERSION' });
  assert.equal(requests.length, 1);
  assert.equal(runtime.diagnostics().wasmInstanceCount, 0);
});

test('corrupt binary is rejected by SHA-256 before instantiation', async () => {
  const { runtime } = fixture({ corrupt: true });
  await assert.rejects(runtime.initialize(), { code: 'WASM_INTEGRITY_FAILED' });
  assert.equal(runtime.diagnostics().successfulInitializationCount, 0);
});

test('a failed load allows one shared retry', async () => {
  const { runtime } = fixture({ failOnce: true });
  await assert.rejects(runtime.initialize(), { code: 'WASM_FETCH_FAILED' });
  await Promise.all([runtime.initialize(), runtime.initialize()]);
  const d = runtime.diagnostics();
  assert.equal(d.initializationAttemptCount, 2);
  assert.equal(d.wasmFetchCount, 2);
  assert.equal(d.successfulInitializationCount, 1);
  assert.equal(d.wasmInstanceCount, 1);
});

test('input is captured before asynchronous initialization', async () => {
  const { runtime } = fixture();
  const input = image();
  const pending = runtime.filter(input, 'grayscale');
  input.data.fill(0);
  input.width = 100;
  assert.deepEqual([...(await pending).data], [20, 20, 20, 255, 116, 116, 116, 128]);
});

test('output copies survive later memory growth and allocator reuse', async () => {
  const { runtime } = fixture();
  const output = await runtime.filter(image(), 'invert');
  const expected = [...output.data];
  const large = { width: 640, height: 420, data: new Uint8Array(640 * 420 * 4).fill(70) };
  await runtime.resize(large, 1280, 840);
  assert.ok(runtime.diagnostics().wasmLinearMemoryBytes > 4 * 65536);
  assert.deepEqual([...output.data], expected);
  assert.equal(runtime.diagnostics().wasmInstanceCount, 1);
});

test('resize, flip and rotation use the correct dimensions and pixel order', async () => {
  const { runtime } = fixture();
  const resized = await runtime.resize(image(), 1, 1);
  assert.deepEqual(resized, { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) });
  assert.deepEqual([...(await runtime.flip(image(), 'horizontal')).data], [250, 100, 0, 128, 10, 20, 30, 255]);
  const rotated = await runtime.rotate90(image());
  assert.equal(rotated.width, 1);
  assert.equal(rotated.height, 2);
  assert.deepEqual([...rotated.data], [...image().data]);
  assert.deepEqual([...(await runtime.flip(rotated, 'vertical')).data], [250, 100, 0, 128, 10, 20, 30, 255]);
});

test('brightness, contrast and analysis expose usable results', async () => {
  const { runtime } = fixture();
  const brighter = await runtime.filter(image(), 'brightness', 20);
  assert.deepEqual([...brighter.data], [30, 40, 50, 255, 255, 120, 20, 128]);
  assert.deepEqual([...(await runtime.filter(image(), 'contrast', 1000)).data], [...image().data]);
  const result = await runtime.analyze(image());
  let hash = 2166136261;
  for (const byte of image().data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  assert.deepEqual(result, { redSum: 260, greenSum: 120, blueSum: 30, min: 0, max: 250, checksum: hash, pixels: 2 });
});

test('diagnostics are snapshots and decoded WASM bytes are counted once', async () => {
  const { runtime } = fixture();
  await runtime.analyze(image());
  const first = runtime.diagnostics();
  first.wasmFetchCount = 900;
  await runtime.analyze(image());
  const d = runtime.diagnostics();
  assert.equal(d.wasmFetchCount, 1);
  assert.equal(d.wasmFetchedBytes, binary.length);
  assert.equal(d.operationCount, 2);
  assert.ok(d.operationDurationMs >= d.lastOperationDurationMs);
  assert.ok(d.initializationDurationMs >= 0);
});
