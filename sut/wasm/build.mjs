import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import wabtFactory from 'wabt';

const sourcePath = resolve(import.meta.dirname, 'image-core.wat');
const outputDirectory = resolve(import.meta.dirname, 'dist');
const source = await readFile(sourcePath, 'utf8');
const wabt = await wabtFactory();
const module = wabt.parseWat(sourcePath, source);
try {
  module.validate();
  const { buffer } = module.toBinary({ canonicalize_lebs: true, write_debug_names: false });
  const bytes = Buffer.from(buffer);
  const manifest = {
    apiVersion: '1',
    file: 'image-core.wasm',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    compiler: { name: 'wabt', version: JSON.parse(await readFile(new URL('../../node_modules/wabt/package.json', import.meta.url), 'utf8')).version }
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, 'image-core.wasm'), bytes);
  await writeFile(resolve(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Built image-core.wasm: ${bytes.length} bytes, SHA-256 ${manifest.sha256}`);
} finally {
  module.destroy();
}
