import type { ImageAnalysis, RgbaImage } from '../runtime/image-runtime';

const number = (value: number, digits = 0) => value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
function paragraph(parent: HTMLElement, text: string): void {
  const p = document.createElement('p'); p.textContent = text; parent.append(p);
}
function table(parent: HTMLElement, rows: [string, string][]): void {
  const table = document.createElement('table');
  const body = document.createElement('tbody');
  for (const [label, value] of rows) {
    const row = document.createElement('tr');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = label;
    const cell = document.createElement('td'); cell.textContent = value;
    row.append(heading, cell); body.append(row);
  }
  table.append(body); parent.append(table);
}
export function showResults(options: {
  title: string;
  explanation: string;
  analysis?: ImageAnalysis;
  duration?: number;
  instances?: number;
  operations?: number;
  memory?: number;
  steps?: string[];
  branches?: RgbaImage[];
}): void {
  const root = document.querySelector<HTMLElement>('#output')!;
  root.replaceChildren();
  document.querySelector<HTMLElement>('#result-title')!.textContent = options.title;
  paragraph(root, options.explanation);
  if (options.steps) {
    const list = document.createElement('ol');
    options.steps.forEach(step => { const item = document.createElement('li'); item.textContent = step; list.append(item); });
    root.append(list);
  }
  if (options.duration !== undefined) {
    table(root, [
      ['Время выполнения сценария', `${number(options.duration, 3)} мс`],
      ['Выполнено операций', number(options.operations!)],
      ['Создано экземпляров WASM', number(options.instances!)],
      ['Выделено линейной памяти WASM', `${number(options.memory!)} байт`]
    ]);
    paragraph(root, 'Это результат одного запуска. Для сравнения скорости нужны повторные измерения.');
  }
  if (options.branches) {
    const group = document.createElement('div'); group.className = 'branch-results';
    options.branches.forEach((image, index) => {
      const figure = document.createElement('figure');
      const caption = document.createElement('figcaption');
      caption.textContent = `${index === 0 ? 'Ветка фильтрации' : 'Ветка уменьшения'}: ${image.width} × ${image.height}`;
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      canvas.setAttribute('aria-label', index === 0 ? 'Результат фильтрации' : 'Результат уменьшения');
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      figure.append(caption, canvas); group.append(figure);
    });
    root.append(group);
  }
  if (options.analysis) {
    const a = options.analysis;
    table(root, [
      ['Число пикселей', number(a.pixels)],
      ['Среднее значение красного канала', number(a.redSum / a.pixels, 2)],
      ['Среднее значение зелёного канала', number(a.greenSum / a.pixels, 2)],
      ['Среднее значение синего канала', number(a.blueSum / a.pixels, 2)],
      ['Минимальное значение среди каналов RGB', number(a.min)],
      ['Максимальное значение среди каналов RGB', number(a.max)],
      ['Контрольная сумма RGBA (FNV-1a)', a.checksum.toString(16).padStart(8, '0').toUpperCase()]
    ]);
    paragraph(root, 'Значения цветовых каналов находятся в диапазоне от 0 до 255. Средние рассчитаны из сумм, полученных в WASM. Контрольная сумма помогает сравнивать результаты разных подходов (она не оценивает качество изображения).');
  }
}
