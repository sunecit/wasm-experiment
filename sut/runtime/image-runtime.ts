/** Одна среда владеет одним WASM-экземпляром. Общий объект означает общую память. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface ImageAnalysis {
  redSum: number;
  greenSum: number;
  blueSum: number;
  min: number;
  max: number;
  checksum: number;
  pixels: number;
}

export interface RuntimeDiagnostics {
  initializationAttemptCount: number;
  successfulInitializationCount: number;
  wasmFetchCount: number;
  wasmFetchedBytes: number;
  wasmInstanceCount: number;
  wasmLinearMemoryBytes: number;
  initializationDurationMs: number;
  operationCount: number;
  operationDurationMs: number;
  lastOperationDurationMs: number;
}

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'RuntimeError';
  }
}

interface Core {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  reset_allocator(): void;
  grayscale(pointer: number, length: number): void;
  invert(pointer: number, length: number): void;
  brightness(pointer: number, length: number, delta: number): void;
  contrast(pointer: number, length: number, factor: number): void;
  resize_nearest(src: number, width: number, height: number, dst: number, tw: number, th: number): void;
  flip_horizontal(pointer: number, width: number, height: number): void;
  flip_vertical(pointer: number, width: number, height: number): void;
  rotate90(src: number, width: number, height: number, dst: number): void;
  analyze(pointer: number, length: number, out: number): void;
}

// Ограничения защищают выделение памяти и 32-битную арифметику координат в WAT.
const MAX_SIDE = 16_384;
const MAX_PIXELS = 16_777_216;
function dimensions(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new RuntimeError('INVALID_IMAGE_SIZE', 'Invalid image dimensions or image exceeds the runtime limit.');
  }
  return width * height * 4;
}
function snapshot(image: RgbaImage): RgbaImage {
  if (!image || typeof image !== 'object') throw new RuntimeError('INVALID_IMAGE', 'An RGBA image is required.');
  const bytes = dimensions(image.width, image.height);
  if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) || image.data.length !== bytes) {
    throw new RuntimeError('INVALID_IMAGE_DATA', 'RGBA data must contain exactly width × height × 4 bytes.');
  }
  // Копируем вход до ожидания загрузки: вызывающий код может изменять исходный массив.
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}
function integerRange(value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RuntimeError('INVALID_PARAMETER', `Parameter must be an integer from ${min} to ${max}.`);
  }
}

export function createImageRuntime(manifestUrl: string, options: { fetch?: typeof fetch } = {}) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const resolvedManifestUrl = new URL(manifestUrl, globalThis.location?.href).href;
  let core: Core | undefined;
  let initialization: Promise<Core> | undefined;
  const metrics: RuntimeDiagnostics = {
    initializationAttemptCount: 0, successfulInitializationCount: 0,
    wasmFetchCount: 0, wasmFetchedBytes: 0, wasmInstanceCount: 0,
    wasmLinearMemoryBytes: 0, initializationDurationMs: 0,
    operationCount: 0, operationDurationMs: 0, lastOperationDurationMs: 0
  };

  async function load(): Promise<Core> {
    const started = performance.now();
    metrics.initializationAttemptCount++;
    try {
      const response = await request(resolvedManifestUrl);
      if (!response.ok) throw new RuntimeError('MANIFEST_FETCH_FAILED', `Manifest HTTP ${response.status}.`);
      const manifest = await response.json();
      if (!manifest || manifest.apiVersion !== '1') {
        throw new RuntimeError('INCOMPATIBLE_API_VERSION', 'Expected WASM API version 1.');
      }
      if (typeof manifest.file !== 'string' || !manifest.file ||
          typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
          !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1) {
        throw new RuntimeError('INVALID_MANIFEST', 'Manifest must specify file, bytes and SHA-256.');
      }
      metrics.wasmFetchCount++;
      const wasmResponse = await request(new URL(manifest.file, response.url || resolvedManifestUrl));
      if (!wasmResponse.ok) throw new RuntimeError('WASM_FETCH_FAILED', `WASM HTTP ${wasmResponse.status}.`);
      const bytes = await wasmResponse.arrayBuffer();
      metrics.wasmFetchedBytes += bytes.byteLength;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== manifest.bytes || sha256 !== manifest.sha256) {
        throw new RuntimeError('WASM_INTEGRITY_FAILED', 'WASM size or SHA-256 does not match the manifest.');
      }
      const { instance } = await WebAssembly.instantiate(bytes);
      const exports = instance.exports;
      const functions = ['alloc', 'reset_allocator', 'grayscale', 'invert', 'brightness', 'contrast',
        'resize_nearest', 'flip_horizontal', 'flip_vertical', 'rotate90', 'analyze'];
      if (!(exports.memory instanceof WebAssembly.Memory) || functions.some(name => typeof exports[name] !== 'function')) {
        throw new RuntimeError('INVALID_WASM_EXPORTS', 'WASM exports do not match API version 1.');
      }
      core = exports as unknown as Core;
      metrics.successfulInitializationCount++;
      metrics.wasmInstanceCount = 1;
      return core;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('INITIALIZATION_FAILED', 'Could not initialize the WASM runtime.', { cause: error });
    } finally {
      metrics.initializationDurationMs += performance.now() - started;
    }
  }

  function ready(): Promise<Core> {
    if (core) return Promise.resolve(core);
    // Первые конкурентные вызовы ожидают один Promise. После ошибки загрузку можно повторить.
    if (!initialization) initialization = load().catch(error => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  }

  async function execute<T>(image: RgbaImage, operation: (wasm: Core, input: RgbaImage, pointer: number) => T): Promise<T> {
    const input = snapshot(image);
    const wasm = await ready();
    const started = performance.now();
    // Здесь нет await: выделение памяти, вычисления и копирование результата выполняются
    // синхронно в одном потоке, поэтому конкурентные вызовы не перемешивают работу с памятью.
    wasm.reset_allocator();
    try {
      const pointer = wasm.alloc(input.data.length);
      new Uint8Array(wasm.memory.buffer, pointer, input.data.length).set(input.data);
      const output = operation(wasm, input, pointer);
      const duration = performance.now() - started;
      metrics.operationCount++;
      metrics.operationDurationMs += duration;
      metrics.lastOperationDurationMs = duration;
      return output;
    } finally {
      wasm.reset_allocator();
    }
  }

  function copyImage(wasm: Core, pointer: number, width: number, height: number): RgbaImage {
    // Отдельная копия сохраняет результат при следующих выделениях и росте памяти.
    return { width, height, data: new Uint8ClampedArray(new Uint8Array(wasm.memory.buffer, pointer, width * height * 4)) };
  }

  return {
    async initialize(): Promise<void> { await ready(); },
    async filter(image: RgbaImage, kind: 'grayscale' | 'invert' | 'brightness' | 'contrast', parameter?: number): Promise<RgbaImage> {
      if (!['grayscale', 'invert', 'brightness', 'contrast'].includes(kind)) {
        throw new RuntimeError('INVALID_FILTER', 'Unsupported filter.');
      }
      if (kind === 'brightness') integerRange(parameter as number, -255, 255);
      if (kind === 'contrast') integerRange(parameter as number, 0, 10_000);
      return execute(image, (wasm, input, pointer) => {
        if (kind === 'brightness' || kind === 'contrast') wasm[kind](pointer, input.data.length, parameter!);
        else wasm[kind](pointer, input.data.length);
        return copyImage(wasm, pointer, input.width, input.height);
      });
    },
    async resize(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
      const bytes = dimensions(width, height);
      return execute(image, (wasm, input, pointer) => {
        const out = wasm.alloc(bytes);
        wasm.resize_nearest(pointer, input.width, input.height, out, width, height);
        return copyImage(wasm, out, width, height);
      });
    },
    async flip(image: RgbaImage, direction: 'horizontal' | 'vertical'): Promise<RgbaImage> {
      if (direction !== 'horizontal' && direction !== 'vertical') {
        throw new RuntimeError('INVALID_DIRECTION', 'Expected horizontal or vertical.');
      }
      return execute(image, (wasm, input, pointer) => {
        wasm[direction === 'horizontal' ? 'flip_horizontal' : 'flip_vertical'](pointer, input.width, input.height);
        return copyImage(wasm, pointer, input.width, input.height);
      });
    },
    async rotate90(image: RgbaImage): Promise<RgbaImage> {
      return execute(image, (wasm, input, pointer) => {
        const out = wasm.alloc(input.data.length);
        wasm.rotate90(pointer, input.width, input.height, out);
        return copyImage(wasm, out, input.height, input.width);
      });
    },
    async analyze(image: RgbaImage): Promise<ImageAnalysis> {
      return execute(image, (wasm, input, pointer) => {
        const out = wasm.alloc(40);
        wasm.analyze(pointer, input.data.length, out);
        const view = new DataView(wasm.memory.buffer, out, 40);
        return {
          redSum: Number(view.getBigUint64(0, true)), greenSum: Number(view.getBigUint64(8, true)),
          blueSum: Number(view.getBigUint64(16, true)), min: view.getUint32(24, true),
          max: view.getUint32(28, true), checksum: view.getUint32(32, true), pixels: view.getUint32(36, true)
        };
      });
    },
    diagnostics(): RuntimeDiagnostics {
      return { ...metrics, wasmLinearMemoryBytes: core?.memory.buffer.byteLength ?? 0 };
    }
  };
}

export type ImageRuntime = ReturnType<typeof createImageRuntime>;
