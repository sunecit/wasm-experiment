import { Microfrontend } from '../common';
import type { RgbaImage } from '../../runtime/image-runtime';

export class FiltersElement extends Microfrontend {
  readonly componentName = 'filters';
  connectedCallback(): void {
    this.innerHTML = `<h2>Фильтрация</h2>
      <button data-action="grayscale">Оттенки серого</button>
      <button data-action="invert">Инверсия</button>
      <button data-action="brightness">Яркость +12</button>`;
    for (const kind of ['grayscale', 'invert', 'brightness'] as const) {
      this.bind(`[data-action="${kind}"]`, async () => {
        this.context.commit(await this.apply(this.context.getImage(), kind, kind === 'brightness' ? 12 : undefined));
      });
    }
  }
  apply(image: RgbaImage, kind: 'grayscale' | 'invert' | 'brightness', value?: number): Promise<RgbaImage> {
    return this.runtime.filter(image, kind, value);
  }
}
customElements.define('filters-mfe', FiltersElement);
