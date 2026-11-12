import { Microfrontend } from '../common';
import type { RgbaImage, ImageAnalysis } from '../../runtime/image-runtime';

export class AnalysisElement extends Microfrontend {
  readonly componentName = 'analysis';
  connectedCallback(): void {
    this.innerHTML = `<p id="analysis-description">Анализ не меняет изображение. Он рассчитывает средние значения цветов, границы значений каналов и контрольную сумму. Результаты появятся внизу страницы.</p>
      <button data-action="analyze" aria-describedby="analysis-description">Проанализировать</button>`;
    this.bind('[data-action="analyze"]', async () => this.context.showAnalysis(await this.analyze(this.context.getImage())));
  }
  analyze(image: RgbaImage): Promise<ImageAnalysis> { return this.runtime.analyze(image); }
}
customElements.define('analysis-mfe', AnalysisElement);
