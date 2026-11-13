import argparse
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
import matplotlib.pyplot as plt
from analyze import load_batch, holm, cliffs_delta, median_interval, TIMINGS

def aa_test(values, labels):
    x = np.asarray(values, dtype=float)
    a, b = x[labels == 'A1'], x[labels == 'A2']
    ranks = stats.rankdata(x)
    observed = abs(ranks[labels == 'A1'].sum() - ranks[labels == 'A2'].sum())
    total, extreme = 0, 0
    for subset in itertools.combinations(range(10), 5):
        score = abs(2 * ranks[list(subset)].sum() - ranks.sum())
        total += 1
        extreme += score >= observed - 1e-12
    return dict(median_a1=float(np.median(a)), median_a2=float(np.median(b)),
                median_difference=float(np.median(a) - np.median(b)),
                cliffs_delta=cliffs_delta(a, b), p_raw=extreme / total)

def trend_test(order, values, seed, permutations):
    x, y = stats.rankdata(order), stats.rankdata(values)
    if np.ptp(y) == 0:
        return dict(rho=0.0, p_raw=1.0, constant=True)
    x, y = x - x.mean(), y - y.mean()
    norm = np.linalg.norm(x) * np.linalg.norm(y)
    rho = float(np.dot(x, y) / norm)
    rng = np.random.default_rng(seed)
    extreme = sum(abs(np.dot(x, rng.permutation(y)) / norm) >= abs(rho) - 1e-12 for _ in range(permutations))
    return dict(rho=rho, p_raw=(extreme + 1) / (permutations + 1), constant=False)

def adjust(rows):
    for row, value in zip(rows, holm([row['p_raw'] for row in rows])):
        row['p_holm'] = float(value)

def load_resources(path, expected_count):
    rows = []
    for file in sorted(path.glob('run-*.json')):
        record = json.loads(file.read_text())
        for phase in ['scenario', 'browserRun']:
            resource = record.get('resources', {}).get(phase)
            if resource is None:
                raise ValueError('В серии нет ресурсов. Выполните новую серию с обновлённым раннером.')
            row = dict(runId=record['runId'], **record['params'], phase=phase, **resource)
            for key in ['wallMs', 'controllerCpuPercentOneCore']:
                if not isinstance(row.get(key), (float, int)) or not np.isfinite(row[key]) or row[key] < 0:
                    raise ValueError(f'Некорректный показатель ресурсов {key}.')
            rows.append(row)
    if len(rows) != expected_count * 2:
        raise ValueError('Число записей ресурсов не соответствует серии.')
    return pd.DataFrame(rows)

def resource_summary(frame, threshold):
    result = []
    for phase, group in frame.groupby('phase'):
        available = bool(group.cgroupAvailable.all())
        quota = group.get('containerCpuPercentQuota', pd.Series(dtype=float)).dropna()
        throttle = group.get('throttledPeriods', pd.Series(dtype=float)).dropna()
        controller_max = float(group.controllerCpuPercentOneCore.max())
        container_max = float(quota.max()) if len(quota) else None
        complete = available and len(quota) == len(group) and len(throttle) == len(group)
        warning = controller_max >= threshold or (container_max is not None and container_max >= threshold) or bool((throttle > 0).any())
        result.append(dict(phase=phase, controllerMaxPercentOneCore=controller_max,
            containerMaxPercentQuota=container_max,
            runsWithThrottling=int((throttle > 0).sum()) if complete else None,
            status='incomplete' if not complete else 'attention' if warning else 'no_saturation_observed'))
    return result

