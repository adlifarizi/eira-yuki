import { Logger } from 'pino';
import { BotCommand, CoreResponse, IncomingMessage } from '../../../core';
import { StickerConverter } from './types';

const PENDING_SESSION_TTL_MS = 60 * 1000;
const MAX_PENDING_SESSIONS = 100;

interface PendingVisual {
  stickerBuffer: Buffer;
  isAnimated: boolean;
  expiresAt: number;
}

/**
 * Creates the `.asticker` command for native WhatsApp 1-bubble audio stickers.
 * Supports:
 * 1. Video with audio stream (1-step).
 * 2. Image/GIF/sticker replying to an audio message (1-step).
 * 3. Image/GIF/sticker followed by an audio/voice-note message within 60 seconds (2-step).
 */
export function createAudioStickerCommand(
  stickerConverter: StickerConverter,
  prefix: string,
  logger?: Logger
): BotCommand {
  const pendingSessions = new Map<string, PendingVisual>();

  const getSessionKey = (chatId: string, senderId: string) => `${chatId}:${senderId}`;

  const getActiveSession = (chatId: string, senderId: string): PendingVisual | undefined => {
    const key = getSessionKey(chatId, senderId);
    const entry = pendingSessions.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      pendingSessions.delete(key);
      return undefined;
    }
    return entry;
  };

  const setPendingSession = (chatId: string, senderId: string, visual: PendingVisual): void => {
    const key = getSessionKey(chatId, senderId);
    if (pendingSessions.size >= MAX_PENDING_SESSIONS) {
      const oldest = pendingSessions.keys().next().value;
      if (oldest !== undefined) pendingSessions.delete(oldest);
    }
    pendingSessions.set(key, visual);
  };

  const buildAudioStickerResponse = (
    stickerBuffer: Buffer,
    audioBuffer: Buffer,
    seconds: number,
    isAnimated: boolean
  ): CoreResponse => ({
    text: '',
    attachment: {
      type: 'sticker',
      payload: stickerBuffer,
      metadata: {
        isAnimated,
        audio: audioBuffer,
        seconds,
      },
    },
  });

  return {
    name: 'asticker',
    aliases: ['as', 'soundsticker'],
    description: 'Buat stiker bersuara dari video bersuara atau gambar/GIF + audio',
    hasPendingSession: (chatId: string, senderId: string) =>
      getActiveSession(chatId, senderId) !== undefined,
    tryHandlePending: async (incoming: IncomingMessage): Promise<CoreResponse | null> => {
      if (incoming.media?.type !== 'audio' || !stickerConverter.audioToOpus) {
        return null;
      }

      const session = getActiveSession(incoming.chatId, incoming.senderId);
      if (!session) {
        return null;
      }

      pendingSessions.delete(getSessionKey(incoming.chatId, incoming.senderId));

      try {
        const opus = await stickerConverter.audioToOpus(incoming.media.buffer);
        return buildAudioStickerResponse(
          session.stickerBuffer,
          opus.audio,
          opus.seconds,
          session.isAnimated
        );
      } catch (err) {
        logger?.error({ err }, 'Failed to process follow-up audio for audio sticker');
        return { text: 'Gagal menggabungkan audio menjadi stiker bersuara.' };
      }
    },
    execute: async (_args: string[], incoming: IncomingMessage): Promise<CoreResponse> => {
      const primary = incoming.media;
      const secondary = incoming.secondaryMedia;

      if (!primary || (primary.type !== 'image' && primary.type !== 'video')) {
        return {
          text: `Kirim/balas video bersuara dengan ${prefix}asticker, atau kirim gambar/GIF dengan caption ${prefix}asticker (bisa sambil reply audio, atau kirim audio setelahnya).`,
        };
      }

      try {
        // Case 1: Visual + quoted audio in a single turn
        if (secondary?.type === 'audio' && stickerConverter.audioToOpus) {
          const [visualBuffer, opus] = await Promise.all([
            primary.type === 'image'
              ? stickerConverter.imageToSticker(primary.buffer)
              : stickerConverter.videoToSticker(primary.buffer),
            stickerConverter.audioToOpus(secondary.buffer),
          ]);
          return buildAudioStickerResponse(
            visualBuffer,
            opus.audio,
            opus.seconds,
            primary.type === 'video'
          );
        }

        // Case 2: Video with embedded audio stream
        if (primary.type === 'video' && stickerConverter.videoToAudioSticker) {
          const result = await stickerConverter.videoToAudioSticker(primary.buffer);
          if (result.audio) {
            return buildAudioStickerResponse(result.sticker, result.audio, result.seconds, true);
          }

          // Silent video/GIF: hold visual and wait for follow-up audio
          setPendingSession(incoming.chatId, incoming.senderId, {
            stickerBuffer: result.sticker,
            isAnimated: true,
            expiresAt: Date.now() + PENDING_SESSION_TTL_MS,
          });
          return {
            text: 'Video/GIF tersebut tidak bersuara. Kirim audio atau voice note dalam 60 detik untuk digabungkan.',
          };
        }

        // Case 3: Image without quoted audio -> hold WebP and wait for follow-up audio
        const stickerBuffer = await stickerConverter.imageToSticker(primary.buffer);
        setPendingSession(incoming.chatId, incoming.senderId, {
          stickerBuffer,
          isAnimated: false,
          expiresAt: Date.now() + PENDING_SESSION_TTL_MS,
        });
        return {
          text: 'Gambar siap. Kirim audio atau voice note dalam 60 detik untuk digabungkan.',
        };
      } catch (err) {
        logger?.error({ err, mediaType: primary.type }, 'Failed to create audio sticker');
        return { text: 'Gagal membuat stiker bersuara.' };
      }
    },
  };
}
