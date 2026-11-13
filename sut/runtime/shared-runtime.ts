import { createImageRuntime } from './image-runtime';
import type { ImageRuntime } from './image-runtime';

let runtime: ImageRuntime | undefined;
export function getSharedRuntime(): ImageRuntime {
  return runtime ??= createImageRuntime('/shared/manifest.json');
}

export function resetSharedRuntime(): void { runtime = undefined; }
