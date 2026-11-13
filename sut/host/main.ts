import './style.css';
import { showResults } from './results';
import { resetSharedRuntime } from '@stand/shared-runtime';
import { createSample } from './sample';
import type { RgbaImage, RuntimeDiagnostics, ImageAnalysis } from '../runtime/image-runtime';
import type { Context, Variant } from '../mfes/common';
import type { FiltersElement } from '../mfes/filters/index';
import type { TransformElement } from '../mfes/transform/index';
import type { AnalysisElement } from '../mfes/analysis/index';

type Scenario = 'sequential' | 'concurrent' | 'repeated';
type Totals = Omit<RuntimeDiagnostics, 'lastOperationDurationMs'>;
const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const status = element('#status');
const selector = element<HTMLSelectElement>('#variant');
let variant: Variant = 'local';
let image: RgbaImage = createSample();
let busy = false;
const messages: Record<string, [string, string]> = {
  grayscale: ['Преобразуем изображение в оттенки серого.', 'Изображение преобразовано в оттенки серого. Результат показан в области изображения.'],
  invert: ['Инвертируем цвета изображения.', 'Цвета изображения инвертированы. Результат показан в области изображения.'],
  brightness: ['Увеличиваем яркость изображения.', 'Значения цветовых каналов увеличены на 12 с ограничением до 255. Изображение обновлено.'],
  resize: ['Уменьшаем изображение до 320 × 210 пикселей.', 'Размер изображения изменён на 320 × 210 пикселей. Результат показан в области изображения.'],
  horizontal: ['Отражаем изображение по горизонтали.', 'Изображение отражено по горизонтали. Результат показан в области изображения.'],
  vertical: ['Отражаем изображение по вертикали.', 'Изображение отражено по вертикали. Результат показан в области изображения.'],
  analyze: ['Вычисляем характеристики текущего изображения.', 'Анализ завершён. Характеристики цветов, число пикселей и контрольная сумма показаны в таблице ниже. Изображение не изменено.'],
  sequential: ['Выполняем последовательный сценарий: фильтрацию, уменьшение и анализ.', 'Последовательный сценарий завершён: изображение преобразовано в серое, уменьшено до 320 × 210 и проанализировано. Результаты показаны ниже.'],
  concurrent: ['Запускаем фильтрацию и уменьшение с одновременным обращением к WASM.', 'Конкурентный сценарий завершён. Ниже показаны результаты обеих веток: серая и уменьшенная цветная картинки. Исходное изображение сохранено.'],
  repeated: ['Выполняем пять операций повторного обращения к WASM.', 'Завершены пять операций: инверсия, горизонтальное отражение, анализ, увеличение яркости и вертикальное отражение. Ниже показаны показатели запуска и анализ третьего шага.']
};
const descriptions: Record<Variant, string> = {
  local: 'Каждый микрофронтенд загружает свою копию WASM и создаёт собственный экземпляр с памятью. После обращения всех трёх компонентов будет три экземпляра.',
  server: 'Все микрофронтенды получают WASM по одному адресу, но создают собственные экземпляры. Общий файл не означает общую память: после обращения всех компонентов будет три экземпляра.',
  shared: 'Все микрофронтенды используют общую среду, которая создаёт один экземпляр WASM. Фильтрация, преобразование и анализ повторно используют его память.'
};

