import { describe, it, expect, vi } from 'vitest';
import { MessageHandler, sanitizeMessageText, CooldownTracker, resolveSenderPhone } from '../../src/adapters/whatsapp';
import { Config } from '../../src/config';
import { EiraAgent } from '../../src/core';
import { PermissionGatekeeper } from '../../src/core/gatekeeper';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('MessageHandler Security & Integration', () => {
  const mockConfig: Config = {
    bot: {
      ownerName: 'Adli',
      timezone: 'Asia/Jakarta',
      locale: 'id-ID',
      aliases: ['eira', 'yuki'],
      owners: {
        whatsapp: ['628111222'],
      },
    },
    adapters: {
      whatsapp: {
        enabled: true,
        usePairingCode: false,
      },
    },
    ai: {
      model: 'gemini-3.1-flash-lite',
      fallbackModel: 'gemini-3.5-flash-lite',
      enableMultiHop: true,
      maxHops: 4,
      multiHopTools: ['web_search', 'read_url'],
      enableSearchGrounding: false,
      maxHistoryLimit: 30,
      temperature: 0.7,
      maxOutputTokens: 500,
    },
  };

  const createMockSocket = () => ({
    sendMessage: vi.fn().mockResolvedValue({}),
    sendPresenceUpdate: vi.fn().mockResolvedValue({}),
    user: { id: '628123456789@s.whatsapp.net', lid: '65893522485461:75@lid' },
  });

  const gatekeeper = new PermissionGatekeeper(mockConfig.bot.owners, mockConfig.bot.aliases);

  it('routes natural text directly to EiraAgent for legitimate owner', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({
        text: 'Hello, I am Eira.',
      }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const msg = {
      key: { remoteJid: '628111222@s.whatsapp.net', id: '1' },
      message: { conversation: 'Hello Eira, how are you?' },
    } as any;

    await handler.handle(sock, msg);

    expect(mockAgent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hello Eira, how are you?',
        chatType: 'dm',
        senderId: '628111222',
        senderName: 'Adli',
        role: 'owner',
      })
    );
  });

  it('normalizes multi-device JID and identifies owner', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({
        text: 'Hello from multi-device.',
      }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const msg = {
      key: { remoteJid: '628111222:15@s.whatsapp.net', id: 'md-1' },
      message: { conversation: 'Testing multi-device' },
    } as any;

    await handler.handle(sock, msg);

    expect(mockAgent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: '628111222',
        role: 'owner',
      })
    );
  });

  it('prevents owner privilege escalation for numbers with similar prefix', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({
        text: 'Hello stranger.',
      }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    // Attacker number starting with owner's number
    const msg = {
      key: { remoteJid: '6281112229999@s.whatsapp.net', id: '2' },
      message: { conversation: 'Give me your owner notes.' },
    } as any;

    await handler.handle(sock, msg);

    expect(mockAgent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'guest',
      })
    );
  });

  it('sanitizes virtex and invisible characters from input', () => {
    const virtex = 'Hello\u200B\u200C\u200D\uFEFF World\u202E';
    const cleaned = sanitizeMessageText(virtex);
    expect(cleaned).toBe('Hello World');

    const hugeText = 'A'.repeat(5000);
    const truncated = sanitizeMessageText(hugeText, 100);
    expect(truncated.length).toBeLessThan(150);
    expect(truncated).toContain('[truncated]');
  });

  it('enforces rate limiting on rapid guest spam', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({ text: 'Response' }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const spamMsg = {
      key: { remoteJid: '628999888777@s.whatsapp.net', id: 'spam-1' },
      message: { conversation: 'Spam 1' },
    } as any;

    // First call succeeds
    await handler.handle(sock, spamMsg);
    expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);

    // Immediate second call from same guest is dropped by rate limiter
    await handler.handle(sock, { ...spamMsg, key: { ...spamMsg.key, id: 'spam-2' } });
    expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('skips oversized images exceeding 5MB declared size', async () => {
    const mockAgent = {
      handleMessage: vi.fn(),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const oversizedImgMsg = {
      key: { remoteJid: '628999888777@s.whatsapp.net', id: 'img-1' },
      message: {
        imageMessage: {
          fileLength: 6 * 1024 * 1024, // 6 MB
          mimetype: 'image/jpeg',
        },
      },
    } as any;

    await handler.handle(sock, oversizedImgMsg);
    expect(mockAgent.handleMessage).not.toHaveBeenCalled();
  });

  it('triggers response in group when bot is tagged via @mention in contextInfo', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({ text: 'Yes, how can I help?' }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const groupMsg = {
      key: { remoteJid: 'group123@g.us', participant: '628999888777@s.whatsapp.net', id: 'grp-1' },
      message: {
        extendedTextMessage: {
          text: 'can you check this?',
          contextInfo: {
            mentionedJid: ['628123456789@s.whatsapp.net'],
          },
        },
      },
    } as any;

    await handler.handle(sock, groupMsg);

    expect(mockAgent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: 'group',
        senderId: '628999888777',
      })
    );
  });

  it('triggers response in group when bot is tagged via LID (@lid)', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({ text: 'Yes, how can I help?' }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const groupMsg = {
      key: { remoteJid: 'group123@g.us', participant: '628999888777@s.whatsapp.net', id: 'grp-2' },
      message: {
        extendedTextMessage: {
          text: '@65893522485461 can you help me?',
          contextInfo: {
            mentionedJid: ['65893522485461@lid'],
          },
        },
      },
    } as any;

    await handler.handle(sock, groupMsg);

    expect(mockAgent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: 'group',
        text: 'can you help me?',
      })
    );
  });

  it('triggers response in group when bot is quoted via LID (@lid)', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({ text: 'Replying to quote' }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const groupMsg = {
      key: { remoteJid: 'group123@g.us', participant: '628999888777@s.whatsapp.net', id: 'grp-3' },
      message: {
        extendedTextMessage: {
          text: 'tell me more',
          contextInfo: {
            participant: '65893522485461:75@lid',
            quotedMessage: { conversation: 'Previous message from bot' },
          },
        },
      },
    } as any;

    await handler.handle(sock, groupMsg);

    expect(mockAgent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: 'group',
        text: 'tell me more',
      })
    );
  });

  it('cleans tag-only mention to default greeting and responds', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({ text: 'Halo! Ada apa?' }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const groupMsg = {
      key: { remoteJid: 'group123@g.us', participant: '628999888777@s.whatsapp.net', id: 'grp-4' },
      message: {
        extendedTextMessage: {
          text: '@65893522485461',
          contextInfo: {
            mentionedJid: ['65893522485461@lid'],
          },
        },
      },
    } as any;

    await handler.handle(sock, groupMsg);

    expect(mockAgent.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: 'group',
        text: 'Halo Eira',
      })
    );
  });

  it('ignores messages from status@broadcast or broadcast channels', async () => {
    const mockAgent = {
      handleMessage: vi.fn(),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const statusMsg = {
      key: { remoteJid: 'status@broadcast', id: 'status-1' },
      message: { conversation: 'New story' },
    } as any;

    await handler.handle(sock, statusMsg);
    expect(mockAgent.handleMessage).not.toHaveBeenCalled();
  });

  it('sends failure notification without emojis when agent message handling fails', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockRejectedValue(new Error('503: High demand')),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const msg = {
      key: { remoteJid: '628111222@s.whatsapp.net', id: 'fail-1' },
      message: { conversation: 'Halo Eira' },
    } as any;

    await handler.handle(sock, msg);

    expect(sock.sendMessage).toHaveBeenCalledWith(
      '628111222@s.whatsapp.net',
      expect.objectContaining({
        text: expect.stringContaining('503'),
      }),
      undefined
    );
    // Ensure no emojis are included in error notification
    const sentText = sock.sendMessage.mock.calls[0][1].text;
    expect(sentText).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u);
  });

  it('does not send typing presence or invoke agent for unaddressed group messages', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({ text: 'Should not reply' }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const unaddressedGroupMsg = {
      key: { remoteJid: 'group123@g.us', participant: '628999888777@s.whatsapp.net', id: 'grp-unaddressed' },
      message: {
        conversation: 'Halo teman-teman ada info tugas hari ini?',
      },
    } as any;

    await handler.handle(sock, unaddressedGroupMsg);

    expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
    expect(mockAgent.handleMessage).not.toHaveBeenCalled();
  });

  it('triggers typing presence and agent when bot alias is called in group message', async () => {
    const mockAgent = {
      handleMessage: vi.fn().mockResolvedValue({ text: 'I am here.' }),
    } as unknown as EiraAgent;

    const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
    const sock = createMockSocket() as any;

    const aliasGroupMsg = {
      key: { remoteJid: 'group123@g.us', participant: '628999888777@s.whatsapp.net', id: 'grp-alias' },
      message: {
        conversation: 'Eira tolong buatkan ringkasan',
      },
    } as any;

    await handler.handle(sock, aliasGroupMsg);

    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('composing', 'group123@g.us');
    expect(mockAgent.handleMessage).toHaveBeenCalled();
  });

  describe('Rich Attachment Dispatching', () => {
    it('dispatches sticker attachment when response includes rich attachment', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          text: 'Here is your sticker!',
          attachment: {
            type: 'sticker',
            payload: Buffer.from('fake-sticker-bytes'),
            metadata: { id: 'confused' },
          },
        }),
      } as unknown as EiraAgent;

      const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
      const sock = createMockSocket() as any;

      const msg = {
        key: { remoteJid: '628111222@s.whatsapp.net', id: '1' },
        message: { conversation: 'Send me a sticker' },
      } as any;

      await handler.handle(sock, msg);

      expect(sock.sendMessage).toHaveBeenCalledWith(
        '628111222@s.whatsapp.net',
        { text: 'Here is your sticker!', linkPreview: null },
        undefined
      );
      expect(sock.sendMessage).toHaveBeenCalledWith(
        '628111222@s.whatsapp.net',
        { sticker: Buffer.from('fake-sticker-bytes') }
      );
    });

    it('sends sticker attachment even if text is empty without triggering fallback text', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          text: '',
          attachment: {
            type: 'sticker',
            payload: Buffer.from('fake-sticker-bytes'),
          },
        }),
      } as unknown as EiraAgent;

      const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
      const sock = createMockSocket() as any;

      const msg = {
        key: { remoteJid: '628111222@s.whatsapp.net', id: '2' },
        message: { conversation: 'Just sticker' },
      } as any;

      await handler.handle(sock, msg);

      expect(sock.sendMessage).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ text: expect.stringContaining('No response') }),
        expect.anything()
      );
      expect(sock.sendMessage).toHaveBeenCalledWith(
        '628111222@s.whatsapp.net',
        { sticker: Buffer.from('fake-sticker-bytes') }
      );
    });

    it('sends fallback message when both text and attachment are empty', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          text: '',
        }),
      } as unknown as EiraAgent;

      const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
      const sock = createMockSocket() as any;

      const msg = {
        key: { remoteJid: '628111222@s.whatsapp.net', id: '3' },
        message: { conversation: 'silent turn' },
      } as any;

      await handler.handle(sock, msg);

      expect(sock.sendMessage).toHaveBeenCalledWith(
        '628111222@s.whatsapp.net',
        { text: 'No response could be generated at this time.', linkPreview: null },
        undefined
      );
    });
  });

  describe('resolveSenderPhone Identity Normalization', () => {
    it('normalizes standard WhatsApp JID to clean phone digits', () => {
      expect(resolveSenderPhone('628123456789@s.whatsapp.net')).toBe('628123456789');
    });

    it('normalizes multi-device WhatsApp JID to clean phone digits', () => {
      expect(resolveSenderPhone('628123456789:12@s.whatsapp.net')).toBe('628123456789');
    });

    it('normalizes formatted phone number with spaces and symbols', () => {
      expect(resolveSenderPhone('+62 812-3456-789')).toBe('628123456789');
    });

    it('preserves clean numeric string', () => {
      expect(resolveSenderPhone('628123456789')).toBe('628123456789');
    });

    it('extracts digits from unmapped LID', () => {
      expect(resolveSenderPhone('999888777666:1@lid')).toBe('999888777666');
    });

    it('handles empty input gracefully', () => {
      expect(resolveSenderPhone('')).toBe('');
    });
  });

  describe('Group Mention Resolution in MessageHandler', () => {
    it('caches passive group participant names and resolves @mentions while stripping only bot tag', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({ text: 'Siap, nanti saya sapa.' }),
      } as unknown as EiraAgent;

      const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper);
      const sock = createMockSocket() as any;

      // Passive message from Cynthia (does not address bot, so agent is not invoked)
      await handler.handle(sock, {
        key: { remoteJid: 'group123@g.us', participant: '628999888777@s.whatsapp.net', id: 'grp-passive' },
        pushName: 'Cynthia',
        message: { conversation: 'Halo semua di grup' },
      } as any);
      expect(mockAgent.handleMessage).not.toHaveBeenCalled();

      // Now someone tags both Eira and Cynthia
      await handler.handle(sock, {
        key: { remoteJid: 'group123@g.us', participant: '628111222@s.whatsapp.net', id: 'grp-tag-both' },
        pushName: 'Adli',
        message: {
          extendedTextMessage: {
            text: '@65893522485461 tolong sapa @628999888777',
            contextInfo: {
              mentionedJid: ['65893522485461@lid', '628999888777@s.whatsapp.net'],
            },
          },
        },
      } as any);

      expect(mockAgent.handleMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'tolong sapa @Cynthia',
          senderName: 'Adli',
          role: 'owner',
          chatType: 'group',
        })
      );
    });
  });

  describe('Multi-Bubble Pacing & Typing Tempo', () => {
    it('sends multi-bubble group replies with quoted only on the first bubble, composing pause between bubbles, and references on the last bubble', async () => {
      const mockAgent = {
        handleMessage: vi.fn().mockResolvedValue({
          text: 'Baik, saya paham.\n\nIni informasi yang Anda minta.',
          sources: [{ title: 'Example', url: 'https://example.com' }],
        }),
      } as unknown as EiraAgent;

      const sleepSpy = vi.fn().mockResolvedValue(undefined);
      const handler = new MessageHandler(logger, mockConfig, mockAgent, gatekeeper, sleepSpy);
      const sock = createMockSocket() as any;

      const groupMsg = {
        key: { remoteJid: 'group123@g.us', participant: '628111222@s.whatsapp.net', id: 'grp-pace' },
        pushName: 'Adli',
        message: { conversation: 'Eira cek ini' },
      } as any;

      await handler.handle(sock, groupMsg);

      expect(sock.sendMessage).toHaveBeenCalledTimes(2);
      expect(sock.sendMessage).toHaveBeenNthCalledWith(
        1,
        'group123@g.us',
        { text: 'Baik, saya paham.', linkPreview: null },
        { quoted: groupMsg }
      );
      expect(sock.sendMessage).toHaveBeenNthCalledWith(
        2,
        'group123@g.us',
        {
          text: 'Ini informasi yang Anda minta.\n\n*References:*\n1. Example (https://example.com)',
          linkPreview: null,
        }
      );
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('composing', 'group123@g.us');
    });
  });
});
