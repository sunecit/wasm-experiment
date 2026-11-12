import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
test('Браузерное приложение: подходы, сценарии и пользовательские действия', async t => {
  const externalURL = process.env.TEST_BASE_URL;
  const baseURL = externalURL ?? 'http://127.0.0.1:4186';
  const server = externalURL ? undefined : await preview({ configFile: false, root, build: { outDir: 'dist' }, preview: { host: '127.0.0.1', port: 4186, strictPort: true } });
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL === 'chromium' ? undefined : (process.env.BROWSER_CHANNEL ?? 'chrome'), headless: true });
    const checksums = new Set();
    const memory = {};
    for (const variant of ['local', 'server', 'shared']) {
      for (const scenario of ['sequential', 'concurrent', 'repeated']) {
        await t.test(`${variant}: ${scenario}`, async () => {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(baseURL);
            await page.waitForFunction(() => Boolean(globalThis.__imageLabHarness));
            const result = await page.evaluate(({ variant, scenario }) => globalThis.__imageLabHarness.runScenario(scenario, variant), { variant, scenario });
            const expected = variant === 'shared' ? 1 : scenario === 'concurrent' ? 2 : 3;
            assert.equal(result.diagnostics.wasmInstanceCount, expected);
            assert.equal(result.diagnostics.initializationAttemptCount, expected);
            assert.equal(result.diagnostics.wasmFetchCount, expected);
            assert.equal(result.diagnostics.operationCount, { sequential: 3, concurrent: 2, repeated: 5 }[scenario]);
            assert.ok(result.scenarioDurationMs > 0);
            if (scenario === 'sequential') {
              checksums.add(result.result.checksum);
              memory[variant] = result.diagnostics.wasmLinearMemoryBytes;
              assert.equal(result.result.pixels, 320 * 210);
            }
            assert.equal(await page.locator('#output pre').count(), 0);
            if (scenario === 'concurrent') {
              assert.equal(await page.locator('.branch-results canvas').count(), 2);
              const pixels = await page.evaluate(() => ['#image', '.branch-results figure:first-child canvas', '.branch-results figure:last-child canvas'].map(selector => {
                const canvas = document.querySelector(selector);
                return [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data];
              }));
              assert.deepEqual(pixels, [[0, 0, 70, 255], [23, 23, 23, 255], [0, 0, 70, 255]]);
            }
            assert.deepEqual(errors, []);
          } finally { await context.close(); }
        });
      }
    }
    await t.test('Последовательный результат одинаков, общая память меньше', () => {
      assert.equal(checksums.size, 1);
      assert.ok(memory.shared < memory.local);
      assert.equal(memory.server, memory.local);
    });
    await t.test('Кнопки микрофронтендов, переключение и сброс состояния', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      await page.goto(baseURL);
      await page.waitForFunction(() => Boolean(globalThis.__imageLabHarness));
      await page.selectOption('#variant', 'shared');
      await page.getByRole('button', { name: 'Оттенки серого', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'complete');
      await page.getByRole('button', { name: 'Размер 320 × 210', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'complete');
      await page.getByRole('button', { name: 'Проанализировать', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'complete');
      assert.match(await page.locator('#dimensions').textContent(), /320 × 210/);
      assert.equal(await page.locator('#result-title').textContent(), 'Анализ текущего изображения');
      assert.match(await page.locator('#status').textContent(), /Анализ завершён/);
      assert.equal(await page.locator('#output tbody tr').count(), 7);
      assert.match(await page.locator('#output').textContent(), /Среднее значение красного канала/);
      assert.equal(await page.evaluate(() => globalThis.__imageLabHarness.diagnostics().wasmInstanceCount), 1);
      await mkdir(resolve(root, 'test-results'), { recursive: true });
      await page.screenshot({ path: resolve(root, 'test-results/app-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'Сбросить состояние', exact: true }).click();
      assert.equal(await page.evaluate(() => globalThis.__imageLabHarness.diagnostics().wasmInstanceCount), 0);
      assert.match(await page.locator('#dimensions').textContent(), /640 × 420/);
      await page.close();
      const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await mobile.goto(baseURL);
      await mobile.waitForFunction(() => Boolean(globalThis.__imageLabHarness));
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await mobile.locator('h1').count(), 1);
      await mobile.screenshot({ path: resolve(root, 'test-results/app-mobile.png'), fullPage: true });
      await mobile.close();
    });
    await t.test('Ошибка загрузки показана, следующая попытка восстанавливает работу', async () => {
      const page = await browser.newPage();
      await page.goto(baseURL);
      await page.waitForFunction(() => Boolean(globalThis.__imageLabHarness));
      await page.route('**/*.wasm', route => route.fulfill({ status: 503, body: 'Недоступно' }));
      await page.getByRole('button', { name: 'Оттенки серого', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.error === 'true');
      assert.equal(await page.getByRole('button', { name: 'Оттенки серого', exact: true }).isEnabled(), true);
      await page.unroute('**/*.wasm');
      await page.getByRole('button', { name: 'Оттенки серого', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'complete');
      assert.equal(await page.evaluate(() => globalThis.__imageLabHarness.diagnostics().wasmInstanceCount), 1);
      await page.close();
    });
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
