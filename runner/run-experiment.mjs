import {snapshot, difference} from './resources.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile, rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {readConfig, makePlan} from './plan.mjs';

const configPath = process.env.EXPERIMENT_CONFIG ?? 'configs/experiment.json';
const config = await readConfig(configPath);
const plan = makePlan(config);
const metadataPath = process.env.EXPERIMENT_METADATA;
if (!metadataPath) throw new Error('Метаданные отсутствуют. Используйте make quick или make experiment.');
const metadataBytes = await readFile(metadataPath);
const metadata = JSON.parse(metadataBytes);
const configHash = createHash('sha256').update(await readFile(configPath)).digest('hex');
assert.equal(configHash, metadata.configSha256, 'Конфигурация изменилась после фиксации метаданных.');
const metadataHash = createHash('sha256').update(metadataBytes).digest('hex');
if (config.purpose === 'experiment') assert.ok(metadata.git.commit && !metadata.git.dirty);

const baseURL = process.env.TEST_BASE_URL;
if (!baseURL) throw new Error('Укажите TEST_BASE_URL. Локальный резервный сервер не запускается.');
const id = `${config.name}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = resolve('results/raw', id);
await mkdir(directory, {recursive: false});

async function save(name, data) {
    const target = resolve(directory, name);
    // Атомарная замена не оставляет наполовину записанный JSON.
    await writeFile(`${target}.tmp`, JSON.stringify(data, null, 2) + '\n');
    await rename(`${target}.tmp`, target);
}

async function withTimeout(promise, milliseconds) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Превышен лимит выполнения ${milliseconds} мс.`)), milliseconds);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

const summary = {
    batchId: id, purpose: config.purpose, startedAt: new Date().toISOString(), status: 'running',
    planned: plan.length, completed: 0, failed: 0, configPath, seed: config.seed,
    metadataStatus: metadata.git.commit && !metadata.git.dirty ? 'captured' : 'unversioned-code',
    limitations: [...metadata.limitations,
        'Оценка A/A, нагрузки и стабильности выполняется отдельной командой make validate.']
};
await writeFile(resolve(directory, 'environment.json'), metadataBytes);
await save('config.json', config);
await save('plan.json', plan);
await save('summary.json', summary);
let sequentialChecksum;
try {
    // Проверяем именно контейнерные сервисы, а не случайно работающий сервер разработки.
    for (const [path, service] of [['/health', 'web'], ['/delivery/health', 'wasm-delivery']]) {
        const response = await fetch(new URL(path, baseURL), {signal: AbortSignal.timeout(config.navigationTimeoutMs)});
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-stand-service'), service);
    }
    const artifacts = await fetch(new URL('/build-artifacts.json', baseURL), {signal: AbortSignal.timeout(config.navigationTimeoutMs)});
    assert.equal(artifacts.status, 200);
    await save('build-artifacts.json', await artifacts.json());
    for (const params of plan) {
        let browser;
        let context;
        const pageErrors = [];
        const record = {
            batchId: id, runId: String(params.order).padStart(4, '0'), purpose: config.purpose,
            manifest: {file: 'environment.json', sha256: metadataHash, git: metadata.git},
            params, seed: config.seed, startedAt: new Date().toISOString(), status: 'running',
            environment: {node: process.version, platform: process.platform, architecture: process.arch}, pageErrors, resources: {}
        };
        const browserResourceStart = snapshot();
        try {
            // Новый процесс браузера и контекст исключают повторное использование runtime и HTTP-кэша браузера.
            browser = await chromium.launch({headless: true, timeout: config.navigationTimeoutMs});
            record.environment.browser = browser.version();
            context = await browser.newContext({viewport: config.viewport, serviceWorkers: 'block'});
            const page = await context.newPage();
            page.setDefaultTimeout(config.navigationTimeoutMs);
            page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(baseURL, {waitUntil: 'load'});
            await page.waitForFunction(() => Boolean(globalThis.__imageLabHarness));
            assert.equal(await page.evaluate(() => isSecureContext && Boolean(crypto.subtle)), true);
            const scenarioResourceStart = snapshot();
            let output;
            try {
                output = await withTimeout(page.evaluate(({variant, scenario}) =>
                    globalThis.__imageLabHarness.runScenario(scenario, variant), params), config.scenarioTimeoutMs);
            } finally {
                record.resources.scenario = difference(scenarioResourceStart, snapshot());
            }
            // Сначала сохраняем исходный ответ, затем проверяем корректность: ошибочный ответ не теряется.
            record.output = output;
            assert.equal(output.variant, params.variant);
            assert.equal(output.scenario, params.scenario);
            assert.ok(Number.isFinite(output.scenarioDurationMs) && output.scenarioDurationMs >= 0);
            for (const value of Object.values(output.diagnostics)) assert.ok(Number.isFinite(value) && value >= 0);
            assert.deepEqual(pageErrors, []);
            const expectedInstances = params.variant === 'shared' ? 1 : params.scenario === 'concurrent' ? 2 : 3;
            assert.equal(output.diagnostics.wasmInstanceCount, expectedInstances);
            assert.equal(output.diagnostics.initializationAttemptCount, expectedInstances);
            assert.equal(output.diagnostics.operationCount, {
                sequential: 3,
                concurrent: 2,
                repeated: 5
            }[params.scenario]);
            if (params.scenario === 'sequential') {
                assert.equal(output.result.pixels, 320 * 210);
                sequentialChecksum ??= output.result.checksum;
                assert.equal(output.result.checksum, sequentialChecksum);
            }
            record.status = 'completed';
            summary.completed++;
        } catch (error) {
            record.status = 'failed';
            summary.failed++;
            record.error = {name: error.name, message: error.message, stack: error.stack};
            throw error;
        } finally {
            record.resources.browserRun = difference(browserResourceStart, snapshot());
            record.finishedAt = new Date().toISOString();
            // Запись выполняется до закрытия браузера, чтобы ошибка очистки не скрыла исходные данные.
            try {
                await save(`run-${record.runId}.json`, record);
            } finally {
                try {
                    await context?.close();
                } finally {
                    await browser?.close();
                }
            }
        }
        await save('summary.json', summary);
        console.log(`[${params.order}/${plan.length}] ${params.variant} / ${params.scenario} / повтор ${params.repetition}`);
        if (config.pauseMs && params.order < plan.length) await new Promise(resolve => setTimeout(resolve, config.pauseMs));
    }
    summary.status = 'completed';
} catch (error) {
    summary.status = 'failed';
    summary.error = error.message;
    console.error(error);
    process.exitCode = 1;
} finally {
    summary.finishedAt = new Date().toISOString();
    await save('summary.json', summary);
    console.log(`Результаты: ${directory}`);
}
