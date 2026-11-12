import { createImageRuntime } from './image-runtime';
import type { ImageRuntime } from './image-runtime';

// Один загружаемый браузерный модуль хранит общую среду для всех микрофронтендов.
let runtime: ImageRuntime | undefined;
export function getSharedRuntime(): ImageRuntime {
  return runtime ??= createImageRuntime('/shared/manifest.json');
}
// Вызывается только между сценариями, когда нет незавершённых операций.
export function resetSharedRuntime(): void { runtime = undefined; }
