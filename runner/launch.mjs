import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import os from 'node:os';
import {readConfig} from './plan.mjs';

const configPath = process.env.EXPERIMENT_CONFIG ?? 'configs/experiment.json';
const config = await readConfig(configPath);

function command(program, args) {
    return execFileSync(program, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function docker(...args) {
    return command('docker', args);
}

let git;
try {
    git = {
        commit: command('git', ['rev-parse', 'HEAD']),
        dirty: Boolean(command('git', ['status', '--porcelain', '--untracked-files=normal']))
    };
} catch {
    git = {commit: null, dirty: null, reason: 'Нет доступного Git-коммита.'};
}
if (config.purpose === 'experiment' && (!git.commit || git.dirty)) {
    throw new Error('Для основной серии требуется Git-коммит и чистая рабочая копия. Проверка доступна через make quick.');
}
const compose = JSON.parse(docker('compose', '--profile', 'experiment', 'config', '--format', 'json'));
const services = {};
for (const name of ['web', 'wasm-delivery', 'experiment']) {
    const service = compose.services[name];
    let image;
    let actualLimits = null;
    if (name === 'experiment') {
        image = service.image ?? `${compose.name}-${name}`;
    } else {
        const id = docker('compose', 'ps', '-q', name);
        if (!id || id.includes('\n')) throw new Error(`Ожидается один работающий контейнер ${name}.`);
        const container = JSON.parse(docker('inspect', id))[0];
        image = container.Image;
        actualLimits = {
            nanoCpus: container.HostConfig.NanoCpus, memoryBytes: container.HostConfig.Memory,
            shmBytes: container.HostConfig.ShmSize
        };
    }
    const details = JSON.parse(docker('image', 'inspect', image))[0];
    services[name] = {
        imageId: details.Id, repoDigests: details.RepoDigests ?? [],
        os: details.Os, architecture: details.Architecture,
        configuredLimits: {cpus: service.cpus, memory: service.mem_limit, shmSize: service.shm_size}, actualLimits
    };
}
const daemon = JSON.parse(docker('info', '--format', '{{json .}}'));
const metadata = {
    schemaVersion: 1, capturedAt: new Date().toISOString(), git,
    configSha256: createHash('sha256').update(readFileSync(configPath)).digest('hex'),
    host: {
        os: os.type(), release: os.release(), architecture: os.arch(),
        cpuModel: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, memoryBytes: os.totalmem()
    },
    docker: {
        serverVersion: daemon.ServerVersion, operatingSystem: daemon.OperatingSystem,
        architecture: daemon.Architecture, cpuCount: daemon.NCPU, memoryBytes: daemon.MemTotal,
        composeVersion: docker('compose', 'version', '--short')
    }, services,
    limitations: git.commit && !git.dirty ? [] : ['Версия кода не зафиксирована чистым Git-коммитом.']
};

mkdirSync('results/raw', {recursive: true});
const filename = `environment-${randomUUID()}.json`;
writeFileSync(`results/raw/${filename}`, JSON.stringify(metadata, null, 2) + '\n', {flag: 'wx'});
try {

    execFileSync('docker', ['compose', '--profile', 'experiment', 'run', '--rm', '--no-deps',
        '-e', `EXPERIMENT_CONFIG=${configPath}`, '-e', `EXPERIMENT_METADATA=results/raw/${filename}`,
        'experiment'], {stdio: 'inherit'});
} catch (error) {
    process.exitCode = error.status ?? 1;
}
