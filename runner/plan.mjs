import {readFile} from 'node:fs/promises';

const variants = ['local', 'server', 'shared'];
const scenarios = ['sequential', 'concurrent', 'repeated'];

function integer(value, min, max, name) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Некорректный параметр ${name}.`);
}

export function validateConfig(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Конфигурация должна быть объектом.');
    const allowed = ['name', 'purpose', 'seed', 'variants', 'scenarios', 'repetitions', 'randomizeOrder', 'pauseMs',
        'navigationTimeoutMs', 'scenarioTimeoutMs', 'viewport', 'isolation', 'validationKind'];
    for (const key of Object.keys(c)) if (!allowed.includes(key)) throw new Error(`Неизвестный параметр ${key}.`);
    if (typeof c.name !== 'string' || !/^[a-z0-9-]{1,60}$/.test(c.name)) throw new Error('Некорректное имя эксперимента.');
    if (!['experiment', 'validation'].includes(c.purpose)) throw new Error('Укажите назначение experiment или validation.');
    integer(c.seed, 0, 4294967295, 'seed');
    integer(c.repetitions, 1, 1000, 'repetitions');
    integer(c.pauseMs, 0, 60000, 'pauseMs');
    integer(c.navigationTimeoutMs, 100, 300000, 'navigationTimeoutMs');
    integer(c.scenarioTimeoutMs, 100, 300000, 'scenarioTimeoutMs');
    for (const [key, choices] of [['variants', variants], ['scenarios', scenarios]]) {
        const values = c[key];
        if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length || values.some(value => !choices.includes(value))) {
            throw new Error(`Некорректный список ${key}.`);
        }
    }
    if (typeof c.randomizeOrder !== 'boolean') throw new Error('randomizeOrder должен быть логическим значением.');
    if (c.isolation !== 'browser-per-run') throw new Error('Поддерживается изоляция browser-per-run.');
    if (!c.viewport || Object.keys(c.viewport).some(key => !['width', 'height'].includes(key))) throw new Error('Некорректный viewport.');
    integer(c.viewport.width, 320, 3840, 'viewport.width');
    integer(c.viewport.height, 240, 2160, 'viewport.height');
    if (c.validationKind !== undefined && (c.validationKind !== 'aa' || c.purpose !== 'validation' || c.variants.length !== 1 || c.scenarios.length !== 1 || c.repetitions !== 10)) throw new Error('A/A требует 10 повторений одной конфигурации с purpose=validation.');
    return c;
}

export async function readConfig(path) {
    return validateConfig(JSON.parse(await readFile(path, 'utf8')));
}

function randomGenerator(seed) {
    let state = seed >>> 0;
    return () => {
        // Детерминированный генератор Mulberry32 задаёт только порядок запусков.
        state = (state + 0x6D2B79F5) >>> 0;
        let value = Math.imul(state ^ state >>> 15, 1 | state);
        value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

export function makePlan(config) {
    const c = validateConfig(config);
    const plan = [];
    for (let repetition = 1; repetition <= c.repetitions; repetition++) {
        for (const variant of c.variants) for (const scenario of c.scenarios) plan.push({
            variant,
            scenario,
            repetition
        });
    }
    if (c.randomizeOrder) {
        const random = randomGenerator(c.seed);
        for (let i = plan.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [plan[i], plan[j]] = [plan[j], plan[i]];
        }
    }
    return plan.map((params, index) => ({order: index + 1, ...params}));
}
