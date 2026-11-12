import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const baseURL = process.env.TEST_BASE_URL;
if (!baseURL) throw new Error('Укажите TEST_BASE_URL. Проверка не запускает резервный локальный сервер.');

async function get(path) {
    const response = await fetch(new URL(path, baseURL));
    assert.equal(response.status, 200, `Недоступен адрес ${path}`);
    return response;
}

const web = await get('/health');
assert.equal(web.headers.get('x-stand-service'), 'web');
const delivery = await get('/delivery/health');
assert.equal(delivery.headers.get('x-stand-service'), 'wasm-delivery');
assert.equal(delivery.headers.get('x-stand-gateway'), 'web');
const manifest = await (await get('/delivery/manifest.json')).json();
const wasm = await get('/delivery/image-core.wasm');
assert.equal(wasm.headers.get('x-stand-service'), 'wasm-delivery');
assert.equal(wasm.headers.get('content-type'), 'application/wasm');
const bytes = Buffer.from(await wasm.arrayBuffer());
assert.equal(bytes.length, manifest.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
const report = {startedAt: new Date().toISOString(), baseURL, node: process.version, browser: null, checks: []};
const browser = await chromium.launch({headless: true});
try {
    report.browser = browser.version();
    const checksums = new Set();
    for (const variant of ['local', 'server', 'shared']) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.goto(baseURL);
            await page.waitForFunction(() => Boolean(globalThis.__imageLabHarness));
            assert.equal(await page.evaluate(() => isSecureContext && Boolean(crypto.subtle)), true);
            const result = await page.evaluate(variant => globalThis.__imageLabHarness.runScenario('sequential', variant), variant);
            assert.equal(result.diagnostics.wasmInstanceCount, variant === 'shared' ? 1 : 3);
            assert.equal(result.result.pixels, 67200);
            checksums.add(result.result.checksum);
            report.checks.push({
                variant,
                instances: result.diagnostics.wasmInstanceCount,
                checksum: result.result.checksum
            });
        } finally {
            await context.close();
        }
    }
    assert.equal(checksums.size, 1);
    report.finishedAt = new Date().toISOString();
    await mkdir('test-results', {recursive: true});
    await writeFile('test-results/docker-smoke.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Smoke-проверка пройдена: оба сервиса доступны, доставка отдельная, три подхода работают в Chromium.');
} finally {
    await browser.close();
}