async function start(): Promise<void> {

  await Promise.all(['filters', 'transform', 'analysis'].map(name => {
    const url = `/mfes/${name}/remoteEntry.js`;
    return import(                   url);
  }));
  const filters = element<FiltersElement>('filters-mfe');
  const transform = element<TransformElement>('transform-mfe');
  const analysis = element<AnalysisElement>('analysis-mfe');
  const components = [filters, transform, analysis];

  function diagnostics(): Totals {

    const runtimes = [...new Set(components.map(component => component.runtime))];
    const { lastOperationDurationMs: _last, ...totals } = runtimes[0].diagnostics();
    for (const key of Object.keys(totals) as (keyof Totals)[]) {
      totals[key] = runtimes.reduce((sum, runtime) => sum + runtime.diagnostics()[key], 0);
    }
    return totals;
  }
  function draw(): void {
    const canvas = element<HTMLCanvasElement>('#image');
    canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    element('#dimensions').textContent = `${image.width} × ${image.height} (RGBA)`;
    const d = diagnostics();
    const entries = [ ['Экземпляры WASM', d.wasmInstanceCount], ['Попытки инициализации', d.initializationAttemptCount],
      ['Вызовы fetch для WASM', d.wasmFetchCount], ['Память WASM, байт', d.wasmLinearMemoryBytes],
      ['Завершённые операции', d.operationCount], ['Инициализация, мс (сумма)', d.initializationDurationMs.toFixed(3)] ];
    element('#metrics').innerHTML = entries.map(([label, value]) => `<tr><th scope="row">${label}</th><td>${value}</td></tr>`).join('');
  }
  function lock(value: boolean): void {
    busy = value;
    document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach(control => control.disabled = value);
  }
  async function perform<T>(action: () => Promise<T>, operation: string): Promise<T> {
    if (busy) throw new Error('Предыдущее действие ещё не завершено.');
    lock(true); status.textContent = messages[operation][0]; status.dataset.error = 'false'; status.dataset.state = 'running';
    try {
      const result = await action();
      draw(); status.textContent = messages[operation][1]; status.dataset.state = 'complete';
      return result;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.dataset.error = 'true'; status.dataset.state = 'error';
      throw error;
    } finally { lock(false); }
  }
  const context: Context = {
    getImage: () => image,
    commit: value => { image = value; showResults({ title: 'Изображение обработано', explanation: `Текущий размер: ${image.width} × ${image.height} пикселей. Нажмите «Проанализировать» под изображением, чтобы получить его характеристики.` }); },
    showAnalysis: value => { showResults({ title: 'Анализ текущего изображения', explanation: `Проанализировано изображение ${image.width} × ${image.height} пикселей. Анализ не изменяет его содержимое.`, analysis: value }); },
    perform: (action, operation) => { void perform(action, operation).catch(() => {                                      }); }
  };
  function reset(next: Variant): void {
    if (!['local', 'server', 'shared'].includes(next)) throw new Error('Неизвестный подход.');
    variant = next; selector.value = next; image = createSample();
    resetSharedRuntime();
    components.forEach(component => component.configure(next, context));
    performance.clearResourceTimings();
    status.dataset.error = 'false'; status.dataset.state = 'idle';
    element('#approach-description').textContent = descriptions[next];
    showResults({ title: 'Результаты', explanation: 'Выберите фильтр или преобразование для ручной обработки. Кнопка «Проанализировать» покажет характеристики текущего изображения. Сценарии справа запускают готовые проверки с исходного изображения.' });
    draw();
  }
  async function runScenario(scenario: Scenario, next: Variant = variant) {
    if (!['sequential', 'concurrent', 'repeated'].includes(scenario)) throw new Error('Неизвестный сценарий.');
    return perform(async () => {
      reset(next);
      const started = performance.now();
      let result: ImageAnalysis | { branches: { width: number; height: number }[] } | undefined;
      let branchImages: RgbaImage[] | undefined;
      if (scenario === 'sequential') {
        image = await filters.apply(image, 'grayscale');
        image = await transform.resize(image, 320, 210);
        result = await analysis.analyze(image);
      } else if (scenario === 'concurrent') {

        const outputs = await Promise.all([filters.apply(image, 'grayscale'), transform.resize(image, 320, 210)]);

        branchImages = outputs;
        result = { branches: outputs.map(value => ({ width: value.width, height: value.height })) };
      } else {
        image = await filters.apply(image, 'invert');
        image = await transform.flip(image, 'horizontal');
        result = await analysis.analyze(image);
        image = await filters.apply(image, 'brightness', 12);
        image = await transform.flip(image, 'vertical');
      }
      const scenarioDurationMs = performance.now() - started;
      const output = { variant, scenario, scenarioDurationMs, diagnostics: diagnostics(), result,
        analysisStage: scenario === 'repeated' ? 'После инверсии и горизонтального отражения, до последних двух операций.' : null,
        resources: performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('.wasm')).map(entry => {
          const r = entry as PerformanceResourceTiming;
          return { name: r.name, duration: r.duration, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize };
        }) };
      const titles = { sequential: 'Последовательный доступ: результат', concurrent: 'Конкурентный первый доступ: две ветки', repeated: 'Повторные обращения: результат' };
      const explanations = {
        sequential: 'Три микрофронтенда обработали изображение по очереди. Сверху показано уменьшенное серое изображение, ниже его характеристики.',
        concurrent: 'Обе ветки получили одну исходную картинку и одновременно запросили WASM. Фильтрация дала серое изображение, уменьшение сохранило цвета. Это два независимых результата; основное изображение не изменилось.',
        repeated: 'Выполнено пять обращений к WASM. Сверху показано изображение после всех операций. Анализ ниже относится к третьему шагу, до изменения яркости и вертикального отражения.'
      };
      const steps = {
        sequential: ['Преобразование в оттенки серого', 'Уменьшение до 320 × 210', 'Анализ уменьшенного изображения'],
        concurrent: ['Общий старт двух обращений к WASM', 'Независимая обработка исходного изображения в каждой ветке'],
        repeated: ['Инверсия цветов', 'Горизонтальное отражение', 'Анализ промежуточного изображения', 'Увеличение яркости на 12', 'Вертикальное отражение']
      };
      showResults({ title: titles[scenario], explanation: explanations[scenario], steps: steps[scenario],
        duration: scenarioDurationMs, operations: output.diagnostics.operationCount,
        instances: output.diagnostics.wasmInstanceCount, memory: output.diagnostics.wasmLinearMemoryBytes,
        analysis: result && 'pixels' in result ? result : undefined, branches: branchImages });
      return output;
    }, scenario);
  }
  selector.onchange = () => { reset(selector.value as Variant); status.textContent = `Выбран подход «${selector.selectedOptions[0].textContent}». Восстановлено исходное изображение, счётчики обнулены. WASM загрузится при первой операции.`; };
  element<HTMLButtonElement>('#reset').onclick = () => { reset(variant); status.textContent = 'Восстановлено исходное изображение 640 × 420. Счётчики обнулены. WASM загрузится при следующей операции; HTTP-кэш браузера не очищен.'; };
  document.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach(button => {
    button.onclick = () => { void runScenario(button.dataset.scenario as Scenario).catch(() => {                                      }); };
  });
  reset('local'); status.textContent = 'Выберите фильтр или преобразование под изображением либо запустите сценарий справа. Вычисления ещё не выполнялись.';
  Object.assign(globalThis, { __imageLabHarness: { runScenario, diagnostics } });
}
void start().catch(error => { status.textContent = `Ошибка загрузки: ${error.message}`; status.dataset.error = 'true'; });
