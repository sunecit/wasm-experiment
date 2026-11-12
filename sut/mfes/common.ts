import { createImageRuntime } from '../runtime/image-runtime';
import type { ImageRuntime, RgbaImage, ImageAnalysis } from '../runtime/image-runtime';
import { getSharedRuntime } from '@stand/shared-runtime';

export type Variant = 'local' | 'server' | 'shared';
export interface Context {
  getImage(): RgbaImage;
  commit(image: RgbaImage): void;
  showAnalysis(result: ImageAnalysis): void;
  perform(action: () => Promise<void>, operation: string): void;
}

export abstract class Microfrontend extends HTMLElement {
  runtime!: ImageRuntime;
  protected context!: Context;
  abstract readonly componentName: string;
  configure(variant: Variant, context: Context): void {
    this.context = context;
    // Независимые среды принадлежат микрофронтендам; общая — отдельному модулю.
    this.runtime = variant === 'shared' ? getSharedRuntime() : createImageRuntime(
      variant === 'local' ? `/mfes/${this.componentName}/manifest.json` : '/delivery/manifest.json'
    );
  }
  protected bind(selector: string, action: () => Promise<void>): void {
    const button = this.querySelector<HTMLButtonElement>(selector)!;
    button.onclick = () => this.context.perform(action, button.dataset.action!);
  }
}
