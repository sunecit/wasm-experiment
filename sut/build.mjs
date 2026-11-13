import { build } from 'vite';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const external = ['@stand/shared-runtime'];
const paths = { '@stand/shared-runtime': '/shared/runtime.js' };
await build({ configFile: false, root: resolve(root, 'sut/host'), base: '/', build: {
  target: 'es2022', outDir: resolve(root, 'dist'), emptyOutDir: true,
  rollupOptions: { external, output: { paths } }
} });

for (const name of ['filters', 'transform', 'analysis']) {
  await build({ configFile: false, build: {
    target: 'es2022', outDir: resolve(root, `dist/mfes/${name}`), emptyOutDir: true,
    lib: { entry: resolve(root, `sut/mfes/${name}/index.ts`), formats: ['es'], fileName: () => 'remoteEntry.js' },
    rollupOptions: { external, output: { paths } }
  } });
}
await build({ configFile: false, build: {
  target: 'es2022', outDir: resolve(root, 'dist/shared'), emptyOutDir: true,
  lib: { entry: resolve(root, 'sut/runtime/shared-runtime.ts'), formats: ['es'], fileName: () => 'runtime.js' }
} });
const artifacts = [];
for (const path of ['mfes/filters', 'mfes/transform', 'mfes/analysis', 'delivery', 'shared']) {
  const directory = resolve(root, 'dist', path);
  await mkdir(directory, { recursive: true });
  for (const file of ['image-core.wasm', 'manifest.json']) {
    await copyFile(resolve(root, 'sut/wasm/dist', file), resolve(directory, file));
  }
  const bytes = await readFile(resolve(directory, 'image-core.wasm'));
  artifacts.push({ path: `${path}/image-core.wasm`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
if (new Set(artifacts.map(item => item.sha256)).size !== 1) throw new Error('WASM-файлы различаются.');
await writeFile(resolve(root, 'dist/build-artifacts.json'), JSON.stringify({
  artifacts, byVariant: { local: artifacts.slice(0, 3), server: [artifacts[3]], shared: [artifacts[4]] }
}, null, 2) + '\n');
