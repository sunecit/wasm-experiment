import { Microfrontend } from '../common';
import type { RgbaImage } from '../../runtime/image-runtime';

export class TransformElement extends Microfrontend {
  readonly componentName = 'transform';
  connectedCallback(): void {
    this.innerHTML = `<h2>Преобразование</h2>
      <button data-action="resize">Размер 320 × 210</button>
      <button data-action="horizontal">Отразить по горизонтали</button>
      <button data-action="vertical">Отразить по вертикали</button>`;
    this.bind('[data-action="resize"]', async () => this.context.commit(await this.resize(this.context.getImage(), 320, 210)));
    for (const direction of ['horizontal', 'vertical'] as const) {
      this.bind(`[data-action="${direction}"]`, async () => this.context.commit(await this.flip(this.context.getImage(), direction)));
    }
  }
  resize(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
    return this.runtime.resize(image, width, height);
  }
  flip(image: RgbaImage, direction: 'horizontal' | 'vertical'): Promise<RgbaImage> {
    return this.runtime.flip(image, direction);
  }
}
customElements.define('transform-mfe', TransformElement);
