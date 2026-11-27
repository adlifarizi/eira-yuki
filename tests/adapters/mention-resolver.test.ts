import { describe, it, expect, vi } from 'vitest';
import { MentionResolver } from '../../src/adapters/whatsapp/mention-resolver';
import { PermissionGatekeeper } from '../../src/core/gatekeeper';

describe('MentionResolver', () => {
  const gatekeeper = new PermissionGatekeeper({ whatsapp: ['628111222'] }, ['eira', 'yuki']);
  const mockSock = {
    user: { id: '628123456789@s.whatsapp.net', lid: '65893522485461:75@lid' },
  } as any;

  it('strips only bot mentions and preserves and resolves other participant mentions', async () => {
    const resolver = new MentionResolver({
      gatekeeper,
      ownerName: 'Adli',
      botPhone: '628123456789',
    });

    resolver.recordParticipant('628999888777@s.whatsapp.net', '628999888777', 'Cynthia');

    const processed = await resolver.processMentions({
      text: '@65893522485461 tolong sapa @628999888777 ya',
      mentionedJids: ['65893522485461@lid', '628999888777@s.whatsapp.net'],
      sock: mockSock,
      chatId: 'group123@g.us',
      isGroup: true,
      hasImage: false,
      isDirectlyAddressed: true,
    });

    expect(processed).toBe('tolong sapa @Cynthia ya');
  });

  it('resolves mentions to display names even when bot is called via alias (not directly tagged)', async () => {
    const resolver = new MentionResolver({
      gatekeeper,
      ownerName: 'Adli',
      botPhone: '628123456789',
    });

    resolver.recordParticipant('130408142385266@lid', '130408142385266', 'Glorian');

    const processed = await resolver.processMentions({
      text: 'Eira, ajak ngobrol @130408142385266 dan @628111222',
      mentionedJids: ['130408142385266@lid', '628111222@s.whatsapp.net'],
      sock: mockSock,
      chatId: 'group123@g.us',
      isGroup: true,
      hasImage: false,
      isDirectlyAddressed: false,
    });

    expect(processed).toBe('Eira, ajak ngobrol @Glorian dan @Adli');
  });

  it('falls back to groupMetadata when participant has not sent a message yet', async () => {
    const sockWithMetadata = {
      ...mockSock,
      groupMetadata: vi.fn().mockResolvedValue({
        participants: [
          { id: '628777666555@s.whatsapp.net', notify: 'Budi' },
        ],
      }),
    } as any;

    const resolver = new MentionResolver({
      gatekeeper,
      ownerName: 'Adli',
      botPhone: '628123456789',
    });

    const processed = await resolver.processMentions({
      text: 'Eira, ingetin @628777666555',
      mentionedJids: ['628777666555@s.whatsapp.net'],
      sock: sockWithMetadata,
      chatId: 'group123@g.us',
      isGroup: true,
      hasImage: false,
      isDirectlyAddressed: false,
    });

    expect(processed).toBe('Eira, ingetin @Budi');
    expect(sockWithMetadata.groupMetadata).toHaveBeenCalledTimes(1);
  });

  it('keeps raw digits when participant name cannot be resolved and falls back to Halo Eira when empty', async () => {
    const resolver = new MentionResolver({
      gatekeeper,
      ownerName: 'Adli',
      botPhone: '628123456789',
    });

    const unknownMention = await resolver.processMentions({
      text: 'Eira, cek @628000111222',
      mentionedJids: ['628000111222@s.whatsapp.net'],
      sock: mockSock,
      chatId: 'group123@g.us',
      isGroup: true,
      hasImage: false,
      isDirectlyAddressed: false,
    });
    expect(unknownMention).toBe('Eira, cek @628000111222');

    const emptyAfterBotStrip = await resolver.processMentions({
      text: '@628123456789',
      mentionedJids: ['628123456789@s.whatsapp.net'],
      sock: mockSock,
      chatId: 'group123@g.us',
      isGroup: true,
      hasImage: false,
      isDirectlyAddressed: true,
    });
    expect(emptyAfterBotStrip).toBe('Halo Eira');
  });
});
