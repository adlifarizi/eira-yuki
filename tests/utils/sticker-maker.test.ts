import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { imageToSticker } from '../../src/utils/sticker-maker';

describe('sticker-maker', () => {
  it('converts a PNG image buffer into a 512x512 WebP sticker buffer', async () => {
    const pngBuffer = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const webpBuffer = await imageToSticker(pngBuffer);
    const metadata = await sharp(webpBuffer).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
  });
});
