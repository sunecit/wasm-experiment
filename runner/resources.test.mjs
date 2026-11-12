import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCounters, difference} from './resources.mjs';

test('Счётчики cgroup читаются по именам', () => {
    assert.deepEqual(parseCounters('usage_usec 2000\nnr_throttled 1\n'), {usage_usec: 2000, nr_throttled: 1});
});
test('CPU контроллера и контейнера нормируются отдельно', () => {
    const before = {wallMs: 0, processCpu: {user: 0, system: 0}, processRssBytes: 1,
        container: {available: true, quotaCpus: 2, memoryBytes: 1, cpu: {usage_usec: 0, throttled_usec: 0, nr_throttled: 0}}};
    const after = structuredClone(before);
    after.wallMs = 100; after.processCpu.user = 20000;
    after.container.cpu.usage_usec = 100000;
    after.container.cpu.throttled_usec = 10; after.container.cpu.nr_throttled = 1;
    const output = difference(before, after);
    assert.equal(output.controllerCpuPercentOneCore, 20);
    assert.equal(output.containerCpuPercentQuota, 50);
    assert.equal(output.throttledPeriods, 1);
});
test('Недоступный мониторинг не превращается в нулевую нагрузку', () => {
    const a = {wallMs: 0, processCpu: {user: 0, system: 0}, container: {available: false, reason: 'нет cgroup'}};
    const b = {...a, wallMs: 100};
    assert.equal(difference(a, b).cgroupAvailable, false);
    assert.equal(difference(a, b).containerCpuPercentQuota, undefined);
});