def main():
    parser = argparse.ArgumentParser(description='A/A, нагрузка и стабильность экспериментального стенда.')
    parser.add_argument('--batch', required=True)
    parser.add_argument('--settings', default='configs/validation.json')
    args = parser.parse_args()
    settings = json.loads(Path(args.settings).read_text())
    if not 0 < settings['alpha'] < 1 or not 0 < settings['cpuWarningPercent'] <= 100 or settings['trendPermutations'] < 999:
        raise ValueError('Некорректные параметры проверки.')
    path = Path(args.batch).resolve()
    if path.parent != Path('results/raw').resolve():
        raise ValueError('Выберите каталог одной серии из results/raw.')
    frame, config, summary, hashes = load_batch(path)
    output = Path('results/processed') / path.name / 'validation'
    output.mkdir(parents=True, exist_ok=True)
    aa_rows = []
    if config.get('validationKind') == 'aa':
        if config['purpose'] != 'validation' or len(frame) != 10 or len(frame.groupby(['variant', 'scenario'])) != 1:
            raise ValueError('A/A требует десять прогонов одной конфигурации.')
        labels = np.array(['A1'] * 5 + ['A2'] * 5)
        np.random.default_rng(settings['splitSeed']).shuffle(labels)
        grouping = frame[['runId', 'order', 'variant', 'scenario', 'repetition']].copy()
        grouping['group'] = labels
        grouping.to_csv(output / 'aa-groups.csv', index=False)
        for metric in TIMINGS:
            values = frame[metric].to_numpy()
            lo, hi = median_interval(values, settings['splitSeed'], 10000)
            aa_rows.append(dict(metric=metric, **aa_test(values, labels), n=10,
                median=float(np.median(values)), iqr=float(np.quantile(values, .75) - np.quantile(values, .25)),
                ci95_low=lo, ci95_high=hi))
        adjust(aa_rows)
        pd.DataFrame(aa_rows).to_csv(output / 'aa.csv', index=False)
        fig, axes = plt.subplots(1, 3, figsize=(13, 4))
        for ax, metric in zip(axes, TIMINGS):
            values = frame[metric].to_numpy()
            ax.boxplot([values[labels == 'A1'], values[labels == 'A2']], tick_labels=['A1', 'A2'])
            for i, label in enumerate(['A1', 'A2'], 1):
                ax.scatter(np.full(5, i), values[labels == label], zorder=3)
            ax.set(title=metric, ylabel='мс')
        fig.suptitle('A/A: одна конфигурация, случайное разбиение 5 + 5')
        fig.tight_layout(); fig.savefig(output / 'aa.png', dpi=140); plt.close(fig)
    trends, insufficient = [], []
    for (variant, scenario), group in frame.groupby(['variant', 'scenario']):
        if len(group) < 10:
            insufficient.append(dict(variant=variant, scenario=scenario, n=len(group)))
            continue
        for metric in TIMINGS:
            trends.append(dict(variant=variant, scenario=scenario, metric=metric, n=len(group),
                **trend_test(group.order, group[metric], settings['splitSeed'], settings['trendPermutations'])))
    adjust(trends)
    pd.DataFrame(trends, columns=['variant', 'scenario', 'metric', 'n', 'rho', 'p_raw', 'constant', 'p_holm']).to_csv(output / 'trends.csv', index=False)
    resources = load_resources(path, len(frame))
    resources.to_csv(output / 'resources.csv', index=False)
    resource_checks = resource_summary(resources, settings['cpuWarningPercent'])
    fig, axes = plt.subplots(1, 2, figsize=(11, 4))
    for phase, group in resources.groupby('phase'):
        axes[0].plot(group.order, group.controllerCpuPercentOneCore, 'o-', label=phase)
        if 'containerCpuPercentQuota' in group:
            axes[1].plot(group.order, group.containerCpuPercentQuota, 'o-', label=phase)
    for ax, title in zip(axes, ['CPU контроллера, % одного ядра', 'CPU контейнера, % квоты']):
        ax.axhline(settings['cpuWarningPercent'], color='red', linestyle='--', label='Порог внимания')
        ax.set(xlabel='Порядковый номер прогона', ylabel='%', title=title); ax.legend()
    fig.tight_layout(); fig.savefig(output / 'resources.png', dpi=140); plt.close(fig)
    alpha = settings['alpha']
    report = dict(batchId=summary['batchId'], settings=settings, inputSha256=hashes,
        validatorSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        aaStatus=('difference_detected' if any(r['p_holm'] < alpha for r in aa_rows) else 'no_difference_detected') if aa_rows else 'not_requested',
        trendStatus='insufficient' if insufficient else 'trend_detected' if any(r['p_holm'] < alpha for r in trends) else 'no_trend_detected',
        insufficientGroups=insufficient, resources=resource_checks,
        codeVersionStatus=summary['metadataStatus'],
        repeatability='Основная серия должна быть повторена после запуска основного эксперимента.',
        limitations=['Отсутствие значимости при 5 + 5 наблюдениях не доказывает эквивалентность.',
            'Средняя CPU-нагрузка за интервал не исключает кратковременные пики и ожидание ввода-вывода.',
            'Контейнер включает Chromium с объектом исследования; его CPU не равен CPU генератора.',
            'Память фиксируется в конце интервала, это не максимум памяти.',
            'При предупреждении о CPU или троттлинге нужна проверка влияния ресурсов до основного эксперимента.'])
    (output / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    descriptions = {
        'no_difference_detected': 'статистически значимое различие не обнаружено',
        'difference_detected': 'обнаружено статистически значимое различие',
        'not_requested': 'A/A не запрошена для этой серии',
        'no_trend_detected': 'значимый монотонный тренд не обнаружен; требуется просмотр графиков',
        'trend_detected': 'обнаружен значимый монотонный тренд',
        'insufficient': 'недостаточно повторений',
        'no_saturation_observed': 'порог нагрузки не превышен, троттлинг не зафиксирован',
        'attention': 'требуется внимание к нагрузке или троттлингу',
        'incomplete': 'недостаточно данных мониторинга',
        'unversioned-code': 'есть незакоммиченные изменения или отсутствует коммит',
        'captured': 'чистая версия кода зафиксирована'
    }
    text = ['Проверка стенда', f'Серия: {summary["batchId"]}',
            f'A/A: {descriptions[report["aaStatus"]]}',
            f'Стабильность: {descriptions[report["trendStatus"]]}',
            f'Версия кода: {descriptions.get(report["codeVersionStatus"], report["codeVersionStatus"])}']
    for item in resource_checks:
        phase = 'Выполнение сценария' if item['phase'] == 'scenario' else 'Запуск браузера и сценарий'
        text.append(f'{phase}: {descriptions[item["status"]]}; максимум CPU контроллера {item["controllerMaxPercentOneCore"]:.2f}%')
        container_max = item['containerMaxPercentQuota']
        text.append(f'Максимальная средняя нагрузка контейнера за интервал: {container_max:.2f}% квоты' if container_max is not None else 'Нагрузка контейнера: нет данных')
        text.append(f'Прогонов с троттлингом: {item["runsWithThrottling"]}')
    text.extend(report['limitations'])
    (output / 'validation.txt').write_text('\n'.join(text) + '\n')
    print('\n'.join(text[:4])); print(f'Протокол: {output}')

if __name__ == '__main__':
    main()
