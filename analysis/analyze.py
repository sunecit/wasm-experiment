import argparse
import hashlib
import itertools
import json
import platform
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy
from scipy import stats

METRICS = {
    'scenarioDurationMs': 'Время сценария, мс',
    'initializationDurationMs': 'Суммарное время инициализации, мс',
    'operationDurationMs': 'Суммарное время операций, мс',
    'wasmInstanceCount': 'Число экземпляров WASM',
    'wasmLinearMemoryBytes': 'Линейная память WASM, байт',
    'wasmFetchCount': 'Число вызовов загрузки WASM',
    'wasmFetchedBytes': 'Сумма размеров полученных WASM-данных, байт',
}
TIMINGS = list(METRICS)[:3]


def read_json(path):
    return json.loads(path.read_text())


def load_batch(path):
    summary = read_json(path / 'summary.json')
    config = read_json(path / 'config.json')
    plan = read_json(path / 'plan.json')
    if summary['status'] != 'completed' or summary['failed'] != 0:
        raise ValueError('Анализ требует полностью завершённой серии без ошибок.')
    files = sorted(path.glob('run-*.json'))
    if len(files) != len(plan) or len(files) != summary['completed'] or len(files) != summary['planned']:
        raise ValueError('Количество записей не соответствует плану.')
    expected = {p['order']: p for p in plan}
    if len(expected) != len(plan):
        raise ValueError('Повторяющиеся номера в плане.')
    rows, hashes = [], {}
    for file in files:
        hashes[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
        record = read_json(file)
        p = record['params']
        if record['status'] != 'completed' or record['batchId'] != summary['batchId']:
            raise ValueError('Некорректная запись прогона.')
        if record['purpose'] != config['purpose'] or record['seed'] != config['seed']:
            raise ValueError('Назначение или сид прогона не соответствует конфигурации.')
        if expected.pop(p['order'], None) != p:
            raise ValueError('Запись не соответствует плану или повторяется.')
        manifest = record.get('manifest')
        if not manifest or manifest['file'] != 'environment.json':
            raise ValueError('Отсутствует поддерживаемый манифест окружения.')
        digest = hashlib.sha256((path / 'environment.json').read_bytes()).hexdigest()
        if digest != manifest['sha256']:
            raise ValueError('Контрольная сумма манифеста не совпадает.')
        output = record['output']
        if output['variant'] != p['variant'] or output['scenario'] != p['scenario'] or record['pageErrors']:
            raise ValueError('Несогласованные или ошибочные результаты.')
        row = dict(p, runId=record['runId'])
        for metric in METRICS:
            value = output[metric] if metric == 'scenarioDurationMs' else output['diagnostics'][metric]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or value < 0:
                raise ValueError(f'Недопустимое значение {metric}.')
            row[metric] = value
        rows.append(row)
    frame = pd.DataFrame(rows).sort_values('order')
    combos = set(itertools.product(config['variants'], config['scenarios'], range(1, config['repetitions'] + 1)))
    actual = list(frame[['variant', 'scenario', 'repetition']].itertuples(index=False, name=None))
    if len(actual) != len(combos) or set(actual) != combos:
        raise ValueError('Набор комбинаций не соответствует конфигурации.')
    environment = read_json(path / 'environment.json')
    if config['purpose'] == 'experiment' and (not environment['git']['commit'] or environment['git']['dirty']):
        raise ValueError('Основная серия не привязана к чистому Git-коммиту.')
    for name in ['config.json', 'plan.json', 'summary.json', 'environment.json']:
        hashes[name] = hashlib.sha256((path / name).read_bytes()).hexdigest()
    return frame, config, summary, hashes


def median_interval(values, seed, resamples):
    x = np.asarray(values, dtype=float)
    if len(x) < 2:
        return None, None
    # Перцентильный bootstrap: единицей повторной выборки является целый прогон.
    rng = np.random.default_rng(seed)
    medians = np.median(rng.choice(x, size=(resamples, len(x)), replace=True), axis=1)
    return tuple(float(v) for v in np.quantile(medians, [0.025, 0.975]))


def cliffs_delta(a, b):
    return float(np.sign(np.subtract.outer(np.asarray(a, dtype=float), np.asarray(b, dtype=float))).mean())


def holm(pvalues):
    pvalues = np.asarray(pvalues, dtype=float)
    order = np.argsort(pvalues)
    result = np.empty(len(pvalues))
    previous = 0.0
    for rank, index in enumerate(order):
        previous = max(previous, min(1.0, (len(pvalues) - rank) * pvalues[index]))
        result[index] = previous
    return result


def analyze(frame, config, output, seed, resamples):
    summaries = []
    for (scenario, variant), group in frame.groupby(['scenario', 'variant'], sort=True):
        for metric in METRICS:
            x = group[metric].to_numpy()
            lo, hi = median_interval(x, seed, resamples)
            summaries.append(dict(scenario=scenario, variant=variant, metric=metric, n=len(x),
                median=float(np.median(x)), iqr=float(np.quantile(x, .75) - np.quantile(x, .25)),
                ci95_low=lo, ci95_high=hi))
    pd.DataFrame(summaries).to_csv(output / 'summary.csv', index=False)
    comparisons = []
    # Проверочные серии не используются для проверки гипотез.
    for scenario in config['scenarios']:
        for a, b in itertools.combinations(config['variants'], 2):
            for metric in TIMINGS:
                x = frame.query('scenario == @scenario and variant == @a')[metric].to_numpy()
                y = frame.query('scenario == @scenario and variant == @b')[metric].to_numpy()
                eligible = config['purpose'] == 'experiment' and min(len(x), len(y)) >= 10
                p = float(stats.mannwhitneyu(x, y, alternative='two-sided', method='asymptotic').pvalue) if eligible else None
                comparisons.append(dict(scenario=scenario, metric=metric, a=a, b=b, n_a=len(x), n_b=len(y),
                    cliffs_delta=cliffs_delta(x, y) if eligible else None, p_raw=p, p_holm=None,
                    status='calculated' if eligible else 'insufficient_or_validation'))
    valid = [row for row in comparisons if row['p_raw'] is not None]
    for row, adjusted in zip(valid, holm([row['p_raw'] for row in valid])):
        row['p_holm'] = float(adjusted)
    pd.DataFrame(comparisons, columns=['scenario', 'metric', 'a', 'b', 'n_a', 'n_b', 'cliffs_delta', 'p_raw', 'p_holm', 'status']).to_csv(output / 'comparisons.csv', index=False)
    for scenario in config['scenarios']:
        for metric, label in METRICS.items():
            fig, axes = plt.subplots(1, 3 if metric in TIMINGS else 2, figsize=(14 if metric in TIMINGS else 10, 4.5))
            groups = [frame.query('scenario == @scenario and variant == @variant').sort_values('order') for variant in config['variants']]
            axes[0].boxplot([g[metric] for g in groups], tick_labels=config['variants'])
            for i, (variant, group) in enumerate(zip(config['variants'], groups), 1):
                axes[0].scatter(np.full(len(group), i), group[metric], s=18, alpha=.7, zorder=3)
                axes[1].plot(group['order'], group[metric], 'o-', label=variant, markersize=4)
                if metric in TIMINGS:
                    x = np.sort(group[metric].to_numpy())
                    axes[2].ecdf(x, label=variant)
            axes[0].set(ylabel=label, title='Распределение и отдельные прогоны')
            axes[1].set(xlabel='Порядковый номер прогона', ylabel=label, title='Изменение по ходу серии')
            axes[1].legend()
            if metric in TIMINGS:
                axes[2].set(xlabel=label, ylabel='Доля прогонов ≤ значения', title='ECDF', ylim=(0, 1.05))
                axes[2].legend()
            fig.suptitle(f"{scenario} | {'Проверочная серия' if config['purpose'] == 'validation' else 'Экспериментальная серия'}")
            fig.tight_layout()
            fig.savefig(output / f'{scenario}-{metric}.png', dpi=140)
            plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description='Анализ одной явно выбранной серии прогонов.')
    parser.add_argument('--batch', required=True)
    parser.add_argument('--seed', type=int, default=20261112)
    parser.add_argument('--resamples', type=int, default=10000)
    args = parser.parse_args()
    if args.resamples < 1000:
        parser.error('Требуется не менее 1000 bootstrap-выборок.')
    path = Path(args.batch).resolve()
    raw = Path('results/raw').resolve()
    if path.parent != raw:
        parser.error('Выберите один каталог серии внутри results/raw.')
    frame, config, summary, hashes = load_batch(path)
    output = Path('results/processed') / path.name
    output.mkdir(parents=True, exist_ok=True)
    frame.to_csv(output / 'runs.csv', index=False)
    analyze(frame, config, output, args.seed, args.resamples)
    metadata = dict(batchId=summary['batchId'], purpose=config['purpose'], inputSha256=hashes,
        analysisSourceSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), seed=args.seed,
        bootstrapResamples=args.resamples, bootstrapMethod='percentile', confidenceLevel=.95,
        multipleTestingFamily='Все рассчитанные сравнения временных метрик этой серии',
        versions=dict(python=platform.python_version(), numpy=np.__version__, scipy=scipy.__version__, pandas=pd.__version__, matplotlib=matplotlib.__version__),
        limitations=['Проверки A/A, нагрузки и повторяемости выполняются отдельно.',
            'Линейная память WASM не равна общей памяти браузера.',
            'Сумма полученных WASM-байт не равна сетевому трафику из-за кэширования.',
            'Отсутствие значимого различия не доказывает эквивалентность.'])
    (output / 'analysis-manifest.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(f'Обработано {len(frame)} прогонов. Назначение: {config["purpose"]}. Результаты: {output}')
    if config['purpose'] == 'validation':
        print('Проверочная серия: статистические сравнения отключены. При n=1 доверительный интервал не рассчитывается.')


if __name__ == '__main__':
    main()
