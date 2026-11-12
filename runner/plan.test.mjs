import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readConfig, makePlan, validateConfig} from './plan.mjs';

const config = await readConfig(new URL('../configs/experiment.json', import.meta.url));
test('План содержит все сочетания факторов и повторения без дубликатов', () => {
    const plan = makePlan(config);
    assert.equal(plan.length, 90);
    assert.equal(new Set(plan.map(p => `${p.variant}/${p.scenario}/${p.repetition}`)).size, 90);
    for (const variant of config.variants) for (const scenario of config.scenarios) {
        assert.equal(plan.filter(p => p.variant === variant && p.scenario === scenario).length, 10);
    }
    assert.deepEqual(plan.map(p => p.order), Array.from({length: 90}, (_, i) => i + 1));
});
test('Одинаковый сид даёт одинаковый порядок, другой сид меняет порядок', () => {
    assert.deepEqual(makePlan(config), makePlan(structuredClone(config)));
    assert.notDeepEqual(makePlan(config), makePlan({...config, seed: config.seed + 1}));
});
test('Без рандомизации соблюдается заданный порядок конфигурации', () => {
    assert.deepEqual(makePlan({...config, randomizeOrder: false}).slice(0, 3).map(p => p.scenario), config.scenarios);
});
test('Ошибки конфигурации отклоняются до запуска браузера', () => {
    for (const patch of [{repetitions: 0}, {seed: -1}, {variants: ['shared', 'shared']},
        {scenarios: ['unknown']}, {randomizeOrder: 'yes'}, {pauseMs: -1},
        {viewport: {width: 0, height: 900}}, {repetitionss: 10}]) {
        assert.throws(() => validateConfig({...config, ...patch}));
    }
});
test('Сокращённая конфигурация помечена как проверочная и содержит девять прогонов', async () => {
    const quick = await readConfig(new URL('../configs/quick.json', import.meta.url));
    assert.equal(quick.purpose, 'validation');
    assert.equal(makePlan(quick).length, 9);
});

test('A/A содержит ровно десять повторений одной конфигурации', async () => {
    const aa = await readConfig(new URL('../configs/aa.json', import.meta.url));
    assert.equal(makePlan(aa).length, 10);
    assert.equal(aa.validationKind, 'aa');
    assert.throws(() => validateConfig({...aa, repetitions: 9}));
    assert.throws(() => validateConfig({...aa, variants: ['local', 'shared']}));
});
