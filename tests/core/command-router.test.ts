import { describe, it, expect, vi } from 'vitest';
import {
  CommandRouter,
  createHelpCommand,
} from '../../src/core/commands';
import {
  createAudioStickerCommand,
  createStickerCommand,
  StickerConverter,
} from '../../src/adapters/whatsapp/commands';
import { IncomingMessage } from '../../src/core/types';

describe('CommandRouter & Core Commands', () => {
  const createMsg = (
    text: string,
    role: 'owner' | 'guest' = 'guest',
    media?: IncomingMessage['media']
  ): IncomingMessage => ({
    id: 'cmd-1',
    senderId: '628999',
    senderName: 'Cynthia',
    chatId: 'group123@g.us',
    chatType: 'group',
    role,
    text,
    media,
    timestamp: Date.now(),
    adapter: 'whatsapp',
  });

  it('recognizes only registered commands with the configured prefix', () => {
    const router = new CommandRouter('.');
    router.register(createHelpCommand(router));

    expect(router.isRegisteredCommand('.help')).toBe(true);
    expect(router.isRegisteredCommand('.MENU')).toBe(true);
    expect(router.isRegisteredCommand('...')).toBe(false);
    expect(router.isRegisteredCommand('.unknown')).toBe(false);
    expect(router.isRegisteredCommand('. help')).toBe(false);
    expect(router.isRegisteredCommand('help')).toBe(false);
  });

  it('executes .sticker for image and video media, and returns guidance when no media is attached', async () => {
    const mockConverter: StickerConverter = {
      imageToSticker: vi.fn().mockResolvedValue(Buffer.from('webp-image')),
      videoToSticker: vi.fn().mockResolvedValue(Buffer.from('webp-video')),
    };

    const router = new CommandRouter('.');
    router.register(createStickerCommand(mockConverter, '.'));

    const noMediaRes = await router.tryExecute(createMsg('.sticker'));
    expect(noMediaRes?.text).toContain('.sticker');
    expect(noMediaRes?.attachment).toBeUndefined();

    const imgRes = await router.tryExecute(
      createMsg('.s', 'guest', {
        buffer: Buffer.from('raw-img'),
        mimeType: 'image/jpeg',
        type: 'image',
      })
    );
    expect(mockConverter.imageToSticker).toHaveBeenCalledTimes(1);
    expect(imgRes?.attachment).toEqual({
      type: 'sticker',
      payload: Buffer.from('webp-image'),
    });

    const vidRes = await router.tryExecute(
      createMsg('.sticker', 'guest', {
        buffer: Buffer.from('raw-vid'),
        mimeType: 'video/mp4',
        type: 'video',
      })
    );
    expect(mockConverter.videoToSticker).toHaveBeenCalledTimes(1);
    expect(vidRes?.attachment).toEqual({
      type: 'sticker',
      payload: Buffer.from('webp-video'),
      metadata: { isAnimated: true },
    });
  });

  it('uses .asticker for video with audio, 1-step quoted audio, and 2-step pending audio session', async () => {
    const mockConverter: StickerConverter = {
      imageToSticker: vi.fn().mockResolvedValue(Buffer.from('webp-img')),
      videoToSticker: vi.fn().mockResolvedValue(Buffer.from('webp-vid')),
      audioToOpus: vi.fn().mockResolvedValue({
        audio: Buffer.from('ogg-opus'),
        seconds: 4,
      }),
      videoToAudioSticker: vi.fn().mockResolvedValue({
        sticker: Buffer.from('webp-anim'),
        audio: Buffer.from('ogg-opus-vid'),
        seconds: 5,
      }),
    };

    const router = new CommandRouter('.');
    router.register(createStickerCommand(mockConverter, '.'));
    router.register(createAudioStickerCommand(mockConverter, '.'));

    // 1. Video with audio via .asticker
    const vidRes = await router.tryExecute(
      createMsg('.asticker', 'guest', {
        buffer: Buffer.from('raw-vid-sound'),
        mimeType: 'video/mp4',
        type: 'video',
      })
    );
    expect(mockConverter.videoToAudioSticker).toHaveBeenCalledTimes(1);
    expect(vidRes?.attachment).toEqual({
      type: 'sticker',
      payload: Buffer.from('webp-anim'),
      metadata: {
        isAnimated: true,
        audio: Buffer.from('ogg-opus-vid'),
        seconds: 5,
      },
    });

    // 2. 1-step image + quoted audio via .asticker
    const oneStepRes = await router.tryExecute({
      ...createMsg('.asticker', 'guest', {
        buffer: Buffer.from('raw-img'),
        mimeType: 'image/jpeg',
        type: 'image',
      }),
      secondaryMedia: {
        buffer: Buffer.from('raw-audio'),
        mimeType: 'audio/ogg',
        type: 'audio',
      },
    });
    expect(oneStepRes?.attachment).toEqual({
      type: 'sticker',
      payload: Buffer.from('webp-img'),
      metadata: {
        isAnimated: false,
        audio: Buffer.from('ogg-opus'),
        seconds: 4,
      },
    });

    // 3. 2-step image -> pending session -> follow-up audio
    const step1 = await router.tryExecute(
      createMsg('.as', 'guest', {
        buffer: Buffer.from('raw-img-2'),
        mimeType: 'image/png',
        type: 'image',
      })
    );
    expect(step1?.text).toContain('60 detik');
    expect(router.hasPendingInteraction('group123@g.us', '628999')).toBe(true);

    const step2 = await router.tryExecute(
      createMsg('[Audio]', 'guest', {
        buffer: Buffer.from('follow-up-audio'),
        mimeType: 'audio/ogg',
        type: 'audio',
      })
    );
    expect(router.hasPendingInteraction('group123@g.us', '628999')).toBe(false);
    expect(step2?.attachment).toEqual({
      type: 'sticker',
      payload: Buffer.from('webp-img'),
      metadata: {
        isAnimated: false,
        audio: Buffer.from('ogg-opus'),
        seconds: 4,
      },
    });
  });

  it('enforces ownerOnly on commands and hides owner-only commands from guests in .help', async () => {
    const router = new CommandRouter('.');
    router.register({
      name: 'admin',
      description: 'Owner only command',
      ownerOnly: true,
      execute: async () => ({ text: 'ok' }),
    });
    router.register(createHelpCommand(router));

    const denied = await router.tryExecute(createMsg('.admin', 'guest'));
    expect(denied?.text).toContain('Owner');

    const allowed = await router.tryExecute(createMsg('.admin', 'owner'));
    expect(allowed?.text).toBe('ok');

    const guestHelp = await router.tryExecute(createMsg('.help', 'guest'));
    expect(guestHelp?.text).not.toContain('.admin');
    expect(guestHelp?.text).toContain('.help');
  });
});
