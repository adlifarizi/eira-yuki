import { Logger } from 'pino';
import { CommandRouter } from '../../../core';
import { createAudioStickerCommand } from './audio-sticker-command';
import { createStickerCommand } from './sticker-command';
import { StickerConverter } from './types';

export * from './types';
export { createStickerCommand } from './sticker-command';
export { createAudioStickerCommand } from './audio-sticker-command';

/**
 * Registers WhatsApp-specific prefix commands onto the shared core CommandRouter.
 */
export function registerWhatsAppCommands(
  router: CommandRouter,
  stickerConverter: StickerConverter,
  logger?: Logger
): void {
  const prefix = router.getPrefix();
  router.register(createStickerCommand(stickerConverter, prefix, logger));
  router.register(createAudioStickerCommand(stickerConverter, prefix, logger));
}
