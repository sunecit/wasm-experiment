import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

export function parseCounters(text) {
    return Object.fromEntries(text.trim().split('\n').map(line => {
        const [name, value] = line.trim().split(/\s+/);
        return [name, Number(value)];
    }));
}

export function snapshot() {
    let container;
    try {
        const cpu = parseCounters(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'));
        const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
        container = {available: true, cpu, quotaCpus: quota === 'max' ? null : Number(quota) / Number(period),
            memoryBytes: Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'))};
    } catch (error) {
        container = {available: false, reason: error.message};
    }
    return {wallMs: performance.now(), processCpu: process.cpuUsage(),
        processRssBytes: process.memoryUsage().rss, container};
}

export function difference(before, after) {
    const wallMs = after.wallMs - before.wallMs;
    const processCpuUs = after.processCpu.user + after.processCpu.system - before.processCpu.user - before.processCpu.system;
    const result = {wallMs, controllerCpuUs: processCpuUs,
        controllerCpuPercentOneCore: wallMs > 0 ? processCpuUs / (wallMs * 1000) * 100 : null,
        controllerRssBytesAfter: after.processRssBytes,
        cgroupAvailable: before.container.available && after.container.available};
    if (result.cgroupAvailable) {
        const a = before.container, b = after.container;
        result.containerCpuUs = b.cpu.usage_usec - a.cpu.usage_usec;
        result.cpuQuotaCpus = b.quotaCpus;
        result.containerCpuPercentQuota = wallMs > 0 && b.quotaCpus > 0 ? result.containerCpuUs / (wallMs * 1000 * b.quotaCpus) * 100 : null;
        result.throttledUs = b.cpu.throttled_usec - a.cpu.throttled_usec;
        result.throttledPeriods = b.cpu.nr_throttled - a.cpu.nr_throttled;
        result.containerMemoryBytesAfter = b.memoryBytes;
    } else {
        result.reason = after.container.reason ?? before.container.reason;
    }
    return result;
}
