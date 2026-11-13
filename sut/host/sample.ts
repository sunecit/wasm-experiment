import type { RgbaImage } from '../runtime/image-runtime';

export function createSample(): RgbaImage {
  const width = 640, height = 420;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = Math.floor(x * 255 / (width - 1));
    data[i + 1] = Math.floor(y * 255 / (height - 1));
    data[i + 2] = ((x >> 5) + (y >> 5)) % 2 ? 210 : 70;
    data[i + 3] = 255;
  }
  return { width, height, data };
}
