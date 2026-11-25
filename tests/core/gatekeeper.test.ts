import { describe, it, expect } from 'vitest';
import { PermissionGatekeeper } from '../../src/core/gatekeeper/permission-gatekeeper';
import { IncomingMessage } from '../../src/core/types';

describe('PermissionGatekeeper', () => {
  const gatekeeper = new PermissionGatekeeper(
    {
      whatsapp: ['628123456789'],
      discord: ['123456789012345678'],
      telegram: ['987654321', 'adlidev'],
      api: ['admin_user'],
    },
    ['eira', 'yuki']
  );

  describe('Canonical Identity Permissions', () => {
    it('identifies owner by exact canonical ID within adapter namespace', () => {
      expect(gatekeeper.isOwner('628123456789', 'whatsapp')).toBe(true);
      expect(gatekeeper.isOwner('123456789012345678', 'discord')).toBe(true);
      expect(gatekeeper.isOwner('987654321', 'telegram')).toBe(true);
      expect(gatekeeper.isOwner('adlidev', 'telegram')).toBe(true);
      expect(gatekeeper.isOwner('admin_user', 'api')).toBe(true);
    });

    it('rejects unnormalized or raw platform strings without backward compatibility', () => {
      expect(gatekeeper.isOwner('628123456789@s.whatsapp.net', 'whatsapp')).toBe(false);
      expect(gatekeeper.isOwner('628123456789:12@s.whatsapp.net', 'whatsapp')).toBe(false);
      expect(gatekeeper.isOwner('@adlidev', 'telegram')).toBe(false);
    });

    it('identifies non-owner as guest', () => {
      expect(gatekeeper.isOwner('628999999999', 'whatsapp')).toBe(false);
      expect(gatekeeper.isOwner('999999999999999999', 'discord')).toBe(false);
      expect(gatekeeper.isOwner('stranger', 'telegram')).toBe(false);
      expect(gatekeeper.isOwner('guest_user', 'api')).toBe(false);
    });

    it('prevents privilege escalation for numbers sharing prefix with owner', () => {
      expect(gatekeeper.isOwner('628123456789000', 'whatsapp')).toBe(false);
    });

    it('handles whitespace trimming safely', () => {
      expect(gatekeeper.isOwner('  628123456789  ', 'whatsapp')).toBe(true);
      expect(gatekeeper.isOwner('   ', 'whatsapp')).toBe(false);
      expect(gatekeeper.isOwner('', 'whatsapp')).toBe(false);
    });
  });

  describe('Multi-Adapter Isolation & Cross-Lookup', () => {
    it('prevents cross-adapter collision when adapter is specified', () => {
      expect(gatekeeper.isOwner('628123456789', 'telegram')).toBe(false);
      expect(gatekeeper.isOwner('123456789012345678', 'whatsapp')).toBe(false);
    });

    it('resolves owner across any adapter when adapter is omitted', () => {
      expect(gatekeeper.isOwner('628123456789')).toBe(true);
      expect(gatekeeper.isOwner('123456789012345678')).toBe(true);
      expect(gatekeeper.isOwner('admin_user')).toBe(true);
      expect(gatekeeper.isOwner('unknown_user')).toBe(false);
    });
  });

  describe('shouldRespond', () => {
    it('always responds in DM regardless of content', () => {
      const msg: IncomingMessage = {
        id: '1',
        senderId: '628999999999',
        senderName: 'Friend',
        chatId: '628999999999',
        chatType: 'dm',
        role: 'guest',
        text: 'halo apa kabar',
        timestamp: Date.now(),
        adapter: 'whatsapp',
      };
      expect(gatekeeper.shouldRespond(msg)).toBe(true);
    });

    it('in group, ignores messages that do not mention bot aliases', () => {
      const msg: IncomingMessage = {
        id: '2',
        senderId: '628999999999',
        senderName: 'Friend',
        chatId: '123456@g.us',
        chatType: 'group',
        role: 'guest',
        text: 'ada yang tau tugas besok apa?',
        timestamp: Date.now(),
        adapter: 'whatsapp',
      };
      expect(gatekeeper.shouldRespond(msg)).toBe(false);
    });

    it('in group, responds when "eira" or "yuki" is mentioned', () => {
      const msgEira: IncomingMessage = {
        id: '3',
        senderId: '628999999999',
        senderName: 'Friend',
        chatId: '123456@g.us',
        chatType: 'group',
        role: 'guest',
        text: 'halo Eira, lagi ngapain?',
        timestamp: Date.now(),
        adapter: 'whatsapp',
      };
      expect(gatekeeper.shouldRespond(msgEira)).toBe(true);

      const msgYuki: IncomingMessage = {
        ...msgEira,
        id: '4',
        text: 'yuki tolong bantuin dong',
      };
      expect(gatekeeper.shouldRespond(msgYuki)).toBe(true);
    });

    it('in group, responds when quoted message is from bot even without mention', () => {
      const msgQuoting: IncomingMessage = {
        id: '5',
        senderId: '628999999999',
        senderName: 'Friend',
        chatId: '123456@g.us',
        chatType: 'group',
        role: 'guest',
        text: 'kenapa begitu?',
        timestamp: Date.now(),
        adapter: 'whatsapp',
      };
      expect(gatekeeper.shouldRespond(msgQuoting, true)).toBe(true);
    });

    it('in group, safely returns false when text is empty, whitespace, or undefined', () => {
      const emptyMsg: IncomingMessage = {
        id: '6',
        senderId: '628999999999',
        senderName: 'Friend',
        chatId: '123456@g.us',
        chatType: 'group',
        role: 'guest',
        text: '',
        timestamp: Date.now(),
        adapter: 'whatsapp',
      };
      expect(gatekeeper.shouldRespond(emptyMsg)).toBe(false);

      const whitespaceMsg: IncomingMessage = {
        ...emptyMsg,
        id: '7',
        text: '    ',
      };
      expect(gatekeeper.shouldRespond(whitespaceMsg)).toBe(false);

      const undefinedTextMsg = {
        ...emptyMsg,
        id: '8',
        text: undefined as unknown as string,
      };
      expect(gatekeeper.shouldRespond(undefinedTextMsg)).toBe(false);
    });
  });
});
