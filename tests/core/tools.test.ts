import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { createSendStickerTool } from '../../src/core/tools/sticker-tool';
import { StickerCatalog } from '../../src/utils/sticker-catalog';
import { createCurrentTimeTool } from '../../src/core/tools';
import { CoreTool } from '../../src/core/tools/types';
import { IncomingMessage } from '../../src/core/types';

describe('ToolRegistry', () => {
  const createMockMessage = (role: 'owner' | 'guest'): IncomingMessage => ({
    id: 'test-1',
    senderId: '123',
    senderName: 'Tester',
    chatId: '123',
    chatType: 'dm',
    role,
    text: 'test',
    timestamp: Date.now(),
  });

  const mockOwnerTool: CoreTool = {
    name: 'secret_owner_tool',
    description: 'A tool exclusively for Owner.',
    parameters: {
      type: 'object',
      properties: {
        payload: { type: 'string' },
      },
    },
    ownerOnly: true,
    execute: async (params) => {
      const payload = params?.payload?.trim();
      if (!payload) return { status: 'error' };
      return { status: 'saved', payload };
    },
  };

  const mockAnotherOwnerTool: CoreTool = {
    name: 'another_owner_tool',
    description: 'Another tool exclusively for Owner.',
    parameters: {
      type: 'object',
      properties: {},
    },
    ownerOnly: true,
    execute: async () => ({ status: 'success' }),
  };

  it('registers and retrieves tools correctly', () => {
    const registry = new ToolRegistry();
    registry.register(createSendStickerTool({ catalog: new StickerCatalog() }));
    registry.register(mockOwnerTool);
    registry.register(mockAnotherOwnerTool);

    expect(registry.getTool('send_sticker')).toBeDefined();
    expect(registry.getTool('secret_owner_tool')).toBeDefined();
    expect(registry.getTool('another_owner_tool')).toBeDefined();
    expect(registry.getTool('non_existent')).toBeUndefined();
  });

  it('registers tools in batch via registerAll', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      createSendStickerTool({ catalog: new StickerCatalog() }),
      mockOwnerTool,
      mockAnotherOwnerTool,
    ]);

    expect(registry.getTool('send_sticker')).toBeDefined();
    expect(registry.getTool('secret_owner_tool')).toBeDefined();
    expect(registry.getTool('another_owner_tool')).toBeDefined();
  });

  it('filters tools by role: owner gets all tools, guest gets only public tools', () => {
    const registry = new ToolRegistry();
    registry.register(createSendStickerTool({ catalog: new StickerCatalog() }));
    registry.register(createCurrentTimeTool({ timeZone: 'Asia/Jakarta', locale: 'id-ID' }));
    registry.register(mockOwnerTool);
    registry.register(mockAnotherOwnerTool);

    const ownerTools = registry.getToolsForRole('owner');
    expect(ownerTools.map((t) => t.name)).toContain('secret_owner_tool');
    expect(ownerTools.map((t) => t.name)).toContain('another_owner_tool');
    expect(ownerTools.length).toBe(4);

    const guestTools = registry.getToolsForRole('guest');
    expect(guestTools.map((t) => t.name)).not.toContain('secret_owner_tool');
    expect(guestTools.map((t) => t.name)).not.toContain('another_owner_tool');
    expect(guestTools.length).toBe(2);
  });

  it('formats tools into definitions for role', () => {
    const registry = new ToolRegistry();
    registry.register(createSendStickerTool({ catalog: new StickerCatalog() }));
    registry.register(mockOwnerTool);
    registry.register(mockAnotherOwnerTool);

    const guestDecls = registry.getToolDefinitionsForRole('guest');
    expect(guestDecls.length).toBe(1);
    expect(guestDecls[0].name).toBe('send_sticker');

    const ownerDecls = registry.getToolDefinitionsForRole('owner');
    expect(ownerDecls.length).toBe(3);
  });

  describe('executeTool', () => {
    const registry = new ToolRegistry();
    registry.register(createSendStickerTool({ catalog: new StickerCatalog() }));
    registry.register(mockOwnerTool);
    registry.register(mockAnotherOwnerTool);

    it('allows owner to execute ownerOnly tool', async () => {
      const ownerMsg = createMockMessage('owner');
      const result = await registry.executeTool(
        'secret_owner_tool',
        { payload: 'secret data' },
        ownerMsg
      );
      expect(result.status).toBe('saved');
    });

    it('rejects guest executing ownerOnly tool', async () => {
      const guestMsg = createMockMessage('guest');
      await expect(
        registry.executeTool('secret_owner_tool', { payload: 'secret data' }, guestMsg)
      ).rejects.toThrow(/Access denied/);
    });

    it('allows guest to execute public tool', async () => {
      const guestMsg = createMockMessage('guest');
      const result = await registry.executeTool(
        'send_sticker',
        { tag: 'smug', reason: 'playful tease' },
        guestMsg
      );
      expect(result.status).toBe('success');
      expect(result.stickerRequested).toBe('smug');
    });
  });

  describe('executeToolsParallel', () => {
    const registry = new ToolRegistry();
    registry.register(createSendStickerTool({ catalog: new StickerCatalog() }));
    registry.register(mockOwnerTool);
    registry.register(mockAnotherOwnerTool);

    it('executes multiple tools concurrently in order', async () => {
      const ownerMsg = createMockMessage('owner');
      const results = await registry.executeToolsParallel(
        [
          { name: 'send_sticker', args: { tag: 'smug' } },
          { name: 'secret_owner_tool', args: { payload: 'data 1' } },
        ],
        ownerMsg
      );

      expect(results.length).toBe(2);
      expect(results[0].toolName).toBe('send_sticker');
      expect(results[0].result.status).toBe('success');
      expect(results[1].toolName).toBe('secret_owner_tool');
      expect(results[1].result.status).toBe('saved');
    });

    it('isolates errors if one tool throws while another succeeds', async () => {
      const guestMsg = createMockMessage('guest');
      const results = await registry.executeToolsParallel(
        [
          { name: 'send_sticker', args: { tag: 'tease' } },
          { name: 'secret_owner_tool', args: { payload: 'secret' } },
        ],
        guestMsg
      );

      expect(results.length).toBe(2);
      expect(results[0].toolName).toBe('send_sticker');
      expect(results[0].result.status).toBe('success');
      expect(results[1].toolName).toBe('secret_owner_tool');
      expect(results[1].error).toMatch(/Access denied/);
      expect(results[1].result.error).toMatch(/Access denied/);
    });

    it('returns empty array when calls list is empty', async () => {
      const ownerMsg = createMockMessage('owner');
      const results = await registry.executeToolsParallel([], ownerMsg);
      expect(results).toEqual([]);
    });
  });

  describe('createSendStickerTool', () => {
    it('dynamically embeds sticker catalog descriptions into parameter schema', () => {
      const mockCatalog = {
        describeForTools: () => '- custom_sticker [text: "Wow"]: Amazed reaction (tags: wow, amaze)',
      } as any;

      const tool = createSendStickerTool({ catalog: mockCatalog });
      expect(tool.parameters.properties.tag.description).toContain('custom_sticker');
      expect(tool.parameters.properties.tag.description).toContain('Amazed reaction');
    });
  });
});
