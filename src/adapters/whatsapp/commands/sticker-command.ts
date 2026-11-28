import { Logger } from 'pino';
import { BotCommand, CoreResponse, IncomingMessage } from '../../../core';
import { StickerConverter } from './types';

/**
 * Creates the `.sticker` command that converts attached or quoted images/videos into silent WebP stickers.
 */
export function createStickerCommand(
  stickerConverter: StickerConverter,
  prefix: string,
  logger?: Logger
): BotCommand {
  return {
    name: 'sticker',
    aliases: ['s'],
    description: 'Ubah gambar, GIF, atau video menjadi stiker tanpa suara',
    execute: async (_args: string[], incoming: IncomingMessage): Promise<CoreResponse> => {
      const media = incoming.media;
      if (!media || (media.type !== 'image' && media.type !== 'video')) {
        return {
          text: `Silakan kirim atau balas gambar, gif, atau video dengan ${prefix}sticker`,
        };
      }

      try {
        const stickerBuffer =
          media.type === 'image'
            ? await stickerConverter.imageToSticker(media.buffer)
            : await stickerConverter.videoToSticker(media.buffer);

        return {
          text: '',
          attachment: {
            type: 'sticker',
            payload: stickerBuffer,
            metadata: media.type === 'video' ? { isAnimated: true } : undefined,
          },
        };
      } catch (err) {
        logger?.error({ err, mediaType: media.type }, 'Failed to create sticker');
        return { text: 'Gagal membuat stiker.' };
      }
    },
  };
}
